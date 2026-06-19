import { homedir, platform } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { getConfigRoot } from "./paths.js";

describe("config paths", () => {
  it("uses the explicit Mega wallet config override first", () => {
    expect(
      getConfigRoot({
        MEGA_WALLET_CLI_CONFIG_DIR: "/tmp/moss-wallet",
      }),
    ).toBe("/tmp/moss-wallet");
  });

  it("uses fixed platform defaults", () => {
    const expected =
      platform() === "win32"
        ? join(homedir(), "AppData", "Roaming", "megaeth", "wallet-cli")
        : platform() === "darwin"
          ? join(
              homedir(),
              "Library",
              "Application Support",
              "megaeth",
              "wallet-cli",
            )
          : join(homedir(), ".config", "megaeth", "wallet-cli");

    expect(getConfigRoot({})).toBe(expected);
  });
});
