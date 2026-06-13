import { executeWalletCalls, type ExecuteCommandDependencies } from "../commands/execute.js";
import { executePreviewedCalls } from "./execute-plan.js";
import { previewExecute, type ExecutePreviewInput } from "./execute-preview.js";

export async function executePlannedCalls(
  input: ExecutePreviewInput,
  dependencies: ExecuteCommandDependencies & {
    executeWalletCalls?: typeof executeWalletCalls;
  } = {},
) {
  const preview = await previewExecute(input, dependencies);
  return executePreviewedCalls({
    dependencies,
    preview,
    calls: preview.calls.map((call) => ({ ...call, value: BigInt(call.value) })),
    network: preview.network,
    requestedKey: input.key,
    onResult: (execution, currentPreview) => ({
      ...execution,
      previewWarnings: currentPreview.warnings,
      previewIssues: currentPreview.issues,
    }),
  });
}
