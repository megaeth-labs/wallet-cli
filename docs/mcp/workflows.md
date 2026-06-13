# MCP Workflows

## Best first tool

Start most agent sessions with:

- `moss_wallet_status`

It provides:
- connected account status
- delegated-key presence
- readiness state
- structured issue codes
- suggested next actions

## Readiness states

### `ready`
A delegated key is present and usable for delegated operations.

### `needs_key`
Additional delegated authorization is required before delegated writes can proceed.

## Logged in, no delegated key

Useful MCP operations still exist:
- inspect account identity
- list keys
- inspect wallet readiness
- preview transfers/calls and receive structured refusal or missing-capability guidance

## Delegated key present

The MCP server can additionally:
- preview real delegated writes
- execute delegated writes through the relay path
- report missing call or spend permissions in structured form
