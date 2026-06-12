import { describe, expect, it } from "vitest";

import { createWalletMcpRegistry } from "./tools.js";

describe("wallet MCP registry", () => {
  it("exposes the initial read-only wallet tools", () => {
    const registry = createWalletMcpRegistry();
    expect(registry.map((tool) => tool.schema.id)).toEqual([
      "moss_whoami",
      "moss_list_keys",
      "moss_permissions",
      "moss_wallet_status",
      "moss_transfer_preview",
      "moss_transfer_execute",
      "moss_execute_preview",
      "moss_execute",
      "moss_debug",
    ]);
  });
});
