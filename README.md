# MegaETH Wallet CLI

MegaETH Wallet CLI exposes local delegated-key wallet workflows for developers
and agents. The CLI is designed for native-app loopback authorization: it
generates a delegated secp256k1 key locally, opens MegaETH Wallet in the system
browser, receives approval metadata on `127.0.0.1`, and stores the approved
profile on the local machine.

The package exposes both binaries after build. `mega wallet` is the canonical
command shape; `wallet` remains a compatibility shortcut.

- `mega`: namespaced commands, e.g. `mega wallet login`
- `wallet`: wallet commands at the root, e.g. `wallet login`

```bash
pnpm install
pnpm build
npm link
mega wallet --help
```

## Install And Update

For a local developer install from this checkout:

```bash
./scripts/install.sh
```

The installer builds the CLI, installs a versioned release under
`~/.mega/wallet-cli/releases/`, points `~/.mega/wallet-cli/current` at that
release, writes `mega` / `wallet` wrappers into `~/.local/bin` by default, and
installs the Codex agent skill into `~/.codex/skills/mega-wallet-cli`. Add
`~/.local/bin` to `PATH` if your shell does not already include it.

The installer checks for Node.js `>=22` and pnpm before building. In an
interactive shell it prompts before installing missing prerequisites it knows
how to install: Node.js through Homebrew, and pnpm through Corepack, npm, or
Homebrew. Pass `--yes` to approve those prerequisite installs up front. In
non-interactive shells it exits with instructions instead of changing system
tooling.

To install the agent-facing skill for both Codex and Claude:

```bash
./scripts/install-skill.sh --agent all --force
```

To update an existing install, pull the latest checkout and rerun the installer:

```bash
git pull
./scripts/install.sh
```

If an existing installed skill differs from this checkout, the installer stops
instead of overwriting it. Pass `--force-skill` to replace it.

Useful overrides:

```bash
./scripts/install.sh --bin-dir "$HOME/bin"
./scripts/install.sh --install-root "$HOME/.mega/wallet-cli"
./scripts/install.sh --default-wallet-url http://localhost:4000
./scripts/install.sh --skill-agent all --force-skill
./scripts/install.sh --no-skill
./scripts/install.sh --yes
./scripts/install.sh --dry-run
```

To wipe a local install between agent-readiness tests:

```bash
./scripts/uninstall.sh --config
```

By default this removes the `mega` / `wallet` wrappers, the versioned install
root, and the `mega-wallet-cli` skill from both Codex and Claude homes. It keeps
wallet profiles unless `--config` is passed. Use `--dry-run` to inspect the
removal plan first.

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
mega wallet login \
  --allow-call '0xfafddbb3fc7688494971a79cc65dca3ef82079e7:transfer(address,uint256)' \
  --allow-call '0xfafddbb3fc7688494971a79cc65dca3ef82079e7:approve(address,uint256)' \
  --allow-call '0x7e324AbC5De01d112AfC03a584966ff199741C28:supply(address,uint256,address,uint16)' \
  --allow-call '0x7e324AbC5De01d112AfC03a584966ff199741C28:withdraw(address,uint256,address)'
```

Paid write mode sends tiny USDM transactions, but relay fees still debit the
test wallet. Use `--include-timeout` only when explicitly testing timeout UX; it
submits another paid bundle and expects the CLI to time out locally.

## Loopback Limitation

`mega wallet login` is local-machine only. The browser and CLI process must run
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

Connect a local wallet profile:

```bash
mega wallet login
mega wallet login \
  --wallet-url http://127.0.0.1:4000 \
  --allow-call 0x1234567890abcdef1234567890abcdef12345678:transfer(address,uint256)
```

By default, login uses `https://account.megaeth.com` for the wallet UI and
`https://wallet-relay.megaeth.com` for the relay. Use `--wallet-url` only when
testing a local wallet UI. Use `--relay-url` only for an explicit non-canonical
relay target.

The default permission request expires after one week. It prefers USDM as the
fee token with a `1 USDM` fee allowance, and asks for a flat `100 USDM` spend
cap over the one-week authorization window. It intentionally omits
`permissions.calls`, which allows arbitrary contract interactions bounded by the
spend/fee/expiry limits. Add `--allow-call` entries or use
`--permissions ./permissions.json` when a more restrictive custom permission
object is needed. Login writes the first active delegated key for a network with
file mode `0600`.

If a profile already exists, login exits before opening the browser with:
`Wallet already connected to 0x.... Either logout with \`mega wallet logout\` or
add a key to the existing wallet profile with \`mega wallet create-key\`.`Use`create-key` to add delegated keys to an existing wallet profile.

### Whoami

Show the active wallet account, delegated key, network, expiry, and derived
permission summary:

```bash
mega wallet whoami
mega wallet whoami --json
mega wallet whoami -t
```

`whoami` never prints the private key. If no profile exists, run
`mega wallet login` first.

### Key Management

List locally known delegated keys:

```bash
mega wallet list
mega wallet list --show-inactive
mega wallet list --json
mega wallet list -t
```

`list` reports local delegated/access keys, not passkey credentials. Revoked
and expired keys are hidden by default; pass `--show-inactive` to include them
for audit.

Show a key's approved scope in plain English:

```bash
mega wallet permissions 0xKEY_OR_ACCESS_ADDRESS
mega wallet permissions 0xKEY_OR_ACCESS_ADDRESS --json
```

Select the default key used by write commands:

```bash
mega wallet switch 0xKEY_OR_ACCESS_ADDRESS
```

Label a key for local operator clarity:

```bash
mega wallet label 0xKEY_OR_ACCESS_ADDRESS "agent"
```

Create and authorize a new delegated key:

```bash
mega wallet create-key --label "agent"
mega wallet create-key --spend-limit 25 --label "agent"
mega wallet create-key --from 0xEXISTING_KEY
```

`create-key` opens the same loopback browser/passkey flow as `login`, stores
the new key, and makes it the default for writes. It never silently rotates
keys in the background. `--spend-limit <amount>` sets the default USDM spend
cap for the new key using a human amount like `25` or `0.5`; use
`--permissions ./permissions.json` for custom fee token, expiry, spend token,
spend period, or no spend.

Revoke a delegated key on-chain and keep the local audit record:

```bash
mega wallet revoke 0xKEY_OR_ACCESS_ADDRESS
```

Revocation uses a wallet UI loopback route so the passkey wallet can revoke the
key. The CLI removes the local private key material after revocation but keeps
the key id, address, label, expiry, permission summary, and revoke metadata.

### Logout

Delete the local wallet profile for a network:

```bash
mega wallet logout
mega wallet logout -t
```

Logout is local-only, but it is destructive for the CLI. It deletes the local
profile for that network, including all locally stored delegated key private
material and key-selection metadata. The wallet account still exists, and the
delegated keys are not revoked on-chain; they can remain authorized until they
expire or are revoked with `mega wallet revoke <key>`. After logout, this CLI
cannot use those keys unless the profile is restored from backup or a new login
authorizes fresh key material.

## Read-Only Calls

`call` performs `eth_call`. It reads chain state and does not submit a
transaction through the relay:

```bash
mega wallet call \
  --to 0x1234567890abcdef1234567890abcdef12345678 \
  --data 0x70a08231000000000000000000000000abcdefabcdefabcdefabcdefabcdefabcdefabcd

mega wallet call \
  --to 0x1234567890abcdef1234567890abcdef12345678 \
  --abi ./erc20.json \
  --function balanceOf \
  --args '["0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"]'
```

Use `call` for read-only inspection. It does not require a write-capable
permission grant. If `--from` is omitted, the CLI uses the logged-in wallet
account when a local profile exists; pass `--from 0x...` to simulate from a
different address.

## Write Execution

`execute` submits one or more state-changing calls through the MegaETH/Porto
relay using the locally delegated key:

```bash
mega wallet execute \
  --to 0x1234567890abcdef1234567890abcdef12345678 \
  --data 0xa9059cbb000000000000000000000000abcdefabcdefabcdefabcdefabcdefabcdefabcd0000000000000000000000000000000000000000000000000000000000000001 \
  --value 0

mega wallet execute --calls ./calls.json
mega wallet execute --key 0xKEY_OR_ACCESS_ADDRESS --calls ./calls.json
```

Use `execute` only for writes. The relay prepares calls, the CLI signs with the
delegated key reconstructed from the local profile, the relay sends the prepared
calls, and the CLI polls until the status is terminal. Permission failures are
reported as delegated-key authorization errors.

Spend permission is not call permission. A restrictive key with `calls: []` can
still fail with `UnauthorizedCall` when executing ERC20 `approve`, ERC20
`transfer`, Aave `supply`, or any other contract function even when it has token
spend allowance. In that case, inspect `mega wallet permissions <key>` and
create or switch to a key with matching call scopes:

```bash
mega wallet create-key \
  --spend-limit 100 \
  --allow-call '0xfafddbb3fc7688494971a79cc65dca3ef82079e7:approve(address,uint256)' \
  --allow-call '0x7e324AbC5De01d112AfC03a584966ff199741C28:supply(address,uint256,address,uint16)'
```

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
  --to 0xabcdefabcdefabcdefabcdefabcdefabcdefabcd \
  --amount 0.1
```

ERC20 transfer:

```bash
mega wallet transfer \
  --token 0x1234567890abcdef1234567890abcdef12345678 \
  --to 0xabcdefabcdefabcdefabcdefabcdefabcdefabcd \
  --amount 100

mega wallet transfer \
  --key 0xKEY_OR_ACCESS_ADDRESS \
  --token 0x1234567890abcdef1234567890abcdef12345678 \
  --to 0xabcdefabcdefabcdefabcdefabcdefabcdefabcd \
  --amount 100
```

For ERC20 transfers, the CLI reads `decimals()` from the token contract by
default. Use `--decimals` as an explicit override for nonstandard tokens or
offline flows, and `--rpc-url` when token metadata should be read from a
specific RPC endpoint.

## Funding

`fund` opens the MegaETH Wallet deposit flow for the active account:

```bash
mega wallet fund
mega wallet fund --no-open --json
```

The command uses the active profile account. It does not transfer funds by
itself; the browser wallet handles the deposit flow.

## Debug Diagnostics

`debug` prints local wallet diagnostics without private key material:

```bash
mega wallet debug
mega wallet debug --skip-chain --json
```

It reports the profile path/mode, account, delegated access key, expiry, native
balance when RPC is reachable, and whether the relay still reports the delegated
key for the account.

## Agent Usage

Agents should prefer deterministic output:

```bash
mega wallet whoami --json
mega wallet list --json
mega wallet permissions 0xKEY_OR_ACCESS_ADDRESS --json
mega wallet call --to 0x... --data 0x... --json
mega wallet transfer --to 0x... --amount 0.01 --json
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
pnpm install:local -- --dry-run
pnpm install:skill -- --dry-run
pnpm uninstall:local -- --dry-run
```

Command changes should include focused Vitest coverage for the command runner,
registry wiring, JSON/terse output, and secret redaction where applicable. The
functional E2E script covers the local profile path plus read-only RPC checks;
paid relay writes stay opt-in.

The v1 command surface is intentionally small: read with `call`, write with
`execute` or `transfer`, and manage delegated keys with `list`,
`permissions`, `switch`, `create-key`, `label`, and `revoke`.
