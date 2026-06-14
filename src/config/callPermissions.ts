import { CliError } from "../errors.js";

export const anyAddress = "0x3232323232323232323232323232323232323232";
export const anyFunctionSelector = "0x32323232";

export function assertAllowedCallTarget(value: unknown, label: string): void {
  if (
    typeof value === "string" &&
    value.toLowerCase() === anyAddress.toLowerCase()
  ) {
    throw new CliError(`${label} cannot use reserved wildcard address`);
  }
}

export function assertAllowedCallSignature(
  value: unknown,
  label: string,
): void {
  if (
    typeof value === "string" &&
    value.toLowerCase() === anyFunctionSelector
  ) {
    throw new CliError(`${label} cannot use reserved wildcard selector`);
  }
}
