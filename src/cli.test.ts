import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { createCli } from "./cli.js";

const execFileAsync = promisify(execFile);

describe("mega cli", () => {
  it("renders top-level help", () => {
    const help = createCli().helpInformation();

    expect(help).toContain("Usage: mega");
    expect(help).toContain("MegaETH wallet CLI");
    expect(help).toContain("wallet");
  });

  it("runs compiled mega --help", async () => {
    const { stdout } = await execFileAsync("npm", ["exec", "--package", ".", "--", "mega", "--help"], {
      cwd: process.cwd()
    });

    expect(stdout).toContain("Usage: mega");
    expect(stdout).toContain("MegaETH wallet CLI");
    expect(stdout).toContain("wallet");
  });
});
