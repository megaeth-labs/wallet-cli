# MegaETH Wallet CLI

MegaETH Wallet CLI exposes local delegated-key wallet workflows for developers
and agents. The CLI is designed for native-app loopback authorization: it
generates a delegated secp256k1 key locally, opens MegaETH Wallet in the system
browser, receives approval metadata on `127.0.0.1`, and stores the approved
profile on the local machine.

The package exposes the `mega` binary after build:

```bash
pnpm install
pnpm build
node dist/index.js --help
```

## Loopback Limitation

`mega wallet login` is local-machine only. The browser and CLI process must run
on the same computer because MegaETH Wallet redirects to a random
`http://127.0.0.1:<port>/callback` URL owned by the CLI. The callback carries
public approval metadata and a high-entropy `state`; it never carries the
delegated private key, API keys, bearer tokens, or passkey material.

PKCE is not part of v1 because the browser does not return a bearer token or a
transferable authorization code. The CLI-generated private key remains local and
the wallet approves that key through the MegaETH/Porto account flow.

## Commands

### Login

Authorize a local delegated key and save the approved profile:

```bash
mega wallet login --network testnet
mega wallet login \
  --network testnet \
  --wallet-url https://wallet.megaeth.com \
  --relay-url https://relay.megaeth.com \
  --allow-call 0x1234567890abcdef1234567890abcdef12345678:transfer(address,uint256)
```

Use `--permissions ./permissions.json` for a full permission object when a
single `--allow-call` entry is not enough. Login writes one active default
profile per network with file mode `0600`.

### Whoami

Show the active wallet account, delegated key, network, expiry, and derived
permission summary:

```bash
mega wallet whoami --network testnet
mega wallet whoami --network testnet --json
mega wallet whoami --network testnet -t
```

`whoami` never prints the private key. If no profile exists, run
`mega wallet login --network <network>` first.

### Keys

List locally known delegated keys and approved limits:

```bash
mega wallet keys --network testnet
mega wallet keys --network testnet --json
mega wallet keys --network testnet -t
```

`keys` reports local delegated/access keys, not passkey credentials.

### Logout

Remove the local profile for a network:

```bash
mega wallet logout --network testnet
mega wallet logout --network testnet -t
```

Logout is local-only in v1. It does not revoke the key on-chain.

## Read-Only Calls

`call` performs `eth_call`. It reads chain state and does not submit a
transaction through the relay:

```bash
mega wallet call \
  --network testnet \
  --to 0x1234567890abcdef1234567890abcdef12345678 \
  --data 0x70a08231000000000000000000000000abcdefabcdefabcdefabcdefabcdefabcdefabcd

mega wallet call \
  --network testnet \
  --to 0x1234567890abcdef1234567890abcdef12345678 \
  --abi ./erc20.json \
  --function balanceOf \
  --args '["0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"]'
```

Use `call` for read-only inspection. It does not require a write-capable
permission grant.

## Write Execution

`execute` submits one or more state-changing calls through the MegaETH/Porto
relay using the locally delegated key:

```bash
mega wallet execute \
  --network testnet \
  --to 0x1234567890abcdef1234567890abcdef12345678 \
  --data 0xa9059cbb000000000000000000000000abcdefabcdefabcdefabcdefabcdefabcdefabcd0000000000000000000000000000000000000000000000000000000000000001 \
  --value 0

mega wallet execute --network testnet --calls ./calls.json
```

Use `execute` only for writes. The relay prepares calls, the CLI signs with the
delegated key reconstructed from the local profile, the relay sends the prepared
calls, and the CLI polls until the status is terminal. Permission failures are
reported as delegated-key authorization errors.

`calls.json` contains the same call shape accepted by `execute`:

```json
[
  {
    "to": "0x1234567890abcdef1234567890abcdef12345678",
    "data": "0x",
    "value": "0"
  }
]
```

## Transfers

`transfer` is a convenience wrapper over `execute`.

Native ETH transfer:

```bash
mega wallet transfer \
  --network testnet \
  --to 0xabcdefabcdefabcdefabcdefabcdefabcdefabcd \
  --amount 0.1
```

ERC20 transfer:

```bash
mega wallet transfer \
  --network testnet \
  --token 0x1234567890abcdef1234567890abcdef12345678 \
  --to 0xabcdefabcdefabcdefabcdefabcdefabcdefabcd \
  --amount 100 \
  --decimals 18
```

## Agent Usage

Agents should prefer deterministic output:

```bash
mega wallet whoami --network testnet --json
mega wallet keys --network testnet --json
mega wallet call --network testnet --to 0x... --data 0x... --json
mega wallet transfer --network testnet --to 0x... --amount 0.01 --json
```

Use `-t` only when compact text is easier to route through a shell pipeline.
Never request, print, persist outside the CLI profile, or transmit the delegated
private key. Treat `call` as the read path and `execute` or `transfer` as write
paths that can spend funds or mutate state.

## Development

```bash
pnpm build
pnpm test
pnpm typecheck
pnpm lint
```

The v1 command surface is scaffolded incrementally across orchestration tasks.
This documentation defines the intended CLI contract; implementation tasks fill
in the command behavior behind the same `mega wallet ...` entry points.
