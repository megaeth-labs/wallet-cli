import { Command } from "commander";

import { CliError, formatErrorMessage } from "./errors.js";

export const commandName = "mega";

export function createCli(): Command {
  const program = new Command();

  program
    .name(commandName)
    .description("MegaETH wallet CLI")
    .version("0.1.0")
    .showHelpAfterError()
    .exitOverride();

  const wallet = program.command("wallet").description("Manage MegaETH wallet workflows");

  wallet
    .command("login")
    .description("Authorize a local delegated key with the MegaETH wallet")
    .action(() => {
      throw new CliError("wallet login is not implemented yet");
    });

  wallet
    .command("whoami")
    .description("Show the active wallet account and delegated key")
    .action(() => {
      throw new CliError("wallet whoami is not implemented yet");
    });

  wallet
    .command("keys")
    .description("List locally known delegated keys")
    .action(() => {
      throw new CliError("wallet keys is not implemented yet");
    });

  wallet
    .command("logout")
    .description("Remove the local wallet profile")
    .action(() => {
      throw new CliError("wallet logout is not implemented yet");
    });

  wallet
    .command("call")
    .description("Run a read-only eth_call")
    .action(() => {
      throw new CliError("wallet call is not implemented yet");
    });

  wallet
    .command("execute")
    .description("Submit one or more write calls through the MegaETH relay")
    .action(() => {
      throw new CliError("wallet execute is not implemented yet");
    });

  wallet
    .command("transfer")
    .description("Transfer native ETH or ERC20 tokens through wallet execute")
    .action(() => {
      throw new CliError("wallet transfer is not implemented yet");
    });

  return program;
}

export async function runCli(argv = process.argv): Promise<void> {
  const program = createCli();

  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof Error && error.name === "CommanderError") {
      process.exitCode = Number("exitCode" in error ? error.exitCode : 1);
      return;
    }

    process.stderr.write(`${formatErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
