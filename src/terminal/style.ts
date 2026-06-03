import type { OutputWriter } from "../commands/common.js";

export type TerminalStyle = {
  accent(value: string): string;
  dim(value: string): string;
  enabled: boolean;
  error(value: string): string;
  strong(value: string): string;
  success(value: string): string;
  warning(value: string): string;
};

export type TerminalStyleOptions = {
  env?: NodeJS.ProcessEnv;
  json?: boolean;
  stream?: OutputWriter;
  terse?: boolean;
};

type FieldRow = readonly [label: string, value: unknown] | undefined;

const reset = "\x1b[0m";
const codes = {
  accent: "\x1b[38;5;114m",
  dim: "\x1b[38;5;245m",
  error: "\x1b[38;5;203m",
  strong: "\x1b[1;38;5;118m",
  success: "\x1b[38;5;70m",
  warning: "\x1b[38;5;178m",
};

export const plainStyle: TerminalStyle = {
  accent: identity,
  dim: identity,
  enabled: false,
  error: identity,
  strong: identity,
  success: identity,
  warning: identity,
};

export function createTerminalStyle(
  options: TerminalStyleOptions,
): TerminalStyle {
  if (!shouldUseAnsi(options)) {
    return plainStyle;
  }

  return {
    accent: color(codes.accent),
    dim: color(codes.dim),
    enabled: true,
    error: color(codes.error),
    strong: color(codes.strong),
    success: color(codes.success),
    warning: color(codes.warning),
  };
}

export function shouldUseAnsi(options: TerminalStyleOptions): boolean {
  if (options.json || options.terse) {
    return false;
  }

  const env = options.env ?? process.env;
  if (
    env.CI !== undefined ||
    env.NO_COLOR !== undefined ||
    env.TERM === "dumb"
  ) {
    return false;
  }

  return options.stream?.isTTY === true;
}

export function formatTerminalFieldLines(
  rows: readonly FieldRow[],
  style: TerminalStyle,
): string[] {
  return rows.flatMap((row) =>
    row === undefined || row[1] === undefined
      ? []
      : [`${style.dim(row[0])}: ${String(row[1])}`],
  );
}

function color(code: string): (value: string) => string {
  return (value) => `${code}${value}${reset}`;
}

function identity(value: string): string {
  return value;
}
