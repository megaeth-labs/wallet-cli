import { Command } from "commander";

import {
  assertHttpUrl,
  normalizeNetwork,
  type OutputWriter,
} from "./common.js";
import type { Network } from "../config/chains.js";
import { readWalletProfile, type HexString } from "../config/profile.js";
import { openSystemBrowser, type BrowserOpener } from "../auth/loopback.js";
import { compactAddress, formatFieldLines, toJson } from "../output.js";

export type FundCommandOptions = {
  json?: boolean;
  network?: string;
  open?: boolean;
  terse?: boolean;
  walletUrl?: string;
};

export type FundCommandResult = {
  accountAddress: HexString;
  fundingUrl: string;
  network: Network;
  opened: boolean;
};

export type FundCommandDependencies = {
  env?: NodeJS.ProcessEnv;
  openBrowser?: BrowserOpener;
  stdout?: OutputWriter;
};

export function registerFundCommand(
  wallet: Command,
  dependencies: FundCommandDependencies = {},
): void {
  wallet
    .command("fund")
    .description("Open the MegaETH wallet deposit flow for the active account")
    .option("--network <network>", "wallet network: mainnet or testnet")
    .option("--wallet-url <url>", "wallet UI URL")
    .option("--no-open", "print the funding URL without opening a browser")
    .option("--json", "print JSON output")
    .option("-t, --terse", "print compact output")
    .action(async (options: FundCommandOptions) => {
      await runWalletFund(options, dependencies);
    });
}

export async function runWalletFund(
  options: FundCommandOptions,
  dependencies: FundCommandDependencies = {},
): Promise<FundCommandResult> {
  const network = normalizeNetwork(options.network);
  const profile = await readWalletProfile(network, dependencies.env);
  const walletUrl = options.walletUrl ?? profile.walletUrl;
  assertHttpUrl(walletUrl, "wallet-url must be an HTTP(S) URL");
  const fundingUrl = buildFundingUrl({
    accountAddress: profile.accountAddress,
    network,
    walletUrl,
  });
  const shouldOpen = options.open !== false;

  if (shouldOpen) {
    await (dependencies.openBrowser ?? openSystemBrowser)(fundingUrl);
  }

  const result: FundCommandResult = {
    accountAddress: profile.accountAddress,
    fundingUrl,
    network,
    opened: shouldOpen,
  };

  renderFundResult(result, options, dependencies.stdout ?? process.stdout);

  return result;
}

export function buildFundingUrl(options: {
  accountAddress: HexString;
  network: Network;
  walletUrl: string;
}): string {
  const url = new URL("/deposit", options.walletUrl);
  url.searchParams.set("address", options.accountAddress);
  url.searchParams.set("network", options.network);
  url.searchParams.set("source", "mega-cli");

  return url.toString();
}

function renderFundResult(
  result: FundCommandResult,
  options: Pick<FundCommandOptions, "json" | "terse">,
  stdout: OutputWriter,
): void {
  if (options.json) {
    stdout.write(toJson(result));
    return;
  }

  if (options.terse) {
    stdout.write(
      [
        result.network,
        result.accountAddress,
        result.opened ? "opened" : "ready",
        result.fundingUrl,
      ]
        .join("\t")
        .concat("\n"),
    );
    return;
  }

  stdout.write(
    [
      result.opened ? "Funding page opened." : "Funding page ready.",
      ...formatFieldLines([
        ["Account", compactAddress(result.accountAddress)],
        ["Network", result.network],
        ["URL", result.fundingUrl],
      ]),
      "",
    ].join("\n"),
  );
}
