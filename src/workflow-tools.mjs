import * as z from "zod/v4";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";

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

function messageOf(error) {
  return error instanceof Error
    ? error.message
    : String(error);
}

function fail(error) {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: messageOf(error),
      },
    ],
  };
}

function ok(value) {
  return {
    content: [
      {
        type: "text",
        text:
          typeof value === "string"
            ? value
            : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function safeTransferFile(transferDir, name) {
  if (typeof name !== "string" || !name.trim()) {
    throw new Error("A file name is required.");
  }

  const clean = name.trim();

  if (
    clean === "." ||
    clean === ".." ||
    path.basename(clean) !== clean ||
    /[<>:"/\\|?*\x00-\x1F]/.test(clean) ||
    clean.endsWith(".") ||
    clean.endsWith(" ")
  ) {
    throw new Error(
      "Only a simple file name inside " +
      transferDir +
      " is allowed: " +
      clean
    );
  }

  return path.join(transferDir, clean);
}

function validateFileTarget(step) {
  const supplied = [
    step.target,
    step.ref,
    step.selector,
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

function tabMatchScore(tab, target, fallbackUrl) {
  const title = String(tab.title || "").toLowerCase();
  const url = String(tab.url || "").toLowerCase();
  const needle = String(target || fallbackUrl || "")
    .trim()
    .toLowerCase();

  let score = tab.active ? 2 : 0;

  if (!needle) {
    return score + 1;
  }

  if (title === needle) {
    score += 100;
  } else if (title.includes(needle)) {
    score += 60;
  }

  if (url === needle) {
    score += 100;
  } else if (url.includes(needle)) {
    score += 50;
  }

  try {
    const candidate = new URL(fallbackUrl || target);
    const host = candidate.hostname.toLowerCase();

    if (host && url.includes(host)) {
      score += 80;
    }
  } catch {}

  const words = needle
    .split(/\s+/)
    .filter((word) => word.length >= 3);

  for (const word of words) {
    if (title.includes(word)) {
      score += 8;
    }

    if (url.includes(word)) {
      score += 6;
    }
  }

  return score;
}

function chooseUserTab(tabs, input) {
  if (input.tab_id !== undefined) {
    return (
      tabs.find((tab) => tab.tab_id === input.tab_id) ||
      null
    );
  }

  if (!input.target && !input.url) {
    return (
      tabs.find((tab) => tab.active) ||
      tabs[0] ||
      null
    );
  }

  const ranked = tabs
    .map((tab) => ({
      tab,
      score: tabMatchScore(tab, input.target, input.url),
    }))
    .sort((a, b) => b.score - a.score);

  if (!ranked.length || ranked[0].score <= 2) {
    return null;
  }

  return ranked[0].tab;
}

const workflowStepSchema = z.object({
  action: z.enum([
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

  tab_id: z.number().int().optional(),
  target: z.string().optional(),
  value: z.string().optional(),
  values: z.array(z.string()).optional(),
  key: z.string().optional(),
  url: z.string().optional(),

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

  button: z
    .enum([
      "left",
      "middle",
      "right",
    ])
    .optional(),

  click_count: z.number().int().positive().optional(),
  modifiers: z.string().optional(),
  settle: z.string().optional(),
  no_clear: z.boolean().optional(),
  delta_x: z.number().optional(),
  delta_y: z.number().optional(),
  hold_ms: z.number().int().nonnegative().optional(),
  capture: z.string().optional(),
  image_x: z.number().optional(),
  image_y: z.number().optional(),
  cursor: z.string().optional(),
  ref: z.string().optional(),
  selector: z.string().optional(),
  max_depth: z.number().int().positive().optional(),
  max_tokens: z.number().int().positive().optional(),
  max_bytes: z.number().int().positive().optional(),
  full_page: z.boolean().optional(),
  scope: z.string().optional(),
  since: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().optional(),
  max_text_chars: z.number().int().positive().optional(),
  include_stack: z.boolean().optional(),
  probe_hover: z.boolean().optional(),
  debug_surfaces: z.boolean().optional(),
  no_active: z.boolean().optional(),
  index: z.number().int().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  device: z.string().optional(),
  dpr: z.number().positive().optional(),
  mobile: z.boolean().optional(),
  no_mobile: z.boolean().optional(),
  ua: z.string().optional(),
  accept_language: z.string().optional(),
  touch: z.boolean().optional(),
  no_touch: z.boolean().optional(),
  max_touch_points: z.number().int().positive().optional(),
  off: z.boolean().optional(),
  prompt: z.string().optional(),
  title: z.string().optional(),
  targets: z.array(z.string()).optional(),
  completion_criteria: z.string().optional(),
  files: z.array(z.string()).min(1).optional(),
  out: z.string().optional(),
  overwrite: z.boolean().optional(),
});

export function registerBrowserWorkflowTools({
  server,
  runJson,
  ensureBskDaemon,
  claimSession,
  releaseSession,
  transferDir,
}) {
  const workflows = new Map();
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

  function getWorkflow(requested) {
    const id = requested || currentWorkflow;

    if (!id) {
      throw new Error(
        "No active browser workflow. Start one with browser_acquire."
      );
    }

    const state = workflows.get(id);

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

  async function startSession(name, noFocus) {
    const status = await ensureBskDaemon();
    const browsers = Array.isArray(status?.browsers)
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

    const args = [
      "session",
      "start",
      "--browser",
      browsers[0].instance_id,
    ];

    addOpt(
      args,
      "--name",
      name || "Browser workflow"
    );

    addFlag(
      args,
      "--no-focus",
      noFocus
    );

    const data = await runJson(args, 130000);

    if (!data.session_id) {
      throw new Error(
        "bsk did not return session_id for browser workflow: " +
        JSON.stringify(data)
      );
    }

    claimSession(data.session_id);
    return data;
  }

  async function stopSession(sessionId) {
    let result = null;
    let error = null;

    try {
      result = await runJson(
        [
          "session",
          "stop",
          sessionId,
        ],
        130000
      );
    } catch (caught) {
      error = messageOf(caught);
    } finally {
      releaseSession(sessionId);
    }

    return {
      result,
      error,
    };
  }

  async function releaseState(state) {
    const returned = [];
    const returnFailures = [];

    for (
      const tabId of
      [...state.borrowed_tab_ids].reverse()
    ) {
      try {
        const result = await runJson(
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

        state.borrowed_tab_ids.delete(tabId);
      } catch (caught) {
        returnFailures.push({
          tab_id: tabId,
          error: messageOf(caught),
        });
      }
    }

    const sessionStop =
      await stopSession(state.session_id);

    workflows.delete(state.workflow_id);

    if (currentWorkflow === state.workflow_id) {
      currentWorkflow =
        [...workflows.keys()].at(-1) ||
        null;
    }

    return {
      workflow_id: state.workflow_id,
      returned,
      return_failures: returnFailures,
      session_stop: sessionStop,
    };
  }

  async function executeStep(state, step) {
    const tabId =
      step.tab_id !== undefined
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
      ].includes(step.action)
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

      if (step.action === "observe") {
        addOpt(args, "--cursor", step.cursor);
        addOpt(args, "--max-depth", step.max_depth);
        addOpt(args, "--max-tokens", step.max_tokens);
        addFlag(args, "--probe-hover", step.probe_hover);
        addFlag(args, "--debug-surfaces", step.debug_surfaces);

      } else if (step.action === "snapshot") {
        addOpt(args, "--max-depth", step.max_depth);
        addOpt(args, "--max-tokens", step.max_tokens);

      } else if (step.action === "html") {
        addOpt(args, "--ref", step.ref);
        addOpt(args, "--max-bytes", step.max_bytes);

      } else if (step.action === "screenshot") {
        addOpt(args, "--ref", step.ref);
        addFlag(args, "--full-page", step.full_page);
        addOpt(args, "--scope", step.scope);
        addOpt(args, "--timeout", step.timeout);

        if (step.full_page) {
          timeoutMs = 300000;
        }

      } else {
        addOpt(args, "--since", step.since);
        addOpt(args, "--limit", step.limit);
        addOpt(
          args,
          "--max-text-chars",
          step.max_text_chars
        );

        if (step.action === "console") {
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
      ].includes(step.action)
    ) {
      if (step.action === "navigate") {
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

      } else if (step.action === "back") {
        args = [
          "navigate-back",
          "--session",
          state.session_id,
        ];

      } else if (step.action === "forward") {
        args = [
          "navigate-forward",
          "--session",
          state.session_id,
        ];

      } else if (step.action === "reload") {
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
      ].includes(step.action)
    ) {
      args = [
        step.action,
      ];

      const needsTarget = [
        "click",
        "hover",
        "scroll-to",
        "focus",
        "blur",
        "fill",
        "select",
      ].includes(step.action);

      if (needsTarget && !step.target) {
        throw new Error(
          "target is required for " +
          step.action +
          "."
        );
      }

      if (step.action === "press") {
        if (!step.key) {
          throw new Error(
            "key is required for press."
          );
        }

        args.push(step.key);

      } else if (step.target) {
        args.push(step.target);
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

      if (step.action === "click") {
        addOpt(args, "--button", step.button);
        addOpt(
          args,
          "--click-count",
          step.click_count
        );
        addOpt(args, "--capture", step.capture);
        addOpt(args, "--image-x", step.image_x);
        addOpt(args, "--image-y", step.image_y);

      } else if (step.action === "hover") {
        addOpt(args, "--settle", step.settle);

      } else if (step.action === "fill") {
        if (step.value === undefined) {
          throw new Error(
            "value is required for fill."
          );
        }

        addOpt(args, "--value", step.value);
        addFlag(args, "--no-clear", step.no_clear);

      } else if (step.action === "select") {
        if (!step.values?.length) {
          throw new Error(
            "values is required for select."
          );
        }

        for (const value of step.values) {
          addOpt(args, "--value", value);
        }

      } else if (step.action === "press") {
        if (step.target) {
          if (/^@?e\d+$/.test(step.target)) {
            addOpt(args, "--ref", step.target);
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

      } else if (step.action === "wheel") {
        if (!step.delta_x && !step.delta_y) {
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

    } else if (step.action.startsWith("tab-")) {
      const tabAction = step.action.slice(4);

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
        ].includes(tabAction)
      ) {
        if (step.tab_id === undefined) {
          throw new Error(
            "tab_id is required for " +
            step.action +
            "."
          );
        }

        args.push(
          String(step.tab_id)
        );
      }

      args.push(
        "--session",
        state.session_id
      );

      if (tabAction === "list") {
        addOpt(
          args,
          "--scope",
          step.scope || "all"
        );
      }

      if (tabAction === "create") {
        addOpt(args, "--url", step.url);
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

      if (tabAction === "borrow") {
        addOpt(
          args,
          "--timeout",
          step.timeout
        );

        timeoutMs = 180000;
      }

    } else if (step.action === "resize") {
      if (!step.width || !step.height) {
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

    } else if (step.action === "emulate") {
      args = [
        "emulate",
        "--session",
        state.session_id,
      ];

      addOpt(args, "--tab-id", tabId);
      addFlag(args, "--off", step.off);
      addOpt(args, "--device", step.device);
      addOpt(args, "--width", step.width);
      addOpt(args, "--height", step.height);
      addOpt(args, "--dpr", step.dpr);
      addFlag(args, "--mobile", step.mobile);
      addFlag(
        args,
        "--no-mobile",
        step.no_mobile
      );
      addOpt(args, "--ua", step.ua);
      addOpt(
        args,
        "--accept-language",
        step.accept_language
      );
      addFlag(args, "--touch", step.touch);
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

    } else if (step.action === "request-help") {
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

      addOpt(args, "--tab-id", tabId);
      addOpt(args, "--title", step.title);

      for (const target of step.targets || []) {
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
      ].includes(step.action)
    ) {
      validateFileTarget(step);

      if (
        step.action === "upload" ||
        step.action === "drop-upload"
      ) {
        if (!step.files?.length) {
          throw new Error(
            "files is required for upload."
          );
        }

        args = [
          "upload",
          "--session",
          state.session_id,
          "--mode",
          step.action === "drop-upload"
            ? "drop"
            : "input",
        ];

        addOpt(
          args,
          "--tab-id",
          tabId
        );

        for (const fileName of step.files) {
          args.push(
            "--file",
            safeTransferFile(
              transferDir,
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
            transferDir,
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

      } else if (step.selector) {
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
        args.push(step.target);
      }

      timeoutMs = 330000;

    } else {
      throw new Error(
        "Unsupported workflow action: " +
        step.action
      );
    }

    const result =
      await runJson(args, timeoutMs);

    if (step.action === "tab-borrow") {
      state.borrowed_tab_ids.add(step.tab_id);
      state.tab_id = step.tab_id;
    }

    if (step.action === "tab-return") {
      state.borrowed_tab_ids.delete(step.tab_id);

      if (state.tab_id === step.tab_id) {
        state.tab_id = null;
      }
    }

    if (step.action === "tab-select") {
      state.tab_id = step.tab_id;
    }

    if (
      step.action === "tab-close" &&
      state.tab_id === step.tab_id
    ) {
      state.tab_id = null;
    }

    if (
      step.action === "tab-create" &&
      result?.tab_id &&
      !step.no_active
    ) {
      state.tab_id = result.tab_id;
    }

    if (
      step.action === "navigate" &&
      result?.tab_id
    ) {
      state.tab_id = result.tab_id;
    }

    let image = null;

    if (
      step.action === "screenshot" &&
      result?.path
    ) {
      const bytes =
        await readFile(result.path);

      try {
        await unlink(result.path);
      } catch {}

      image = {
        mimeType: "image/png",
        data: bytes.toString("base64"),
      };
    }

    return {
      action: step.action,
      tab_id: state.tab_id,
      result,
      image,
    };
  }

  server.registerTool(
    "browser_acquire",
    {
      description:
        "Start a high-level BrowserSkill workflow. It checks existing user tabs first, borrows a suitable existing tab when possible, otherwise opens the supplied fallback URL, and returns an initial observation. Prefer this over manual browser_session + browser_tabs for normal tasks.",

      inputSchema: z.object({
        target: z
          .string()
          .optional()
          .describe(
            "Human-readable site/app/tab hint such as Telegram, Gmail, Example Domain, or part of a title/URL."
          ),

        url: z
          .string()
          .optional()
          .describe(
            "Fallback URL to open only when no suitable existing user tab is found."
          ),

        tab_id: z
          .number()
          .int()
          .optional()
          .describe(
            "Optional exact existing user tab id."
          ),

        existing_only: z
          .boolean()
          .optional()
          .describe(
            "When true, fail instead of opening url if a suitable existing user tab is not found."
          ),

        observe: z
          .boolean()
          .optional()
          .describe(
            "Initial semantic observation; defaults to true."
          ),

        name: z.string().optional(),
        no_focus: z.boolean().optional(),
      }),
    },

    async (input) => {
      let state = null;

      try {
        const started =
          await startSession(
            input.name,
            input.no_focus
          );

        state = {
          workflow_id: nextWorkflowId(),
          session_id: started.session_id,
          browser_instance_id:
            started.browser_instance_id,
          tab_id: null,
          borrowed_tab_ids: new Set(),
          source: null,
          matched_tab: null,
        };

        const listed = await runJson(
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

        const userTabs = Array.isArray(listed)
          ? listed
          : listed.tabs || [];

        const matched =
          chooseUserTab(
            userTabs,
            input
          );

        if (
          input.tab_id !== undefined &&
          !matched
        ) {
          throw new Error(
            "Requested user tab_id was not found: " +
            input.tab_id
          );
        }

        if (matched) {
          const borrowed = await runJson(
            [
              "tab",
              "borrow",
              String(matched.tab_id),
              "--session",
              state.session_id,
            ],
            180000
          );

          state.tab_id =
            matched.tab_id;

          state.borrowed_tab_ids.add(
            matched.tab_id
          );

          state.source =
            "borrowed_user_tab";

          state.matched_tab =
            matched;

          state.borrow_result =
            borrowed;

        } else {
          if (input.existing_only) {
            throw new Error(
              "No suitable existing user tab was found."
            );
          }

          if (!input.url) {
            throw new Error(
              "No suitable existing user tab was found and no fallback url was supplied."
            );
          }

          const navigated = await runJson(
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

          if (!state.tab_id) {
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
              Array.isArray(agentListed)
                ? agentListed
                : agentListed.tabs || [];

            const active =
              agentTabs.find(
                (tab) => tab.active
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

        if (input.observe !== false) {
          if (!state.tab_id) {
            throw new Error(
              "Could not determine the active tab for initial observation."
            );
          }

          observation = await runJson(
            [
              "observe",
              "--session",
              state.session_id,
              "--tab-id",
              String(state.tab_id),
            ],
            130000
          );
        }

        workflows.set(
          state.workflow_id,
          state
        );

        currentWorkflow =
          state.workflow_id;

        return ok({
          workflow_id:
            state.workflow_id,
          session:
            state.session_id,
          tab_id:
            state.tab_id,
          source:
            state.source,
          matched_tab:
            state.matched_tab,
          user_tab_count:
            userTabs.length,
          observation,
        });

      } catch (error) {
        if (state) {
          try {
            await releaseState(state);
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
        "Execute one or more explicit BrowserSkill actions inside an acquired workflow. Supports inspection, navigation, click/fill/press/select/scroll, tabs, files, downloads, resize/emulation, and request-help. Completed steps are always reported; if a later step or post-action observation fails, do not blindly repeat completed write actions.",

      inputSchema: z.object({
        workflow_id:
          z.string().optional(),

        steps:
          z.array(
            workflowStepSchema
          )
            .min(1)
            .max(20),

        observe_after:
          z.boolean().optional(),
      }),
    },

    async (input) => {
      try {
        const state =
          getWorkflow(
            input.workflow_id
          );

        const completed = [];
        const images = [];
        let failedStep = null;

        for (
          let index = 0;
          index < input.steps.length;
          index += 1
        ) {
          const step =
            input.steps[index];

          try {
            const executed =
              await executeStep(
                state,
                step
              );

            completed.push({
              index,
              action:
                executed.action,
              tab_id:
                executed.tab_id,
              result:
                executed.result,
            });

            if (executed.image) {
              images.push(
                executed.image
              );
            }

          } catch (caught) {
            failedStep = {
              index,
              action:
                step.action,
              tab_id:
                step.tab_id ??
                state.tab_id,
              error:
                messageOf(caught),
            };

            break;
          }
        }

        let observation = null;
        let observationError = null;

        const lastCompletedAction =
          completed.at(-1)?.action;

        const alreadyObserved = [
          "observe",
          "snapshot",
          "html",
          "screenshot",
        ].includes(
          lastCompletedAction
        );

        if (
          !failedStep &&
          input.observe_after !== false &&
          !alreadyObserved &&
          state.tab_id
        ) {
          try {
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
          } catch (caught) {
            observationError =
              messageOf(caught);
          }
        }

        const status =
          failedStep
            ? (
                completed.length
                  ? "partial"
                  : "failed"
              )
            : (
                observationError
                  ? "actions_completed_observation_failed"
                  : "ok"
              );

        const payload = {
          status,
          workflow_id:
            state.workflow_id,
          session:
            state.session_id,
          tab_id:
            state.tab_id,
          completed_steps:
            completed,
          failed_step:
            failedStep,
          observation,
          observation_error:
            observationError,
          retry_guidance:
            failedStep ||
            observationError
              ? "Do not blindly repeat completed write actions. Inspect completed_steps and current state first; retry only the unfinished operation when appropriate."
              : null,
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

        for (const image of images) {
          content.push({
            type: "image",
            data: image.data,
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

      inputSchema: z.object({
        workflow_id:
          z.string().optional(),
      }),
    },

    async (input) => {
      try {
        const state =
          getWorkflow(
            input.workflow_id
          );

        return ok(
          await releaseState(state)
        );

      } catch (error) {
        return fail(error);
      }
    }
  );
}
