import type { Command } from "commander";

import { runMcpServer } from "../mcp/server.js";

export function registerMcpCommand(wallet: Command): void {
  wallet
    .command("mcp")
    .description("Agent-facing MCP integration")
    .command("serve")
    .description("Start the embedded MCP server over stdio")
    .action(async () => {
      await runMcpServer();
    });
}
