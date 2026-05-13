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
- `mega wallet login` connects this CLI install to that wallet account and
  stores the first approved delegated session key locally.
- `mega wallet create-key` asks the passkey wallet to approve another scoped
  session key for the same wallet account.
- Session keys can spend only within their approved expiry, token spend limits,
  fee allowance, and contract call scopes.
- The CLI signs with the delegated session key and submits writes through the
  MegaETH/Porto relay. It never has the user's passkey or root/admin key.
- `mega wallet revoke <key>` revokes a delegated key on-chain.
- `mega wallet logout` only deletes this CLI's local profile and delegated
  private key material.

## Setup

If `mega wallet --help` is unavailable and the wallet CLI checkout is present,
install the local CLI and this skill from the repo root:

```bash
./scripts/install.sh
```

For Claude support too, install the skill into both agent homes:

```bash
./scripts/install.sh --skill-agent all
```

After installing or updating a skill, restart the target agent process so it can
load the new instructions.

## Safety Rules

- Never print, log, request, or transmit private keys, bearer tokens, API keys,
  passkeys, WebAuthn material, or relay secrets.
- Treat profile files as local secrets. Do not copy profile contents into chat,
  issue comments, logs, or telemetry.
- Use `mega wallet call` for read-only `eth_call` workflows.
- Use `mega wallet execute` or `mega wallet transfer` only when the user asked
  for a state-changing operation.
- Prefer `--json` for machine-readable output and `-t` only for compact text.

## Login

Run loopback login on the same machine as the browser:

```bash
mega wallet login
```

The CLI opens MegaETH Wallet in the system browser, listens on
`127.0.0.1:<random-port>/callback`, validates `state`, and stores the approved
delegated-key profile locally. The callback must not contain private keys or
transferable bearer credentials.

Use login only to connect a wallet profile when none exists. If the CLI reports
`Wallet already connected to ...`, do not rerun login. Use
`mega wallet create-key` to add a delegated key to the existing profile, or
`mega wallet logout` only when the user explicitly wants this CLI install to
forget the local wallet profile.

Login defaults to `https://account.megaeth.com` and
`https://wallet-relay.megaeth.com`. Use `--wallet-url` only when deliberately
targeting a different wallet UI, and use `--relay-url` only for an explicit
non-canonical relay.

For local wallet UI auth testing, run the sibling wallet app as
`pnpm dev -- --host localhost --port 4000` from `../wallet`, and start this
repo's shim on port `4002`:

```bash
node scripts/loopback-e2e.mjs --shim-only --shim-port 4002 \
  --artifacts-dir .e2e/artifacts-local-debug \
  --config-dir .e2e/config-local-shim
```

Use `--mock-relay` only for no-chain E2E harness checks. For real
`grantPermissions` or revoke verification, omit `--mock-relay` so `/rpc`
proxies to the real relayer; mock mode can make the wallet UI report approval
without broadcasting an on-chain transaction. If approval succeeds but no relay
traffic appears, check that the browser origin is `http://localhost:4000` and
the wallet UI is using the local `4002` backend.

Default login permissions expire after one week, prefer USDM as the fee token
with a `1 USDM` allowance, and ask for a flat `100 USDM` spend cap over the
one-week authorization window. Approved broad-call keys are represented as
`permissions.calls: [{}]`, which allows arbitrary contract interactions bounded
by spend/fee/expiry limits. Use `--allow-call` or a custom permissions file when
a more restrictive protocol-specific key is required. For additional keys, use
`mega wallet create-key --spend-limit <amount>` to override the default USDM
spend cap. Use `--permissions ./permissions.json` to change fee token, call
scope, expiry, spend token, or spend period.

Only `mainnet` is enabled for now. Do not use `--network testnet`; the CLI
rejects it until the testnet wallet path is available.

## Inspect The Active Wallet

```bash
mega wallet whoami --json
mega wallet list --json
mega wallet permissions 0xKEY_OR_ACCESS_ADDRESS --json
```

Use these before writes to verify the account, delegated access address, expiry,
network, and approved permission limits.

## Manage Delegated Keys

```bash
mega wallet list --json
mega wallet list --show-inactive --json
mega wallet permissions 0xKEY_OR_ACCESS_ADDRESS --json
mega wallet switch 0xKEY_OR_ACCESS_ADDRESS
mega wallet create-key --label "agent"
mega wallet create-key --spend-limit 25 --label "agent"
mega wallet label 0xKEY_OR_ACCESS_ADDRESS "agent"
mega wallet revoke 0xKEY_OR_ACCESS_ADDRESS
```

Use `list` to inspect local keys. Revoked and expired keys are hidden unless
`--show-inactive` is present. Use `permissions` to inspect the exact approved
scope in plain English before a write.

Use `create-key` when no existing key has the requested scope; it opens the
browser/passkey loopback flow. Use `revoke` to revoke a key on-chain; the CLI
keeps an inactive audit record but removes local private key material.

## Custom Permission Files

Use `create-key --spend-limit <amount>` for a simple default USDM spend cap.
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

Spend permission is not call permission. A restrictive key with `calls: []`
cannot call `approve`, `transfer`, Aave `supply`, or other contract functions
even when it has token spend allowance. If the relay returns
`UnauthorizedCall`, inspect the target/function selector and create or switch to
a key with matching `--allow-call` scopes.

For custom permission files, use `permissions.calls: [{}]` for broad contract
call authority and `permissions.calls: []` only for an intentionally no-call key.

For Aave supply-style interactions, the key needs both spend permission for the
token being supplied and call permission for the ERC20 `approve` plus the Aave
pool `supply` call.

Example Aave USDM deposit call scopes on top of the default spend request:

```bash
mega wallet create-key \
  --spend-limit 100 \
  --allow-call '0xfafddbb3fc7688494971a79cc65dca3ef82079e7:approve(address,uint256)' \
  --allow-call '0x7e324AbC5De01d112AfC03a584966ff199741C28:supply(address,uint256,address,uint16)'
```

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

Logout deletes the local wallet profile for the selected network, including
locally stored delegated private key material and key-selection metadata. It
does not revoke delegated keys on-chain. Use `mega wallet revoke <key>` when
the user wants on-chain revocation; use `logout` only when the user explicitly
wants this CLI install to forget the wallet locally.
