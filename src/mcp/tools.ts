import type { WalletOperation } from "../core/operations.js";
import { whoamiSchema, listSchema, permissionsSchema, debugSchema, walletStatusSchema, transferPreviewSchema } from "../schemas/wallet.js";
import { runWalletPermissions } from "../commands/wallet.js";
import { getWalletPermissions } from "../core/wallet-permissions.js";
import { getWalletDebug } from "../core/wallet-debug.js";
import { previewTransfer } from "../core/transfer-preview.js";
import { getWalletAggregateStatus, getWalletList, getWalletStatus } from "../core/wallet-status.js";

type McpInput = Record<string, unknown>;

export function createWalletMcpRegistry(): Array<WalletOperation<McpInput, unknown>> {
  return [
    {
      schema: whoamiSchema,
      run: async (input) =>
        getWalletStatus(
          { network: asString(input.network), json: true },
          { stdout: sinkWriter },
        ),
    },
    {
      schema: listSchema,
      run: async (input) =>
        getWalletList(
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
        return getWalletPermissions(
          key,
          { network: asString(input.network), json: true },
          { stdout: sinkWriter },
        );
      },
    },
    {
      schema: walletStatusSchema,
      run: async (input) =>
        getWalletAggregateStatus(
          { network: asString(input.network), json: true },
          { stdout: sinkWriter },
        ),
    },
    {
      schema: transferPreviewSchema,
      run: async (input) =>
        previewTransfer(
          {
            amount: asString(input.amount),
            decimals: asNumber(input.decimals),
            key: asString(input.key),
            network: asString(input.network),
            rpcUrl: asString(input.rpcUrl),
            to: asString(input.to),
            token: asString(input.token),
          },
          { stdout: sinkWriter },
        ),
    },
    {
      schema: debugSchema,
      run: async (input) =>
        getWalletDebug(
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

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
