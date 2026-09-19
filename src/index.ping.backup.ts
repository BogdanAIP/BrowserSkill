import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

function createServer() {
  const server = new McpServer(
    {
      name: "browserskill-chatgpt",
      version: "0.1.0",
    },
    {
      instructions:
        "Local bridge between ChatGPT and Tencent BrowserSkill. Browser tools will be added after the MCP transport is verified.",
    }
  );

  server.registerTool(
    "ping",
    {
      description: "Checks that the local BrowserSkill ChatGPT MCP server is running.",
      inputSchema: z.object({
        text: z.string().optional(),
      }),
    },
    async ({ text }) => ({
      content: [
        {
          type: "text",
          text: text ? `pong: ${text}` : "pong",
        },
      ],
    })
  );

  return server;
}

await serveStdio(() => createServer());
