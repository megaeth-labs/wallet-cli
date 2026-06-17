import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
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
    await execFileAsync("sh", ["-n", "scripts/install-release.sh"]);
    await execFileAsync("bash", ["-n", "scripts/install-skill.sh"]);
    await execFileAsync("bash", ["-n", "scripts/package-release.sh"]);
    await execFileAsync("bash", ["-n", "scripts/uninstall.sh"]);
  });

  it("supports a dry-run binary install plan", async () => {
    const dir = await tempDir();

    const { stdout } = await execFileAsync("bash", [
      "scripts/install.sh",
      "--",
      "--dry-run",
      "--skip-build",
      "--install-root",
      join(dir, "mega-wallet-cli"),
      "--bin-dir",
      join(dir, "bin"),
    ]);

    expect(stdout).toContain("would install release:");
    expect(stdout).toContain(
      `would write wrapper: ${join(dir, "bin", "mega")} ->`,
    );
    expect(stdout).not.toContain(`${join(dir, "bin", "wallet")} ->`);
    expect(stdout).toContain(
      `would remove legacy wallet wrapper if repo-owned: ${join(dir, "bin", "wallet")}`,
    );
    expect(stdout).toContain("would install codex skill:");
    expect(stdout).toContain("would install claude skill:");
    expect(stdout).toContain("would install hermes skill:");
    expect(stdout).toContain("would install openclaw skill:");
  });

  it("can skip the default skill install", async () => {
    const dir = await tempDir();

    const { stdout } = await execFileAsync("bash", [
      "scripts/install.sh",
      "--dry-run",
      "--skip-build",
      "--install-root",
      join(dir, "mega-wallet-cli"),
      "--bin-dir",
      join(dir, "bin"),
      "--no-skill",
    ]);

    expect(stdout).toContain("would install release:");
    expect(stdout).not.toContain("would install codex skill:");
  });

  it("supports a dry-run release install plan", async () => {
    const dir = await tempDir();

    const { stdout } = await execFileAsync("sh", [
      "scripts/install-release.sh",
      "--dry-run",
      "--version",
      "v0.1.0",
      "--install-root",
      join(dir, "mega-wallet-cli"),
      "--bin-dir",
      join(dir, "bin"),
      "--no-skill",
    ]);

    expect(stdout).toContain(
      "would use asset: https://github.com/megaeth-labs/wallet-cli/releases/download/v0.1.0/mega-wallet-cli-v0.1.0.tar.gz",
    );
    expect(stdout).toContain(
      `would write auto-updating wrapper: ${join(dir, "bin", "mega")} -> ${join(dir, "mega-wallet-cli", "current", "dist", "index.js")}`,
    );
    expect(stdout).toContain(
      `would remove legacy wallet wrapper if repo-owned: ${join(dir, "bin", "wallet")}`,
    );
    expect(stdout).not.toContain("would install bundled skill");
  });

  it("supports a dry-run release package plan", async () => {
    const dir = await tempDir();

    const { stdout } = await execFileAsync("bash", [
      "scripts/package-release.sh",
      "--dry-run",
      "--version",
      "v0.1.0",
      "--out-dir",
      join(dir, "artifacts"),
    ]);

    expect(stdout).toContain("would package release: mega-wallet-cli-v0.1.0");
    expect(stdout).toContain(
      `would write archive: ${join(dir, "artifacts", "mega-wallet-cli-v0.1.0.tar.gz")}`,
    );
    expect(stdout).toContain(
      `would write checksum: ${join(dir, "artifacts", "mega-wallet-cli-v0.1.0.tar.gz.sha256")}`,
    );
  });

  it("offers to install missing prerequisites in dry-run mode", async () => {
    const dir = await tempDir();
    const fakeBin = join(dir, "bin");
    await mkdir(fakeBin, { recursive: true });
    await writeFile(join(fakeBin, "brew"), "#!/usr/bin/env sh\nexit 0\n");
    await chmod(join(fakeBin, "brew"), 0o755);

    const { stdout } = await execFileAsync(
      "bash",
      [
        "scripts/install.sh",
        "--dry-run",
        "--skip-build",
        "--install-root",
        join(dir, "mega-wallet-cli"),
        "--bin-dir",
        join(dir, "wrappers"),
      ],
      {
        env: {
          ...process.env,
          PATH: `${fakeBin}:/usr/bin:/bin`,
        },
      },
    );

    expect(stdout).toContain("would prompt: Node.js >= 22 is missing.");
    expect(stdout).toContain("+ brew install node");
    expect(stdout).toContain(
      "would prompt: pnpm is not installed. Install pnpm with Homebrew now?",
    );
    expect(stdout).toContain("+ brew install pnpm");
  });

  it("installs the agent skill into isolated agent homes", async () => {
    const dir = await tempDir();
    const codexHome = join(dir, "codex");
    const claudeHome = join(dir, "claude");
    const hermesHome = join(dir, "hermes");
    const openclawStateDir = join(dir, "openclaw");

    await execFileAsync("bash", [
      "scripts/install-skill.sh",
      "--agent",
      "all",
      "--codex-home",
      codexHome,
      "--claude-home",
      claudeHome,
      "--hermes-home",
      hermesHome,
      "--openclaw-state-dir",
      openclawStateDir,
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
    const hermesSkill = await readFile(
      join(hermesHome, "skills", "mega-wallet-cli", "SKILL.md"),
      "utf8",
    );
    const openclawSkill = await readFile(
      join(openclawStateDir, "skills", "mega-wallet-cli", "SKILL.md"),
      "utf8",
    );
    const codexPermissionsReference = await readFile(
      join(
        codexHome,
        "skills",
        "mega-wallet-cli",
        "references",
        "permissions.md",
      ),
      "utf8",
    );
    const claudePermissionsReference = await readFile(
      join(
        claudeHome,
        "skills",
        "mega-wallet-cli",
        "references",
        "permissions.md",
      ),
      "utf8",
    );

    expect(codexSkill).toContain("mega moss");
    expect(claudeSkill).toBe(codexSkill);
    expect(hermesSkill).toBe(codexSkill);
    expect(openclawSkill).toBe(codexSkill);
    expect(codexPermissionsReference).toContain("Permission Requests");
    expect(claudePermissionsReference).toBe(codexPermissionsReference);
  });

  it("treats an unchanged installed skill as up to date", async () => {
    const dir = await tempDir();
    const codexHome = join(dir, "codex");

    await execFileAsync("bash", [
      "scripts/install-skill.sh",
      "--agent",
      "codex",
      "--codex-home",
      codexHome,
    ]);

    const { stdout } = await execFileAsync("bash", [
      "scripts/install-skill.sh",
      "--agent",
      "codex",
      "--codex-home",
      codexHome,
    ]);

    expect(stdout).toContain("codex skill already up to date:");
  });

  it("supports a dry-run uninstall plan", async () => {
    const dir = await tempDir();

    const { stdout } = await execFileAsync("bash", [
      "scripts/uninstall.sh",
      "--",
      "--dry-run",
      "--install-root",
      join(dir, "mega-wallet-cli"),
      "--bin-dir",
      join(dir, "bin"),
      "--codex-home",
      join(dir, "codex"),
      "--claude-home",
      join(dir, "claude"),
      "--hermes-home",
      join(dir, "hermes"),
      "--openclaw-state-dir",
      join(dir, "openclaw"),
      "--config-dir",
      join(dir, "config"),
      "--config",
    ]);

    expect(stdout).toContain("skip missing wrapper:");
    expect(stdout).toContain("skip missing install root:");
    expect(stdout).toContain("skip missing codex skill:");
    expect(stdout).toContain("skip missing claude skill:");
    expect(stdout).toContain("skip missing hermes skill:");
    expect(stdout).toContain("skip missing openclaw skill:");
    expect(stdout).toContain("skip missing config:");
  });

  it("keeps relay-smoke state outside install-owned wallet-cli directories", async () => {
    const script = await readFile("scripts/loopback-e2e.mjs", "utf8");

    expect(script).toContain(
      'const defaultRelaySmokeE2eDir = resolve(defaultE2eDir, "relay-smoke");',
    );
    expect(script).not.toContain('".mega",');
    expect(script).not.toContain('"wallet-cli",');
  });

  it("supports pnpm-style argument separators for skill dry-runs", async () => {
    const dir = await tempDir();

    const { stdout } = await execFileAsync("bash", [
      "scripts/install-skill.sh",
      "--",
      "--dry-run",
      "--agent",
      "codex",
      "--codex-home",
      join(dir, "codex"),
    ]);

    expect(stdout).toContain("would install codex skill:");
  });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mega-wallet-install-"));
  tempDirs.push(dir);

  return dir;
}
