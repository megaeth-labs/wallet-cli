import { executeWalletCalls, type ExecuteCommandDependencies } from "../commands/execute.js";
import type { TransferCommandDependencies, TransferCommandResult } from "../commands/transfer.js";
import { CliError } from "../errors.js";
import { buildTransferPlan, type TransferPreviewInput } from "./transfer-shared.js";

export async function executeTransfer(
  input: TransferPreviewInput,
  dependencies: (TransferCommandDependencies & ExecuteCommandDependencies) & {
    executeWalletCalls?: typeof executeWalletCalls;
  } = {},
): Promise<TransferCommandResult & { previewWarnings: string[] }> {
  const preview = await buildTransferPlan(input, dependencies);
  if (preview.readiness !== "ready") {
    throw new CliError(preview.warnings.join(" "));
  }
  const execution = await (dependencies.executeWalletCalls ?? executeWalletCalls)(
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
