---
name: mega-wallet-cli
description: Use the MegaETH Wallet CLI to connect a MegaETH passkey wallet, create/manage scoped delegated session keys, inspect permissions, and use those keys for read-only calls, transfers, and relay-backed execution on MegaETH.
---

# MegaETH Wallet CLI

Use this skill when an agent needs to operate a local MegaETH wallet through
`mega wallet` commands.

## Mental Model

MegaETH Wallet CLI is not a root wallet or passkey manager. It is a local tool
for creating, managing, and using scoped delegated session keys for a MegaETH
wallet account.

- The wallet account is an EVM address on MegaETH controlled by the user's
  passkey wallet at `account.megaeth.com`.
- Commands default to mainnet. Add `--network testnet` when the user explicitly
  asks for testnet; local profiles are separate per network.
- `mega wallet login` connects this CLI install to that wallet account and
  stores an account profile locally. It does not create a delegated session key.
- `mega wallet create-key` generates a delegated key locally and asks the
  passkey wallet to approve a scoped session key for the same wallet account.
- Session keys can spend only within their approved expiry, token spend limits,
  fee allowance, and contract call scopes.
- The CLI signs with the delegated session key and submits writes through the
  MegaETH/Porto relay. It never has the user's passkey or root/admin key.
- `mega wallet revoke <key>` revokes a delegated key on-chain.
- `mega wallet logout` only deletes this CLI's local profile and delegated
  private key material.

## Setup

If `mega wallet --help` is unavailable, install the wallet CLI with the public
installer:

```bash
curl -fsSL https://account.megaeth.com/install | sh
```

After install, make sure the install directory printed by the installer is on
`PATH`, then rerun `mega wallet --help`.

## Safety Rules

- Never print, log, request, or transmit private keys, bearer tokens, API keys,
  passkeys, WebAuthn material, or relay secrets.
- Treat profile files as local secrets. Do not copy profile contents into chat,
  issue comments, logs, or telemetry.
- Use `mega wallet call` for read-only `eth_call` workflows.
- Use `mega wallet execute` or `mega wallet transfer` only when the user asked
  for a state-changing operation.
- Prefer `--json` for machine-readable output and `-t` only for compact text.

## Login And Browser Authorization

Run loopback login on the same machine as the browser:

```bash
mega wallet login
```

The CLI opens MegaETH Wallet in the system browser, listens on
`127.0.0.1:<random-port>/callback`, validates `state`, and stores the approved
account profile locally. The callback must not contain private keys or
transferable bearer credentials. Login alone is not enough for writes; create a
scoped delegated key before `execute` or `transfer`.

`--auth-flow` selects the authorization protocol. `--no-browser` only prevents
the CLI from opening the browser automatically and prints the authorization URL
instead. For example, `mega wallet login --no-browser` still uses same-machine
loopback auth; use `--auth-flow device` when the browser is not on the CLI
machine.

For both browser-opened and `--no-browser` authorization flows, pass
`--timeout-ms 300000` when passkey approval may take longer than the default
120 seconds.

Authorization commands that use `--no-browser` are interactive waiting
processes. Do not run them as unmonitored foreground shell commands: the printed
URL/code can be lost while the process keeps waiting for browser approval.
Before starting `login`, `create-key`, or `revoke` with `--no-browser`, make
sure your execution tool will stream stdout/stderr immediately and keep the
session open for polling. Capture the printed URL/code, show it to the user, and
continue monitoring until the command completes, times out, or the user asks you
to stop. If you cannot monitor live output, do not start the auth flow; tell the
user the exact command to run locally instead.

For headless, SSH, container, or remote CLI environments, use device-style auth:

```bash
mega wallet login --auth-flow device --no-browser --timeout-ms 300000
```

The CLI prints an authorization URL and a verification code:

```text
Running headless? Go to https://account.megaeth.com/cli-auth and input this code - XXXX-XXXX
```

Open the URL in a browser, enter the code, approve with the wallet passkey, and
leave the CLI running until approval completes. PKCE remains on the CLI machine;
`create-key` delegated private keys do too.

Use login only to connect a wallet profile when none exists. If the CLI reports
`Wallet already connected to ...`, do not rerun login. Use
`mega wallet create-key` to add a delegated key to the existing profile, or
`mega wallet logout` only when the user explicitly wants this CLI install to
forget the local wallet profile.

If `create-key` fails because the authorized wallet account does not match the
local profile, run `mega wallet whoami`, then ask the user to switch the browser
wallet/profile to that account. `mega wallet logout` deletes the local profile
and delegated private key material; run it only after the user explicitly
approves reconnecting this CLI to a different wallet.

Login defaults to mainnet, `https://account.megaeth.com`,
`https://wallet-api.megaeth.com`, and `https://wallet-relay.megaeth.com`. Use
`--wallet-url`, `--wallet-api-url`, or `--relay-url` only when deliberately
targeting non-canonical endpoints. Use `--network testnet` for the wallet
testnet profile and chain config.

Create-key defaults keep the approval simple: one-week expiry, network-specific
USDM as the fee token with a `1 USDM` allowance, and a flat `100 USDM` spend cap
over the one-week authorization window. The agent must provide call scope with
`--allow-call <target:signature>`, copy a known-good key with `--from`, or pass
a complete `--permissions ./permissions.json` file. Do not create workflow keys
with implicit broad call authority. If broad authority is explicitly intended,
represent it as `permissions.calls: [{}]` in a permissions file.

Use `mega wallet create-key --spend-limit <amount> --allow-call ...` to
override the default USDM spend cap while preserving the default fee token,
expiry, spend token, and spend period. Custom permission files must include a
non-empty `permissions.calls` array. Never omit `permissions.calls`; omitted
calls have produced keys that the relay rejects for writes.

Fee limits are token-denominated. The CLI does not implement `maxFeesUSD`; use
`feeToken.limit` for the amount of `feeToken.symbol` the key may spend on relay
fees. Fee token encoding is symbol-based; for native ETH relay fees use
`"feeToken": { "limit": "0.001", "symbol": "ETH" }`. This differs from native
ETH spend permissions, where the spend entry omits `token`.

## Inspect The Active Wallet

```bash
mega wallet whoami --json
mega wallet list --json
mega wallet permissions 0xKEY_OR_ACCESS_ADDRESS --json
```

Use these before writes to verify the account, delegated access address, expiry,
approved permission limits, and current on-chain spend remaining. If you only
have a shortened key id from plain text output, run `mega wallet list --json`
and copy the full `accessAddress` into `mega wallet permissions`.
In `permissions --json`, treat `authorizedKey.permissions.spend` as the stored
request and `spendInfos[].remaining` as the live execution capacity.
`spendInfos` is Porto/account spend accounting, so it can include relay
fee-token allowance even when `authorizedKey.permissions.spend` is empty.

## Manage Delegated Keys

```bash
mega wallet list --json
mega wallet list --show-inactive --json
mega wallet permissions 0xKEY_OR_ACCESS_ADDRESS --json
mega wallet switch 0xKEY_OR_ACCESS_ADDRESS
mega wallet create-key \
  --allow-call '0xfafddbb3fc7688494971a79cc65dca3ef82079e7:transfer(address,uint256)' \
  --label "usdm-transfer"
mega wallet create-key \
  --spend-limit 25 \
  --allow-call '0xfafddbb3fc7688494971a79cc65dca3ef82079e7:transfer(address,uint256)' \
  --label "agent"
mega wallet create-key --auth-flow device --no-browser --timeout-ms 300000 \
  --allow-call '0xfafddbb3fc7688494971a79cc65dca3ef82079e7:transfer(address,uint256)' \
  --label "agent"
mega wallet label 0xKEY_OR_ACCESS_ADDRESS "agent"
mega wallet revoke 0xKEY_OR_ACCESS_ADDRESS
mega wallet revoke 0xKEY_OR_ACCESS_ADDRESS \
  --auth-flow device \
  --no-browser \
  --timeout-ms 300000
```

Use `list` to inspect local keys. Revoked and expired keys are hidden unless
`--show-inactive` is present. Use `permissions` to inspect the exact approved
scope and remaining on-chain spend before a write. Plain-text output separates
the stored approved scope from live on-chain spend remaining. When operating on
testnet, pass `--network testnet` consistently on login, create-key,
inspection, writes, revoke, fund, and logout commands.

Use `create-key` when no existing key has the requested scope; it opens the
browser/passkey approval flow and requires explicit call scope unless using
`--from` or `--permissions`. Use `--auth-flow device --no-browser` for headless
create-key or revoke authorization. Use `revoke` to revoke a key on-chain; the
CLI keeps an inactive audit record but removes local private key material.

## Custom Permission Files

Read [references/permissions.md](references/permissions.md) only when building
`--permissions ./permissions.json` files or debugging permission schema errors.

## Read State

```bash
mega wallet call \
  --to 0x1234567890abcdef1234567890abcdef12345678 \
  --data 0x
```

`call` is read-only and should be the default for inspection.
If `--from` is omitted, the CLI uses the logged-in wallet account when a local
profile exists. Pass `--from 0x...` only when a different simulation address is
needed.

## Execute Writes

```bash
mega wallet execute \
  --to 0x1234567890abcdef1234567890abcdef12345678 \
  --data 0x \
  --value 0
```

For multiple writes, pass `--calls ./calls.json`. Pass
`--key 0xKEY_OR_ACCESS_ADDRESS` only when the user has approved using a
non-default stored key. Confirm that the requested operation fits the approved
delegated-key permissions before executing.

When hand-writing raw calldata or `--allow-call` signatures, verify the
function selector first with an ABI encoder or `cast sig`; mismatched selectors
cause permission rejections or wrong calls.

> **ERC20 approvals must be bundled.** On the MegaETH relay, a standalone
> `approve` is reset at end-of-transaction. Always include `approve` and its
> consuming call in the same `--calls` array.

Spend permission is not call permission. A key with `calls: []` or omitted
`permissions.calls` cannot execute relay-backed writes, including native ETH
transfers, even when it has spend allowance. Do not request `calls: []` and do
not omit `permissions.calls`; use `permissions.calls: [{}]` for broad contract
authority or explicit `--allow-call` scopes for restrictive keys.

For workflows that move ERC20 value through another contract, the key usually
needs both spend permission for the token and call permission for each contract
function it invokes, such as ERC20 `approve` plus the downstream protocol call.

### Common Patterns

ERC20 approve plus protocol call, such as Aave supply or a swap:

```json
[
  {
    "to": "<TOKEN>",
    "data": "0x<approve(spender,amount) calldata>",
    "value": "0"
  },
  {
    "to": "<PROTOCOL>",
    "data": "0x<supply/swap/deposit calldata>",
    "value": "0"
  }
]
```

Use one `mega wallet execute --calls ./calls.json` command for the array above.
Do not split approval and consumption across two `execute` calls.

## Transfer Funds

Native ETH:

```bash
mega wallet transfer --to 0xabcdefabcdefabcdefabcdefabcdefabcdefabcd --amount 0.1
```

ERC20:

```bash
mega wallet transfer \
  --token 0x1234567890abcdef1234567890abcdef12345678 \
  --to 0xabcdefabcdefabcdefabcdefabcdefabcdefabcd \
  --amount 100
```

`transfer` is a wrapper over `execute`; it is still a write operation.
For ERC20s, the CLI reads token decimals from RPC unless `--decimals` is
provided.
Pass `--key 0xKEY_OR_ACCESS_ADDRESS` only when the user has approved using a
specific non-default delegated key.

## Fund The Wallet

```bash
mega wallet fund
mega wallet fund --no-open --json
```

`fund` opens or prints the wallet deposit URL for the active account. It does
not transfer funds by itself.

## Debug

```bash
mega wallet debug --json
mega wallet debug --skip-chain --json
```

Use `debug` to inspect profile path/mode, account, delegated key expiry, native
balance, and relay key status. Do not print or copy profile files.

## Logout

```bash
mega wallet logout
```

Logout deletes the local wallet profile, including locally stored delegated
private key material and key-selection metadata. It does not revoke delegated
keys on-chain. Use `mega wallet revoke <key>` when the user wants on-chain
revocation; use `logout` only when the user explicitly wants this CLI install to
forget the wallet locally.
