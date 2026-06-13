import { executeWalletCalls, type ExecuteCommandDependencies } from "../commands/execute.js";
import type { RelayCall } from "../relay/sendCalls.js";
import { assertReadyForExecution } from "./execute-common.js";
import type { PreviewEnvelope } from "./runtime-types.js";

export async function executePreviewedCalls<TPreview extends PreviewEnvelope, TResult>(options: {
  dependencies: ExecuteCommandDependencies & { executeWalletCalls?: typeof executeWalletCalls };
  preview: TPreview;
  calls: readonly RelayCall[];
  network: "mainnet" | "testnet";
  requestedKey?: string;
  onResult: (execution: Awaited<ReturnType<typeof executeWalletCalls>>, preview: TPreview) => TResult;
}): Promise<TResult> {
  assertReadyForExecution(options.preview);
  const execution = await (options.dependencies.executeWalletCalls ?? executeWalletCalls)(
    {
      calls: options.calls,
      ...(options.requestedKey === undefined ? {} : { key: options.requestedKey }),
      network: options.network,
    },
    options.dependencies,
  );

  return options.onResult(execution, options.preview);
}
