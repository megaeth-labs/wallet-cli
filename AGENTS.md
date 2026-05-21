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

- `mega wallet login`: connect the local wallet account profile through loopback or device authorization.
- `mega wallet whoami`: show the active account, delegated key, expiry, and limits.
- `mega wallet list`: list locally known delegated/access keys and approved limits.
- `mega wallet permissions`: show a key's approved scope and on-chain spend remaining. The stored spend request is not the same thing as live remaining capacity; use `spendInfos[].remaining` when judging whether another execution can fit.
- `mega wallet call`: read-only `eth_call`; does not use the relay for writes.
- `mega wallet execute`: submit state-changing calls through the MegaETH/Porto relay.
- `mega wallet transfer`: convenience wrapper over `execute`.
- `mega wallet fund`: open the wallet deposit flow for the active account.
- `mega wallet debug`: inspect local profile, balance, and relay key status without private key output.
- `mega wallet logout`: delete the local profile and delegated private key material; it does not revoke on-chain.

Mainnet is the default network. Testnet is supported with `--network testnet`
and uses a separate local profile path plus testnet chain/token defaults.

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

`mega wallet login` defaults to a native-app loopback flow:

1. The CLI opens MegaETH Wallet at `/cli-auth/loopback` with `operation=login`,
   a high-entropy `state`, and a loopback `redirectUri`.
2. The browser wallet approves connecting the wallet account to the local CLI
   profile.
3. The browser redirects to `http://127.0.0.1:<random-port>/callback` with the
   approved public account address.
4. The CLI validates `state` and persists the account profile without delegated
   private key material.

Login is a profile bootstrap command. If a profile already exists, it must fail
before browser auth and direct the user to either `mega wallet logout` or
`mega wallet create-key`. Use `create-key` to add delegated keys to an existing
wallet profile.

`mega wallet create-key` is the delegated-key grant flow. It generates the
secp256k1 private key locally, opens MegaETH Wallet with the delegated public
address and requested permissions, validates the callback state/account, and
persists the private key only after approval.

If `create-key` fails because the authorized wallet account does not match the
local profile, treat it as a browser-wallet mismatch. Run `mega wallet whoami`
to identify the expected account, then direct the user to switch the browser
wallet/profile to that account or intentionally `mega wallet logout` and log in
again with the desired wallet. Failed mismatched authorizations must not be
stored locally.

Loopback requires the browser and CLI process to run on the same machine.
Device authorization is available with `--auth-flow device` for headless, SSH,
container, and remote CLI environments. In device auth, the CLI prints a
verification URL/code, wallet-backend brokers the short-lived pending request,
and PKCE binds final redemption to the CLI process that started the request.

The loopback callback must never carry the delegated private key, bearer tokens,
API keys, passkey material, or other transferable secrets. Login callbacks may
carry only public account metadata. Create-key callbacks may carry public
approval metadata required to reconstruct the authorized session key.

Device auth callbacks/polling must follow the same secret boundary: never send
delegated private keys, passkeys, bearer tokens, or PKCE verifiers to wallet UI.
The browser may see the user code and public request/approval metadata only.

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

Run local auth E2E checks from this repo:

```bash
pnpm e2e:loopback -- --screen-only --mock-relay --reset
pnpm e2e:loopback -- --auth-flow device --screen-only --mock-relay --reset
pnpm e2e:loopback -- --auth-flow device --management --mock-relay --reset
```

The device management check covers device login, device create-key,
local list/permissions/switch, and device revoke through the local wallet UI and
shim. Login should produce a profile with no delegated keys; create-key should
produce the first active delegated key.

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
  with spend allowance but `calls: []` cannot perform useful ERC20, swap,
  protocol, or other contract-write actions because those all require contract
  calls.
- `permissions.spend: []` means no explicit asset spend scopes were requested.
- Omitted `permissions.calls` is not broad call authority in relay execution.
  It has produced approvals that look funded but fail writes with delegated-key
  permission errors. Reject omitted `permissions.calls` in CLI/auth request
  files; encode broad call authority intentionally as `permissions.calls: [{}]`,
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

The create-key default keeps the visible approval simple: one-week expiry,
network-specific USDM as the fee token with a `1 USDM` allowance, and a flat
`100 USDM` spend cap for the authorization window. It must not silently request
broad call authority. Require explicit call scopes from `--allow-call`, copied
permissions from `--from`, or a full `--permissions` file. Approved broad-call
keys may still be represented as `permissions.calls: [{}]` only when broad
authority is explicitly intended. Do not create CLI write keys with omitted or
empty `permissions.calls`. Keep those caps and call-scope requirements explicit
in prompt/UI copy, avoid ambiguous empty or omitted permissions, and update
`README.md`, `SKILL.md`, tests, and this file together when changing the
default.

`mega wallet create-key --spend-limit <amount>` is a shorthand for overriding
the default network-specific USDM spend cap on the new key request. It accepts a
human USDM amount and preserves the default fee token, expiry, spend token, and
spend period; it still requires `--allow-call`, `--from`, or `--permissions` to
define executable call scope. Use a full `--permissions` file for anything
outside that narrow override.

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

For mainnet command-level regression checks, use:

```bash
pnpm e2e:functional
```

This uses the current mainnet local profile and performs validation plus
read-only protocol/USDM calls. Paid relay writes are opt-in:

```bash
pnpm e2e:functional:writes
```

Only run paid write mode when the active delegated key has the required call
scopes for the tested transfer/approval/protocol functions, and the test wallet
has enough USDM to cover relay fees. Add
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
