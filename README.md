# MegaETH MOSS CLI

Command-line access to a MegaETH MOSS account. Connect your passkey account,
create scoped delegated keys, inspect live permissions, and submit reads or
writes from a terminal or automation workflow.

> Warning: This is early software. Use scoped keys, review wallet prompts, and
> avoid approving more spend or call authority than a workflow needs.

## Install

### Shell Script

```bash
curl -fsSL https://account.megaeth.com/install | sh
```

The installer downloads the latest release, verifies its checksum, installs the
`mega` command, and installs the bundled agent skill. Add the printed install
directory to `PATH` if needed.

Install a specific release:

```bash
curl -fsSL https://account.megaeth.com/install | sh -- --version v0.1.0
```

### Build From Source

```bash
git clone https://github.com/megaeth-labs/wallet-cli
cd wallet-cli
pnpm install
pnpm build
./scripts/install.sh
```

Requires Node.js 22 or newer and pnpm.

## Quick Start

```bash
# Connect this machine to your MOSS account
mega moss login

# Check the connected account and active delegated key
mega moss whoami

# Create a scoped key for USDm transfers
mega moss create-key \
  --spend-limit 0xfafddbb3fc7688494971a79cc65dca3ef82079e7:25:week \
  --allow-call '0xfafddbb3fc7688494971a79cc65dca3ef82079e7:transfer(address,uint256)' \
  --label usdm-transfer

# Send through the active delegated key
mega moss transfer \
  --token 0xfafddbb3fc7688494971a79cc65dca3ef82079e7 \
  --to 0xabcdefabcdefabcdefabcdefabcdefabcdefabcd \
  --amount 1
```

Login opens `account.megaeth.com` in your browser and stores a local account
profile. It does not create a write-capable key. Use `create-key` to approve a
delegated key with explicit call and spend scope.

## Account And Key Model

MegaETH MOSS CLI is not a root wallet or passkey manager. Your passkey stays in
MegaETH Wallet. The CLI stores local delegated session-key material only after
you approve it in the browser.

Delegated keys are bounded by:

- expiry
- token/native spend limits
- allowed contract calls
- account and relay enforcement

Use narrow keys. A key that can transfer USDm should not also be able to call an
unrelated protocol unless the workflow needs that permission.

## Output Formats

Human output is the default:

```bash
mega moss list
mega moss permissions 0xKEY_OR_ACCESS_ADDRESS
```

Machine-readable output:

```bash
mega moss whoami --json
mega moss list --json
mega moss permissions 0xKEY_OR_ACCESS_ADDRESS --json
```

Compact tab-delimited output:

```bash
mega moss whoami --terse
```

Use `--json` or `--terse` for scripts and agents. Human mode may include
terminal color or login helpers when attached to a TTY.

## Commands

### Login

```bash
mega moss login
```

Connects the local CLI profile to your MOSS account. Browser authorization uses
same-machine loopback. Normally let the CLI open the browser; use
`--no-browser` only when you need to copy the authorization URL manually.

If a profile already exists, `login` exits before opening the browser. Use
`create-key` to add a delegated key, or `logout` to forget the local profile.
`logout` is local-only and does not revoke keys on-chain.

### Keys

```bash
mega moss whoami
mega moss list
mega moss list --show-inactive
mega moss permissions 0xKEY_OR_ACCESS_ADDRESS
mega moss switch 0xKEY_OR_ACCESS_ADDRESS
mega moss label 0xKEY_OR_ACCESS_ADDRESS "agent"
```

`permissions` shows the approved scope and, when RPC is available, live
on-chain spend remaining. In JSON output, `authorizedKey.permissions.spend` is
the stored request and `spendInfos[].remaining` is the live remaining capacity.

Create a key:

```bash
mega moss create-key \
  --spend-limit 0xfafddbb3fc7688494971a79cc65dca3ef82079e7:25:week \
  --allow-call '0xfafddbb3fc7688494971a79cc65dca3ef82079e7:transfer(address,uint256)' \
  --label agent
```

Each `--spend-limit` is `<token_address>:<amount>:<period>`. Use
`0x0000000000000000000000000000000000000000` for native ETH. Amount is a human
token amount. Period is `minute`, `hour`, `day`, `week`, `month`, or `year`.

Each `--allow-call` is `<contract_address>:<function_signature>`. Write keys
must have explicit call scope. Empty or omitted call permissions cannot execute
relay-backed writes.

For advanced permission files, see
[references/permissions.md](references/permissions.md).

### Revoke

```bash
mega moss revoke 0xKEY_OR_ACCESS_ADDRESS
mega moss revoke 0xKEY_OR_ACCESS_ADDRESS --fee-token USDm
```

Revokes a delegated key on-chain after browser confirmation. After success, the
CLI removes local private key material for that key and keeps an inactive audit
record.

### Reads

```bash
mega moss call \
  --to 0x1234567890abcdef1234567890abcdef12345678 \
  --data 0x
```

ABI mode:

```bash
mega moss call \
  --to 0x1234567890abcdef1234567890abcdef12345678 \
  --abi ./erc20.json \
  --function balanceOf \
  --args '["0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"]'
```

`call` is read-only and does not require a delegated write key.

### Writes

```bash
mega moss execute \
  --to 0x1234567890abcdef1234567890abcdef12345678 \
  --data 0x \
  --value 0
```

Multiple calls:

```bash
mega moss execute --calls ./calls.json
```

Selected key:

```bash
mega moss execute --key 0xKEY_OR_ACCESS_ADDRESS --calls ./calls.json
```

Spend permission is not call permission. Select or create a key whose spend
limits and call scopes cover the operation.

### Transfers

Native ETH:

```bash
mega moss transfer \
  --to 0xabcdefabcdefabcdefabcdefabcdefabcdefabcd \
  --amount 0.1
```

ERC20:

```bash
mega moss transfer \
  --token 0x1234567890abcdef1234567890abcdef12345678 \
  --to 0xabcdefabcdefabcdefabcdefabcdefabcdefabcd \
  --amount 100
```

The CLI reads ERC20 decimals from RPC by default.

### Funding And Debugging

```bash
mega moss fund
mega moss debug
mega moss debug --skip-chain --json
```

`debug` inspects local profile health without printing private key material.

## Fees

Relay fees use the same spend accounting as token/native movement. Make sure a
key has enough spend capacity for both the workflow amount and expected relay
fees in the selected fee token.

Use `--fee-token <symbol>` and optional `--fee-limit <amount>` on `create-key`
when a key should pay relay fees with a token other than the default.

## Logout And Uninstall

```bash
mega moss logout
```

Deletes the local profile and delegated private key material for this CLI
install. It does not revoke on-chain keys.

Remove installed CLI files:

```bash
~/.mega/wallet-cli/current/scripts/uninstall.sh
```

Remove installed CLI files and local profiles:

```bash
~/.mega/wallet-cli/current/scripts/uninstall.sh --config
```

## Help

```bash
mega moss --help
mega moss <command> --help
```


## Embedded MCP

This repository includes an embedded MCP server driven by a small shared
operation registry. The current MCP surface exposes:

- `moss_whoami`
- `moss_list_keys`
- `moss_permissions`
- `moss_wallet_status`
- `moss_transfer_preview`
- `moss_transfer_execute`
- `moss_execute_preview`
- `moss_execute`
- `moss_debug`

The long-term direction is a shared runtime architecture where CLI commands and
MCP tools derive from the same wallet operation definitions. Trust-boundary
creation flows such as `login`, `create-key`, `revoke`, and `logout` remain
human-governed and are intentionally excluded from the initial MCP surface.
