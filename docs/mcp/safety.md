# MCP Safety Model

## Tool classes

### Read tools
- `moss_whoami`
- `moss_list_keys`
- `moss_permissions`
- `moss_wallet_status`
- `moss_debug`

### Preview tools
- `moss_transfer_preview`
- `moss_execute_preview`

### Execute tools
- `moss_transfer_execute`
- `moss_execute`

## Recommended host policy

- auto-approve read tools only
- use preview tools before execute tools
- require human review for execute tools unless delegated scope is tightly controlled

## Human-governed trust-boundary flows

The following flows are intentionally excluded from MCP v1:
- `login`
- `create-key`
- `revoke`
- `logout`

These remain human-governed because they establish, expand, or revoke wallet authority.
