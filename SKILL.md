---
name: mega-wallet-cli
description: Use the MegaETH Wallet CLI for local loopback login, profile inspection, read-only calls, relay-backed execution, and transfers.
---

# MegaETH Wallet CLI

Use this skill when an agent needs to operate a local MegaETH wallet through the
`wallet` CLI.

## Safety Rules

- Never print, log, request, or transmit private keys, bearer tokens, API keys,
  passkeys, WebAuthn material, or relay secrets.
- Treat profile files as local secrets. Do not copy profile contents into chat,
  issue comments, logs, or telemetry.
- Use `wallet call` for read-only `eth_call` workflows.
- Use `wallet execute` or `wallet transfer` only when the user asked
  for a state-changing operation.
- Prefer `--json` for machine-readable output and `-t` only for compact text.

## Login

Run loopback login on the same machine as the browser:

```bash
wallet login
```

The CLI opens MegaETH Wallet in the system browser, listens on
`127.0.0.1:<random-port>/callback`, validates `state`, and stores the approved
delegated-key profile locally. The callback must not contain private keys or
transferable bearer credentials.

Login defaults to `https://account.megaeth.com` and
`https://wallet-relay.megaeth.com`. Use `--wallet-url` only when testing a local
wallet UI, and use `--relay-url` only for an explicit non-canonical relay.

Default login permissions expire after one week, use ETH as the fee token with
a `0.01 ETH` allowance, and ask for a flat `100 USDM/week` spending limit. Use
a custom permissions file when the user needs narrower or different limits.

Only `mainnet` is enabled for now. Do not use `--network testnet`; the CLI
rejects it until the testnet wallet path is available.

## Inspect The Active Wallet

```bash
wallet whoami --json
wallet keys --json
```

Use these before writes to verify the account, delegated access address, expiry,
network, and approved permission limits.

## Read State

```bash
wallet call \
  --to 0x1234567890abcdef1234567890abcdef12345678 \
  --data 0x
```

`call` is read-only and should be the default for inspection.

## Execute Writes

```bash
wallet execute \
  --to 0x1234567890abcdef1234567890abcdef12345678 \
  --data 0x \
  --value 0
```

For multiple writes, pass `--calls ./calls.json`. Confirm that the requested
operation fits the approved delegated-key permissions before executing.

## Transfer Funds

Native ETH:

```bash
wallet transfer --to 0xabcdefabcdefabcdefabcdefabcdefabcdefabcd --amount 0.1
```

ERC20:

```bash
wallet transfer \
  --token 0x1234567890abcdef1234567890abcdef12345678 \
  --to 0xabcdefabcdefabcdefabcdefabcdefabcdefabcd \
  --amount 100 \
  --decimals 18
```

`transfer` is a wrapper over `execute`; it is still a write operation.

## Logout

```bash
wallet logout
```

Logout removes the local profile only. It does not revoke the delegated key
on-chain in v1.
