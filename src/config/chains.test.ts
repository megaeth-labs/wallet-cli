import { describe, expect, it } from "vitest";

import { getDefaultRpcUrl } from "../eth/client.js";
import { getChainConfig, isNetwork, networks } from "./chains.js";

describe("chain configuration", () => {
  it("supports mainnet and testnet chain metadata", () => {
    expect(networks).toEqual(["mainnet", "testnet"]);
    expect(isNetwork("mainnet")).toBe(true);
    expect(isNetwork("testnet")).toBe(true);
    expect(isNetwork("devnet")).toBe(false);

    expect(getChainConfig("mainnet")).toMatchObject({
      chainId: 4326,
      name: "MegaETH Mainnet",
      rpcUrl: "https://mainnet.megaeth.com/rpc",
      defaultFeeToken: {
        address: "0xfafddbb3fc7688494971a79cc65dca3ef82079e7",
        symbol: "USDM",
      },
    });
    expect(getChainConfig("testnet")).toMatchObject({
      chainId: 6343,
      name: "MegaETH Testnet",
      rpcUrl: "https://carrot.megaeth.com/rpc",
      defaultFeeToken: {
        address: "0x15e9f2b0a747ac05c7446559306687085d161e5c",
        symbol: "USDM",
      },
    });
    expect(getDefaultRpcUrl("testnet")).toBe("https://carrot.megaeth.com/rpc");
  });
});
