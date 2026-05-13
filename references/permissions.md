# Permission Requests

Read this when constructing `--permissions ./permissions.json` files, changing
non-default permission limits, or debugging wallet permission schema errors.

For a simple default USDM spend cap on a new key, prefer:

```bash
mega wallet create-key --spend-limit 25
```

Use a full permission file when the user needs custom expiry, fee token, spend
token, spend period, call scope, or no spend.

## File Shape

The file passed to `--permissions` is the complete permission request, not only
the inner `permissions` object:

```json
{
  "expiry": 1800000000,
  "feeToken": {
    "limit": "1",
    "symbol": "USDM"
  },
  "permissions": {
    "calls": [
      {
        "to": "0xfafddbb3fc7688494971a79cc65dca3ef82079e7",
        "signature": "approve(address,uint256)"
      },
      {
        "to": "0x7e324AbC5De01d112AfC03a584966ff199741C28",
        "signature": "supply(address,uint256,address,uint16)"
      }
    ],
    "spend": [
      {
        "token": "0xfafddbb3fc7688494971a79cc65dca3ef82079e7",
        "limit": "100000000000000000000",
        "period": "year"
      }
    ]
  }
}
```

## Field Rules

- `expiry` is required and must be a future Unix timestamp in seconds.
- `feeToken` is required. `feeToken.limit` is a decimal string; `symbol` is
  optional but should be included for user-readable approval text.
- `permissions` is required.
- `permissions.spend` is required and may be `[]` for no explicit spend.
- Spend `limit` values are integer base units, not human decimals.
- Spend `period` must be `minute`, `hour`, `day`, `week`, `month`, or `year`.
- Omit `token` for native ETH spend. Use a 20-byte token address for ERC20
  spend.
- Prefer including `permissions.calls` explicitly in custom files.
- Use `permissions.calls: [{}]` for broad contract call authority: any target
  and any function, still bounded by spend, fee, expiry, relay, and account
  enforcement.
- Use `permissions.calls: []` only when the key should have no executable
  contract call scope. A key with spend allowance but `calls: []` cannot perform
  useful ERC20, swap, Aave, or other contract-write actions because those all
  require contract calls.
- Omitted `permissions.calls` is legacy/default shorthand that the wallet may
  present as broad call authority. Do not rely on omission in hand-authored
  permission files; use `calls: [{}]` for broad authority.
- A call entry may specify `to`, `signature`, or both. `signature` may be a
  function signature like `transfer(address,uint256)` or a 4-byte selector.

## Aave Supply

Aave supply-style interactions need both spend permission for the supplied token
and call permission for ERC20 `approve` plus Aave pool `supply`. A key with
sufficient spend but `permissions.calls: []` will still fail with
`UnauthorizedCall`.
