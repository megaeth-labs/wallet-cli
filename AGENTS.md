# Wallet CLI Agent Instructions

This repository contains the MegaETH Wallet CLI. Follow the orchestration plan
for task ownership and keep edits scoped to the files assigned to the active
task unless a small adjacent test or documentation update is required.

## Commands

```bash
pnpm build
pnpm test
pnpm lint
pnpm typecheck
pnpm format
```

## Security Rules

- Never print or log private keys, authorization blobs, API keys, bearer tokens,
  passkeys, WebAuthn material, or relay secrets.
- Do not put secrets in URLs. Loopback callback URLs may carry state and
  approved public metadata only.
- Persist canonical authorization data exactly as approved by the wallet. Treat
  summaries shown by CLI commands as derived output.
- Keep profile files private to the local user when implementing storage.

## Git Rules

- Do not revert changes made by other workers.
- Stage only files owned by the current task.
- Use conventional commits with no AI attribution.
