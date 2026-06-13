import type { Readable, Writable } from "node:stream";
import { createInterface } from "node:readline/promises";
import { stdin as processInput, stdout as processOutput } from "node:process";

import { createWalletMcpRegistry } from "./tools.js";

type JsonRpcId = string | number | null;

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
} & ({ result: unknown } | { error: { code: number; message: string } });

export async function runMcpServer(options: {
  input?: Readable;
  output?: Writable;
} = {}): Promise<void> {
  const registry = createWalletMcpRegistry();
  const input = options.input ?? processInput;
  const output = options.output ?? processOutput;
  const rl = createInterface({ input, output, terminal: false });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    const response = await handleMcpRequest(trimmed, registry);
    if (response !== null) {
      output.write(JSON.stringify(response) + "\n");
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toMcpToolDescriptor(tool: ReturnType<typeof createWalletMcpRegistry>[number]) {
  const readOnlyHint = tool.schema.safety === "read";
  const destructiveHint = tool.schema.safety === "write";

  return {
    name: tool.schema.id,
    title: tool.schema.title,
    description: tool.schema.description,
    inputSchema: tool.schema.input,
    annotations: {
      readOnlyHint,
      destructiveHint,
      idempotentHint: readOnlyHint,
      safety: tool.schema.safety,
      metadata: tool.schema.metadata,
      outputSchema: tool.schema.output,
    },
  };
}

function toToolContent(value: unknown): { type: "text"; text: string }[] {
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}

function success(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function failure(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function handleJsonRpcRequest(
  request: Record<string, unknown>,
  registry: ReturnType<typeof createWalletMcpRegistry>,
): Promise<JsonRpcResponse | null> {
  const id =
    request.id === null || typeof request.id === "string" || typeof request.id === "number"
      ? request.id
      : null;
  const method = request.method;
  if (typeof method !== "string") {
    return failure(id, -32600, "invalid_request");
  }

  const params = isObject(request.params) ? request.params : {};

  switch (method) {
    case "initialize":
      return success(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "mega-moss-mcp", version: "0.1.0" },
      });
    case "notifications/initialized":
      return null;
    case "ping":
      return success(id, {});
    case "tools/list":
      return success(id, { tools: registry.map((tool) => toMcpToolDescriptor(tool)) });
    case "tools/call": {
      const name = params.name;
      if (typeof name !== "string") {
        return failure(id, -32602, "tool name is required");
      }
      const tool = registry.find((entry) => entry.schema.id === name);
      if (tool === undefined) {
        return failure(id, -32601, "unknown_tool");
      }
      try {
        const result = await tool.run(isObject(params.arguments) ? params.arguments : {});
        return success(id, {
          content: toToolContent(result),
          structuredContent: result,
          isError: false,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return success(id, {
          content: toToolContent({ error: message }),
          structuredContent: { error: message },
          isError: true,
        });
      }
    }
    default:
      return failure(id, -32601, "method_not_found");
  }
}

export async function handleMcpRequest(
  payload: string,
  registry = createWalletMcpRegistry(),
): Promise<JsonRpcResponse | null> {
  let request: unknown;
  try {
    request = JSON.parse(payload);
  } catch {
    return failure(null, -32700, "parse_error");
  }

  if (!isObject(request) || request.jsonrpc !== "2.0") {
    return failure(null, -32600, "invalid_request");
  }

  return handleJsonRpcRequest(request, registry);
}
