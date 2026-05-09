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

- `mega wallet login`: local loopback authorization for a delegated session key.
- `mega wallet whoami`: show the active account, delegated key, expiry, and limits.
- `mega wallet keys`: list locally known delegated/access keys and approved limits.
- `mega wallet call`: read-only `eth_call`; does not use the relay for writes.
- `mega wallet execute`: submit state-changing calls through the MegaETH/Porto relay.
- `mega wallet transfer`: convenience wrapper over `execute`.
- `mega wallet fund`: open the wallet deposit flow for the active account.
- `mega wallet debug`: inspect local profile, balance, and relay key status without private key output.
- `mega wallet logout`: remove the local profile only; it does not revoke on-chain.

Only mainnet is supported for now. Keep `--network testnet` fenced off until the
wallet UI and relay path are known.

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

The browser and CLI process must run on the same machine. This is not a
server-friendly device-code flow. Do not add remote/server login behavior unless
the wallet UI/backend protocol explicitly supports it.

The loopback callback must never carry the delegated private key, bearer tokens,
API keys, passkey material, or other transferable secrets. It may carry public
approval metadata required to reconstruct the authorized session key.

## Permission Model

The delegated key is a Porto/MegaETH session key, not a passkey/root/admin key.
It must not be treated as equivalent to the user's passkey. Session authority is
bounded by expiry, call permissions, spend permissions, and relay/account
enforcement.

Be precise about empty fields versus omitted fields:

- `permissions.calls: []` means no app-level call scopes were requested.
- `permissions.spend: []` means no explicit asset spend scopes were requested.
- Omitted `calls` / `spend` can have different Porto defaults. In particular,
  omitted call scope may be interpreted as broad `canExecute` for a session key.
  Do not rely on accidental omission semantics. If a broad agent default is
  desired, encode it intentionally, document it, and cover it with tests.

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
ETH as the fee token with a `0.01 ETH` allowance, and a flat `100 USDM/week`
spend cap. Keep those caps explicit in prompt/UI copy, avoid ambiguous empty or
omitted permissions, and update `README.md`, `SKILL.md`, tests, and this file
together when changing the default.

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
- Do not construct JSON or calldata by string concatenation for wallet or relay
  payloads. Use structured encoders/parsers and validate untrusted callback and
  profile data.
- Map relay/account authorization failures to clear delegated-key permission
  errors; do not expose raw internals unless running an explicit debug path.

## Git Rules

- Do not revert changes made by other workers.
- Stage only files owned by the current task.
- Use conventional commits with no AI attribution.
