export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

export function formatErrorMessage(error: unknown): string {
  if (error instanceof CliError) {
    return `error: ${error.message}`;
  }

  if (error instanceof Error && error.message.length > 0) {
    return `error: ${error.message}`;
  }

  return "error: unknown failure";
}
