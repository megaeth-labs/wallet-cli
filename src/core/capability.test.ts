import { describe, expect, it } from "vitest";

import { evaluateTransferAuthority } from "./capability.js";

const key = {
  id: "0x3333333333333333333333333333333333333333333333333333333333333333",
  accessAddress: "0x2222222222222222222222222222222222222222",
  privateKey: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  authorizedKey: {
    expiry: 1_900_000_000,
    type: "secp256k1",
    role: "session",
    publicKey: "0x2222222222222222222222222222222222222222",
    feeToken: { symbol: "ETH", limit: "1000000000000000" },
    permissions: {
      calls: [],
      spend: [],
    },
  },
  createdAt: "2026-05-07T00:00:00.000Z",
  updatedAt: "2026-05-07T00:00:00.000Z",
  status: "active",
} as const;

describe("transfer capability authority evaluation", () => {
  it("surfaces missing call and spend permission for ERC20 transfer", () => {
    const issues = evaluateTransferAuthority({
      key,
      token: "0x5555555555555555555555555555555555555555",
      profile: { keys: [key] } as never,
    });

    expect(issues.map((issue) => issue.code)).toEqual([
      "missing_call_permission",
      "missing_spend_permission",
    ]);
    expect(issues[0]?.suggestedAction).toContain("--allow-call");
    expect(issues[1]?.suggestedAction).toContain("--spend-limit");
  });

  it("surfaces requested key not found", () => {
    const issues = evaluateTransferAuthority({
      key: undefined,
      requestedKey: "missing-key",
      profile: { keys: [] } as never,
    });

    expect(issues[0]?.code).toBe("requested_key_not_found");
  });
});
