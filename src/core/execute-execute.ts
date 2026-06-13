import { executeWalletCalls, type ExecuteCommandDependencies } from "../commands/execute.js";
import { assertReadyForExecution } from "./execute-common.js";
import { previewExecute, type ExecutePreviewInput } from "./execute-preview.js";

export async function executePlannedCalls(
  input: ExecutePreviewInput,
  dependencies: ExecuteCommandDependencies & {
    executeWalletCalls?: typeof executeWalletCalls;
  } = {},
) {
  const preview = await previewExecute(input, dependencies);
  assertReadyForExecution(preview);

  const execution = await (dependencies.executeWalletCalls ?? executeWalletCalls)(
    {
      calls: input.calls,
      ...(input.key === undefined ? {} : { key: input.key }),
      network: preview.network,
    },
    dependencies,
  );

  return {
    ...execution,
    previewWarnings: preview.warnings,
    previewIssues: preview.issues,
  };
}
