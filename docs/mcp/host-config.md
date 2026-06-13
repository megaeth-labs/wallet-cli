# MCP Host Configuration

Start the embedded server with:

```bash
mega moss mcp serve
```

## Generic stdio configuration

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

## Notes

- the server uses stdio transport
- formal JSON-RPC MCP flows are supported
- `ping`, `initialize`, `tools/list`, and `tools/call` are supported
