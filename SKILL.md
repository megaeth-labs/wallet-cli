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

Prefer the default browser-opened loopback flow. Use `--no-browser` only as a
fallback when the browser does not open automatically or when the user needs a
URL to copy manually. `--no-browser` is not headless auth; it still uses
same-machine loopback auth and waits for browser approval.

Device-code auth is not supported right now. Do not use `--auth-flow device`;
use loopback auth on the same machine as the browser.

For both browser-opened and `--no-browser` authorization flows, pass
`--timeout-ms 300000` when passkey approval may take longer than the default
120 seconds.

Authorization commands that use `--no-browser` are interactive waiting
processes. Do not choose them just to monitor auth; use normal browser-opened
flows first. If `--no-browser` is necessary, make sure your execution tool will
stream stdout/stderr immediately and keep the session open. Capture the printed
URL, show it to the user, and continue monitoring until the command completes,
times out, or the user asks you to stop. If you cannot monitor live output, do
not start the auth flow; tell the user the exact command to run locally instead.

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
`https://wallet-api.megaeth.com`, and `https://mainnet.megaeth.com/relay`. Use
`--wallet-url`, `--wallet-api-url`, or `--relay-url` only when deliberately
targeting non-canonical endpoints. Use `--network testnet` for the wallet
testnet profile and chain config.

Create-key defaults keep the approval simple: one-week expiry, network-specific
USDM as the fee token, a `100 USDM` workflow spend cap, and a `1 USDM` fee
buffer merged into the USDM spend cap over the one-week authorization window.
The agent must provide call scope with `--allow-call <target:signature>`, copy a
known-good key with `--from`, or pass a complete `--permissions
./permissions.json` file. Do not create workflow keys with implicit broad call
authority. Use the narrowest call and spend scope that covers the requested
workflow.

Use `mega wallet create-key --spend-limit <token_address>:<amount>:<period>
--allow-call ...` to add explicit spend rows. Token must be a 20-byte address;
use `0x0000000000000000000000000000000000000000` for native ETH. Amount is the
human token amount, and period is `minute`, `hour`, `day`, `week`, `month`, or
`year`. Repeat `--spend-limit` for multiple spend rows. Custom permission files
must include a non-empty `permissions.calls` array. Never omit
`permissions.calls`; omitted calls have produced keys that the relay rejects for
writes. Each call entry must include both `to` and `signature`.

Use `--fee-token <symbol>` and optional `--fee-limit <amount>` on `create-key`
when the delegated key should pay relay fees with a token other than the default
USDM. The CLI adds that fee buffer to `permissions.spend` for the selected fee
token before requesting approval.

Relay fees use the same spend accounting as token/native movement. The CLI does
not implement `maxFeesUSD`, and `feeToken.limit` is not an on-chain permission
by itself. Make sure the approved `permissions.spend` includes enough capacity
for both the workflow amount and expected relay fees in the selected fee token.
`feeToken.symbol` selects the preferred fee token for later writes; when
`feeToken.limit` is present for a known token, the CLI adds or merges that
amount into `permissions.spend` before requesting approval.

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
  --spend-limit 0xfafddbb3fc7688494971a79cc65dca3ef82079e7:25:week \
  --allow-call '0xfafddbb3fc7688494971a79cc65dca3ef82079e7:transfer(address,uint256)' \
  --label "agent"
mega wallet label 0xKEY_OR_ACCESS_ADDRESS "agent"
mega wallet revoke 0xKEY_OR_ACCESS_ADDRESS
mega wallet revoke 0xKEY_OR_ACCESS_ADDRESS --fee-token USDm
```

Use `list` to inspect local keys. Revoked and expired keys are hidden unless
`--show-inactive` is present. Use `permissions` to inspect the exact approved
scope and remaining on-chain spend before a write. Plain-text output separates
the stored approved scope from live on-chain spend remaining. When operating on
testnet, pass `--network testnet` consistently on login, create-key,
inspection, writes, revoke, fund, and logout commands.

Use `create-key` when no existing key has the requested scope; it opens the
browser/passkey approval flow and requires explicit call scope unless using
`--from` or `--permissions`. Device-code auth is not supported right now, so
create-key and revoke authorization require same-machine loopback auth. Use
`revoke` to revoke a key on-chain; the CLI keeps an inactive audit record but
removes local private key material. Revoke defaults to the key's stored fee
token; pass `--fee-token` if the wallet needs to pay the revoke transaction
with a different relay fee token.

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
not omit `permissions.calls`; use explicit `--allow-call <target:signature>`
scopes or permission-file call entries with both `to` and `signature`.

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
