import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { createCli } from "./cli.js";
import { cliVersion } from "./version.js";

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

  it("keeps the CLI version aligned with package.json", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      version: string;
    };

    expect(cliVersion).toBe(packageJson.version);
  });

  it("runs compiled mega --help", async () => {
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
