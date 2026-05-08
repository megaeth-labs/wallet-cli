const secretKeyPattern =
  /(^|_)(private[_-]?key|secret|authorization|api[_-]?key|bearer([_-]?token)?|access[_-]?token|refresh[_-]?token|session[_-]?token|password|passkey|webauthn)($|_)/i;
const longHexPattern = /^0x[0-9a-fA-F]{64,}$/;

export const redactedValue = "[redacted]";

export function redactString(value: string): string {
  if (longHexPattern.test(value)) {
    return `${value.slice(0, 10)}...${value.slice(-6)}`;
  }

  return value;
}

export function redactSecrets<T>(value: T): T {
  return redactUnknown(value) as T;
}

export function toJson(value: unknown): string {
  return `${JSON.stringify(redactSecrets(value), null, 2)}\n`;
}

export function compactAddress(value: string): string {
  if (value.length <= 14) {
    return value;
  }

  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function redactUnknown(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactUnknown(item));
  }

  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};

    for (const [key, entry] of Object.entries(value)) {
      if (secretKeyPattern.test(key)) {
        result[key] = redactedValue;
      } else {
        result[key] = redactUnknown(entry);
      }
    }

    return result;
  }

  if (typeof value === "string") {
    return redactString(value);
  }

  return value;
}
