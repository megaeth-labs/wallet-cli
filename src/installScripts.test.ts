import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("installer scripts", () => {
  it("keeps shell installers syntactically valid", async () => {
    await execFileAsync("bash", ["-n", "scripts/install.sh"]);
    await execFileAsync("bash", ["-n", "scripts/install-skill.sh"]);
  });

  it("supports a dry-run binary install plan", async () => {
    const dir = await tempDir();

    const { stdout } = await execFileAsync("bash", [
      "scripts/install.sh",
      "--dry-run",
      "--skip-build",
      "--install-root",
      join(dir, "mega-wallet-cli"),
      "--bin-dir",
      join(dir, "bin"),
      "--with-skill",
      "--skill-agent",
      "codex",
    ]);

    expect(stdout).toContain("would install release:");
    expect(stdout).toContain("would write wrapper:");
    expect(stdout).toContain("would install codex skill:");
  });

  it("installs the agent skill into isolated Codex and Claude homes", async () => {
    const dir = await tempDir();
    const codexHome = join(dir, "codex");
    const claudeHome = join(dir, "claude");

    await execFileAsync("bash", [
      "scripts/install-skill.sh",
      "--agent",
      "all",
      "--codex-home",
      codexHome,
      "--claude-home",
      claudeHome,
      "--force",
    ]);

    const codexSkill = await readFile(
      join(codexHome, "skills", "mega-wallet-cli", "SKILL.md"),
      "utf8",
    );
    const claudeSkill = await readFile(
      join(claudeHome, "skills", "mega-wallet-cli", "SKILL.md"),
      "utf8",
    );

    expect(codexSkill).toContain("mega wallet");
    expect(claudeSkill).toBe(codexSkill);
  });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mega-wallet-install-"));
  tempDirs.push(dir);

  return dir;
}
