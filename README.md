# MegaETH Wallet CLI

MegaETH Wallet CLI lets a local machine use delegated session keys for a
MegaETH passkey wallet. The CLI generates delegated secp256k1 keys locally,
opens MegaETH Wallet for passkey approval, receives public approval metadata,
and stores the approved local profile with private key material on the same
machine.

Use `mega wallet <command>` as the canonical command shape. The standalone
`wallet` binary is kept as a compatibility shortcut.

## Install

From this checkout:

```bash
./scripts/install.sh
```

The installer builds the CLI, installs a versioned release under
`~/.mega/wallet-cli/releases/`, updates `~/.mega/wallet-cli/current`, writes
`mega` and `wallet` wrappers into `~/.local/bin`, and installs the agent skill
bundle. It checks Node.js `>=22` and pnpm before building. Add `~/.local/bin` to
`PATH` if needed.

Update by pulling the checkout and rerunning the installer:

```bash
git pull
./scripts/install.sh --force-skill
```

Remove the local install:

```bash
./scripts/uninstall.sh
```

Pass `--config` to also remove local wallet profiles and delegated private key
material:

```bash
./scripts/uninstall.sh --config
```

Use `--help` on installer scripts for custom paths, dry runs, and skill-only
installs.

## Login

```bash
mega wallet login
```

Login opens MegaETH Wallet at `https://account.megaeth.com`, asks the passkey
wallet to approve a delegated session key, and stores the approved profile
locally. The relay default is `https://wallet-relay.megaeth.com`.

Mainnet is the default network. Pass `--network testnet` to use the separate
testnet profile and chain config:

```bash
mega wallet login --network testnet
mega wallet whoami --network testnet
```

By default, browser authorization uses same-machine loopback. For headless,
SSH, container, or remote environments, use the device-style flow:

```bash
mega wallet login --auth-flow device --no-browser
```

The CLI prints:

```text
Running headless? Go to https://account.megaeth.com/cli-auth and input this code - XXXX-XXXX
```

Open that URL on any browser-capable device, enter the code, approve with the
wallet passkey, and leave the CLI running until approval completes. The
delegated private key and PKCE verifier stay on the CLI machine; the browser
and backend only receive public request/approval metadata.

Default permissions are agent-oriented: one-week expiry, network-specific USDM
fee token with a `1 USDM` fee allowance, `100 USDM` spend cap for the
authorization window, and explicit broad contract call authority represented as
`permissions.calls: [{}]`.

Fee allowances are token-denominated. A `maxFeesUSD` permission field is not
implemented by the CLI; set `feeToken.limit` to the approved amount of
`feeToken.symbol` instead.

If a profile already exists, `login` exits before opening the browser. Use
`mega wallet create-key` to add another delegated key, or `mega wallet logout`
to forget the local profile.

## Keys

Inspect the active account and default delegated key:

```bash
mega wallet whoami
mega wallet whoami --json
```

List locally known delegated keys:

```bash
mega wallet list
mega wallet list --show-inactive
```

Show a key's approved scope:

```bash
mega wallet permissions 0xKEY_OR_ACCESS_ADDRESS
```

Create a new delegated key:

```bash
mega wallet create-key --label "agent"
mega wallet create-key --spend-limit 25 --label "agent"
mega wallet create-key --auth-flow device --no-browser --label "agent"
```

`--spend-limit` accepts a human USDM amount and preserves the network-specific
default fee token, expiry, spend period, and broad call authority. Use
`--permissions ./permissions.json` only for custom expiry, fee token, spend
token, spend period, no-spend, or custom call scope. See
[references/permissions.md](references/permissions.md) for that file schema.

Switch or label local keys:

```bash
mega wallet switch 0xKEY_OR_ACCESS_ADDRESS
mega wallet label 0xKEY_OR_ACCESS_ADDRESS "agent"
```

Revoke a delegated key on-chain:

```bash
mega wallet revoke 0xKEY_OR_ACCESS_ADDRESS
mega wallet revoke 0xKEY_OR_ACCESS_ADDRESS --auth-flow device --no-browser
```

`revoke` opens MegaETH Wallet for passkey confirmation. After success, the CLI
removes local private key material for that key but keeps an inactive audit
record. `logout` is local-only and does not revoke keys on-chain.

## Reads

Use `call` for read-only `eth_call` workflows:

```bash
mega wallet call \
  --to 0x1234567890abcdef1234567890abcdef12345678 \
  --data 0x
```

ABI mode is also supported:

```bash
mega wallet call \
  --to 0x1234567890abcdef1234567890abcdef12345678 \
  --abi ./erc20.json \
  --function balanceOf \
  --args '["0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"]'
```

`call` does not submit relay writes or require a write-capable delegated key.

## Writes

Use `execute` for state-changing calls through the MegaETH/Porto relay:

```bash
mega wallet execute \
  --to 0x1234567890abcdef1234567890abcdef12345678 \
  --data 0x \
  --value 0
```

For multiple calls:

```bash
mega wallet execute --calls ./calls.json
```

For a selected stored key:

```bash
mega wallet execute --key 0xKEY_OR_ACCESS_ADDRESS --calls ./calls.json
```

Spend permission is not call permission. Empty call permissions create keys
that cannot execute relay-backed writes, including native ETH transfers. Custom
permission files with `permissions.calls: []` are rejected; use
`permissions.calls: [{}]` for broad authority or include explicit call scopes.

## Transfers

`transfer` is a convenience wrapper over `execute`.

Native ETH:

```bash
mega wallet transfer \
  --to 0xabcdefabcdefabcdefabcdefabcdefabcdefabcd \
  --amount 0.1
```

ERC20:

```bash
mega wallet transfer \
  --token 0x1234567890abcdef1234567890abcdef12345678 \
  --to 0xabcdefabcdefabcdefabcdefabcdefabcdefabcd \
  --amount 100
```

The CLI reads ERC20 decimals from RPC by default. Use `--decimals` only when an
explicit override is needed.

## Funding And Debugging

Open the wallet deposit flow:

```bash
mega wallet fund
```

Inspect local profile health without printing private key material:

```bash
mega wallet debug
mega wallet debug --skip-chain --json
```

For complete options on any command, use:

```bash
mega wallet <command> --help
```

## Development

```bash
pnpm build
pnpm test
pnpm typecheck
pnpm lint
pnpm install:local -- --dry-run
pnpm install:skill -- --dry-run
pnpm uninstall:local -- --dry-run
```
