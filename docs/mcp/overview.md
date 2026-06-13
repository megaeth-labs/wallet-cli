# Embedded MCP

The Wallet CLI includes an embedded MCP server exposed through:

```bash
mega moss mcp serve
```

## Documentation Map

- [Host Configuration](host-config.md)
- [Safety Model](safety.md)
- [Agent Workflows](workflows.md)

## Summary

The embedded MCP server supports formal stdio MCP JSON-RPC flows including:
- `initialize`
- `ping`
- `tools/list`
- `tools/call`
