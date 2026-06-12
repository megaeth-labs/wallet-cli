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
