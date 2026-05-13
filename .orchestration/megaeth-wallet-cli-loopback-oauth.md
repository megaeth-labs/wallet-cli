# Feature: MegaETH Wallet CLI Loopback OAuth

## Overview

Build a TypeScript/Node CLI in `wallet-cli` that exposes the core MegaETH wallet primitives for agent and developer workflows:

- `mega wallet login`: generate a local delegated secp256k1 key, open the wallet loopback auth route in the system browser, receive the local callback, and persist the approved local key profile.
- `mega wallet whoami`: show the active wallet account, delegated key, network, expiry, and permission summary.
- `mega wallet keys`: list locally known delegated keys and their approved limits.
- `mega wallet call`: read-only `eth_call`.
- `mega wallet execute`: submit one or more write calls through the MegaETH/Porto relay using the locally delegated key.
- `mega wallet transfer`: convenience wrapper around `execute` for native ETH and ERC20 transfers.

Use loopback OAuth-style native app guidance: system browser, random local port, high-entropy `state`, localhost-only callback, no private key or secrets in URLs. PKCE is not required for v1 because the browser is not returning a bearer token or transferable authorization code; the CLI-generated private key remains local.

Follow-up: device-code-style authorization with PKCE is specified separately in
`.codex/plans/megaeth-wallet-cli-device-code-pkce.md`. That addition is meant
for headless or remote CLI environments where the browser and CLI cannot share a
loopback callback.

## Scope

**Core intent**: create the first local-machine MegaETH wallet CLI that can authorize a delegated key through wallet-ui and use it for read and write wallet workflows.

**In scope**:

- TypeScript/Node CLI scaffold.
- Local loopback login.
- Local profile storage.
- `wallet login`, `wallet whoami`, `wallet keys`, `wallet logout`.
- Read-only `wallet call`.
- Relay-backed `wallet execute`.
- Native/ERC20 `wallet transfer`.
- Agent-friendly output modes: default human output plus `--json` and `-t` compact output.
- Agent-facing `SKILL.md`.

**Out of scope**:

- Server/device-code auth.
- OS keychain storage.
- On-chain revocation in `logout`.
- Interactive contract ABI discovery.
- Full account-management UI.
- Funding helpers such as `wallet fund`; address-based funding can target wallets not controlled by the CLI and is not part of the delegated-key flow.
- Tempo-style payment sessions; Mega CLI v1 is not implementing MPP request sessions.
- Tempo-style service discovery or `request`; this can be added later only if Mega needs paid HTTP/API workflows.

**Reuse opportunities**:

- `../wallet-sdk/src/types.ts` -> request/permission shape.
- `../wallet/src/screens/CliLoopbackAuthScreen` -> loopback wallet-ui route contract.
- `../wallet/src/modules/wallet.ts` -> Porto relay prepare/sign/send/poll behavior.
- `../wallet-merchant/src/signer.ts` -> local secp256k1 sub-key signing model.

## Constraints & Assumptions

- `wallet-cli` starts from an effectively empty repo with local workflow plugin files only.
- v1 is local-machine loopback only: browser and CLI must run on the same machine.
- `call` means read-only `eth_call`; `execute` means state-changing relay submission.
- `transfer` is a convenience wrapper over `execute`.
- `keys` means locally known delegated/access keys and approved limits, not passkey credential management.
- Profile storage uses a `0600` file as the v1 baseline.
- Private keys must never be logged, printed, or sent over callback URLs.
- The wallet-ui loopback branch must return full approved key metadata before real E2E execution.

## Non-Functional Requirements

- Performance: CLI commands should avoid unnecessary network calls; only `execute` polls relay status.
- Reliability: loopback login must time out clearly and close its local server on completion/failure.
- Security/Privacy: private keys stay local; callback must validate exact state and loopback origin; output must redact secrets.
- Observability: human-readable CLI errors; no persistent logs containing secrets.
- Compatibility/Migration: profile format starts at `version: 1`; future schema changes must be versioned.

## Tooling Commands

These commands are created by `task-1` and used by every implementation task:

- Build: `pnpm build`
- Test: `pnpm test`
- Lint: `pnpm lint`
- Typecheck: `pnpm typecheck`
- Format: `pnpm format`

## Research Findings

- Native-app OAuth guidance favors system browser plus loopback redirect on a random local port.
- PKCE protects authorization-code exchange in OAuth. The v1 MegaETH loopback flow does not return a bearer token or authorization code, so PKCE is not necessary for the minimum local delegated-key flow.
- Porto signing requires reconstructing a `Key.fromSecp256k1` key with the same authorized session key fields: private key, role, expiry, fee token, and permissions.
- The wallet-ui loopback route currently returns approval metadata, but the CLI should persist the final approved `authorizedKey` scope, not just the originally requested scope.
- Tempo wallet ergonomics worth modeling for Mega v1: `login`, `whoami`, `keys`, `transfer`, `logout`, concise `-t` output, JSON output, and debug-safe redaction.
- Tempo wallet features intentionally excluded from Mega v1: `fund`, `sessions`, `services`, and `request`.

## Existing Wallet-UI Progress

The wallet-ui side is already implemented on branch `feat/wallet-loopback-oauth` at commit `2c7c360`.

Completed there:

- Adds `/cli-auth/loopback`.
- Allows the route through the disconnected/auth gate.
- Parses `accessAddress`, base64url permissions, `redirectUri`, `state`, optional `network`, `clientName`, and sponsor fields.
- Validates loopback-only redirect URLs and rejects malformed CLI requests.
- Reuses the existing `GrantPermissionsScreen` by passing `externalAddress: accessAddress`.
- Redirects to the local CLI callback with `state`, `status`, `accountAddress`, `accessAddress`, `expiry`, and optional `grantTxHash`.
- Includes parser/callback tests and a README note.

Still needed before full CLI E2E:

- Extend the wallet-ui callback response to include the final approved `authorizedKey` metadata, because the CLI needs the approved key scope to reconstruct the Porto session key deterministically.

## Data Contracts

### CLI Auth URL

```ts
type CliAuthUrlParams = {
    accessAddress: `0x${string}`;
    permissions: string; // base64url JSON Permission
    redirectUri: `http://127.0.0.1:${number}/callback`;
    state: string; // 32 random bytes, base64url
    network: 'mainnet' | 'testnet';
    clientName: 'mega-cli';
};
```

Invariants:

- `accessAddress` is derived from the CLI-generated secp256k1 private key.
- `permissions` is the requested Porto session permission object.
- `redirectUri` is loopback-only.
- `state` is verified exactly on callback.
- The delegated private key is never sent to wallet-ui or backend.

### Loopback Callback

```ts
type LoopbackCallback =
    | {
          state: string;
          status: 'approved';
          accountAddress: `0x${string}`;
          accessAddress: `0x${string}`;
          authorizedKey: {
              type: 'secp256k1';
              role: 'session';
              publicKey: `0x${string}`;
              expiry: number;
              feeToken?: { limit: string; symbol?: string };
              permissions: {
                  calls: { to: `0x${string}`; signature: string }[];
                  spend: {
                      limit: string;
                      period: 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year';
                      token?: `0x${string}`;
                  }[];
              };
          };
          grantTxHash?: `0x${string}`;
      }
    | {
          state: string;
          status: 'cancelled' | 'error';
          error?: string;
      };
```

Invariants:

- Callback must include the same `state` sent by CLI.
- `accountAddress` is the wallet account that approved the key.
- `accessAddress` must match the CLI-generated key address.
- `authorizedKey` is the final approved scope to persist and use for Porto signing.

### Wallet Profile

```ts
type WalletProfile = {
    version: 1;
    network: 'mainnet' | 'testnet';
    accountAddress: `0x${string}`;
    accessAddress: `0x${string}`;
    privateKey: `0x${string}`;
    authorizedKey: Extract<LoopbackCallback, { status: 'approved' }>['authorizedKey'];
    grantTxHash?: `0x${string}`;
    walletUrl: string;
    relayUrl: string;
    createdAt: string;
    updatedAt: string;
};
```

Invariants:

- Store one active `default` profile per network in the OS config directory.
- Profile files must be written with mode `0600`.
- `privateKey` is never displayed except by an explicit future export command, which is out of scope.

### Authorization Source Of Truth

```ts
type AuthorizationState = {
    localPrivateKey: `0x${string}`;
    approvedKeyMetadata: WalletProfile['authorizedKey'];
    onChainAuthorization: 'relay/account key storage';
};
```

Invariants:

- There is no separate bearer token, OAuth authorization code, or off-chain signed `keyAuthorization` blob in the v1 Mega CLI loopback flow.
- The browser wallet authorizes the delegated key by submitting the grant through the existing Porto relay/account flow.
- The canonical authorization source of truth is on-chain key storage for the wallet account.
- The CLI persists the local private key plus approved key metadata only so it can reconstruct the same Porto session key for future `prepareCalls`/`signCalls`/`sendPreparedCalls`.
- Decoded summaries shown by `whoami` and `keys` are derived from `authorizedKey` and never from the private key.
- The relay/account enforces the approved permissions when the CLI submits calls signed by the delegated key.

## Interface Contracts

### Commands

```bash
mega wallet login [--network mainnet|testnet] [--wallet-url URL] [--relay-url URL] \
  [--permissions FILE] [--allow-call 0xTarget:signature] [--timeout-ms 120000]

mega wallet whoami [--network mainnet|testnet] [-t]
mega wallet keys [--network mainnet|testnet] [-t]
mega wallet logout [--network mainnet|testnet] [-t]

mega wallet call --to 0x... --data 0x... [--network mainnet|testnet]
mega wallet call --to 0x... --abi ./abi.json --function balanceOf --args '["0x..."]'

mega wallet execute --to 0x... --data 0x... [--value 0] [--network mainnet|testnet]
mega wallet execute --calls ./calls.json [--network mainnet|testnet]

mega wallet transfer --to 0x... --amount 0.1 [--network mainnet|testnet]
mega wallet transfer --token 0x... --to 0x... --amount 100 --decimals 18
```

Errors:

- No profile: print login instruction and exit non-zero.
- Expired profile: print expiry warning and exit non-zero for write commands.
- Callback state mismatch: reject and keep profile unchanged.
- User cancellation: exit non-zero with cancellation message.
- Unauthorized relay call: map Porto error to `permission not granted for delegated key`.

## Boundary Map

```text
mega wallet login
  -> generate secp256k1 private key locally
  -> start http://127.0.0.1:{port}/callback
  -> open walletUrl/cli-auth/loopback?... in system browser
  -> wallet-ui uses passkey account to grant externalAddress
  -> wallet-ui redirects to local callback with approved key metadata
  -> CLI verifies state/accessAddress and writes profile

mega wallet execute / transfer
  -> read profile
  -> reconstruct Porto session key from privateKey + authorizedKey
  -> RelayActions.prepareCalls
  -> RelayActions.signCalls
  -> RelayActions.sendPreparedCalls
  -> RelayActions.getCallsStatus polling
```

## Architecture Decisions

| Decision | Rationale |
| --- | --- |
| Use TypeScript/Node | Matches wallet-sdk and user request. |
| Use `commander` | Small, common CLI parser with testable command setup. |
| Use `porto@0.2.37` | Matches wallet-ui Porto version used by the grant flow. |
| Use `viem@2.48.4` | Matches wallet-merchant peer version and supports current chain utilities. |
| Store profile in config dir file | Simple v1 baseline and easy for agents; keychain deferred. |
| Keep `call` read-only | Prevents confusing transaction submission with `eth_call`. |
| Implement `transfer` over `execute` | Keeps relay execution logic single-sourced. |

## Epics

### Epic 1: Scaffold

**Goal**: create a buildable/testable CLI package.
**Dependencies**: None.

#### Tasks

1. **Scaffold CLI package**
   - ID: `task-1`
   - Contract: defines package scripts and CLI entrypoint
   - Files: `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/index.ts`, `src/cli.ts`, `src/errors.ts`, `README.md`, `AGENTS.md`
   - Dependencies: None
   - Unit test: placeholder CLI help test
   - Integration test: compiled `mega --help`
   - Test commands: `pnpm build && pnpm test && pnpm typecheck`
   - Acceptance: `mega --help` works through compiled bin
   - Docs: `README.md`, `AGENTS.md`
   - Performance: N/A

### Epic 2: Auth And Local State

**Goal**: support delegated key login and local profile inspection.
**Dependencies**: `task-1`.

#### Tasks

1. **Implement config, profiles, and redaction**
   - ID: `task-2`
   - Contract: implements `WalletProfile`
   - Files: `src/config/paths.ts`, `src/config/profile.ts`, `src/config/chains.ts`, `src/output.ts`, `src/config/profile.test.ts`
   - Dependencies: `task-1`
   - Unit test: profile round-trip, permission serialization, `0600` mode, redaction
   - Integration test: profile read/write through temp config dir
   - Test commands: `pnpm test -- src/config/profile.test.ts && pnpm typecheck`
   - Acceptance: profile storage never prints private key
   - Docs: None
   - Performance: N/A

2. **Implement loopback login**
   - ID: `task-3`
   - Contract: implements `CliAuthUrlParams` and consumes `LoopbackCallback`
   - Files: `src/auth/loopback.ts`, `src/auth/permissions.ts`, `src/commands/wallet.ts`, `src/auth/loopback.test.ts`
   - Dependencies: `task-2`
   - Unit test: URL construction, state mismatch, cancellation, timeout, success persistence
   - Integration test: mocked local callback server
   - Test commands: `pnpm test -- src/auth/loopback.test.ts && pnpm typecheck`
   - Acceptance: approved callback writes profile only after state/access key validation
   - Docs: None
   - Performance: closes server immediately after terminal callback

3. **Implement wallet status commands**
   - ID: `task-4`
   - Contract: consumes `WalletProfile`
   - Files: `src/commands/wallet.ts`, `src/commands/wallet.test.ts`
   - Dependencies: `task-2`, `task-3`
   - Unit test: no profile, expired profile warning, redacted profile output, key summary output
   - Integration test: command runner with temp profile dir
   - Test commands: `pnpm test -- src/commands/wallet.test.ts && pnpm typecheck`
   - Acceptance: `whoami`, `keys`, and `logout` work without leaking private key
   - Docs: None
   - Performance: N/A

### Epic 3: Wallet Primitives

**Goal**: expose read, execute, and transfer primitives.
**Dependencies**: `task-2`, `task-3`.

#### Tasks

1. **Implement read-only call**
   - ID: `task-5`
   - Contract: implements `mega wallet call`
   - Files: `src/commands/call.ts`, `src/eth/abi.ts`, `src/eth/client.ts`, `src/commands/call.test.ts`
   - Dependencies: `task-2`
   - Unit test: raw calldata, ABI encoding, invalid ABI/args
   - Integration test: mocked viem public client
   - Test commands: `pnpm test -- src/commands/call.test.ts && pnpm typecheck`
   - Acceptance: performs read-only `eth_call` without requiring login by default
   - Docs: None
   - Performance: single RPC call

2. **Implement execute through relay**
   - ID: `task-6`
   - Contract: consumes `WalletProfile` and Porto relay actions
   - Files: `src/commands/execute.ts`, `src/relay/sessionKey.ts`, `src/relay/sendCalls.ts`, `src/relay/status.ts`, `src/commands/execute.test.ts`
   - Dependencies: `task-2`, `task-3`
   - Unit test: mocked prepare/sign/send/poll order, unauthorized error mapping, redaction
   - Integration test: mocked Porto relay client
   - Test commands: `pnpm test -- src/commands/execute.test.ts && pnpm typecheck`
   - Acceptance: submits relay calls with reconstructed delegated session key
   - Docs: None
   - Performance: polls status at bounded interval until terminal status

3. **Implement transfer wrapper**
   - ID: `task-7`
   - Contract: consumes `execute`
   - Files: `src/commands/transfer.ts`, `src/eth/erc20.ts`, `src/commands/transfer.test.ts`
   - Dependencies: `task-6`
   - Unit test: native value generation and ERC20 calldata generation
   - Integration test: mocked execute handoff
   - Test commands: `pnpm test -- src/commands/transfer.test.ts && pnpm typecheck`
   - Acceptance: native/ERC20 transfer map to execute calls correctly
   - Docs: None
   - Performance: N/A

### Epic 4: Documentation

**Goal**: make the CLI usable by agents and humans.
**Dependencies**: `task-1`.

#### Tasks

1. **Document CLI and agent usage**
   - ID: `task-8`
   - Contract: defines agent-facing usage guide
   - Files: `README.md`, `SKILL.md`, `.agents/plugins/marketplace.json`
   - Dependencies: `task-1`
   - Unit test: N/A
   - Integration test: `pnpm build` validates documented bin exists
   - Test commands: `pnpm build`
   - Acceptance: docs distinguish `call` vs `execute`, show login/whoami/transfer examples, and document loopback limitation
   - Docs: `README.md`, `SKILL.md`
   - Performance: N/A

## Dependency DAG

```yaml
tasks:
  - id: task-1
    title: "Scaffold CLI package"
    depends_on: []
    unlocks: [task-2, task-8]

  - id: task-2
    title: "Implement config, profiles, and redaction"
    depends_on: [task-1]
    unlocks: [task-3, task-4, task-5, task-6]

  - id: task-3
    title: "Implement loopback login"
    depends_on: [task-2]
    unlocks: [task-4, task-6]

  - id: task-4
    title: "Implement wallet status commands"
    depends_on: [task-2, task-3]
    unlocks: []

  - id: task-5
    title: "Implement read-only call"
    depends_on: [task-2]
    unlocks: []

  - id: task-6
    title: "Implement execute through relay"
    depends_on: [task-2, task-3]
    unlocks: [task-7]

  - id: task-7
    title: "Implement transfer wrapper"
    depends_on: [task-6]
    unlocks: []

  - id: task-8
    title: "Document CLI and agent usage"
    depends_on: [task-1]
    unlocks: []

parallel_groups:
  - [task-2, task-8]
  - [task-4, task-5]
  - [task-7]

critical_path:
  - task-1
  - task-2
  - task-3
  - task-6
  - task-7
```

## File Creation Audit

| New File | Lines (est.) | Justification |
| --- | ---: | --- |
| `package.json` | ~50 | Required Node package manifest and bin declaration. |
| `tsconfig.json` | ~25 | Required TypeScript compiler config. |
| `vitest.config.ts` | ~15 | Required test config. |
| `src/index.ts` | ~10 | Bin entrypoint. |
| `src/cli.ts` | ~120 | Central command registration. |
| `src/errors.ts` | ~60 | Shared typed CLI errors. |
| `src/config/paths.ts` | ~50 | OS config path resolution. |
| `src/config/profile.ts` | ~180 | Profile persistence and validation. |
| `src/config/chains.ts` | ~80 | Network and relay config. |
| `src/output.ts` | ~120 | Redaction, JSON output, and compact `-t` output. |
| `src/auth/loopback.ts` | ~250 | Loopback HTTP server and browser auth. |
| `src/auth/permissions.ts` | ~150 | Permission parsing/defaults. |
| `src/commands/wallet.ts` | ~200 | Wallet command handlers. |
| `src/auth/loopback.test.ts` | ~150 | Tests callback validation, timeout, cancellation, and profile persistence for auth boundary. |
| `src/commands/wallet.test.ts` | ~120 | Tests wallet command output and redaction. |
| `src/commands/call.ts` | ~160 | Read-only call command. |
| `src/commands/call.test.ts` | ~100 | Tests raw and ABI read-only call behavior. |
| `src/eth/abi.ts` | ~100 | ABI loading/encoding helpers. |
| `src/eth/client.ts` | ~80 | Viem client construction. |
| `src/commands/execute.ts` | ~180 | Execute command handler. |
| `src/commands/execute.test.ts` | ~150 | Tests relay prepare/sign/send/poll order and error mapping. |
| `src/relay/sessionKey.ts` | ~100 | Porto key reconstruction. |
| `src/relay/sendCalls.ts` | ~180 | Relay prepare/sign/send behavior. |
| `src/relay/status.ts` | ~80 | Relay status polling. |
| `src/commands/transfer.ts` | ~140 | Transfer command handler. |
| `src/commands/transfer.test.ts` | ~80 | Tests native and ERC20 transfer-to-execute mapping. |
| `src/eth/erc20.ts` | ~60 | ERC20 transfer ABI helpers. |
| `SKILL.md` | ~120 | Agent-facing usage instructions. |

## Risk Assessment

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Wallet-ui callback lacks approved key metadata | High | Update wallet-ui branch to return `authorizedKey` before E2E. |
| Permission shape mismatch with Porto | High | Reconstruct keys via `Key.fromSecp256k1` and test serialized shape. |
| Private key leakage in errors/output | High | Central redaction helper and tests. |
| Loopback callback interception | Medium | Exact state validation, random port, loopback-only redirect. |
| File-based private key storage | Medium | Use `0600`, document v1 limitation, defer keychain. |
| Relay API drift | Medium | Pin `porto@0.2.37` and `viem@2.48.4`. |

## Integration Verification Checklist

- [ ] `mega --help` runs from compiled bin.
- [ ] `mega wallet login --wallet-url <wallet-ui-preview> --network testnet` opens browser and receives local callback.
- [ ] `mega wallet whoami -t` shows account/delegated key without private key.
- [ ] `mega wallet keys -t` shows delegated key expiry and permission limits without private key.
- [ ] `mega wallet call --to <contract> --data <calldata> -t` performs read-only RPC call.
- [ ] `mega wallet execute --to <permitted-contract> --data <permitted-calldata> -t` signs and submits through relay.
- [ ] `mega wallet transfer --to <address> --amount <amount> -t` maps to execute for native ETH.

## Orchestration Rules

When implementation starts:

1. Copy this plan to `.orchestration/megaeth-wallet-cli-loopback-oauth.md`.
2. Create `.orchestration/megaeth-wallet-cli-loopback-oauth.state.json`.
3. Follow `plugins/wallet-cli-workflow/commands/orchestrate.md` exactly:
   - create one worktree per task branch,
   - cap concurrency at 2 workers,
   - never run overlapping file ownership in parallel,
   - merge one completed task at a time,
   - run task-specific tests before each merge,
   - run full build/typecheck/test/lint at the end.
4. If wallet-ui callback metadata blocks CLI E2E, pause CLI E2E and update the wallet-ui PR branch contract before continuing.

## Task Tracking

### Status Legend

- [ ] Not started
- [~] In progress
- [x] Completed
- [!] Blocked

### Epic 1: Scaffold

- [x] task-1: Scaffold CLI package

### Epic 2: Auth And Local State

- [x] task-2: Implement config, profiles, and redaction
- [x] task-3: Implement loopback login
- [x] task-4: Implement wallet status commands

### Epic 3: Wallet Primitives

- [x] task-5: Implement read-only call
- [x] task-6: Implement execute through relay
- [x] task-7: Implement transfer wrapper

### Epic 4: Documentation

- [x] task-8: Document CLI and agent usage

## Test Plan

Per task:

- `pnpm test -- <task-specific test>`
- `pnpm typecheck`
- `pnpm lint`

End of batch:

- `pnpm test`
- `pnpm build`
- `pnpm typecheck`
- `pnpm lint`

Manual smoke:

- Run wallet-ui branch locally or deployed preview.
- `mega wallet login --wallet-url <preview-url> --network testnet`.
- Approve in browser.
- Verify `mega wallet whoami`.
- Verify `mega wallet keys`.
- Run a harmless `mega wallet call`.
- Run `mega wallet execute` only against a known permitted test contract.

## Sources

- RFC 8252, OAuth 2.0 for Native Apps: https://www.rfc-editor.org/rfc/rfc8252.html
- RFC 7636, PKCE: https://www.rfc-editor.org/rfc/rfc7636.html
- Local Porto implementation inspected at `../wallet/node_modules/porto/src/viem/Key.ts` and `../wallet/node_modules/porto/src/viem/RelayActions.ts`.
- Local SDK surface inspected at `../wallet-sdk/src/types.ts`.
