import { execFile } from "node:child_process";
import { chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { createCli } from "./cli.js";

const execFileAsync = promisify(execFile);

describe("mega cli", () => {
  it("renders top-level help", () => {
    const help = createCli().helpInformation();

    expect(help).toContain("Usage: mega");
    expect(help).toContain("MegaETH MOSS account CLI");
    expect(help).toContain("moss");
  });

  it("renders create-key examples in help", () => {
    const program = createCli();
    const wallet = program.commands.find(
      (command) => command.name() === "moss",
    );
    const createKey = wallet?.commands.find(
      (command) => command.name() === "create-key",
    );

    let help = "";
    createKey?.configureOutput({
      writeOut: (chunk) => {
        help += chunk;
      },
    });
    createKey?.outputHelp();

    expect(help).toContain("Examples:");
    expect(help).toContain("--spend-limit");
    expect(help).toContain("--allow-call");
    expect(help).toContain(
      "0x0000000000000000000000000000000000000000:0.01:week",
    );
  });

  it("registers the moss mcp serve command", () => {
    const program = createCli();
    const wallet = program.commands.find((command) => command.name() === "moss");
    const mcp = wallet?.commands.find((command) => command.name() === "mcp");
    const serve = mcp?.commands.find((command) => command.name() === "serve");

    expect(mcp).toBeDefined();
    expect(serve).toBeDefined();
  });

  it("runs compiled mega --help", { timeout: 15_000 }, async () => {
    await buildDist();

    const { stdout } = await execFileAsync(
      "npm",
      ["exec", "--package", ".", "--", "mega", "--help"],
      {
        cwd: process.cwd(),
      },
    );

    expect(stdout).toContain("Usage: mega");
    expect(stdout).toContain("MegaETH MOSS account CLI");
    expect(stdout).toContain("moss");
  });
});

async function buildDist() {
  const cwd = process.cwd();
  await rm(join(cwd, "dist"), { recursive: true, force: true });
  await execFileAsync(
    process.execPath,
    [join(cwd, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"],
    { cwd },
  );
  await chmod(join(cwd, "dist", "index.js"), 0o755);
}
