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
    version: "0.3.0",
  },
  {
    instructions:
      "Use BrowserSkill to operate the user's real Chrome or Edge browser. " +
      "Only BrowserSkill sessions created by this MCP server may be controlled. " +
      "For normal website and web-app tasks prefer the high-level browser_acquire -> browser_act -> browser_release workflow. " +
      "browser_acquire automatically checks existing user tabs first, borrows a suitable existing tab when available, and otherwise may open the supplied fallback URL. " +
      "Do not require the user to mention borrow, return, session ids, tab ids, scope, or BrowserSkill mechanics. Infer the workflow automatically. " +
      "Use browser_act for explicit browser operations such as observing, clicking, filling, pressing keys, navigation, tabs, files, downloads, emulation, or request-help. " +
      "Use only actions required by the user's request; read-only requests must not send, submit, delete, change settings, or otherwise modify user data. " +
      "Always call browser_release when a high-level workflow is finished so borrowed tabs are returned and the BrowserSkill session is stopped. " +
      "The original low-level tools remain available as a fallback when the high-level workflow is insufficient. " +
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
      "Start, stop, or list BrowserSkill Agent Window sessions owned by this MCP server. After starting a session for a website task, prefer inspecting existing user tabs before opening a new page.",

    inputSchema: z.object({
      action: z.enum([
        "start",
        "stop",
        "list",
      ]),

      session: z.string().optional(),
      name: z.string().optional(),
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

        return ok(data, id);      }


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
      "Navigate, go back, go forward, reload, or wait for navigation. Before navigating a new page for a website/app task, normally check existing user tabs through browser_tabs and borrow a suitable one if present.",

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
      "List, create, select, or close Agent Window tabs; borrow or return existing user tabs. For normal website/app tasks, first list scope=user and prefer borrowing a suitable existing user tab; return borrowed tabs when finished.",

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


      if (        input.action ===
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



// -----------------------------------------------------------------------------
// BrowserSkill file transfer
// -----------------------------------------------------------------------------

const BSK_TRANSFER_DIR =
  process.env.BSK_TRANSFER_DIR ||
  path.join(
    os.homedir(),
    "BrowserSkill-Transfer"
  );

const {
  mkdir: mkdirTransferDir
} =
  await import("node:fs/promises");

await mkdirTransferDir(
  BSK_TRANSFER_DIR,
  { recursive: true }
);


function resolveOwnedSessionForFiles(
  requestedSession
) {

  const id =
    requestedSession ||
    currentSession;

  if (!id) {
    throw new Error(
      "No BrowserSkill session is active. Start one with browser_session first."
    );
  }

  if (!ownedSessions.has(id)) {
    throw new Error(
      `Session ${id} is not owned by this MCP process.`
    );
  }

  return id;
}


function safeTransferFile(
  name
) {

  if (
    typeof name !== "string" ||
    !name.trim()
  ) {
    throw new Error(
      "A file name is required."
    );
  }

  const clean =
    name.trim();

  if (
    clean === "." ||
    clean === ".." ||
    path.basename(clean) !== clean ||
    /[<>:"/\\|?*\x00-\x1F]/.test(clean) ||
    clean.endsWith(".") ||
    clean.endsWith(" ")
  ) {
    throw new Error(
      `Only a simple file name inside ${BSK_TRANSFER_DIR} is allowed: ${clean}`
    );
  }

  return path.join(
    BSK_TRANSFER_DIR,
    clean
  );
}


function validateFileTarget(
  input
) {

  const supplied = [
    input.target,
    input.ref,
    input.selector,
  ].filter(
    (value) =>
      value !== undefined &&
      value !== null &&
      value !== ""
  );

  if (supplied.length > 1) {
    throw new Error(
      "Use only one targeting method: target, ref, or selector."
    );
  }
}


server.registerTool(
  "browser_files",
  {
    description:
      "Upload files to a web page or capture a browser download. File access is restricted to BrowserSkill-Transfer. Actions: upload, drop-upload, download.",

    inputSchema:
      z.object({

        action:
          z.enum([
            "upload",
            "drop-upload",
            "download",
          ]),

        session:
          z.string().optional(),

        tab_id:
          z.number()
            .int()
            .optional(),

        target:
          z.string()
            .optional()
            .describe(
              "Snapshot ref such as @e3 or CSS selector."
            ),

        ref:
          z.string()
            .optional(),

        selector:
          z.string()
            .optional(),

        files:
          z.array(
            z.string()
          )
            .min(1)
            .optional()
            .describe(
              "File names inside BrowserSkill-Transfer. Paths are forbidden."
            ),

        out:
          z.string()
            .optional()
            .describe(
              "Destination file name inside BrowserSkill-Transfer."
            ),

        timeout:
          z.string()
            .optional(),

        overwrite:
          z.boolean()
            .optional(),
      }),
  },

  async (input) => {

    try {

      const id =
        resolveOwnedSessionForFiles(
          input.session
        );

      validateFileTarget(input);

      if (
        input.action === "upload" ||
        input.action === "drop-upload"
      ) {

        if (
          !input.files ||
          input.files.length === 0
        ) {
          throw new Error(
            "files is required for upload."
          );
        }


        const args = [
          "upload",
          "--session",
          id,
          "--mode",
          input.action === "drop-upload"
            ? "drop"
            : "input",
        ];


        if (
          input.tab_id !== undefined
        ) {
          args.push(
            "--tab-id",
            String(input.tab_id)
          );
        }


        for (
          const fileName of input.files
        ) {

          args.push(
            "--file",
            safeTransferFile(
              fileName
            )
          );
        }


        if (input.ref) {
          args.push(
            "--ref",
            input.ref
          );

        } else if (input.selector) {
          args.push(
            "--selector",
            input.selector
          );
        }


        if (input.timeout) {
          args.push(
            "--timeout",
            input.timeout
          );
        }


        if (input.target) {
          args.push(
            input.target
          );
        }


        const data =
          await runJson(
            args,
            330000
          );


        return ok(
          {
            action:
              input.action,

            transfer_dir:
              BSK_TRANSFER_DIR,

            files:
              input.files,

            result:
              data,
          },
          id
        );
      }


      if (
        input.action === "download"
      ) {

        if (!input.out) {
          throw new Error(
            "out is required for download."
          );
        }


        const outputPath =
          safeTransferFile(
            input.out
          );


        const args = [
          "download",
          "--session",
          id,
          "--out",
          outputPath,
        ];


        if (
          input.tab_id !== undefined
        ) {
          args.push(
            "--tab-id",
            String(input.tab_id)
          );
        }


        if (input.ref) {
          args.push(
            "--ref",
            input.ref
          );

        } else if (input.selector) {
          args.push(
            "--selector",
            input.selector
          );
        }


        if (input.timeout) {
          args.push(
            "--timeout",
            input.timeout
          );
        }


        if (input.overwrite) {
          args.push(
            "--overwrite"
          );
        }


        if (input.target) {
          args.push(
            input.target
          );
        }


        const data =
          await runJson(
            args,
            330000
          );


        return ok(
          {
            action:
              "download",

            transfer_dir:
              BSK_TRANSFER_DIR,

            downloaded_to:
              outputPath,

            result:
              data,
          },
          id
        );
      }


      throw new Error(
        `Unsupported browser_files action: ${input.action}`
      );

    } catch (error) {
      return fail(error);
    }
  }
);


/* =========================================================
   High-level browser workflow
   acquire -> act -> release
   ========================================================= */

const browserWorkflows = new Map();
let currentWorkflow = null;
let workflowSequence = 0;


function nextWorkflowId() {
  workflowSequence += 1;

  return [
    "wf",
    Date.now().toString(36),
    workflowSequence.toString(36),
  ].join("-");
}


function getBrowserWorkflow(requested) {
  const id =
    requested ||
    currentWorkflow;

  if (!id) {
    throw new Error(
      "No active browser workflow. Start one with browser_acquire."
    );
  }

  const state =
    browserWorkflows.get(id);

  if (!state) {
    throw new Error(
      "Browser workflow " +
      id +
      " is not active in this MCP process."
    );
  }

  currentWorkflow = id;

  return state;
}


function tabMatchScore(
  tab,
  target,
  fallbackUrl
) {
  const title =
    String(tab.title || "")
      .toLowerCase();

  const url =
    String(tab.url || "")
      .toLowerCase();

  const needle =
    String(
      target ||
      fallbackUrl ||
      ""
    )
      .trim()
      .toLowerCase();

  let score = 0;

  if (tab.active) {
    score += 2;
  }

  if (!needle) {
    return score + 1;
  }

  if (title === needle) {
    score += 100;
  } else if (
    title.includes(needle)
  ) {
    score += 60;
  }

  if (url === needle) {
    score += 100;
  } else if (
    url.includes(needle)
  ) {
    score += 50;
  }

  try {
    const candidateUrl =
      new URL(
        fallbackUrl ||
        target
      );

    const host =
      candidateUrl.hostname
        .toLowerCase();

    if (
      host &&
      url.includes(host)
    ) {
      score += 80;
    }
  } catch {}

  const words =
    needle
      .split(/\s+/)
      .filter(
        (word) =>
          word.length >= 3
      );

  for (
    const word of
    words
  ) {
    if (title.includes(word)) {
      score += 8;
    }

    if (url.includes(word)) {
      score += 6;
    }
  }

  return score;
}


function chooseUserTab(
  tabs,
  input
) {
  if (
    input.tab_id !== undefined
  ) {
    return (
      tabs.find(
        (tab) =>
          tab.tab_id ===
          input.tab_id
      ) ||
      null
    );
  }

  if (
    !input.target &&
    !input.url
  ) {
    return (
      tabs.find(
        (tab) => tab.active
      ) ||
      tabs[0] ||
      null
    );
  }

  const ranked =
    tabs
      .map(
        (tab) => ({
          tab,
          score:
            tabMatchScore(
              tab,
              input.target,
              input.url
            ),
        })
      )
      .sort(
        (a, b) =>
          b.score - a.score
      );

  if (
    !ranked.length ||
    ranked[0].score <= 2
  ) {
    return null;
  }

  return ranked[0].tab;
}


async function startWorkflowSession(
  name,
  noFocus
) {
  const status =
    await ensureBskDaemon();

  const browsers =
    Array.isArray(
      status?.browsers
    )
      ? status.browsers
      : [];

  if (browsers.length === 0) {
    throw new Error(
      "BrowserSkill has no connected browser."
    );
  }

  if (browsers.length > 1) {
    throw new Error(
      "BrowserSkill high-level workflow requires exactly one connected browser; found " +
      browsers.length +
      "."
    );
  }

  const browser =
    browsers[0];

  const args = [
    "session",
    "start",
    "--browser",
    browser.instance_id,
  ];

  addOpt(
    args,
    "--name",
    name ||
      "Browser workflow"
  );

  addFlag(
    args,
    "--no-focus",
    noFocus
  );

  const data =
    await runJson(
      args,
      130000
    );

  if (!data.session_id) {
    throw new Error(
      "bsk did not return session_id for browser workflow: " +
      JSON.stringify(data)
    );
  }

  ownedSessions.add(
    data.session_id
  );

  currentSession =
    data.session_id;

  return data;
}


async function stopWorkflowSession(
  sessionId
) {
  let result = null;
  let error = null;

  try {
    result =
      await runJson(
        [
          "session",
          "stop",
          sessionId,
        ],
        130000
      );
  } catch (caught) {
    error =
      caught instanceof Error
        ? caught.message
        : String(caught);
  }

  ownedSessions.delete(
    sessionId
  );

  if (
    currentSession ===
    sessionId
  ) {
    currentSession =
      [...ownedSessions]
        .at(-1) ||
      null;
  }

  return {
    result,
    error,
  };
}


async function releaseWorkflowState(
  state
) {
  const returned = [];
  const returnFailures = [];

  for (
    const tabId of
    [...state.borrowed_tab_ids]
      .reverse()
  ) {
    try {
      const result =
        await runJson(
          [
            "tab",
            "return",
            String(tabId),
            "--session",
            state.session_id,
          ],
          130000
        );

      returned.push({
        tab_id: tabId,
        result,
      });

      state.borrowed_tab_ids
        .delete(tabId);

    } catch (caught) {
      returnFailures.push({
        tab_id: tabId,
        error:
          caught instanceof Error
            ? caught.message
            : String(caught),
      });
    }
  }

  const stopped =
    await stopWorkflowSession(
      state.session_id
    );

  browserWorkflows.delete(
    state.workflow_id
  );

  if (
    currentWorkflow ===
    state.workflow_id
  ) {
    currentWorkflow =
      [...browserWorkflows.keys()]
        .at(-1) ||
      null;
  }

  return {
    workflow_id:
      state.workflow_id,

    returned,
    return_failures:
      returnFailures,

    session_stop:
      stopped,
  };
}


const workflowStepSchema =
  z.object({

    action:
      z.enum([
        "observe",
        "snapshot",
        "html",
        "screenshot",
        "console",
        "network",

        "navigate",
        "back",
        "forward",
        "reload",
        "wait",

        "click",
        "hover",
        "wheel",
        "scroll-to",
        "focus",
        "blur",
        "fill",
        "select",
        "press",

        "tab-list",
        "tab-create",
        "tab-select",
        "tab-close",
        "tab-borrow",
        "tab-return",

        "resize",
        "emulate",
        "request-help",

        "upload",
        "drop-upload",
        "download",
      ]),

    tab_id:
      z.number()
        .int()
        .optional(),

    target:
      z.string()
        .optional(),

    value:
      z.string()
        .optional(),

    values:
      z.array(
        z.string()
      )
        .optional(),

    key:
      z.string()
        .optional(),

    url:
      z.string()
        .optional(),

    wait_until:
      z.enum([
        "load",
        "domcontentloaded",
        "networkidle",
        "commit",
      ])
        .optional(),

    timeout:
      z.string()
        .optional(),

    hard:
      z.boolean()
        .optional(),

    button:
      z.enum([
        "left",
        "middle",
        "right",
      ])
        .optional(),

    click_count:
      z.number()
        .int()
        .positive()
        .optional(),

    modifiers:
      z.string()
        .optional(),

    settle:
      z.string()
        .optional(),

    no_clear:
      z.boolean()
        .optional(),

    delta_x:
      z.number()
        .optional(),

    delta_y:
      z.number()
        .optional(),

    hold_ms:
      z.number()
        .int()
        .nonnegative()
        .optional(),

    capture:
      z.string()
        .optional(),

    image_x:
      z.number()
        .optional(),

    image_y:
      z.number()
        .optional(),

    cursor:
      z.string()
        .optional(),

    ref:
      z.string()
        .optional(),

    selector:
      z.string()
        .optional(),

    max_depth:
      z.number()
        .int()
        .positive()
        .optional(),

    max_tokens:
      z.number()
        .int()
        .positive()
        .optional(),

    max_bytes:
      z.number()
        .int()
        .positive()
        .optional(),

    full_page:
      z.boolean()
        .optional(),

    scope:
      z.string()
        .optional(),

    since:
      z.number()
        .int()
        .nonnegative()
        .optional(),

    limit:
      z.number()
        .int()
        .positive()
        .optional(),

    max_text_chars:
      z.number()
        .int()
        .positive()
        .optional(),

    include_stack:
      z.boolean()
        .optional(),

    probe_hover:
      z.boolean()
        .optional(),

    debug_surfaces:
      z.boolean()
        .optional(),

    no_active:
      z.boolean()
        .optional(),

    index:
      z.number()
        .int()
        .optional(),

    width:
      z.number()
        .int()
        .positive()
        .optional(),

    height:
      z.number()
        .int()
        .positive()
        .optional(),

    device:
      z.string()
        .optional(),

    dpr:
      z.number()
        .positive()
        .optional(),

    mobile:
      z.boolean()
        .optional(),

    no_mobile:
      z.boolean()
        .optional(),

    ua:
      z.string()
        .optional(),

    accept_language:
      z.string()
        .optional(),

    touch:
      z.boolean()
        .optional(),

    no_touch:
      z.boolean()
        .optional(),

    max_touch_points:
      z.number()
        .int()
        .positive()
        .optional(),

    off:
      z.boolean()
        .optional(),

    prompt:
      z.string()
        .optional(),

    title:
      z.string()
        .optional(),

    targets:
      z.array(
        z.string()
      )
        .optional(),

    completion_criteria:
      z.string()
        .optional(),

    files:
      z.array(
        z.string()
      )
        .min(1)
        .optional(),

    out:
      z.string()
        .optional(),

    overwrite:
      z.boolean()
        .optional(),
  });


async function executeWorkflowStep(
  state,
  step
) {
  const tabId =
    step.tab_id !==
      undefined
      ? step.tab_id
      : state.tab_id;

  let args = null;
  let timeoutMs = 130000;


  if (
    [
      "observe",
      "snapshot",
      "html",
      "screenshot",
      "console",
      "network",
    ].includes(
      step.action
    )
  ) {
    const command =
      step.action === "html"
        ? "get-html"
        : step.action;

    args = [
      command,
      "--session",
      state.session_id,
    ];

    addOpt(
      args,
      "--tab-id",
      tabId
    );

    if (
      step.action ===
      "observe"
    ) {
      addOpt(
        args,
        "--cursor",
        step.cursor
      );

      addOpt(
        args,
        "--max-depth",
        step.max_depth
      );

      addOpt(
        args,
        "--max-tokens",
        step.max_tokens
      );

      addFlag(
        args,
        "--probe-hover",
        step.probe_hover
      );

      addFlag(
        args,
        "--debug-surfaces",
        step.debug_surfaces
      );

    } else if (
      step.action ===
      "snapshot"
    ) {
      addOpt(
        args,
        "--max-depth",
        step.max_depth
      );

      addOpt(
        args,
        "--max-tokens",
        step.max_tokens
      );

    } else if (
      step.action ===
      "html"
    ) {
      addOpt(
        args,
        "--ref",
        step.ref
      );

      addOpt(
        args,
        "--max-bytes",
        step.max_bytes
      );

    } else if (
      step.action ===
      "screenshot"
    ) {
      addOpt(
        args,
        "--ref",
        step.ref
      );

      addFlag(
        args,
        "--full-page",
        step.full_page
      );

      addOpt(
        args,
        "--scope",
        step.scope
      );

      addOpt(
        args,
        "--timeout",
        step.timeout
      );

      if (step.full_page) {
        timeoutMs = 300000;
      }

    } else {
      addOpt(
        args,
        "--since",
        step.since
      );

      addOpt(
        args,
        "--limit",
        step.limit
      );

      addOpt(
        args,
        "--max-text-chars",
        step.max_text_chars
      );

      if (
        step.action ===
        "console"
      ) {
        addFlag(
          args,
          "--include-stack",
          step.include_stack
        );
      }
    }

  } else if (
    [
      "navigate",
      "back",
      "forward",
      "reload",
      "wait",
    ].includes(
      step.action
    )
  ) {
    if (
      step.action ===
      "navigate"
    ) {
      if (!step.url) {
        throw new Error(
          "url is required for navigate."
        );
      }

      args = [
        "navigate",
        step.url,
        "--session",
        state.session_id,
      ];

    } else if (
      step.action === "back"
    ) {
      args = [
        "navigate-back",
        "--session",
        state.session_id,
      ];

    } else if (
      step.action ===
      "forward"
    ) {
      args = [
        "navigate-forward",
        "--session",
        state.session_id,
      ];

    } else if (
      step.action ===
      "reload"
    ) {
      args = [
        "reload",
        "--session",
        state.session_id,
      ];

      addFlag(
        args,
        "--hard",
        step.hard
      );

    } else {
      args = [
        "wait-for-navigation",
        "--session",
        state.session_id,
      ];
    }

    addOpt(
      args,
      "--tab-id",
      tabId
    );

    addOpt(
      args,
      "--wait-until",
      step.wait_until
    );

    addOpt(
      args,
      "--timeout",
      step.timeout
    );

  } else if (
    [
      "click",
      "hover",
      "wheel",
      "scroll-to",
      "focus",
      "blur",
      "fill",
      "select",
      "press",
    ].includes(
      step.action
    )
  ) {
    args = [
      step.action,
    ];

    const needsTarget =
      [
        "click",
        "hover",
        "scroll-to",
        "focus",
        "blur",
        "fill",
        "select",
      ].includes(
        step.action
      );

    if (
      needsTarget &&
      !step.target
    ) {
      throw new Error(
        "target is required for " +
        step.action +
        "."
      );
    }

    if (
      step.action === "press"
    ) {
      if (!step.key) {
        throw new Error(
          "key is required for press."
        );
      }

      args.push(
        step.key
      );

    } else if (
      step.target
    ) {
      args.push(
        step.target
      );
    }

    args.push(
      "--session",
      state.session_id
    );

    addOpt(
      args,
      "--tab-id",
      tabId
    );

    addOpt(
      args,
      "--timeout",
      step.timeout
    );

    addOpt(
      args,
      "--modifiers",
      step.modifiers
    );

    if (
      step.action === "click"
    ) {
      addOpt(
        args,
        "--button",
        step.button
      );

      addOpt(
        args,
        "--click-count",
        step.click_count
      );

      addOpt(
        args,
        "--capture",
        step.capture
      );

      addOpt(
        args,
        "--image-x",
        step.image_x
      );

      addOpt(
        args,
        "--image-y",
        step.image_y
      );

    } else if (
      step.action === "hover"
    ) {
      addOpt(
        args,
        "--settle",
        step.settle
      );

    } else if (
      step.action === "fill"
    ) {
      if (
        step.value ===
        undefined
      ) {
        throw new Error(
          "value is required for fill."
        );
      }

      addOpt(
        args,
        "--value",
        step.value
      );

      addFlag(
        args,
        "--no-clear",
        step.no_clear
      );

    } else if (
      step.action === "select"
    ) {
      if (
        !step.values?.length
      ) {
        throw new Error(
          "values is required for select."
        );
      }

      for (
        const value of
        step.values
      ) {
        addOpt(
          args,
          "--value",
          value
        );
      }

    } else if (
      step.action === "press"
    ) {
      if (step.target) {
        if (
          /^@?e\d+$/.test(
            step.target
          )
        ) {
          addOpt(
            args,
            "--ref",
            step.target
          );
        } else {
          addOpt(
            args,
            "--selector",
            step.target
          );
        }
      }

      addOpt(
        args,
        "--hold-ms",
        step.hold_ms
      );

    } else if (
      step.action === "wheel"
    ) {
      if (
        !step.delta_x &&
        !step.delta_y
      ) {
        throw new Error(
          "wheel requires non-zero delta_x or delta_y."
        );
      }

      addOpt(
        args,
        "--delta-x",
        step.delta_x ?? 0
      );

      addOpt(
        args,
        "--delta-y",
        step.delta_y ?? 0
      );
    }

  } else if (
    step.action.startsWith(
      "tab-"
    )
  ) {
    const tabAction =
      step.action.slice(4);

    args = [
      "tab",
      tabAction,
    ];

    if (
      [
        "select",
        "close",
        "borrow",
        "return",
      ].includes(
        tabAction
      )
    ) {
      if (
        step.tab_id ===
        undefined
      ) {
        throw new Error(
          "tab_id is required for " +
          step.action +
          "."
        );
      }

      args.push(
        String(
          step.tab_id
        )
      );
    }

    args.push(
      "--session",
      state.session_id
    );

    if (
      tabAction === "list"
    ) {
      addOpt(
        args,
        "--scope",
        step.scope ||
          "all"
      );
    }

    if (
      tabAction === "create"
    ) {
      addOpt(
        args,
        "--url",
        step.url
      );

      addFlag(
        args,
        "--no-active",
        step.no_active
      );

      addOpt(
        args,
        "--index",
        step.index
      );
    }

    if (
      tabAction === "borrow"
    ) {
      addOpt(
        args,
        "--timeout",
        step.timeout
      );

      timeoutMs = 180000;
    }

  } else if (
    step.action === "resize"
  ) {
    if (
      !step.width ||
      !step.height
    ) {
      throw new Error(
        "width and height are required for resize."
      );
    }

    args = [
      "window",
      "resize",
      "--session",
      state.session_id,
      "--width",
      String(step.width),
      "--height",
      String(step.height),
    ];

  } else if (
    step.action === "emulate"
  ) {
    args = [
      "emulate",
      "--session",
      state.session_id,
    ];

    addOpt(
      args,
      "--tab-id",
      tabId
    );

    addFlag(
      args,
      "--off",
      step.off
    );

    addOpt(
      args,
      "--device",
      step.device
    );

    addOpt(
      args,
      "--width",
      step.width
    );

    addOpt(
      args,
      "--height",
      step.height
    );

    addOpt(
      args,
      "--dpr",
      step.dpr
    );

    addFlag(
      args,
      "--mobile",
      step.mobile
    );

    addFlag(
      args,
      "--no-mobile",
      step.no_mobile
    );

    addOpt(
      args,
      "--ua",
      step.ua
    );

    addOpt(
      args,
      "--accept-language",
      step.accept_language
    );

    addFlag(
      args,
      "--touch",
      step.touch
    );

    addFlag(
      args,
      "--no-touch",
      step.no_touch
    );

    addOpt(
      args,
      "--max-touch-points",
      step.max_touch_points
    );

  } else if (
    step.action ===
    "request-help"
  ) {
    if (!step.prompt) {
      throw new Error(
        "prompt is required for request-help."
      );
    }

    args = [
      "request-help",
      "--session",
      state.session_id,
      "--prompt",
      step.prompt,
    ];

    addOpt(
      args,
      "--tab-id",
      tabId
    );

    addOpt(
      args,
      "--title",
      step.title
    );

    for (
      const target of
      step.targets || []
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
      step.timeout
    );

    addOpt(
      args,
      "--completion-criteria",
      step.completion_criteria
    );

    timeoutMs = 330000;

  } else if (
    [
      "upload",
      "drop-upload",
      "download",
    ].includes(
      step.action
    )
  ) {
    const fileTargetInput = {
      target: step.target,
      ref: step.ref,
      selector: step.selector,
    };

    validateFileTarget(
      fileTargetInput
    );

    if (
      step.action === "upload" ||
      step.action ===
        "drop-upload"
    ) {
      if (
        !step.files ||
        step.files.length === 0
      ) {
        throw new Error(
          "files is required for upload."
        );
      }

      args = [
        "upload",
        "--session",
        state.session_id,
        "--mode",
        step.action ===
          "drop-upload"
          ? "drop"
          : "input",
      ];

      addOpt(
        args,
        "--tab-id",
        tabId
      );

      for (
        const fileName of
        step.files
      ) {
        args.push(
          "--file",
          safeTransferFile(
            fileName
          )
        );
      }

    } else {
      if (!step.out) {
        throw new Error(
          "out is required for download."
        );
      }

      args = [
        "download",
        "--session",
        state.session_id,
        "--out",
        safeTransferFile(
          step.out
        ),
      ];

      addOpt(
        args,
        "--tab-id",
        tabId
      );

      addFlag(
        args,
        "--overwrite",
        step.overwrite
      );
    }

    if (step.ref) {
      args.push(
        "--ref",
        step.ref
      );

    } else if (
      step.selector
    ) {
      args.push(
        "--selector",
        step.selector
      );
    }

    addOpt(
      args,
      "--timeout",
      step.timeout
    );

    if (step.target) {
      args.push(
        step.target
      );
    }

    timeoutMs = 330000;

  } else {
    throw new Error(
      "Unsupported workflow action: " +
      step.action
    );
  }


  const result =
    await runJson(
      args,
      timeoutMs
    );


  if (
    step.action ===
      "tab-borrow"
  ) {
    state.borrowed_tab_ids
      .add(step.tab_id);

    state.tab_id =
      step.tab_id;
  }

  if (
    step.action ===
      "tab-return"
  ) {
    state.borrowed_tab_ids
      .delete(step.tab_id);

    if (
      state.tab_id ===
      step.tab_id
    ) {
      state.tab_id = null;
    }
  }

  if (
    step.action ===
      "tab-select"
  ) {
    state.tab_id =
      step.tab_id;
  }

  if (
    step.action ===
      "tab-close" &&
    state.tab_id ===
      step.tab_id
  ) {
    state.tab_id = null;
  }

  if (
    step.action ===
      "tab-create" &&
    result?.tab_id &&
    !step.no_active
  ) {
    state.tab_id =
      result.tab_id;
  }

  if (
    step.action ===
      "navigate" &&
    result?.tab_id
  ) {
    state.tab_id =
      result.tab_id;
  }


  let image = null;

  if (
    step.action ===
      "screenshot" &&
    result?.path
  ) {
    const bytes =
      await readFile(
        result.path
      );

    try {
      await unlink(
        result.path
      );
    } catch {}

    image = {
      mimeType:
        "image/png",
      data:
        bytes.toString(
          "base64"
        ),
    };
  }


  return {
    action:
      step.action,

    tab_id:
      state.tab_id,

    result,
    image,
  };
}


server.registerTool(
  "browser_acquire",
  {
    description:
      "Start a high-level BrowserSkill workflow. It checks existing user tabs first, borrows a suitable existing tab when possible, otherwise opens the supplied fallback URL, and returns an initial observation. Prefer this over manual browser_session + browser_tabs for normal tasks.",

    inputSchema:
      z.object({

        target:
          z.string()
            .optional()
            .describe(
              "Human-readable site/app/tab hint such as Telegram, Gmail, Example Domain, or part of a title/URL."
            ),

        url:
          z.string()
            .optional()
            .describe(
              "Fallback URL to open only when no suitable existing user tab is found."
            ),

        tab_id:
          z.number()
            .int()
            .optional()
            .describe(
              "Optional exact existing user tab id."
            ),

        existing_only:
          z.boolean()
            .optional()
            .describe(
              "When true, fail instead of opening url if a suitable existing user tab is not found."
            ),

        observe:
          z.boolean()
            .optional()
            .describe(
              "Initial semantic observation; defaults to true."
            ),

        name:
          z.string()
            .optional(),

        no_focus:
          z.boolean()
            .optional(),
      }),
  },

  async (input) => {
    let state = null;

    try {
      const started =
        await startWorkflowSession(
          input.name,
          input.no_focus
        );

      const workflowId =
        nextWorkflowId();

      state = {
        workflow_id:
          workflowId,

        session_id:
          started.session_id,

        browser_instance_id:
          started.browser_instance_id,

        tab_id:
          null,

        borrowed_tab_ids:
          new Set(),

        source:
          null,

        matched_tab:
          null,
      };


      const listed =
        await runJson(
          [
            "tab",
            "list",
            "--session",
            state.session_id,
            "--scope",
            "user",
          ],
          130000
        );

      const userTabs =
        Array.isArray(
          listed
        )
          ? listed
          : listed.tabs || [];

      const matched =
        chooseUserTab(
          userTabs,
          input
        );


      if (matched) {
        const borrowed =
          await runJson(
            [
              "tab",
              "borrow",
              String(
                matched.tab_id
              ),
              "--session",
              state.session_id,
            ],
            180000
          );

        state.tab_id =
          matched.tab_id;

        state.borrowed_tab_ids
          .add(
            matched.tab_id
          );

        state.source =
          "borrowed_user_tab";

        state.matched_tab =
          matched;

        state.borrow_result =
          borrowed;

      } else {
        if (
          input.existing_only
        ) {
          throw new Error(
            "No suitable existing user tab was found. User tabs: " +
            JSON.stringify(
              userTabs
            )
          );
        }

        if (!input.url) {
          throw new Error(
            "No suitable existing user tab was found and no fallback url was supplied. User tabs: " +
            JSON.stringify(
              userTabs
            )
          );
        }

        const navigated =
          await runJson(
            [
              "navigate",
              input.url,
              "--session",
              state.session_id,
            ],
            130000
          );

        state.tab_id =
          navigated.tab_id ||
          null;

        if (
          !state.tab_id
        ) {
          const agentListed =
            await runJson(
              [
                "tab",
                "list",
                "--session",
                state.session_id,
                "--scope",
                "agent",
              ],
              130000
            );

          const agentTabs =
            Array.isArray(
              agentListed
            )
              ? agentListed
              : agentListed.tabs || [];

          const active =
            agentTabs.find(
              (tab) =>
                tab.active
            ) ||
            agentTabs.at(-1);

          state.tab_id =
            active?.tab_id ||
            null;
        }

        state.source =
          "new_agent_page";

        state.navigate_result =
          navigated;
      }


      let observation = null;

      if (
        input.observe !==
        false
      ) {
        if (
          !state.tab_id
        ) {
          throw new Error(
            "Could not determine the active tab for initial observation."
          );
        }

        observation =
          await runJson(
            [
              "observe",
              "--session",
              state.session_id,
              "--tab-id",
              String(
                state.tab_id
              ),
            ],
            130000
          );
      }


      browserWorkflows.set(
        workflowId,
        state
      );

      currentWorkflow =
        workflowId;

      return ok({
        workflow_id:
          workflowId,

        session:
          state.session_id,

        tab_id:
          state.tab_id,

        source:
          state.source,

        matched_tab:
          state.matched_tab,

        user_tabs:
          userTabs,

        observation,
      });

    } catch (error) {
      if (state) {
        try {
          await releaseWorkflowState(
            state
          );
        } catch {}
      }

      return fail(error);
    }
  }
);


server.registerTool(
  "browser_act",
  {
    description:
      "Execute one or more explicit BrowserSkill actions inside an acquired workflow. Supports inspection, navigation, click/fill/press/select/scroll, tabs, files, downloads, resize/emulation, and request-help. Actual steps remain explicit so read/write effects are visible. By default a fresh observe is returned after action batches when a current tab remains.",

    inputSchema:
      z.object({

        workflow_id:
          z.string()
            .optional(),

        steps:
          z.array(
            workflowStepSchema
          )
            .min(1)
            .max(20),

        observe_after:
          z.boolean()
            .optional(),
      }),
  },

  async (input) => {
    try {
      const state =
        getBrowserWorkflow(
          input.workflow_id
        );

      const results = [];
      const images = [];

      for (
        const step of
        input.steps
      ) {
        const executed =
          await executeWorkflowStep(
            state,
            step
          );

        results.push({
          action:
            executed.action,

          tab_id:
            executed.tab_id,

          result:
            executed.result,
        });

        if (
          executed.image
        ) {
          images.push(
            executed.image
          );
        }
      }


      let observation = null;

      const lastAction =
        input.steps.at(-1)
          ?.action;

      const alreadyObserved =
        [
          "observe",
          "snapshot",
          "html",
          "screenshot",
        ].includes(
          lastAction
        );

      if (
        input.observe_after !==
          false &&
        !alreadyObserved &&
        state.tab_id
      ) {
        observation =
          await runJson(
            [
              "observe",
              "--session",
              state.session_id,
              "--tab-id",
              String(
                state.tab_id
              ),
            ],
            130000
          );
      }


      const payload = {
        workflow_id:
          state.workflow_id,

        session:
          state.session_id,

        tab_id:
          state.tab_id,

        results,
        observation,
      };

      const content = [
        {
          type: "text",
          text:
            JSON.stringify(
              payload,
              null,
              2
            ),
        },
      ];

      for (
        const image of
        images
      ) {
        content.push({
          type: "image",
          data:
            image.data,
          mimeType:
            image.mimeType,
        });
      }

      return {
        content,
      };

    } catch (error) {
      return fail(error);
    }
  }
);


server.registerTool(
  "browser_release",
  {
    description:
      "Finish a high-level browser workflow. It explicitly returns every borrowed user tab, then stops the BrowserSkill session. Call this whenever the task is finished, including after errors when possible.",

    inputSchema:
      z.object({
        workflow_id:
          z.string()
            .optional(),
      }),
  },

  async (input) => {
    try {
      const state =
        getBrowserWorkflow(
          input.workflow_id
        );

      const released =
        await releaseWorkflowState(
          state
        );

      return ok(
        released
      );

    } catch (error) {
      return fail(error);
    }
  }
);


await serveStdio(
  () => server
);



