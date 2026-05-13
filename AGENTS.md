# Wallet CLI Agent Instructions

This repository contains the MegaETH Wallet CLI. Follow the orchestration plan
for task ownership and keep edits scoped to the files assigned to the active
task unless a small adjacent test or documentation update is required.

## Product Shape

The canonical user-facing command shape is `mega wallet <command>`. The
standalone `wallet` binary exists as a compatibility shortcut, but examples,
agent-facing docs, and user-facing recovery messages should teach
`mega wallet ...`.

Core commands:

- `mega wallet login`: connect the first local wallet profile through loopback authorization.
- `mega wallet whoami`: show the active account, delegated key, expiry, and limits.
- `mega wallet keys`: list locally known delegated/access keys and approved limits.
- `mega wallet call`: read-only `eth_call`; does not use the relay for writes.
- `mega wallet execute`: submit state-changing calls through the MegaETH/Porto relay.
- `mega wallet transfer`: convenience wrapper over `execute`.
- `mega wallet fund`: open the wallet deposit flow for the active account.
- `mega wallet debug`: inspect local profile, balance, and relay key status without private key output.
- `mega wallet logout`: delete the local profile and delegated private key material; it does not revoke on-chain.

Only mainnet is supported for now. Keep `--network testnet` fenced off until the
wallet UI and relay path are known.

## Distribution

The local install path is repo-owned and deterministic:

- `scripts/install.sh` builds the CLI, installs a versioned release under
  `~/.mega/wallet-cli/releases/`, updates `~/.mega/wallet-cli/current`, and
  writes `mega` / `wallet` wrappers into `~/.local/bin` by default.
  It must check Node.js `>=22` and pnpm before building. Interactive runs may
  prompt to install missing prerequisites; non-interactive runs must fail with
  instructions instead of changing system tooling silently.
  Production wrappers should not bake a wallet URL override; pass
  `--default-wallet-url http://localhost:4000` only for local wallet UI testing.
- `scripts/install-skill.sh` installs the in-repo skill bundle (`SKILL.md` plus
  bundled resources such as `references/`) into Codex and/or Claude skill
  directories. The main installer installs the Codex skill by default; use
  `--no-skill` for binary-only installs.
- `scripts/uninstall.sh` removes local install artifacts for agent-readiness
  testing; wallet profiles are removed only when `--config` is passed.
- `pnpm install:local -- --dry-run` and `pnpm install:skill -- --dry-run`
  should remain safe, non-mutating checks. `pnpm uninstall:local -- --dry-run`
  should remain safe and non-mutating too.

When changing installation behavior, update `README.md`, package scripts, and
the installer regression tests together. Installer scripts must not read wallet
profiles, private keys, or auth material.

## Architecture

`mega wallet login` is a native-app loopback flow:

1. The CLI generates a delegated secp256k1 private key locally.
2. The CLI opens MegaETH Wallet at `/cli-auth/loopback` with the delegated
   public address, requested permissions, a high-entropy `state`, and a
   loopback `redirectUri`.
3. The browser wallet approves the delegated key through the existing
   MegaETH/Porto account flow.
4. The browser redirects to `http://127.0.0.1:<random-port>/callback` with
   approved public metadata.
5. The CLI validates `state`, persists the local private key plus the approved
   `authorizedKey` metadata, and uses those fields to reconstruct the Porto
   session key for later relay execution.

Login is a profile bootstrap command. If a profile already exists, it must fail
before browser auth and direct the user to either `mega wallet logout` or
`mega wallet create-key`. Use `create-key` to add delegated keys to an existing
wallet profile.

The browser and CLI process must run on the same machine. This is not a
server-friendly device-code flow. Do not add remote/server login behavior unless
the wallet UI/backend protocol explicitly supports it.

The loopback callback must never carry the delegated private key, bearer tokens,
API keys, passkey material, or other transferable secrets. It may carry public
approval metadata required to reconstruct the authorized session key.

## Local Wallet UI

For development auth testing, start the wallet UI from the sibling `wallet`
checkout with a localhost origin:

```bash
cd ../wallet
pnpm dev -- --host localhost --port 4000
```

The wallet UI expects its local API/relay shim on port `4002`. Start the shim
from this repo before login:

```bash
node scripts/loopback-e2e.mjs --shim-only --shim-port 4002 \
  --artifacts-dir .e2e/artifacts-local-debug \
  --config-dir .e2e/config-local-shim
```

Use `--mock-relay` only for no-chain E2E harness checks. Do not use it when
verifying that `grantPermissions` or revoke submits on-chain: mock mode returns
successful relay statuses without broadcasting a transaction. If the wallet UI
says approved but the shim sees no `/rpc` traffic, check that the browser origin
is `http://localhost:4000` and that the wallet UI is using the local `4002`
backend rather than production.

## Permission Model

The delegated key is a Porto/MegaETH session key, not a passkey/root/admin key.
It must not be treated as equivalent to the user's passkey. Session authority is
bounded by expiry, call permissions, spend permissions, and relay/account
enforcement.

Be precise about empty fields versus omitted fields:

- `permissions.calls: [{}]` means broad contract execution authority: any
  target and any function, still bounded by spend, fee, expiry, relay, and
  account enforcement.
- `permissions.calls: []` means no app-level call scopes were requested. A key
  with spend allowance but `calls: []` cannot perform useful ERC20, swap, Aave,
  or other contract-write actions because those all require contract calls.
- `permissions.spend: []` means no explicit asset spend scopes were requested.
- Omitted `calls` / `spend` can have different Porto defaults. Do not rely on
  accidental omission semantics in hand-authored permission files. If broad call
  authority is desired, encode it intentionally as `permissions.calls: [{}]`,
  document it, and cover it with tests.

`permissions.calls` scopes which target/function selectors the key may execute.
For example, a transfer-only USDC scope should include the USDC token address
and `transfer(address,uint256)`.

`permissions.spend` scopes how much native/token value can leave the account for
a period. Native token spend is represented without a token address in the CLI
profile and as the native/zero-address token in Porto/relay internals.

`feeToken` is user-facing fee configuration, but Porto resolves it into spend
permission for the selected fee token:

- If a matching spend permission already exists, Porto adds the fee amount to
  that spend limit and moves it to the first spend entry.
- If no matching spend permission exists, Porto inserts a spend permission for
  the fee token.

Therefore UI copy like "fees" is product shorthand over a token spend allowance
intended for the relay/orchestrator path. It is not EVM gas introspection and it
is not a separate magical gas-only permission at the final relay permission
layer. Be careful when changing defaults or copy around this.

The agent-oriented default keeps the visible approval simple: one-week expiry,
USDM as the fee token with a `1 USDM` allowance, and a flat `100 USDM` spend
cap for the authorization window. Approved broad-call keys must be represented
as `permissions.calls: [{}]`. Use `permissions.calls: []` only when the key
should have no app-level call scopes, or provide explicit call scopes when a
more restrictive key is required. Keep those caps and call-scope requirements
explicit in prompt/UI copy, avoid ambiguous empty or omitted permissions, and
update `README.md`, `SKILL.md`, tests, and this file together when changing the
default.

`mega wallet create-key --spend-limit <amount>` is a shorthand for overriding
the default mainnet USDM spend cap on the new key request. It accepts a human
USDM amount and preserves the default fee token, expiry, spend token, and spend
period. Use a full `--permissions` file for anything outside that narrow
override.

## Commands

```bash
pnpm build
pnpm test
pnpm lint
pnpm typecheck
pnpm format
```

When adding or changing wallet commands, update the command unit tests in
`src/commands/*.test.ts`, the shared helpers they depend on, `README.md`,
`SKILL.md`, and this file in the same commit. New user-facing commands must be
wired through `registerWalletCommands` and tested through the canonical
`mega wallet <command>` shape.

For command-level regression checks, use:

```bash
pnpm e2e:functional
```

This uses the current local profile and performs validation plus read-only
Aave/USDM calls. Paid relay writes are opt-in:

```bash
pnpm e2e:functional:writes
```

Only run paid write mode when the active delegated key has the required call
scopes for USDM `transfer`, USDM `approve`, Aave `supply`, and Aave `withdraw`,
and the test wallet has enough USDM to cover relay fees. Add
`-- --include-timeout` only when deliberately testing timeout UX.

## Security Rules

- Never print or log private keys, authorization blobs, API keys, bearer tokens,
  passkey material, or relay secrets.
- Do not put secrets in URLs. Loopback callback URLs may carry state and
  approved public metadata only.
- Persist canonical authorization data exactly as approved by the wallet. Treat
  summaries shown by CLI commands as derived output.
- Keep profile files private to the local user when implementing storage.
- The local profile contains delegated private key material. Preserve `0600`
  file permissions and redact profile contents in logs, errors, tests, and docs.
- Treat `mega wallet logout` as a destructive local forget operation: it deletes
  the local profile and delegated private key material without revoking the
  on-chain key authorization.
- Do not construct JSON or calldata by string concatenation for wallet or relay
  payloads. Use structured encoders/parsers and validate untrusted callback and
  profile data.
- Map relay/account authorization failures to clear delegated-key permission
  errors; do not expose raw internals unless running an explicit debug path.

## Git Rules

- Do not revert changes made by other workers.
- Stage only files owned by the current task.
- Use conventional commits with no AI attribution.
