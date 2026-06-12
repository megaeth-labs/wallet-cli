import type { WalletCommandDependencies } from "../commands/wallet.js";
import {
  buildTransferPlan,
  type TransferPreviewInput,
  type TransferPreviewResult,
} from "../core/transfer-shared.js";

export async function previewTransfer(
  input: TransferPreviewInput,
  dependencies: WalletCommandDependencies = {},
): Promise<TransferPreviewResult> {
  return buildTransferPlan(input, dependencies);
}
