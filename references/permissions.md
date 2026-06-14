# Permission Requests

Read this when constructing `--permissions ./permissions.json` files, changing
non-default permission limits, or debugging wallet permission schema errors.

For a simple default USDM spend cap on a new key, pair `--spend-limit` with the
workflow's explicit call scope:

```bash
mega moss create-key \
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
For a custom fee hint with the shorthand flow, use optional
`--fee-limit <amount>` instead of a full file. The wallet UI user selects the
actual Gas Token on the grant screen.

## File Shape

The file passed to `--permissions` is the complete permission request, not only
the inner `permissions` object:

```json
{
  "expiry": 1800000000,
  "maxFeesUSD": 1,
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
- `maxFeesUSD` is optional and must be a non-negative number. It is sent to the
  wallet UI as an approval hint; it is not an on-chain permission. New
  CLI-generated create-key requests use this instead of legacy
  `feeToken.limit` request metadata.
- `feeToken` is optional legacy compatibility metadata. `feeToken.limit` is not
  an on-chain permission by itself, and the current wallet UI does not use
  request `feeToken.symbol` to preselect the grant Gas Token. Prefer
  `maxFeesUSD` plus explicit `permissions.spend` rows for workflow asset
  movement.
- `permissions` is required.
- `permissions.spend` is required and may be `[]` for no explicit spend.
- Spend `limit` values are integer base units, not human decimals. For an
  18-decimal token, `"1000000000000000000"` means 1 token.
- Spend `period` must be `minute`, `hour`, `day`, `week`, `month`, or `year`.
- Use `0x0000000000000000000000000000000000000000` or omit `token` for native
  ETH spend. Use a 20-byte token address for ERC20 spend.
- The wallet UI handles grant Gas Token selection during approval. Inspect the
  returned key with `mega moss permissions --json` before relying on fee spend
  capacity for later writes.
- Relay fees are paid from ordinary spend capacity. During approval, the wallet
  UI may add spend capacity for the user-selected Gas Token based on
  `maxFeesUSD`. Do not use `maxFeesUSD: 0` or `--fee-limit 0` just to remove
  that row unless the user explicitly wants no fee budget.
- `permissions.calls` is required and must contain at least one entry. Do not
  omit it or use `permissions.calls: []`; both produce unusable or rejected
  write keys.
- Each call entry must include both `to` and `signature`. Prefer canonical
  human-readable function signatures, such as `transfer(address,uint256)` or
  `supply(address,uint256,address,uint16)`. Raw 4-byte selectors are accepted
  only when needed. Use `0xe0e0e0e0` for native ETH no-calldata transfer
  scopes. Do not use the reserved wildcard address
  `0x3232323232323232323232323232323232323232` or selector `0x32323232`.
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

Native ETH transfer permission:

```json
"calls": [
  {
    "to": "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    "signature": "0xe0e0e0e0"
  }
],
"spend": [
  {
    "token": "0x0000000000000000000000000000000000000000",
    "limit": "100000000000000000",
    "period": "week"
  }
]
```

## Multi-Contract Writes

Workflows that move ERC20 value through another contract usually need both
spend permission for the token and call permission for each function they
invoke, such as ERC20 `approve` plus the downstream protocol call. A key with
sufficient spend but no call permission will still fail with `UnauthorizedCall`.
