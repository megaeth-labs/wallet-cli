import { executeWalletCalls, type ExecuteCommandDependencies } from "../commands/execute.js";
import type { TransferCommandDependencies, TransferCommandResult } from "../commands/transfer.js";
import { executePreviewedCalls } from "./execute-plan.js";
import { buildTransferPlan, type TransferPreviewInput } from "./transfer-shared.js";

export async function executeTransfer(
  input: TransferPreviewInput,
  dependencies: (TransferCommandDependencies & ExecuteCommandDependencies) & {
    executeWalletCalls?: typeof executeWalletCalls;
  } = {},
): Promise<TransferCommandResult & { previewWarnings: string[] }> {
  const preview = await buildTransferPlan(input, dependencies);
  return executePreviewedCalls({
    dependencies,
    preview,
    calls: [
      {
        to: preview.call.to,
        data: preview.call.data,
        value: BigInt(preview.call.value),
      },
    ],
    network: preview.network,
    requestedKey: input.key,
    onResult: (execution, currentPreview) => ({
      ...execution,
      transfer: currentPreview.transfer,
      previewWarnings: currentPreview.warnings,
    }),
  });
}
