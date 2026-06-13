import type { Readable, Writable } from "node:stream";
import { createInterface } from "node:readline/promises";
import { stdin as processInput, stdout as processOutput } from "node:process";

import { createWalletMcpRegistry } from "./tools.js";

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

    let request: unknown;
    try {
      request = JSON.parse(trimmed);
    } catch {
      output.write(JSON.stringify({ error: "invalid_json" }) + "\n");
      continue;
    }

    if (!isObject(request) || typeof request.tool !== "string") {
      output.write(JSON.stringify({ error: "invalid_request" }) + "\n");
      continue;
    }

    if (request.tool === "mcp.tools") {
      output.write(
        JSON.stringify({
          tools: registry.map((tool) => ({
            name: tool.schema.id,
            title: tool.schema.title,
            description: tool.schema.description,
            safety: tool.schema.safety,
            metadata: tool.schema.metadata,
            input: tool.schema.input,
            output: tool.schema.output,
          })),
        }) + "\n",
      );
      continue;
    }

    const tool = registry.find((entry) => entry.schema.id === request.tool);
    if (tool === undefined) {
      output.write(JSON.stringify({ error: "unknown_tool" }) + "\n");
      continue;
    }

    try {
      const result = await tool.run(isObject(request.input) ? request.input : {});
      output.write(JSON.stringify({ result }) + "\n");
    } catch (error) {
      output.write(
        JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + "\n",
      );
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}


export async function handleMcpRequest(
  payload: string,
  registry = createWalletMcpRegistry(),
): Promise<Record<string, unknown>> {
  let request: unknown;
  try {
    request = JSON.parse(payload);
  } catch {
    return { error: "invalid_json" };
  }

  if (!isObject(request) || typeof request.tool !== "string") {
    return { error: "invalid_request" };
  }

  if (request.tool === "mcp.tools") {
    return {
      tools: registry.map((tool) => ({
        name: tool.schema.id,
        title: tool.schema.title,
        description: tool.schema.description,
        safety: tool.schema.safety,
        metadata: tool.schema.metadata,
        input: tool.schema.input,
        output: tool.schema.output,
      })),
    };
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
