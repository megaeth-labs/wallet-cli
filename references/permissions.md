# Permission Requests

Read this when constructing `--permissions ./permissions.json` files, changing
non-default permission limits, or debugging wallet permission schema errors.

For a simple default USDM spend cap on a new key, pair `--spend-limit` with the
workflow's explicit call scope:

```bash
mega wallet create-key \
  --spend-limit 0xfafddbb3fc7688494971a79cc65dca3ef82079e7:25:week \
  --allow-call '0xfafddbb3fc7688494971a79cc65dca3ef82079e7:transfer(address,uint256)'
```

Each repeated `--spend-limit <token_address>:<amount>:<period>` adds one
`permissions.spend` row. Token must be a 20-byte address; use
`0x0000000000000000000000000000000000000000` for native ETH. Amount is the
human token amount. Period must be `minute`, `hour`, `day`, `week`, `month`, or
`year`.

Add `--network testnet` when creating a testnet key. The default USDM token
address is network-specific; custom permission files must use token and target
addresses for the selected network. The built-in defaults use:

- mainnet USDM: `0xfafddbb3fc7688494971a79cc65dca3ef82079e7`
- testnet USDM: `0x15e9f2b0a747ac05c7446559306687085d161e5c`

Use a full permission file when the user needs custom expiry or no-spend
permissions. Repeat `--spend-limit` for multi-row spend.
For a non-default fee token with the shorthand flow, use `--fee-token <symbol>`
and optional `--fee-limit <amount>` instead of a full file.

## File Shape

The file passed to `--permissions` is the complete permission request, not only
the inner `permissions` object:

```json
{
  "expiry": 1800000000,
  "feeToken": {
    "symbol": "USDM"
  },
  "permissions": {
    "calls": [
      {
        "to": "0xfafddbb3fc7688494971a79cc65dca3ef82079e7",
        "signature": "approve(address,uint256)"
      },
      {
        "to": "0x1234567890abcdef1234567890abcdef12345678",
        "signature": "deposit(uint256)"
      }
    ],
    "spend": [
      {
        "token": "0xfafddbb3fc7688494971a79cc65dca3ef82079e7",
        "limit": "100000000000000000000",
        "period": "week"
      }
    ]
  }
}
```

## Field Rules

- `expiry` is required and must be a future Unix timestamp in seconds.
- `feeToken` is required. `feeToken.symbol` selects the preferred relay fee
  token for later writes. Omit the symbol or use `ETH` for native ETH.
- `feeToken.limit` is optional compatibility metadata, not an on-chain
  permission by itself. When present for a known fee token, the CLI treats it as
  a human-decimal fee buffer and adds or merges that amount into
  `permissions.spend` before approval. You can also omit it and encode the fee
  capacity directly in `permissions.spend`.
- `maxFeesUSD` is not implemented by the CLI; do not include it in permission
  files.
- `permissions` is required.
- `permissions.spend` is required and may be `[]` for no explicit spend.
- Spend `limit` values are integer base units, not human decimals. For an
  18-decimal token, `"1000000000000000000"` means 1 token.
- Spend `period` must be `minute`, `hour`, `day`, `week`, `month`, or `year`.
- Use `0x0000000000000000000000000000000000000000` or omit `token` for native
  ETH spend. Use a 20-byte token address for ERC20 spend.
- Custom permission files must include spend capacity for relay fees in the
  selected fee token. If the fee token is also the workflow token, increase that
  token's spend limit enough to cover both the workflow amount and fees. If the
  fee token is different, add a separate spend row for it.
- `permissions.calls` is required and must contain at least one entry. Do not
  omit it or use `permissions.calls: []`; both produce unusable or rejected
  write keys.
- Each call entry must include both `to` and `signature`. Prefer
  human-readable function signatures, such as `transfer(address,uint256)` or
  `supply(address,uint256,address,uint16)`, over 4-byte hex selectors; use a
  selector only when the full function signature is unavailable.
- Tuple parameters use standard ABI notation with nested parentheses, such as
  `exactOutputSingle((address,address,uint24,address,uint256,uint256,uint160))`.
  Use canonical signatures without parameter names or spaces, and verify complex
  selectors with an ABI encoder or `cast sig`.
- ETH and WETH are different spend scopes. A flow that wraps native ETH and
  then supplies or swaps WETH may need both native ETH spend and WETH spend,
  plus calls for `deposit()`, `approve(address,uint256)`, and the downstream
  contract function.

## Additional Examples

Non-USDM spend token:

```json
"spend": [
  {
    "token": "0x7777777777777777777777777777777777777777",
    "limit": "1000000000000000000",
    "period": "week"
  }
]
```

Selector-only call permission, used when the full function signature is not
available:

```json
"calls": [
  {
    "to": "0x8888888888888888888888888888888888888888",
    "signature": "0x5fd9ae2e"
  }
]
```

## Multi-Contract Writes

Workflows that move ERC20 value through another contract usually need both
spend permission for the token and call permission for each function they
invoke, such as ERC20 `approve` plus the downstream protocol call. A key with
sufficient spend but no call permission will still fail with `UnauthorizedCall`.
