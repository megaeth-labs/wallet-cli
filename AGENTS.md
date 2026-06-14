# Wallet CLI Agent Instructions

This repository contains the MegaETH Wallet CLI. Follow the orchestration plan
for task ownership and keep edits scoped to the files assigned to the active
task unless a small adjacent test or documentation update is required.

## Product Shape

The user-facing command shape is `mega moss <command>`. Examples,
agent-facing docs, and user-facing recovery messages should teach
`mega moss ...`; do not teach or rely on a standalone `wallet` command.

Core commands:

- `mega moss login`: connect the local wallet account profile through loopback authorization.
- `mega moss whoami`: show the active account, delegated key, expiry, and limits.
- `mega moss list`: list locally known delegated/access keys and approved limits.
- `mega moss permissions`: show a key's approved scope and on-chain spend remaining. The stored spend request is not the same thing as live remaining capacity; use `spendInfos[].remaining` when judging whether another execution can fit.
- `mega moss call`: read-only `eth_call`; does not use the relay for writes.
- `mega moss execute`: submit state-changing calls through the MegaETH/Porto relay.
- `mega moss transfer`: convenience wrapper over `execute`.
- `mega moss fund`: open the wallet deposit flow for the active account.
- `mega moss debug`: inspect local profile, balance, and relay key status without private key output.
- `mega moss logout`: delete the local profile and delegated private key material; it does not revoke on-chain.

Mainnet is the default network. Testnet is supported with `--network testnet`
and uses a separate local profile path plus testnet chain/token defaults.

Human command output may use color or lightweight terminal animation only when
the relevant stream is a TTY and the environment is not CI, `NO_COLOR`, or a
dumb terminal. Keep `--json` and `--terse` stdout plain and stable. Auth
progress, browser fallback URLs, and terminal animation belong on stderr; final
command results belong on stdout.

## Distribution

The release install path is repo-owned and deterministic:

- `scripts/install-release.sh` is the public installer intended to be served at
  `https://account.megaeth.com/install`. It downloads the latest GitHub Release
  archive, verifies its `.sha256` checksum, installs a versioned release under
  `~/.mega/wallet-cli/releases/`, updates `~/.mega/wallet-cli/current`, writes
  the `mega` wrapper into `~/.local/bin` by default, removes repo-owned legacy
  `wallet` wrappers, and installs the bundled skill unless `--no-skill` is
  passed. It must not require pnpm or a source checkout.
- `scripts/package-release.sh` builds the self-contained GitHub Release assets:
  `mega-wallet-cli-<tag>.tar.gz` plus `.sha256`. The archive must include
  `dist/`, production `node_modules/`, `package.json`, `pnpm-lock.yaml`,
  `SKILL.md`, `references/`, and `scripts/install-skill.sh` so the public
  installer can install CLI and skill without building from source.
- `scripts/install.sh` is the local checkout installer. It builds the CLI,
  installs a versioned release under `~/.mega/wallet-cli/releases/`, updates
  `~/.mega/wallet-cli/current`, and writes the `mega` wrapper into `~/.local/bin`
  by default. It should remove any repo-owned legacy `wallet` wrapper so stale
  compatibility shortcuts do not remain on PATH.
  It must check Node.js `>=22` and pnpm before building. Interactive runs may
  prompt to install missing prerequisites; non-interactive runs must fail with
  instructions instead of changing system tooling silently.
  Production wrappers should not bake a wallet URL override. Pass
  `--wallet-url http://localhost:4000` on local auth/fund commands when testing
  against a local wallet UI.
- `scripts/install-skill.sh` installs the in-repo skill bundle (`SKILL.md` plus
  bundled resources such as `references/`) into Codex and/or Claude skill
  directories. The main installer installs the Codex skill by default; use
  `--no-skill` for binary-only installs.
- `scripts/uninstall.sh` removes local install artifacts for agent-readiness
  testing; wallet profiles are removed only when `--config` is passed.
- `pnpm install:local -- --dry-run`, `pnpm install:release -- --dry-run
--version v0.1.0`, `pnpm install:skill -- --dry-run`, `pnpm package:release
-- --dry-run --version v0.1.0`, and `pnpm uninstall:local -- --dry-run`
  should remain safe, non-mutating checks.

When changing installation behavior, update `README.md`, package scripts, and
the installer regression tests together. Installer scripts must not read wallet
profiles, private keys, or auth material.

## Architecture

`mega moss login` defaults to a native-app loopback flow:

1. The CLI opens MegaETH Wallet at `/cli-auth/loopback` with `operation=login`,
   a high-entropy `state`, and a loopback `redirectUri`.
2. The browser wallet approves connecting the wallet account to the local CLI
   profile.
3. The browser redirects to `http://127.0.0.1:<random-port>/callback` with the
   approved public account address.
4. The CLI validates `state` and persists the account profile without delegated
   private key material.

Login is a profile bootstrap command. If a profile already exists, it must fail
before browser auth and direct the user to either `mega moss logout` or
`mega moss create-key`. Use `create-key` to add delegated keys to an existing
wallet profile.

`mega moss create-key` is the delegated-key grant flow. It generates the
secp256k1 private key locally, opens MegaETH Wallet with the delegated public
address and requested permissions, validates the callback state/account, and
persists the private key only after approval.

If `create-key` fails because the authorized wallet account does not match the
local profile, treat it as a browser-wallet mismatch. Run `mega moss whoami`
to identify the expected account, then direct the user to switch the browser
wallet/profile to that account or intentionally `mega moss logout` and log in
again with the desired wallet. Failed mismatched authorizations must not be
stored locally.

Loopback requires the browser and CLI process to run on the same machine.
Device-code auth is not a supported user flow right now; do not recommend
`--auth-flow device` in README.md, SKILL.md, examples, or recovery messages
unless the wallet UI/backend support is live.

The loopback callback must never carry the delegated private key, bearer tokens,
API keys, passkey material, or other transferable secrets. Login callbacks may
carry only public account metadata. Create-key callbacks may carry public
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

Run local auth E2E checks from this repo:

```bash
pnpm e2e:loopback -- --screen-only --mock-relay --reset
pnpm e2e:loopback -- --management --mock-relay --reset \
  --wallet-url http://localhost:4000 \
  --relay-url http://127.0.0.1:4002/rpc
pnpm e2e:loopback:relay-smoke
pnpm e2e:device:relay-smoke
```

Login should produce a profile with no delegated keys; create-key should
produce the first active delegated key. The `--management` run covers login,
create-key, list, permissions, label, switch, and revoke. Use the local
`--relay-url` value above when `--mock-relay` needs to exercise command-level
relay calls with the generated profile; it keeps those calls on the shim rather
than production.

The relay-smoke run uses a persistent development-only virtual WebAuthn profile
under this checkout's `.e2e/relay-smoke`, creates or reuses a scoped
`e2e-relay-smoke` key, and submits a real 0.0001 USDM self-transfer. It must
not be run with `--mock-relay`; the cached wallet needs enough USDM for the
transfer and relay fee. Do not pass `--reset` to relay-smoke runs. This state
is intentionally separate from local wallet-cli installs and profiles, so
`scripts/install.sh` and `scripts/uninstall.sh --config` must not remove it.
Delete `.e2e/relay-smoke` manually only when intentionally replacing the funded
smoke wallet.

`pnpm e2e:device:relay-smoke` uses the same persistent funded wallet but
creates or reuses a separate `e2e-relay-smoke-device` delegated key through the
local shim's device-code endpoints. This is an internal E2E path only; device
auth remains unsupported for normal CLI users until the real wallet backend
flow is live.

## Permission Model

The delegated key is a Porto/MegaETH session key, not a passkey/root/admin key.
It must not be treated as equivalent to the user's passkey. Session authority is
bounded by expiry, call permissions, spend permissions, and relay/account
enforcement.

Be precise about empty fields versus omitted fields:

- `permissions.calls: []` means no app-level call scopes were requested. A key
  with spend allowance but `calls: []` cannot perform useful ERC20, swap,
  protocol, or other contract-write actions because those all require contract
  calls.
- `permissions.spend: []` means no explicit asset spend scopes were requested.
- Omitted `permissions.calls` is not broad call authority in relay execution.
  It has produced approvals that look funded but fail writes with delegated-key
  permission errors. Reject omitted `permissions.calls` in CLI/auth request
  files.

`permissions.calls` scopes which target/function selectors the key may execute.
For example, a transfer-only USDC scope should include the USDC token address
and `transfer(address,uint256)`. CLI-created call scopes must include both
`to` and `signature`; do not create broad or partial call entries. Native ETH
transfers use the recipient address as `to` and `0xe0e0e0e0` as the no-calldata
selector. Reject the reserved wildcard address
`0x3232323232323232323232323232323232323232` and selector `0x32323232`.

`permissions.spend` scopes how much native/token value can leave the account for
a period. Native token spend uses the zero address in CLI spend-limit args and
may appear as zero-address or omitted native token data in stored profiles and
Porto/relay internals.

`maxFeesUSD` is an approval hint consumed by the wallet UI, not an on-chain
permission. The durable permission is ordinary `permissions.spend` for the gas
token selected in the wallet UI. New CLI-generated create-key requests should
send `maxFeesUSD`, not legacy `feeToken.symbol`/`feeToken.limit`. The wallet UI
user selects the actual Gas Token on the grant screen. During approval, the
wallet UI may add spend capacity for that Gas Token based on `maxFeesUSD`. Do
not use `maxFeesUSD: 0` or `--fee-limit 0` just to remove that row unless the
user explicitly wants no fee budget. Be careful when changing defaults or copy
around this: UI text like "fees" is product shorthand over token spend
allowance, not a separate gas-only contract permission.

The create-key default keeps the visible approval simple: one-week expiry, a
`100 USDM` workflow spend cap, and a `1` `maxFeesUSD` approval hint.
It must not silently request broad call authority. Require explicit call scopes
from `--allow-call`, copied permissions from `--from`, or a full
`--permissions` file. Do not create CLI write keys with omitted or empty
`permissions.calls`, or with call entries that
omit either `to` or `signature`. Keep those caps and call-scope requirements
explicit in prompt/UI copy, avoid ambiguous empty or omitted permissions, and
update `README.md`, `SKILL.md`, tests, and this file together when changing the
default.

`mega moss create-key --spend-limit <token_address>:<amount>:<period>` adds a
workflow spend row to the new key request. It accepts only 20-byte token
addresses; use `0x0000000000000000000000000000000000000000` for native ETH.
Amount is a human token amount, and period must be `minute`, `hour`, `day`,
`week`, `month`, or `year`. The flow still requires `--allow-call`, `--from`,
or `--permissions` to define executable call scope. Use a full `--permissions`
file for custom expiry or no-spend requests.

`mega moss create-key --fee-limit <amount>` sets the `maxFeesUSD` approval
hint; `--fee-token` does not force the wallet UI Gas Token selection. If either
fee option is present and no `--spend-limit` is supplied, the CLI does not add
the default USDM workflow spend row; add explicit spend rows for workflow token
movement. Revoke should pass the stored key fee token to the wallet UI by
default and support `--fee-token <symbol>` only as the relay payment token for
that revoke transaction.

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
`mega moss <command>` shape.

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
- Treat `mega moss logout` as a destructive local forget operation: it deletes
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
