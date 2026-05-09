import {
  encodeAbiParameters,
  encodeFunctionData,
  encodeFunctionResult,
} from "viem";
import { describe, expect, it } from "vitest";

import type { EthCallClient, HexString } from "./client.js";
import {
  erc20DecimalsAbi,
  erc20SymbolAbi,
  readErc20Decimals,
  readErc20Metadata,
  readErc20Symbol,
} from "./erc20.js";

const token = "0x1234567890abcdef1234567890abcdef12345678";

describe("ERC20 helpers", () => {
  it("reads ERC20 decimals and symbol metadata", async () => {
    const client = fakeCallClient({
      [encodeFunctionData({ abi: erc20DecimalsAbi, functionName: "decimals" })]:
        encodeFunctionResult({
          abi: erc20DecimalsAbi,
          functionName: "decimals",
          result: 6,
        }),
      [encodeFunctionData({ abi: erc20SymbolAbi, functionName: "symbol" })]:
        encodeFunctionResult({
          abi: erc20SymbolAbi,
          functionName: "symbol",
          result: "USDM",
        }),
    });

    await expect(readErc20Metadata(client, token)).resolves.toEqual({
      decimals: 6,
      symbol: "USDM",
    });
  });

  it("supports bytes32 symbols returned by older ERC20s", async () => {
    const symbolData = encodeAbiParameters(
      [{ type: "bytes32" }],
      ["0x5553444d00000000000000000000000000000000000000000000000000000000"],
    );

    await expect(
      readErc20Symbol(
        fakeCallClient({
          [encodeFunctionData({ abi: erc20SymbolAbi, functionName: "symbol" })]:
            symbolData,
        }),
        token,
      ),
    ).resolves.toBe("USDM");
  });

  it("fails clearly when decimals returns invalid data", async () => {
    await expect(
      readErc20Decimals(
        fakeCallClient({
          [encodeFunctionData({
            abi: erc20DecimalsAbi,
            functionName: "decimals",
          })]: "0x",
        }),
        token,
      ),
    ).rejects.toThrow("ERC20 decimals() returned invalid data");
  });
});

function fakeCallClient(responses: Record<string, HexString>): EthCallClient {
  return {
    async call(request) {
      const response = responses[request.data];
      if (response === undefined) {
        throw new Error(`unexpected call data ${request.data}`);
      }

      return response;
    },
  };
}
