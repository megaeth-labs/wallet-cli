import type { WalletOperation } from "../core/operations.js";
import { whoamiSchema, listSchema, permissionsSchema, debugSchema } from "../schemas/wallet.js";
import { runWalletWhoami, runWalletList, runWalletPermissions } from "../commands/wallet.js";
import { runWalletDebug } from "../commands/debug.js";

type McpInput = Record<string, unknown>;

export function createWalletMcpRegistry(): Array<WalletOperation<McpInput, unknown>> {
  return [
    {
      schema: whoamiSchema,
      run: async (input) =>
        runWalletWhoami(
          { network: asString(input.network), json: true },
          { stdout: sinkWriter },
        ),
    },
    {
      schema: listSchema,
      run: async (input) =>
        runWalletList(
          {
            network: asString(input.network),
            showInactive: asBoolean(input.showInactive),
            json: true,
          },
          { stdout: sinkWriter },
        ),
    },
    {
      schema: permissionsSchema,
      run: async (input) => {
        const key = asString(input.key);
        if (key === undefined) throw new Error("key is required");
        return runWalletPermissions(
          key,
          { network: asString(input.network), json: true },
          { stdout: sinkWriter },
        );
      },
    },
    {
      schema: debugSchema,
      run: async (input) =>
        runWalletDebug(
          { network: asString(input.network), json: true },
          { stdout: sinkWriter },
        ),
    },
  ];
}

const sinkWriter = {
  write(_value: string): void {
    // Intentionally discard human-oriented CLI rendering in MCP mode.
  },
};

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
