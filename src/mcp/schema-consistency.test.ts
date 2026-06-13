import { describe, expect, it } from "vitest";

import { createWalletMcpRegistry } from "./tools.js";

const PREVIEW_EXECUTE_PAIRS: Array<[string, string]> = [
  ["moss_transfer_preview", "moss_transfer_execute"],
  ["moss_execute_preview", "moss_execute"],
];

describe("MCP schema consistency", () => {
  it("keeps preview/execute metadata pairs symmetric", () => {
    const registry = createWalletMcpRegistry();
    const byId = new Map(registry.map((op) => [op.schema.id, op.schema]));

    for (const [preview, execute] of PREVIEW_EXECUTE_PAIRS) {
      const previewSchema = byId.get(preview);
      const executeSchema = byId.get(execute);
      expect(previewSchema?.metadata?.pairsWith).toBe(execute);
      expect(executeSchema?.metadata?.pairsWith).toBe(preview);
      expect(previewSchema?.metadata?.role).toBe("preview");
      expect(executeSchema?.metadata?.role).toBe("execute");
    }
  });

  it("marks all write tools as value-moving and delegated-key requiring", () => {
    const registry = createWalletMcpRegistry();
    const writeSchemas = registry
      .map((entry) => entry.schema)
      .filter((schema) => schema.safety === "write");

    for (const schema of writeSchemas) {
      expect(schema.metadata?.movesValue).toBe(true);
      expect(schema.metadata?.requirements?.requiresDelegatedKey).toBe(true);
      expect(schema.metadata?.requirements?.requiresWalletProfile).toBe(true);
    }
  });
});
