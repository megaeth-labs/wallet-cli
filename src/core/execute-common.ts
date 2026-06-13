import { CliError } from "../errors.js";
import type { PreviewEnvelope } from "./runtime-types.js";

export function assertReadyForExecution(preview: PreviewEnvelope): void {
  if (preview.readiness === "ready") {
    return;
  }

  throw new CliError(preview.warnings.join(" "));
}
