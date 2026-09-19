import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const client = new Client({
  name: "browserskill-chatgpt-smoke",
  version: "0.1.0",
});

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", "src/index.ts"],
  cwd: process.cwd(),
});

function getText(result) {
  const block = result.content?.find(
    (item) => item.type === "text"
  );

  return block?.text ?? "";
}

function requireOk(label, result) {
  if (result.isError) {
    throw new Error(
      `${label} failed: ${getText(result)}`
    );
  }

  return result;
}

let sessionId = null;

try {
  console.log("\n=== CONNECT MCP ===");
  await client.connect(transport);

  const { tools } = await client.listTools();

  console.log(
    "Tools:",
    tools.map((tool) => tool.name).join(", ")
  );

  console.log("\n=== SESSION START ===");

  const start = requireOk(
    "browser_session start",
    await client.callTool({
      name: "browser_session",
      arguments: {
        action: "start",
        name: "MCP BrowserSkill smoke test",
      },
    })
  );

  console.log(getText(start));

  const startData = JSON.parse(
    getText(start)
  );

  sessionId =
    startData.session_id ||
    startData.session;

  if (!sessionId) {
    throw new Error(
      "MCP did not return a BrowserSkill session id."
    );
  }

  console.log(
    `\nSESSION ID: ${sessionId}`
  );

  console.log(
    "\n=== NAVIGATE THROUGH MCP ==="
  );

  const nav = requireOk(
    "browser_page navigate",
    await client.callTool({
      name: "browser_page",
      arguments: {
        action: "navigate",
        session: sessionId,
        url: "https://example.com",
      },
    })
  );

  console.log(getText(nav));

  console.log(
    "\n=== OBSERVE THROUGH MCP ==="
  );

  const observe = requireOk(
    "browser_inspect observe",
    await client.callTool({
      name: "browser_inspect",
      arguments: {
        action: "observe",
        session: sessionId,
        max_tokens: 2000,
      },
    })
  );

  console.log(getText(observe));

  console.log(
    "\n=== SESSION STOP ==="
  );

  const stop = requireOk(
    "browser_session stop",
    await client.callTool({
      name: "browser_session",
      arguments: {
        action: "stop",
        session: sessionId,
      },
    })
  );

  console.log(getText(stop));

  sessionId = null;

  console.log(
    "\n=== MCP BROWSER TEST: PASS ==="
  );
} catch (error) {
  console.error(
    "\n=== MCP BROWSER TEST: FAIL ==="
  );

  console.error(error);
  process.exitCode = 1;
} finally {
  if (sessionId) {
    try {
      await client.callTool({
        name: "browser_session",
        arguments: {
          action: "stop",
          session: sessionId,
        },
      });
    } catch {}
  }

  await client.close();
}
