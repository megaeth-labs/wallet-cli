import { executeWalletCalls, type ExecuteCommandDependencies } from "../commands/execute.js";
import { CliError } from "../errors.js";
import { previewExecute, type ExecutePreviewInput } from "./execute-preview.js";

export async function executePlannedCalls(
  input: ExecutePreviewInput,
  dependencies: ExecuteCommandDependencies & {
    executeWalletCalls?: typeof executeWalletCalls;
  } = {},
) {
  const preview = await previewExecute(input, dependencies);
  if (preview.readiness !== "ready") {
    throw new CliError(preview.warnings.join(" "));
  }

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
