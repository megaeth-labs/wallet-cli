# Permission Requests

Read this when constructing `--permissions ./permissions.json` files, changing
non-default permission limits, or debugging wallet permission schema errors.

For a simple default USDM spend cap on a new key, pair `--spend-limit` with the
workflow's explicit call scope:

```bash
mega wallet create-key \
  --spend-limit 25 \
  --allow-call '0xfafddbb3fc7688494971a79cc65dca3ef82079e7:transfer(address,uint256)'
```

Add `--network testnet` when creating a testnet key. The default USDM token
address is network-specific; custom permission files must use token and target
addresses for the selected network. The built-in defaults use:

- mainnet USDM: `0xfafddbb3fc7688494971a79cc65dca3ef82079e7`
- testnet USDM: `0x15e9f2b0a747ac05c7446559306687085d161e5c`

Use a full permission file when the user needs custom expiry, fee token, spend
token, spend period, broad call authority, multi-contract call scope, or no
spend.

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
- `feeToken` is required. `feeToken.limit` is a decimal string; `symbol` is
  optional but should be included for user-readable approval text.
- `feeToken.limit` is token-denominated. `maxFeesUSD` is not implemented by the
  CLI; do not include it in permission files.
- `permissions` is required.
- `permissions.spend` is required and may be `[]` for no explicit spend.
- Spend `limit` values are integer base units, not human decimals.
- Spend `period` must be `minute`, `hour`, `day`, `week`, `month`, or `year`.
- Omit `token` for native ETH spend. Use a 20-byte token address for ERC20
  spend.
- `permissions.calls` is required and must contain at least one entry.
- Use `permissions.calls: [{}]` for broad contract call authority: any target
  and any function, still bounded by spend, fee, expiry, relay, and account
  enforcement.
- Do not use `permissions.calls: []`. Empty call permissions cannot execute
  relay-backed writes, including native ETH transfers, and the CLI rejects them
  in custom permission request files.
- Do not omit `permissions.calls`. Omitted call permissions have produced
  approvals that look funded but are rejected by the relay for writes; the CLI
  rejects them in custom permission request files.
- A call entry may specify `to`, `signature`, or both. Prefer human-readable
  function signatures, such as `transfer(address,uint256)` or
  `supply(address,uint256,address,uint16)`, over 4-byte hex selectors.
- Use a 4-byte selector only when the full function signature is unavailable.
  For example, prefer `supply(address,uint256,address,uint16)` instead of
  `0x617ba037`.
- ETH and WETH are different spend scopes. A flow that wraps native ETH and
  then supplies or swaps WETH may need both native ETH spend and WETH spend,
  plus calls for `deposit()`, `approve(address,uint256)`, and the downstream
  contract function.

## Multi-Contract Writes

Workflows that move ERC20 value through another contract usually need both
spend permission for the token and call permission for each function they
invoke, such as ERC20 `approve` plus the downstream protocol call. A key with
sufficient spend but no call permission will still fail with `UnauthorizedCall`.
