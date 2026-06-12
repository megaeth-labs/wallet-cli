# Progress

- Initialized feature branch workspace.
- Reviewed current repo structure; wallet.ts currently centralizes command registration and rendering.
- Implemented initial architectural skeleton:
  - `src/core/operations.ts`
  - `src/schemas/wallet.ts`
  - `src/mcp/server.ts`
  - `src/mcp/tools.ts`
- Added `mega moss mcp serve` command.
- Added initial read-only MCP tool registry (`whoami`, `list`, `permissions`, `debug`).
- Added README note for the experimental embedded MCP surface.
- Validated with lint + targeted tests.
- Refactored `whoami` and `list` to run through shared core helpers (`src/core/wallet-status.ts`).
- Updated MCP registry to consume shared runtime for those operations instead of command wrappers.
- Moved delegated-key permissions inspection onto shared runtime (`src/core/wallet-permissions.ts`).
- Updated MCP registry to consume shared runtime for `permissions` as well.
- Added first agent-oriented aggregate tool: `moss_wallet_status`, built from shared runtime state.
