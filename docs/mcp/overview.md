# Embedded MCP

The Wallet CLI includes an embedded MCP server exposed through:

```bash
mega moss mcp serve
```

## Host Configuration

Example stdio configuration:

```json
{
  "mcpServers": {
    "mega-moss": {
      "transport": "stdio",
      "command": "mega",
      "args": ["moss", "mcp", "serve"]
    }
  }
}
```

## Tool Surface

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

## Safety Model

- auto-approve read tools only
- use preview tools before execute tools
- require human review for execute tools unless delegated scope is tightly controlled
- trust-boundary creation remains human-governed and is not exposed through MCP v1

Excluded trust-boundary flows:
- `login`
- `create-key`
- `revoke`
- `logout`

## Readiness Model

The most useful first tool for agents is usually:

- `moss_wallet_status`

It provides:
- connected account status
- delegated-key presence
- readiness state
- structured issue codes
- suggested next actions

Typical readiness states:
- `ready` — delegated operations can proceed
- `needs_key` — additional delegated authorization is required

## Pre-Key vs Post-Key Behavior

### Logged in, no delegated key
Useful MCP operations still exist:
- inspect account identity
- list keys
- inspect wallet readiness
- preview transfers/calls and receive structured refusal / missing-capability guidance

### Delegated key present
The MCP server can additionally:
- preview real delegated writes
- execute delegated writes through the relay path
- report missing call/spend permissions in structured form

## Protocol Notes

The embedded server now supports formal stdio MCP JSON-RPC flows including:
- `initialize`
- `ping`
- `tools/list`
- `tools/call`

Legacy proto-MCP `{ "tool": ... }` requests are still accepted for backward compatibility during the transition period.
