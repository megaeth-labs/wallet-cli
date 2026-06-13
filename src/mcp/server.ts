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

function toLegacyToolDescriptor(tool: ReturnType<typeof createWalletMcpRegistry>[number]) {
  return {
    name: tool.schema.id,
    title: tool.schema.title,
    description: tool.schema.description,
    safety: tool.schema.safety,
    metadata: tool.schema.metadata,
    input: tool.schema.input,
    output: tool.schema.output,
  };
}

function toMcpToolDescriptor(tool: ReturnType<typeof createWalletMcpRegistry>[number]) {
  return {
    name: tool.schema.id,
    title: tool.schema.title,
    description: tool.schema.description,
    inputSchema: tool.schema.input,
    annotations: {
      safety: tool.schema.safety,
      metadata: tool.schema.metadata,
      outputSchema: tool.schema.output,
    },
  };
}

function success(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function failure(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function handleLegacyRequest(
  request: Record<string, unknown>,
  registry: ReturnType<typeof createWalletMcpRegistry>,
): Promise<Record<string, unknown>> {
  if (typeof request.tool !== "string") {
    return { error: "invalid_request" };
  }

  if (request.tool === "mcp.tools") {
    return { tools: registry.map((tool) => toLegacyToolDescriptor(tool)) };
  }

  const tool = registry.find((entry) => entry.schema.id === request.tool);
  if (tool === undefined) {
    return { error: "unknown_tool" };
  }

  try {
    const result = await tool.run(isObject(request.input) ? request.input : {});
    return { result };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
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
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
          isError: false,
        });
      } catch (error) {
        return success(id, {
          content: [
            { type: "text", text: error instanceof Error ? error.message : String(error) },
          ],
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
): Promise<Record<string, unknown> | JsonRpcResponse | null> {
  let request: unknown;
  try {
    request = JSON.parse(payload);
  } catch {
    return { error: "invalid_json" };
  }

  if (!isObject(request)) {
    return { error: "invalid_request" };
  }

  if (request.jsonrpc === "2.0") {
    return handleJsonRpcRequest(request, registry);
  }

  return handleLegacyRequest(request, registry);
}
