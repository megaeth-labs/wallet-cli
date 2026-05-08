---
name: mega-wallet-cli
description: Use the MegaETH Wallet CLI for local loopback login, profile inspection, read-only calls, relay-backed execution, and transfers.
---

# MegaETH Wallet CLI

Use this skill when an agent needs to operate a local MegaETH wallet through the
`mega` CLI.

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
mega wallet login --network testnet
```

The CLI opens MegaETH Wallet in the system browser, listens on
`127.0.0.1:<random-port>/callback`, validates `state`, and stores the approved
delegated-key profile locally. The callback must not contain private keys or
transferable bearer credentials.

## Inspect The Active Wallet

```bash
mega wallet whoami --network testnet --json
mega wallet keys --network testnet --json
```

Use these before writes to verify the account, delegated access address, expiry,
network, and approved permission limits.

## Read State

```bash
mega wallet call \
  --network testnet \
  --to 0x1234567890abcdef1234567890abcdef12345678 \
  --data 0x
```

`call` is read-only and should be the default for inspection.

## Execute Writes

```bash
mega wallet execute \
  --network testnet \
  --to 0x1234567890abcdef1234567890abcdef12345678 \
  --data 0x \
  --value 0
```

For multiple writes, pass `--calls ./calls.json`. Confirm that the requested
operation fits the approved delegated-key permissions before executing.

## Transfer Funds

Native ETH:

```bash
mega wallet transfer --network testnet --to 0xabcdefabcdefabcdefabcdefabcdefabcdefabcd --amount 0.1
```

ERC20:

```bash
mega wallet transfer \
  --network testnet \
  --token 0x1234567890abcdef1234567890abcdef12345678 \
  --to 0xabcdefabcdefabcdefabcdefabcdefabcdefabcd \
  --amount 100 \
  --decimals 18
```

`transfer` is a wrapper over `execute`; it is still a write operation.

## Logout

```bash
mega wallet logout --network testnet
```

Logout removes the local profile only. It does not revoke the delegated key
on-chain in v1.
