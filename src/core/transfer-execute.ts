import { executeWalletCalls, type ExecuteCommandDependencies, type ExecuteCommandResult } from "../commands/execute.js";
import type { TransferCommandDependencies, TransferCommandResult } from "../commands/transfer.js";
import { buildTransferPlan, type TransferPreviewInput } from "./transfer-shared.js";

export async function executeTransfer(
  input: TransferPreviewInput,
  dependencies: TransferCommandDependencies & ExecuteCommandDependencies = {},
): Promise<TransferCommandResult & { previewWarnings: string[] }> {
  const preview = await buildTransferPlan(input, dependencies);
  const execution = await executeWalletCalls(
    {
      calls: [
        {
          to: preview.call.to,
          data: preview.call.data,
          value: preview.call.value,
        },
      ],
      ...(input.key === undefined ? {} : { key: input.key }),
      network: preview.network,
    },
    dependencies,
  );

  return {
    ...execution,
    transfer: preview.transfer,
    previewWarnings: preview.warnings,
  };
}
