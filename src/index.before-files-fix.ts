import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

import { spawn } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";


const BSK =
  process.env.BSK_PATH ||
  path.join(
    os.homedir(),
    ".local",
    "bin",
    process.platform === "win32" ? "bsk.exe" : "bsk"
  );


const ownedSessions = new Set();
let currentSession = null;


let daemonStartPromise = null;


function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}


function runBskRaw(args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(BSK, args, {
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,

        // Never use BrowserSkill's own Windows auto-start.
        // Our MCP manages the daemon itself.
        BSK_AUTO_START: "0",
      },
    });

    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill();

      reject(
        new Error(
          `bsk timeout after ${timeoutMs} ms: ${args.join(" ")}`
        )
      );
    }, timeoutMs);


    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });


    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });


    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });


    child.on("close", (code) => {
      clearTimeout(timer);

      if (code === 0) {
        resolve(stdout.trim());
        return;
      }

      reject(
        new Error(
          (
            stderr ||
            stdout ||
            `bsk exited with code ${code}`
          ).trim()
        )
      );
    });
  });
}


async function probeBskDaemon() {
  try {
    const output =
      await runBskRaw(
        [
          "status",
          "--json",
        ],
        2500
      );

    const status =
      JSON.parse(output);

    if (
      status &&
      status.daemon_version
    ) {
      return status;
    }

    return null;

  } catch {
    return null;
  }
}


async function startBskDaemonHidden() {

  const daemonIdle =
    process.env.BSK_DAEMON_IDLE ||
    "30m";

  const sessionIdle =
    process.env.BSK_SESSION_IDLE ||
    "30m";


  let spawnError = null;


  const child = spawn(
    BSK,
    [
      "daemon",
      "start",
      "--foreground",

      "--daemon-idle",
      daemonIdle,

      "--session-idle",
      sessionIdle,
    ],
    {
      shell: false,

      // Important on Windows:
      // no console window is created.
      windowsHide: true,

      // Let bsk keep running independently
      // from the individual tool call.
      detached: true,

      // Do not attach the daemon to MCP stdio.
      stdio: "ignore",

      env: {
        ...process.env,
        BSK_AUTO_START: "0",
      },
    }
  );


  child.once(
    "error",
    (error) => {
      spawnError = error;
    }
  );


  // The daemon no longer keeps the MCP
  // Node process alive.
  child.unref();


  // Wait until IPC actually becomes available.
  // This avoids the BrowserSkill Windows
  // auto-start race we encountered earlier.
  for (
    let attempt = 0;
    attempt < 50;
    attempt++
  ) {

    await sleep(200);

    const status =
      await probeBskDaemon();

    if (status) {
      return status;
    }


    if (spawnError) {
      throw new Error(
        `Could not start BrowserSkill daemon: ${spawnError.message}`
      );
    }
  }


  throw new Error(
    "BrowserSkill daemon was started but did not become ready within 10 seconds. Run `bsk logs` for details."
  );
}


async function ensureBskDaemon() {

  const current =
    await probeBskDaemon();

  if (current) {
    return current;
  }


  // Prevent two simultaneous MCP tool calls
  // from starting two daemons.
  if (!daemonStartPromise) {

    daemonStartPromise =
      startBskDaemonHidden()
        .finally(() => {
          daemonStartPromise = null;
        });
  }


  return daemonStartPromise;
}


async function runBsk(
  args,
  timeoutMs = 120000
) {

  await ensureBskDaemon();

  return runBskRaw(
    args,
    timeoutMs
  );
}


async function runJson(
  args,
  timeoutMs
) {

  const output =
    await runBsk(
      [...args, "--json"],
      timeoutMs
    );

  try {
    return JSON.parse(output);
  } catch {
    return {
      raw: output,
    };
  }
}


function ok(value, session) {
  let payload = value;

  if (
    session &&
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    payload = {
      session,
      ...value,
    };
  }

  return {
    content: [
      {
        type: "text",
        text:
          typeof payload === "string"
            ? payload
            : JSON.stringify(payload, null, 2),
      },
    ],
  };
}


function fail(error) {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text:
          error instanceof Error
            ? error.message
            : String(error),
      },
    ],
  };
}


function getOwnedSession(requested) {
  const id = requested || currentSession;

  if (!id) {
    throw new Error(
      "No current BrowserSkill session. Start one with browser_session."
    );
  }

  if (!ownedSessions.has(id)) {
    throw new Error(
      `Session ${id} is not owned by this MCP server.`
    );
  }

  currentSession = id;

  return id;
}


function addOpt(args, flag, value) {
  if (value !== undefined && value !== null) {
    args.push(flag, String(value));
  }
}


function addFlag(args, flag, enabled) {
  if (enabled) {
    args.push(flag);
  }
}


const server = new McpServer(
  {
    name: "browserskill-chatgpt",
    version: "0.2.0",
  },
  {
    instructions:
      "Use BrowserSkill to operate the user's real Chrome or Edge browser. " +
      "Only BrowserSkill sessions created by this MCP server may be controlled. " +
      "Borrowing an existing user tab remains governed by the BrowserSkill extension confirmation setting.",
  }
);



/* =========================================================
   browser_session
   ========================================================= */

server.registerTool(
  "browser_session",
  {
    description:
      "Start, stop, or list BrowserSkill Agent Window sessions owned by this MCP server.",

    inputSchema: z.object({
      action: z.enum([
        "start",
        "stop",
        "list",
      ]),

      session: z.string().optional(),
      name: z.string().optional(),
      browser: z.string().optional(),

      width: z
        .number()
        .int()
        .min(100)
        .max(7680)
        .optional(),

      height: z
        .number()
        .int()
        .min(100)
        .max(7680)
        .optional(),

      no_focus: z.boolean().optional(),
    }),
  },

  async (input) => {
    try {
      if (input.action === "start") {

        if (
          (input.width === undefined) !==
          (input.height === undefined)
        ) {
          throw new Error(
            "width and height must be supplied together."
          );
        }

        const args = [
          "session",
          "start",
        ];

        addOpt(args, "--name", input.name);
        addOpt(args, "--browser", input.browser);
        addOpt(args, "--width", input.width);
        addOpt(args, "--height", input.height);
        addFlag(args, "--no-focus", input.no_focus);

        const data = await runJson(
          args,
          130000
        );

        if (!data.session_id) {
          throw new Error(
            `bsk did not return session_id: ${JSON.stringify(data)}`
          );
        }

        ownedSessions.add(
          data.session_id
        );

        currentSession =
          data.session_id;

        return ok(
          data,
          data.session_id
        );
      }


      if (input.action === "stop") {

        const id =
          getOwnedSession(
            input.session
          );

        const data =
          await runJson(
            [
              "session",
              "stop",
              id,
            ],
            130000
          );

        ownedSessions.delete(id);

        if (
          currentSession === id
        ) {
          currentSession =
            [...ownedSessions].at(-1) ||
            null;
        }

        return ok(data, id);
      }


      const data =
        await runJson([
          "session",
          "list",
        ]);

      const all =
        Array.isArray(data)
          ? data
          : data.sessions || [];

      const sessions =
        all.filter((session) =>
          ownedSessions.has(
            session.session_id ||
            session.id
          )
        );

      return ok({
        current_session:
          currentSession,

        sessions,
      });

    } catch (error) {
      return fail(error);
    }
  }
);



/* =========================================================
   browser_page
   ========================================================= */

server.registerTool(
  "browser_page",
  {
    description:
      "Navigate, go back, go forward, reload, or wait for navigation.",

    inputSchema: z.object({
      action: z.enum([
        "navigate",
        "back",
        "forward",
        "reload",
        "wait",
      ]),

      session: z.string().optional(),

      url: z.string().optional(),

      tab_id: z
        .number()
        .int()
        .optional(),

      wait_until: z
        .enum([
          "load",
          "domcontentloaded",
          "networkidle",
          "commit",
        ])
        .optional(),

      timeout: z.string().optional(),

      hard: z.boolean().optional(),
    }),
  },

  async (input) => {
    try {

      const id =
        getOwnedSession(
          input.session
        );

      let args;


      if (
        input.action ===
        "navigate"
      ) {

        if (!input.url) {
          throw new Error(
            "url is required for navigate."
          );
        }

        args = [
          "navigate",
          input.url,
          "--session",
          id,
        ];

      } else if (
        input.action ===
        "back"
      ) {

        args = [
          "navigate-back",
          "--session",
          id,
        ];

      } else if (
        input.action ===
        "forward"
      ) {

        args = [
          "navigate-forward",
          "--session",
          id,
        ];

      } else if (
        input.action ===
        "reload"
      ) {

        args = [
          "reload",
          "--session",
          id,
        ];

      } else {

        args = [
          "wait-for-navigation",
          "--session",
          id,
        ];
      }


      addOpt(
        args,
        "--tab-id",
        input.tab_id
      );

      addOpt(
        args,
        "--wait-until",
        input.wait_until
      );

      addOpt(
        args,
        "--timeout",
        input.timeout
      );

      if (
        input.action ===
        "reload"
      ) {
        addFlag(
          args,
          "--hard",
          input.hard
        );
      }


      const data =
        await runJson(
          args,
          130000
        );

      return ok(
        data,
        id
      );

    } catch (error) {
      return fail(error);
    }
  }
);



/* =========================================================
   browser_inspect
   ========================================================= */

server.registerTool(
  "browser_inspect",
  {
    description:
      "Observe semantic page state, inspect ARIA snapshot or HTML, capture screenshots, console messages, or network activity.",

    inputSchema: z.object({
      action: z.enum([
        "observe",
        "snapshot",
        "html",
        "screenshot",
        "console",
        "network",
      ]),

      session: z.string().optional(),

      tab_id: z
        .number()
        .int()
        .optional(),

      cursor: z.string().optional(),

      ref: z.string().optional(),

      max_depth: z
        .number()
        .int()
        .positive()
        .optional(),

      max_tokens: z
        .number()
        .int()
        .positive()
        .optional(),

      max_bytes: z
        .number()
        .int()
        .positive()
        .optional(),

      full_page: z.boolean().optional(),

      scope: z
        .enum([
          "follow",
          "current",
        ])
        .optional(),

      timeout: z.string().optional(),

      since: z
        .number()
        .int()
        .nonnegative()
        .optional(),

      limit: z
        .number()
        .int()
        .positive()
        .optional(),

      max_text_chars: z
        .number()
        .int()
        .positive()
        .optional(),

      include_stack: z.boolean().optional(),

      probe_hover: z.boolean().optional(),

      debug_surfaces: z.boolean().optional(),
    }),
  },

  async (input) => {
    try {

      const id =
        getOwnedSession(
          input.session
        );

      const command =
        input.action === "html"
          ? "get-html"
          : input.action;

      const args = [
        command,
        "--session",
        id,
      ];

      addOpt(
        args,
        "--tab-id",
        input.tab_id
      );


      if (
        input.action ===
        "observe"
      ) {

        addOpt(
          args,
          "--cursor",
          input.cursor
        );

        addOpt(
          args,
          "--max-depth",
          input.max_depth
        );

        addOpt(
          args,
          "--max-tokens",
          input.max_tokens
        );

        addFlag(
          args,
          "--probe-hover",
          input.probe_hover
        );

        addFlag(
          args,
          "--debug-surfaces",
          input.debug_surfaces
        );

      } else if (
        input.action ===
        "snapshot"
      ) {

        addOpt(
          args,
          "--max-depth",
          input.max_depth
        );

        addOpt(
          args,
          "--max-tokens",
          input.max_tokens
        );

      } else if (
        input.action ===
        "html"
      ) {

        addOpt(
          args,
          "--ref",
          input.ref
        );

        addOpt(
          args,
          "--max-bytes",
          input.max_bytes
        );

      } else if (
        input.action ===
        "screenshot"
      ) {

        addOpt(
          args,
          "--ref",
          input.ref
        );

        addFlag(
          args,
          "--full-page",
          input.full_page
        );

        addOpt(
          args,
          "--scope",
          input.scope
        );

        addOpt(
          args,
          "--timeout",
          input.timeout
        );

      } else if (
        input.action === "console" ||
        input.action === "network"
      ) {

        addOpt(
          args,
          "--since",
          input.since
        );

        addOpt(
          args,
          "--limit",
          input.limit
        );

        addOpt(
          args,
          "--max-text-chars",
          input.max_text_chars
        );

        if (
          input.action ===
          "console"
        ) {

          addFlag(
            args,
            "--include-stack",
            input.include_stack
          );
        }
      }


      const data =
        await runJson(
          args,
          input.action ===
            "screenshot" &&
          input.full_page
            ? 300000
            : 130000
        );


      if (
        input.action ===
          "screenshot" &&
        data.path
      ) {

        const bytes =
          await readFile(
            data.path
          );

        try {
          await unlink(
            data.path
          );
        } catch {}


        return {
          content: [
            {
              type: "text",

              text:
                JSON.stringify(
                  {
                    session: id,
                    ...data,
                  },
                  null,
                  2
                ),
            },

            {
              type: "image",

              data:
                bytes.toString(
                  "base64"
                ),

              mimeType:
                "image/png",
            },
          ],
        };
      }


      return ok(
        data,
        id
      );

    } catch (error) {
      return fail(error);
    }
  }
);



/* =========================================================
   browser_interact
   ========================================================= */

server.registerTool(
  "browser_interact",
  {
    description:
      "Interact with controls using fresh @eN references from observe/snapshot or CSS selectors.",

    inputSchema: z.object({
      action: z.enum([
        "click",
        "hover",
        "wheel",
        "scroll-to",
        "focus",
        "blur",
        "fill",
        "select",
        "press",
      ]),

      session: z.string().optional(),

      tab_id: z
        .number()
        .int()
        .optional(),

      target: z.string().optional(),

      value: z.string().optional(),

      values: z
        .array(
          z.string()
        )
        .optional(),

      key: z.string().optional(),

      button: z
        .enum([
          "left",
          "middle",
          "right",
        ])
        .optional(),

      click_count: z
        .number()
        .int()
        .positive()
        .optional(),

      modifiers: z.string().optional(),

      timeout: z.string().optional(),

      settle: z.string().optional(),

      no_clear: z.boolean().optional(),

      delta_x: z.number().optional(),

      delta_y: z.number().optional(),

      hold_ms: z
        .number()
        .int()
        .nonnegative()
        .optional(),

      capture: z.string().optional(),

      image_x: z.number().optional(),

      image_y: z.number().optional(),
    }),
  },

  async (input) => {
    try {

      const id =
        getOwnedSession(
          input.session
        );

      const args = [
        input.action,
      ];

      const needsTarget = [
        "click",
        "hover",
        "scroll-to",
        "focus",
        "blur",
        "fill",
        "select",
      ].includes(
        input.action
      );


      if (
        needsTarget &&
        !input.target
      ) {
        throw new Error(
          `target is required for ${input.action}.`
        );
      }


      if (
        input.action ===
        "press"
      ) {

        if (!input.key) {
          throw new Error(
            "key is required for press."
          );
        }

        args.push(
          input.key
        );

      } else if (
        input.target
      ) {

        args.push(
          input.target
        );
      }


      args.push(
        "--session",
        id
      );

      addOpt(
        args,
        "--tab-id",
        input.tab_id
      );

      addOpt(
        args,
        "--timeout",
        input.timeout
      );

      addOpt(
        args,
        "--modifiers",
        input.modifiers
      );


      if (
        input.action ===
        "click"
      ) {

        addOpt(
          args,
          "--button",
          input.button
        );

        addOpt(
          args,
          "--click-count",
          input.click_count
        );

        addOpt(
          args,
          "--capture",
          input.capture
        );

        addOpt(
          args,
          "--image-x",
          input.image_x
        );

        addOpt(
          args,
          "--image-y",
          input.image_y
        );

      } else if (
        input.action ===
        "hover"
      ) {

        addOpt(
          args,
          "--settle",
          input.settle
        );

      } else if (
        input.action ===
        "fill"
      ) {

        if (
          input.value ===
          undefined
        ) {
          throw new Error(
            "value is required for fill."
          );
        }

        addOpt(
          args,
          "--value",
          input.value
        );

        addFlag(
          args,
          "--no-clear",
          input.no_clear
        );

      } else if (
        input.action ===
        "select"
      ) {

        if (
          !input.values?.length
        ) {
          throw new Error(
            "values is required for select."
          );
        }

        for (
          const value of
          input.values
        ) {
          addOpt(
            args,
            "--value",
            value
          );
        }

      } else if (
        input.action ===
        "press"
      ) {

        if (
          input.target
        ) {

          if (
            /^@?e\d+$/.test(
              input.target
            )
          ) {
            addOpt(
              args,
              "--ref",
              input.target
            );
          } else {
            addOpt(
              args,
              "--selector",
              input.target
            );
          }
        }

        addOpt(
          args,
          "--hold-ms",
          input.hold_ms
        );

      } else if (
        input.action ===
        "wheel"
      ) {

        if (
          !input.delta_x &&
          !input.delta_y
        ) {
          throw new Error(
            "wheel requires non-zero delta_x or delta_y."
          );
        }

        addOpt(
          args,
          "--delta-x",
          input.delta_x ?? 0
        );

        addOpt(
          args,
          "--delta-y",
          input.delta_y ?? 0
        );
      }


      const data =
        await runJson(
          args,
          130000
        );

      return ok(
        data,
        id
      );

    } catch (error) {
      return fail(error);
    }
  }
);



/* =========================================================
   browser_tabs
   ========================================================= */

server.registerTool(
  "browser_tabs",
  {
    description:
      "List, create, select, or close Agent Window tabs; borrow or return existing user tabs.",

    inputSchema: z.object({
      action: z.enum([
        "list",
        "create",
        "select",
        "close",
        "borrow",
        "return",
      ]),

      session: z.string().optional(),

      tab_id: z
        .number()
        .int()
        .optional(),

      scope: z
        .enum([
          "user",
          "agent",
          "all",
        ])
        .optional(),

      url: z.string().optional(),

      no_active: z.boolean().optional(),

      index: z
        .number()
        .int()
        .optional(),

      timeout: z.string().optional(),
    }),
  },

  async (input) => {
    try {

      const id =
        getOwnedSession(
          input.session
        );

      const args = [
        "tab",
        input.action,
      ];


      if (
        [
          "select",
          "close",
          "borrow",
          "return",
        ].includes(
          input.action
        )
      ) {

        if (
          input.tab_id ===
          undefined
        ) {
          throw new Error(
            `tab_id is required for ${input.action}.`
          );
        }

        args.push(
          String(
            input.tab_id
          )
        );
      }


      args.push(
        "--session",
        id
      );


      if (
        input.action ===
        "list"
      ) {

        addOpt(
          args,
          "--scope",
          input.scope || "all"
        );
      }


      if (
        input.action ===
        "create"
      ) {

        addOpt(
          args,
          "--url",
          input.url
        );

        addFlag(
          args,
          "--no-active",
          input.no_active
        );

        addOpt(
          args,
          "--index",
          input.index
        );
      }


      if (
        input.action ===
        "borrow"
      ) {

        addOpt(
          args,
          "--timeout",
          input.timeout
        );
      }


      const data =
        await runJson(
          args,
          input.action ===
            "borrow"
            ? 180000
            : 130000
        );

      return ok(
        data,
        id
      );

    } catch (error) {
      return fail(error);
    }
  }
);



/* =========================================================
   browser_assist
   ========================================================= */

server.registerTool(
  "browser_assist",
  {
    description:
      "Resize the Agent Window, emulate a device, or ask the human to complete a CAPTCHA/login/confirmation step.",

    inputSchema: z.object({
      action: z.enum([
        "resize",
        "emulate",
        "request-help",
      ]),

      session: z.string().optional(),

      tab_id: z
        .number()
        .int()
        .optional(),

      width: z
        .number()
        .int()
        .positive()
        .optional(),

      height: z
        .number()
        .int()
        .positive()
        .optional(),

      device: z.string().optional(),

      dpr: z
        .number()
        .positive()
        .optional(),

      mobile: z.boolean().optional(),

      no_mobile: z.boolean().optional(),

      ua: z.string().optional(),

      accept_language:
        z.string().optional(),

      touch: z.boolean().optional(),

      no_touch: z.boolean().optional(),

      max_touch_points: z
        .number()
        .int()
        .positive()
        .optional(),

      off: z.boolean().optional(),

      prompt: z.string().optional(),

      title: z.string().optional(),

      targets: z
        .array(
          z.string()
        )
        .optional(),

      timeout: z.string().optional(),

      completion_criteria:
        z.string().optional(),
    }),
  },

  async (input) => {
    try {

      const id =
        getOwnedSession(
          input.session
        );

      let args;


      if (
        input.action ===
        "resize"
      ) {

        if (
          !input.width ||
          !input.height
        ) {
          throw new Error(
            "width and height are required for resize."
          );
        }

        args = [
          "window",
          "resize",
          "--session",
          id,
          "--width",
          String(
            input.width
          ),
          "--height",
          String(
            input.height
          ),
        ];

      } else if (
        input.action ===
        "emulate"
      ) {

        args = [
          "emulate",
          "--session",
          id,
        ];

        addOpt(
          args,
          "--tab-id",
          input.tab_id
        );

        addFlag(
          args,
          "--off",
          input.off
        );

        addOpt(
          args,
          "--device",
          input.device
        );

        addOpt(
          args,
          "--width",
          input.width
        );

        addOpt(
          args,
          "--height",
          input.height
        );

        addOpt(
          args,
          "--dpr",
          input.dpr
        );

        addFlag(
          args,
          "--mobile",
          input.mobile
        );

        addFlag(
          args,
          "--no-mobile",
          input.no_mobile
        );

        addOpt(
          args,
          "--ua",
          input.ua
        );

        addOpt(
          args,
          "--accept-language",
          input.accept_language
        );

        addFlag(
          args,
          "--touch",
          input.touch
        );

        addFlag(
          args,
          "--no-touch",
          input.no_touch
        );

        addOpt(
          args,
          "--max-touch-points",
          input.max_touch_points
        );

      } else {

        if (!input.prompt) {
          throw new Error(
            "prompt is required for request-help."
          );
        }

        args = [
          "request-help",
          "--session",
          id,
          "--prompt",
          input.prompt,
        ];

        addOpt(
          args,
          "--tab-id",
          input.tab_id
        );

        addOpt(
          args,
          "--title",
          input.title
        );

        for (
          const target of
          input.targets || []
        ) {
          addOpt(
            args,
            "--target",
            target
          );
        }

        addOpt(
          args,
          "--timeout",
          input.timeout
        );

        addOpt(
          args,
          "--completion-criteria",
          input.completion_criteria
        );
      }


      const data =
        await runJson(
          args,
          input.action ===
            "request-help"
            ? 330000
            : 130000
        );

      return ok(
        data,
        id
      );

    } catch (error) {
      return fail(error);
    }
  }
);


await serveStdio(
  () => server
);

