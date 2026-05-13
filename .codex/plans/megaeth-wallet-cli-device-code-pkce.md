# Feature: MegaETH Wallet CLI Device Authorization With PKCE

## Overview

Add a device-code-style authorization path for `mega wallet login`,
`mega wallet create-key`, and `mega wallet revoke` so a CLI running on a
headless, SSH, container, or remote machine can authorize through MegaETH
Wallet on any browser-capable device. The flow keeps the delegated secp256k1
private key on the CLI machine and uses wallet-backend only to broker the
short-lived authorization request and final public approval metadata.

The user experience should follow the useful part of `tempo wallet login
--no-browser`: print a direct authorization URL, print a human verification
code, and wait for approval. Mega should print the headless fallback prompt for
every browser-mediated authorization, even when it also opens a browser:

```text
Running headless? Go to https://account.megaeth.com/cli-auth and input this code - XXXX-XXXX
```

## Scope

**Core intent**: support delegated-key authorization when the CLI and browser
cannot share a local loopback callback.

**In scope**:

- Device-code authorization for `mega wallet login`.
- Device-code authorization for `mega wallet create-key`.
- Device-code authorization for `mega wallet revoke`.
- PKCE S256 verifier/challenge binding between the CLI and wallet-backend.
- Wallet-backend endpoints and persistence for pending device authorization
  requests.
- Wallet UI `/cli-auth` code entry and approval flow.
- Shared CLI prompt rendering for browser and headless flows.
- Local E2E shim support for the new device flow.
- Documentation for humans and agents.

**Out of scope**:

- Long-lived OAuth access tokens.
- Changing the Porto delegated session key model.
- Sending delegated private keys, passkeys, bearer tokens, or PKCE verifiers to
  wallet UI.
- Making `mega wallet logout` revoke keys on-chain.
- Removing the existing loopback flow.
- Implementing Tempo payment sessions, service discovery, or request flows.

**Reuse opportunities**:

- `src/auth/loopback.ts` -> delegated key generation, browser opener, callback
  validation patterns, result types.
- `src/auth/permissions.ts` -> permission request schema/defaults.
- `src/commands/wallet.ts` -> login/create-key/revoke command orchestration and
  profile persistence.
- `src/config/profile.ts` -> approved key validation, redaction, local profile
  writes.
- `scripts/loopback-e2e.mjs` -> local wallet API/relay shim and Playwright
  auth harness.
- `../wallet/src/screens/CliLoopbackAuthScreen` -> existing grant-permissions
  adapter and loopback parser constraints.
- `../wallet/src/screens/CliLoopbackRevokeScreen` -> existing revoke adapter.
- `../wallet/src/screens/GrantPermissionsScreen/GrantPermissionsScreen.tsx` ->
  permission review/edit UI.
- `../wallet-backend/src/routes/AuthRoutes.ts` -> backend route style,
  validation, env/context middleware patterns.
- Tempo wallet CLI UX -> `--no-browser`, auth URL, verification code, waiting
  prompt.

## Constraints & Assumptions

- Mainnet remains the only supported Mega wallet network in this CLI.
- The current loopback flow stays available for local development and as an
  escape hatch.
- The wallet UI and wallet-backend can be changed in parallel with wallet-cli.
- Production defaults are `https://account.megaeth.com`,
  `https://wallet-api.megaeth.com`, and `https://wallet-relay.megaeth.com`.
- The device flow returns the same public approval metadata the loopback flow
  persists today: `accountAddress`, `accessAddress`, `authorizedKey`, and
  optional transaction hash.
- The CLI discards unapproved delegated private keys on timeout, rejection, or
  any validation failure.
- Prompt/progress text goes to stderr. Command result output remains stdout.

## Non-Functional Requirements

- Performance: Poll wallet-backend at the server-provided interval, honor
  `slow_down`, and avoid extra chain/RPC calls during pending authorization.
- Reliability: Authorization requests expire clearly, are consumable once, and
  survive browser/CLI running on different machines.
- Security/Privacy: Private keys, passkeys, bearer tokens, `deviceCode`, and
  PKCE `codeVerifier` are never printed, logged, put in URLs, or sent to wallet
  UI.
- Observability: Human-readable CLI errors, debug-safe redaction, and backend
  status codes that distinguish pending, slow polling, rejection, expiry, and
  invalid PKCE.
- Compatibility/Migration: Existing wallet profiles remain valid. Add
  `walletApiUrl` to config/profile defaults without requiring profile rewrite.

## Research Findings

- The current loopback plan explicitly made server/device-code auth out of
  scope for v1 because loopback did not exchange bearer tokens or authorization
  codes.
- Device-code auth needs wallet-backend mediation because a remote browser
  cannot redirect to the CLI machine's `127.0.0.1` callback.
- PKCE is useful here because wallet-backend stores a pending authorization
  result that should be redeemable only by the CLI process that started the
  request.
- Tempo wallet CLI prints both an auth URL and a formatted verification code,
  and offers `--no-browser`; that pattern is the target CLI ergonomics.
- The current wallet UI already has grant and revoke flows that can be reused
  after a pending device request is resolved by code.
- The device flow must not treat `userCode` as a secret; it is a short-lived
  lookup handle for the browser. `deviceCode` plus PKCE verifier protect the
  CLI polling side.

## Data Contracts

### DeviceStartRequest

```ts
type DeviceStartRequest =
  | {
      operation: "grant";
      clientName: "mega-cli";
      network: "mainnet";
      accessAddress: `0x${string}`;
      permissions: CliPermissionRequest;
      codeChallenge: string;
      codeChallengeMethod: "S256";
      state: string;
      existingAccountAddress?: `0x${string}`;
    }
  | {
      operation: "revoke";
      clientName: "mega-cli";
      network: "mainnet";
      accountAddress: `0x${string}`;
      accessAddress: `0x${string}`;
      codeChallenge: string;
      codeChallengeMethod: "S256";
      state: string;
    };
```

Invariants:

- `accessAddress` is the delegated key address generated or selected by the
  CLI.
- `state` is 32 random bytes encoded as base64url and validated on completion.
- `codeChallenge` is `BASE64URL(SHA256(codeVerifier))`.
- `existingAccountAddress` is required for `create-key` and omitted for first
  login.
- No private key or PKCE verifier is included.

### DeviceStartResponse

```ts
type DeviceStartResponse = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
};
```

Invariants:

- `deviceCode` is a secret polling credential and is never printed.
- `userCode` is formatted as `XXXX-XXXX` for human comparison.
- `verificationUriComplete` contains only the user code, not `deviceCode` or
  PKCE data.
- Recommended expiry is 10 minutes; recommended poll interval is 5 seconds.

### DeviceTokenRequest

```ts
type DeviceTokenRequest = {
  deviceCode: string;
  codeVerifier: string;
};
```

Invariants:

- Wallet-backend hashes `deviceCode` for lookup.
- Wallet-backend recomputes the S256 challenge from `codeVerifier`.
- A successful approval result is returned once and then marked consumed.

### DeviceTokenResponse

```ts
type DeviceTokenResponse =
  | { status: "authorization_pending"; interval?: number }
  | { status: "slow_down"; interval: number }
  | { status: "expired_token" }
  | { status: "access_denied"; error?: string }
  | DeviceGrantApproved
  | DeviceRevokeApproved;

type DeviceGrantApproved = {
  status: "approved";
  operation: "grant";
  state: string;
  accountAddress: `0x${string}`;
  accessAddress: `0x${string}`;
  authorizedKey: AuthorizedKey;
  grantTxHash?: `0x${string}`;
};

type DeviceRevokeApproved = {
  status: "approved";
  operation: "revoke";
  state: string;
  accountAddress: `0x${string}`;
  accessAddress: `0x${string}`;
  revokeTxHash?: `0x${string}`;
};
```

Invariants:

- The CLI validates `state`, `operation`, and `accessAddress` before mutating
  local profile state.
- `create-key` and `revoke` also validate `accountAddress` against the local
  profile.
- `authorizedKey` is the final wallet-approved session key metadata, not the
  original request echoed back.

### DeviceAuthRecord

```ts
type DeviceAuthRecord = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  consumedAt?: Date;
  status: "pending" | "approved" | "rejected" | "expired" | "consumed";
  operation: "grant" | "revoke";
  network: "mainnet";
  clientName: "mega-cli";
  userCode: string;
  deviceCodeHash: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  pollIntervalSeconds: number;
  request: DeviceStartRequest;
  approval?: DeviceGrantApproved | DeviceRevokeApproved;
  rejectionError?: string;
};
```

Invariants:

- Store only `deviceCodeHash`, never raw `deviceCode`.
- Enforce unique active `userCode`.
- Expired and consumed records cannot be approved.
- Approval payload contains only public metadata.

### Wallet Profile Compatibility

```ts
type WalletProfile = {
  version: 1;
  network: "mainnet";
  accountAddress: `0x${string}`;
  activeKeyId?: `0x${string}`;
  keys: WalletKeyRecord[];
  walletUrl: string;
  walletApiUrl?: string;
  relayUrl: string;
  createdAt: string;
  updatedAt: string;
};
```

Invariants:

- Existing profiles without `walletApiUrl` use the chain default.
- Profile file mode remains `0600`.
- Private keys remain local-only and redacted from all command output.

## Interface Contracts

### CLI Commands

```bash
mega wallet login \
  [--auth-flow device|loopback] \
  [--no-browser] \
  [--wallet-url URL] \
  [--wallet-api-url URL] \
  [--relay-url URL] \
  [--permissions FILE] \
  [--allow-call 0xTarget:signature] \
  [--timeout-ms 120000]

mega wallet create-key \
  [--auth-flow device|loopback] \
  [--no-browser] \
  [--wallet-url URL] \
  [--wallet-api-url URL] \
  [--relay-url URL] \
  [--from KEY | --spend-limit AMOUNT | --permissions FILE | --allow-call ...]

mega wallet revoke KEY \
  [--auth-flow device|loopback] \
  [--no-browser] \
  [--wallet-url URL] \
  [--wallet-api-url URL]
```

Errors:

- Invalid `--auth-flow`: exit non-zero before browser/API work.
- Invalid URL: exit non-zero before browser/API work.
- Device request expired: no profile mutation; report rerun instruction.
- User rejected: no profile mutation; report cancellation/rejection.
- State/access/account mismatch: no profile mutation; report validation error.
- PKCE failure: no profile mutation; report authorization exchange failure.

### Auth Prompt

```ts
type AuthorizationPrompt = {
  verificationUri: string;
  verificationUriComplete: string;
  userCode: string;
  expiresAt: string;
};
```

Errors:

- Prompt rendering must never include `deviceCode`, `codeVerifier`, private
  key, profile JSON, or bearer token.
- Prompt text writes to stderr so stdout remains parseable for `--json`.

### Wallet Backend Routes

```text
POST /v1/cli-auth/device/start
GET  /v1/cli-auth/device/:userCode
POST /v1/cli-auth/device/:userCode/approve
POST /v1/cli-auth/device/:userCode/reject
POST /v1/cli-auth/device/token
```

Errors:

- Unknown/expired code: `404` or explicit expired response.
- Too many code attempts or polling too fast: rate-limit response or
  `slow_down`.
- Invalid PKCE verifier: `400` and no approval disclosure.
- Consumed request: `400`/`410` and no approval disclosure.

### Wallet UI Route

```tsx
<Route path="/cli-auth" element={<CliDeviceAuthScreen />} />
```

Errors:

- Missing code: show manual code entry.
- Unknown or expired code: show recoverable error and code entry.
- Approval/revoke failure: show relay/wallet error and submit rejection to
  backend when appropriate.

## Boundary Map

```text
mega wallet login/create-key
  -> generate delegated secp256k1 private key locally
  -> create state + PKCE verifier/challenge
  -> POST walletApiUrl/v1/cli-auth/device/start
  -> print verificationUriComplete + userCode + headless prompt to stderr
  -> optionally open system browser to verificationUriComplete
  -> poll walletApiUrl/v1/cli-auth/device/token with deviceCode + verifier

browser /cli-auth?code=XXXX-XXXX
  -> GET walletApiUrl/v1/cli-auth/device/:userCode
  -> render request details and permission/revoke UI
  -> wallet passkey submits grantPermissions or revoke
  -> POST approve/reject with public result metadata

CLI poll receives approved result
  -> validate state/access/account
  -> persist local private key + approved authorizedKey metadata
  -> render normal command result on stdout
```

## Architecture Decisions

| Decision | Rationale |
| --- | --- |
| Add device flow beside loopback instead of replacing it | Preserves current local E2E and production fallback while backend/UI support rolls out. |
| Use PKCE S256 | Binds result redemption to the CLI process that created the request without introducing bearer tokens. |
| Keep prompt on stderr | Maintains parseable stdout for `--json` and `-t` command consumers. |
| Store pending auth in wallet-backend | A remote browser cannot reach the CLI loopback callback directly. |
| Return same approval metadata as loopback | Keeps profile persistence, permission summaries, and Porto session reconstruction single-sourced. |
| Add `walletApiUrl` to chain config | Separates user-facing wallet UI URL from backend polling/API URL. |
| Keep user code non-secret and short-lived | Makes manual entry ergonomic while relying on deviceCode + PKCE for polling-side security. |

## Epics

### Epic 1: CLI Device Auth Core

**Goal**: implement PKCE/device polling in wallet-cli without changing profile
semantics.
**Dependencies**: None.

#### Tasks

1. **Add PKCE and device auth helpers**
   - ID: `task-1`
   - Contract: defines `DeviceStartRequest`, `DeviceStartResponse`,
     `DeviceTokenResponse`, and PKCE helpers
   - Files: create `src/auth/pkce.ts`, create `src/auth/device.ts`, create
     `src/auth/device.test.ts`, modify `src/auth/loopback.ts` only if shared
     types move
   - Dependencies: None
   - Unit test: verifier/challenge generation, user-code formatting, token
     response parsing, poll status mapping
   - Integration test: fake `DeviceAuthClient` returns pending, slow_down, and
     approved responses
   - Test commands: `pnpm test -- src/auth/device.test.ts && pnpm typecheck`
   - Acceptance: device authorization returns the same result shape as
     loopback authorization and rejects state/access mismatches
   - Docs: None
   - Performance: polling respects backend interval and slow_down

2. **Wire device auth into wallet commands**
   - ID: `task-2`
   - Contract: consumes device auth helpers and existing wallet command result
     contracts
   - Files: modify `src/commands/wallet.ts`, modify
     `src/commands/wallet.test.ts`, modify `src/config/chains.ts`, modify
     `src/config/profile.ts`, modify `src/config/profile.test.ts`
   - Dependencies: `task-1`
   - Unit test: `--auth-flow device`, `--auth-flow loopback`, `--no-browser`,
     `--wallet-api-url`, stderr prompt, JSON stdout remains parseable
   - Integration test: command runner with temp profile dir and fake device
     authorizer
   - Test commands: `pnpm test -- src/commands/wallet.test.ts src/config/profile.test.ts && pnpm typecheck`
   - Acceptance: login/create-key/revoke can select device flow and preserve
     current loopback behavior
   - Docs: None
   - Performance: no extra network calls outside device start/poll

### Epic 2: Wallet Backend Device Broker

**Goal**: provide durable short-lived device authorization storage and API
contracts.
**Dependencies**: `task-1` contract definitions.

#### Tasks

1. **Add backend device auth persistence**
   - ID: `task-3`
   - Contract: implements `DeviceAuthRecord`
   - Files: in `../wallet-backend`, create Prisma migration/model for device
     auth records, create datastore module, create datastore tests
   - Dependencies: `task-1`
   - Unit test: create pending record, unique active user code, expiry,
     consume-once, hashed device code lookup
   - Integration test: migration applies against local Postgres test database
   - Test commands: `cd ../wallet-backend && pnpm test -- device && pnpm typecheck`
   - Acceptance: backend never stores raw device codes or private key material
   - Docs: None
   - Performance: indexed lookup by user code and device code hash

2. **Add backend device auth routes**
   - ID: `task-4`
   - Contract: implements wallet-backend route contract
   - Files: in `../wallet-backend`, create `src/routes/CliDeviceAuthRoutes.ts`,
     create route tests, modify `src/index.ts`
   - Dependencies: `task-3`
   - Unit test: start, lookup, approve, reject, token pending, token approved,
     slow_down, expired, invalid PKCE
   - Integration test: Hono app route tests with test database
   - Test commands: `cd ../wallet-backend && pnpm test -- CliDeviceAuthRoutes && pnpm typecheck`
   - Acceptance: CLI can start and redeem a device request through backend
     without exposing approval to invalid PKCE/device callers
   - Docs: backend README update if local env/setup changes
   - Performance: route-level rate limiting or slow_down behavior enforced

### Epic 3: Wallet UI Device Authorization

**Goal**: let a browser resolve a pending device authorization by user code and
reuse existing grant/revoke UI.
**Dependencies**: `task-4`.

#### Tasks

1. **Add device auth lookup and code-entry screen**
   - ID: `task-5`
   - Contract: consumes wallet-backend lookup route
   - Files: in `../wallet`, create
     `src/screens/CliDeviceAuthScreen/`, add parser/API helpers, modify
     `src/App.tsx`, add tests
   - Dependencies: `task-4`
   - Unit test: accepts `?code=XXXX-XXXX`, manual code normalization, unknown
     code error, expired code error
   - Integration test: render screen with mocked backend lookup
   - Test commands: `cd ../wallet && pnpm test -- CliDeviceAuthScreen && pnpm lint`
   - Acceptance: user can enter or open a code and see the exact request
     details before approval
   - Docs: None
   - Performance: one lookup per code submit plus normal query retries

2. **Reuse grant and revoke approval flows**
   - ID: `task-6`
   - Contract: consumes pending device request and posts approve/reject result
   - Files: in `../wallet`, modify
     `src/screens/GrantPermissionsScreen/GrantPermissionsScreen.tsx` only if a
     reusable adapter is needed, modify existing CLI loopback screens if shared
     helpers are extracted, add device grant/revoke tests
   - Dependencies: `task-5`
   - Unit test: grant posts `authorizedKey` metadata, revoke posts revoke hash,
     rejection posts reject status, no private data posted
   - Integration test: mocked Porto grant/revoke path through device screen
   - Test commands: `cd ../wallet && pnpm test -- CliDeviceAuthScreen GrantPermissionsScreen && pnpm lint`
   - Acceptance: device grant/revoke produces the same public metadata as
     loopback grant/revoke
   - Docs: wallet README route note
   - Performance: no duplicate grant/revoke submission

### Epic 4: Local E2E And Documentation

**Goal**: make the new flow testable locally and understandable to users and
agents.
**Dependencies**: `task-2`, `task-4`, `task-6`.

#### Tasks

1. **Extend local shim and E2E harness**
   - ID: `task-7`
   - Contract: implements local backend device route behavior for tests
   - Files: modify `scripts/loopback-e2e.mjs`, add or modify E2E artifacts
     handling only as needed
   - Dependencies: `task-2`, `task-4`, `task-6`
   - Unit test: N/A
   - Integration test: CLI starts device auth, Playwright visits
     `/cli-auth?code=...`, wallet approves, CLI persists key; same for revoke
   - Test commands: `pnpm e2e:loopback -- --auth-flow device --screen-only` and
     `pnpm e2e:loopback -- --auth-flow device --management`
   - Acceptance: local wallet UI on `4000` and shim on `4002` can complete
     device login and revoke
   - Docs: `AGENTS.md`
   - Performance: shim polling deterministic and bounded

2. **Update user and agent documentation**
   - ID: `task-8`
   - Contract: documents command and auth UX contracts
   - Files: modify `README.md`, modify `SKILL.md`, modify `AGENTS.md`, update
     this plan's task tracking if implementation starts
   - Dependencies: `task-2`, `task-7`
   - Unit test: N/A
   - Integration test: documented commands appear in `mega wallet --help`
   - Test commands: `pnpm build && pnpm test`
   - Acceptance: docs explain browser/default auth, `--no-browser`, headless
     code entry, loopback fallback, and local dev endpoints
   - Docs: `README.md`, `SKILL.md`, `AGENTS.md`
   - Performance: N/A

## Dependency DAG

```yaml
tasks:
  - id: task-1
    title: "Add PKCE and device auth helpers"
    depends_on: []
    unlocks: [task-2, task-3]

  - id: task-2
    title: "Wire device auth into wallet commands"
    depends_on: [task-1]
    unlocks: [task-7, task-8]

  - id: task-3
    title: "Add backend device auth persistence"
    depends_on: [task-1]
    unlocks: [task-4]

  - id: task-4
    title: "Add backend device auth routes"
    depends_on: [task-3]
    unlocks: [task-5, task-7]

  - id: task-5
    title: "Add device auth lookup and code-entry screen"
    depends_on: [task-4]
    unlocks: [task-6]

  - id: task-6
    title: "Reuse grant and revoke approval flows"
    depends_on: [task-5]
    unlocks: [task-7]

  - id: task-7
    title: "Extend local shim and E2E harness"
    depends_on: [task-2, task-4, task-6]
    unlocks: [task-8]

  - id: task-8
    title: "Update user and agent documentation"
    depends_on: [task-2, task-7]
    unlocks: []

parallel_groups:
  - [task-1]
  - [task-2, task-3]
  - [task-4]
  - [task-5]
  - [task-6]
  - [task-7]
  - [task-8]

critical_path:
  - task-1
  - task-3
  - task-4
  - task-5
  - task-6
  - task-7
  - task-8
```

## File Creation Audit

| New File | Lines (est.) | Justification |
| --- | ---: | --- |
| `src/auth/pkce.ts` | ~120 | PKCE/user-code generation is security-sensitive and reusable across CLI tests and local shim. |
| `src/auth/device.ts` | ~260 | Device start/poll exchange is distinct from loopback callback server behavior. |
| `src/auth/device.test.ts` | ~220 | Auth boundary tests should be isolated from command rendering tests. |
| `../wallet-backend/src/routes/CliDeviceAuthRoutes.ts` | ~300 | New backend API surface for start/lookup/approve/reject/token. |
| `../wallet-backend/src/datastores/CliDeviceAuthDatastore.ts` | ~180 | Encapsulates expiry, hash lookup, uniqueness, and consume-once rules. |
| `../wallet-backend/src/types/requests/CliDeviceAuth*.ts` | ~180 | Existing backend pattern uses typed request/response classes. |
| `../wallet/src/screens/CliDeviceAuthScreen/index.tsx` | ~260 | New top-level wallet UI route and code-entry state machine. |
| `../wallet/src/screens/CliDeviceAuthScreen/parseDeviceAuth.ts` | ~120 | Keeps code normalization and URL parsing testable. |

## Risk Assessment

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Device auth result can be redeemed by the wrong client | High | Store hashed device code, require PKCE verifier, consume once, validate state/access/account in CLI. |
| User approves the wrong request after entering a code | High | Show exact user code, operation, delegated key, permissions, and account in wallet UI before approval. |
| Backend stores sensitive material | High | Never send private key or verifier to UI; store only device code hash and public approval metadata. |
| CLI JSON output becomes unparseable due to prompts | Medium | Write prompts/progress to stderr and add command tests. |
| Divergence between loopback and device approval metadata | Medium | Reuse existing authorizedKey result shape and profile persistence. |
| Multi-repo sequencing causes broken local E2E | Medium | Land backend contract first, then UI consumer, then CLI E2E shim. |
| Brute-force user code lookup | Medium | Short expiry, rate limits, attempt counters, unique active code index. |

## Integration Verification Checklist

- [ ] `mega wallet login --auth-flow device --no-browser --json` keeps stdout
  valid JSON and prints prompt to stderr.
- [ ] `mega wallet create-key --auth-flow device` uses profile `walletUrl`,
  `walletApiUrl`, and `relayUrl`.
- [ ] `mega wallet revoke --auth-flow device` validates local account before
  marking a key revoked.
- [ ] Wallet-backend rejects invalid PKCE verifier and consumed device requests.
- [ ] Wallet UI `/cli-auth?code=XXXX-XXXX` shows request details and code match
  prompt.
- [ ] Wallet UI grant posts approved `authorizedKey` public metadata only.
- [ ] Wallet UI revoke posts revoke public metadata only.
- [ ] Local wallet UI on `http://localhost:4000` plus shim on
  `http://127.0.0.1:4002` completes device login.
- [ ] Local E2E completes device revoke and local key audit update.
- [ ] Existing loopback E2E still passes.

## Task Tracking

### Status Legend

- [ ] Not started
- [~] In progress
- [x] Completed
- [!] Blocked

### Epic 1: CLI Device Auth Core

- [ ] task-1: Add PKCE and device auth helpers
- [ ] task-2: Wire device auth into wallet commands

### Epic 2: Wallet Backend Device Broker

- [ ] task-3: Add backend device auth persistence
- [ ] task-4: Add backend device auth routes

### Epic 3: Wallet UI Device Authorization

- [ ] task-5: Add device auth lookup and code-entry screen
- [ ] task-6: Reuse grant and revoke approval flows

### Epic 4: Local E2E And Documentation

- [ ] task-7: Extend local shim and E2E harness
- [ ] task-8: Update user and agent documentation
