# MegaETH Wallet CLI

MegaETH Wallet CLI exposes local delegated-key wallet workflows for developers
and agents. The CLI is designed for native-app loopback authorization: it
generates a delegated secp256k1 key locally, opens MegaETH Wallet in the system
browser, receives approval metadata on `127.0.0.1`, and stores the approved
profile on the local machine.

The package exposes both binaries after build:

- `wallet`: wallet commands at the root, e.g. `wallet login`
- `mega`: namespaced commands, e.g. `mega wallet login`

```bash
pnpm install
pnpm build
npm link
wallet --help
```

## Functional Regression E2E

The CLI has a functional regression suite that replays the command matrix used
for manual wallet testing. It uses the active local CLI profile, generates
temporary ABI/call fixtures under `.e2e/functional/`, and runs validation plus
read-only Aave/USDM calls by default:

```bash
pnpm e2e:functional
```

To include paid relay writes, use the explicit write mode:

```bash
pnpm e2e:functional:writes
```

Write mode requires an active profile whose delegated key has these call scopes:

```bash
wallet login \
  --allow-call '0xfafddbb3fc7688494971a79cc65dca3ef82079e7:transfer(address,uint256)' \
  --allow-call '0xfafddbb3fc7688494971a79cc65dca3ef82079e7:approve(address,uint256)' \
  --allow-call '0x7e324AbC5De01d112AfC03a584966ff199741C28:supply(address,uint256,address,uint16)' \
  --allow-call '0x7e324AbC5De01d112AfC03a584966ff199741C28:withdraw(address,uint256,address)'
```

Paid write mode sends tiny USDM transactions, but relay fees still debit the
test wallet. Use `--include-timeout` only when explicitly testing timeout UX; it
submits another paid bundle and expects the CLI to time out locally.

## Loopback Limitation

`wallet login` is local-machine only. The browser and CLI process must run
on the same computer because MegaETH Wallet redirects to a random
`http://127.0.0.1:<port>/callback` URL owned by the CLI. The callback carries
public approval metadata and a high-entropy `state`; it never carries the
delegated private key, API keys, bearer tokens, or passkey material.

PKCE is not part of v1 because the browser does not return a bearer token or a
transferable authorization code. The CLI-generated private key remains local and
the wallet approves that key through the MegaETH/Porto account flow.

## Network Support

Only `mainnet` is enabled for now. `--network testnet` is intentionally fenced
off until the testnet wallet and relay path are known.

## Commands

### Login

Authorize a local delegated key and save the approved profile:

```bash
wallet login
wallet login \
  --wallet-url http://127.0.0.1:4000 \
  --allow-call 0x1234567890abcdef1234567890abcdef12345678:transfer(address,uint256)
```

By default, login uses `https://account.megaeth.com` for the wallet UI and
`https://wallet-relay.megaeth.com` for the relay. Use `--wallet-url` only when
testing a local wallet UI. Use `--relay-url` only for an explicit non-canonical
relay target.

The default permission request expires after one week. It uses ETH as the fee
token with a `0.01 ETH` fee allowance, and asks for a flat `100 USDM/week`
spending limit. Use `--permissions ./permissions.json` to replace this default
with a full custom permission object when a single `--allow-call` entry is not
enough. Login writes one active default profile per network with file mode
`0600`.

### Whoami

Show the active wallet account, delegated key, network, expiry, and derived
permission summary:

```bash
wallet whoami
wallet whoami --json
wallet whoami -t
```

`whoami` never prints the private key. If no profile exists, run
`wallet login` first.

### Keys

List locally known delegated keys and approved limits:

```bash
wallet keys
wallet keys --json
wallet keys -t
```

`keys` reports local delegated/access keys, not passkey credentials.

### Logout

Remove the local profile for a network:

```bash
wallet logout
wallet logout -t
```

Logout is local-only in v1. It does not revoke the key on-chain.

## Read-Only Calls

`call` performs `eth_call`. It reads chain state and does not submit a
transaction through the relay:

```bash
wallet call \
  --to 0x1234567890abcdef1234567890abcdef12345678 \
  --data 0x70a08231000000000000000000000000abcdefabcdefabcdefabcdefabcdefabcdefabcd

wallet call \
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
wallet execute \
  --to 0x1234567890abcdef1234567890abcdef12345678 \
  --data 0xa9059cbb000000000000000000000000abcdefabcdefabcdefabcdefabcdefabcdefabcd0000000000000000000000000000000000000000000000000000000000000001 \
  --value 0

wallet execute --calls ./calls.json
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
wallet transfer \
  --to 0xabcdefabcdefabcdefabcdefabcdefabcdefabcd \
  --amount 0.1
```

ERC20 transfer:

```bash
wallet transfer \
  --token 0x1234567890abcdef1234567890abcdef12345678 \
  --to 0xabcdefabcdefabcdefabcdefabcdefabcdefabcd \
  --amount 100 \
  --decimals 18
```

## Agent Usage

Agents should prefer deterministic output:

```bash
wallet whoami --json
wallet keys --json
wallet call --to 0x... --data 0x... --json
wallet transfer --to 0x... --amount 0.01 --json
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
in the command behavior behind the same `wallet ...` entry points.
