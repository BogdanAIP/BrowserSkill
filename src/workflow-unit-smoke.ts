import { registerBrowserWorkflowTools } from "./workflow-tools.mjs";

const registered = new Map();

const server = {
  registerTool(name, spec, handler) {
    registered.set(name, { spec, handler });
  },
};

let sessionNumber = 0;
let userTabs = [
  {
    tab_id: 10,
    title: "Telegram",
    url: "https://web.telegram.org/",
    active: true,
  },
];

const calls = [];
const claimed = new Set();
const released = new Set();
let failPress = false;

async function ensureBskDaemon() {
  return {
    daemon_version: "0.3.0",
    browsers: [
      { instance_id: "browser-1" },
    ],
  };
}

async function runJson(args) {
  calls.push([...args]);

  if (args[0] === "session" && args[1] === "start") {
    sessionNumber += 1;
    return {
      session_id: "s" + sessionNumber,
      browser_instance_id: "browser-1",
    };
  }

  if (args[0] === "session" && args[1] === "stop") {
    return { stopped: [args[2]] };
  }

  if (args[0] === "tab" && args[1] === "list") {
    const scopeIndex = args.indexOf("--scope");
    const scope = scopeIndex >= 0 ? args[scopeIndex + 1] : "all";

    if (scope === "user") {
      return { tabs: userTabs };
    }

    return {
      tabs: [
        {
          tab_id: 30,
          title: "Agent page",
          url: "https://example.com/",
          active: true,
        },
      ],
    };
  }

  if (args[0] === "tab" && args[1] === "borrow") {
    return {
      tab_id: Number(args[2]),
      agent_window_id: 99,
    };
  }

  if (args[0] === "tab" && args[1] === "return") {
    return {
      tab_id: Number(args[2]),
      returned_to_window_id: 1,
    };
  }

  if (args[0] === "navigate") {
    return {
      tab_id: 30,
      final_url: args[1],
    };
  }

  if (args[0] === "observe") {
    return {
      observed: true,
      tab_id: Number(args[args.indexOf("--tab-id") + 1]),
    };
  }

  if (args[0] === "click") {
    return { clicked: args[1] };
  }

  if (args[0] === "press" && failPress) {
    throw new Error("simulated press failure");
  }

  if (args[0] === "press") {
    return { pressed: args[1] };
  }

  return { ok: true, args };
}

registerBrowserWorkflowTools({
  server,
  runJson,
  ensureBskDaemon,
  transferDir: "/tmp/browser-transfer",
  claimSession(id) {
    claimed.add(id);
  },
  releaseSession(id) {
    released.add(id);
  },
});

function textOf(result) {
  const block = result.content?.find(
    (item) => item.type === "text"
  );

  return block?.text ?? "";
}

function dataOf(result) {
  if (result.isError) {
    throw new Error(textOf(result));
  }

  return JSON.parse(textOf(result));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const acquireHandler = registered.get("browser_acquire")?.handler;
const actHandler = registered.get("browser_act")?.handler;
const releaseHandler = registered.get("browser_release")?.handler;

assert(acquireHandler, "browser_acquire handler missing");
assert(actHandler, "browser_act handler missing");
assert(releaseHandler, "browser_release handler missing");

// Existing user tab path: start -> list user -> borrow -> observe.
const acquired = dataOf(
  await acquireHandler({
    target: "Telegram",
  })
);

assert(acquired.source === "borrowed_user_tab", "existing Telegram tab was not borrowed");
assert(acquired.tab_id === 10, "wrong borrowed tab id");
assert(claimed.has("s1"), "workflow session was not claimed");

const startCall = calls.find(
  (args) => args[0] === "session" && args[1] === "start"
);
assert(startCall?.includes("--browser"), "session start did not use explicit browser instance");
assert(startCall?.includes("browser-1"), "wrong browser instance id");

const borrowCall = calls.find(
  (args) => args[0] === "tab" && args[1] === "borrow"
);
assert(borrowCall, "borrow call missing");
assert(!borrowCall.includes("--timeout"), "acquire should not add a borrow timeout by default");

// Partial-result behavior: first click succeeds, later press fails.
failPress = true;
const partial = dataOf(
  await actHandler({
    steps: [
      {
        action: "click",
        target: "@e1",
      },
      {
        action: "press",
        key: "Enter",
      },
    ],
  })
);

assert(partial.status === "partial", "partial action status not reported");
assert(partial.completed_steps.length === 1, "completed step was lost");
assert(partial.failed_step?.action === "press", "failed step not reported");

failPress = false;

const releasedResult = dataOf(
  await releaseHandler({})
);

assert(releasedResult.returned.length === 1, "borrowed tab was not returned");
assert(released.has("s1"), "workflow session was not released");

// Fallback navigation path when no matching user tab exists.
userTabs = [];

const fallback = dataOf(
  await acquireHandler({
    target: "Example Domain",
    url: "https://example.com/",
  })
);

assert(fallback.source === "new_agent_page", "fallback URL was not opened");
assert(fallback.tab_id === 30, "fallback tab id missing");

dataOf(
  await releaseHandler({})
);

console.log("Browser workflow unit smoke: PASS");
