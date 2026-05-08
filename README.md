# MegaETH Wallet CLI

MegaETH Wallet CLI provides local-machine wallet commands for agent and developer
workflows. The first release is scoped to loopback browser authorization, local
profile storage, read-only calls, relay-backed execution, and transfer helpers.

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck
```

The package exposes a `mega` binary after `pnpm build`:

```bash
node dist/index.js --help
```

## Planned Commands

```bash
mega wallet login
mega wallet whoami
mega wallet keys
mega wallet logout
mega wallet call
mega wallet execute
mega wallet transfer
```

Only the scaffold and help output are implemented in this task. Follow-up tasks
will add loopback authorization, profile storage, read-only RPC calls, relay
execution, and transfer convenience commands.

## Security Baseline

Private keys, authorization material, API keys, bearer tokens, and passkey or
WebAuthn material must never be logged or printed. The loopback flow keeps the
CLI-generated delegated key private on the local machine.
