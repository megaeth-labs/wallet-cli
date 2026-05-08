import { readFile } from "node:fs/promises";

import { encodeFunctionData, type Abi } from "viem";

import { CliError } from "../errors.js";
import type { HexString } from "./client.js";

export async function loadAbiFile(filePath: string): Promise<Abi> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      throw new CliError(`ABI file not found: ${filePath}`);
    }

    throw error;
  }

  try {
    return parseAbiJson(JSON.parse(raw));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new CliError(`ABI file is not valid JSON: ${filePath}`);
    }

    throw error;
  }
}

export function parseAbiJson(value: unknown): Abi {
  const candidate = Array.isArray(value)
    ? value
    : isObject(value) && Array.isArray(value.abi)
      ? value.abi
      : undefined;

  if (!candidate) {
    throw new CliError(
      "ABI JSON must be an ABI array or an object with an abi array",
    );
  }

  for (const item of candidate) {
    if (!isObject(item) || typeof item.type !== "string") {
      throw new CliError("ABI entries must be objects with a type field");
    }
  }

  return candidate as Abi;
}

export function parseAbiArgs(value: string | undefined): readonly unknown[] {
  if (value === undefined || value.trim().length === 0) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new CliError("ABI args must be valid JSON");
  }

  if (!Array.isArray(parsed)) {
    throw new CliError("ABI args must be a JSON array");
  }

  return parsed;
}

export function encodeAbiCall(
  abi: Abi,
  functionName: string,
  args: readonly unknown[],
): HexString {
  try {
    return encodeFunctionData({
      abi,
      args,
      functionName,
    });
  } catch (error) {
    const suffix =
      error instanceof Error && error.message.length > 0
        ? `: ${firstLine(error.message)}`
        : "";
    throw new CliError(`failed to encode ABI call${suffix}`);
  }
}

function firstLine(value: string): string {
  return value.split("\n", 1)[0] ?? value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
