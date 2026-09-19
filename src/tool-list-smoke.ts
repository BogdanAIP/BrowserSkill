import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const expected = [
  "browser_session",
  "browser_page",
  "browser_inspect",
  "browser_interact",
  "browser_tabs",
  "browser_assist",
  "browser_files",
  "browser_acquire",
  "browser_act",
  "browser_release",
];

const client = new Client({
  name: "browserskill-tool-list-smoke",
  version: "0.1.0",
});

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", "src/index.ts"],
  cwd: process.cwd(),
});

try {
  await client.connect(transport);

  const { tools } =
    await client.listTools();

  const names =
    tools.map((tool) => tool.name);

  const missing =
    expected.filter(
      (name) => !names.includes(name)
    );

  if (missing.length) {
    throw new Error(
      "Missing MCP tools: " +
      missing.join(", ")
    );
  }

  if (names.length !== expected.length) {
    throw new Error(
      "Unexpected MCP tool count. Expected " +
      expected.length +
      ", got " +
      names.length +
      ": " +
      names.join(", ")
    );
  }

  console.log(
    "MCP tool schema smoke: PASS"
  );

  console.log(
    names.join(", ")
  );
} finally {
  await client.close();
}
