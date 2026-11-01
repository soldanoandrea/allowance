# Allowance reference

The contract interface, the policy fields, NEP-141 payments, the revenue split, the factory and the MVP scope, moved
out of the [README](../README.md) on 2026-11-01 so the README keeps the pitch and the "do X, see Y" steps. Nothing here
changed in the move.

## Interface

Amounts are `NearToken` (JSON string of a `u128`): yoctoNEAR, or the token's
base unit when the asset is `{"ft": "<token>"}`. Timestamps ending in `_ns`
are `U64` (JSON string of nanoseconds since the epoch). Enum variants are
`snake_case`. `AgentId` is `{"key": "ed25519:..."}` or `{"account": "bot.near"}`.

### Owner (`predecessor == owner_id`)

| Method | Arguments | Effect / returns |
|---|---|---|
| `new` | `owner_id`, `approver_id?`, `approval_ttl_ns?` (default 24h), `key_gas_allowance?` (default 1 NEAR) | init |
| `deposit` *(payable, anyone)* | attached >= 0.01 NEAR | `income` receipt (with the revenue split applied); returns receipt id |
| `withdraw` | `amount`, `to?` | transfer to owner (or `to`); the storage reserve cannot be withdrawn; `refund` receipt |
| `register_token` *(payable)* | `token_id`, `min_deposit?` | accept a NEP-141 token; attached NEAR registers the vault on the token |
| `withdraw_ft` | `token_id`, `amount`, `to?` | `ft_transfer` out; `refund` receipt settled `paid` or `failed` (credited back) |
| `set_split` | `split` (`{beneficiaries: [{account_id, bps}]}`, up to 4, <= 100%) or `null` | revenue split of every income |
| `add_agent` | `agent_id`, `label`, `policy`, `gas_allowance?` | key agents: `AddKey` on the vault account, registration completed in a callback (returns `true`); account agents: immediate. Token policies need a registered token |
| `set_policy` | `agent_id`, `policy` | validates; bumps `policy_version`; counters kept |
| `disable_agent` / `enable_agent` | `agent_id` | cheap, reversible; key untouched. `enable_agent` also re-enables an agent the vault disabled itself (and resets its rejection count) |
| `remove_agent` | `agent_id` | forgets the agent, `DeleteKey`, denies its queued approvals |
| `top_up_allowance` | `public_key`, `allowance?` | `DeleteKey` + `AddKey` in one batch (allowances are immutable on NEAR) |
| `set_denylist` | `accounts[]` | replaces the vault-wide denylist |
| `set_approver` / `set_approval_ttl` | `approver_id?` / `ttl_ns` | |
| `pause` / `unpause` | | every payment refused while paused; keys stay |
| `kill` | | pause + remove every agent + `DeleteKey` for each key + deny every queued approval; returns the removed ids; receipts kept |
| `prune_receipts` | `before_id`, `limit?` | frees storage of settled receipts (events remain in logs) |

### Approver (`owner_id` or `approver_id`)

| Method | Arguments | Effect / returns |
|---|---|---|
| `approve` | `pending_id` | re-evaluates the policy with the threshold waived; pays, or returns `rejected`/`expired` |
| `deny` | `pending_id` | receipt `denied` (or `expired` if the TTL passed) |
| `expire_pending` *(anyone)* | `pending_id` | sweeps a request whose TTL passed |

### Agent (function-call key, or the agent's own account)

| Method | Arguments | Returns |
|---|---|---|
| `pay` | `payee`, `amount`, `asset?` (default `"near"`; must be the policy's asset), `memo?` (<= 256 bytes), `request_hash?` (32 bytes, base64) | `{"outcome":"paid"\|"failed"\|"needs_approval"\|"rejected", "receipt_id", ...}` as the transaction's final value |
| `confirm_delivery` | `receipt_id`, `passed` | records the agent's verdict on a paid receipt (once) |
| `ping` | | `{agent, registered, label, active, paused, block_timestamp_ns}` |

`pay` never panics for policy reasons; it panics only for malformed input, an
unregistered caller (so strangers cannot write receipts) or a disabled agent
(so a disabled key cannot either). After `max_consecutive_rejections`
rejected payments in a row, or a request for one approval more than
`max_open_approvals`, the vault disables the agent itself (event
`agent_auto_disabled`, recorded as `auto_disabled` on the agent); only the
owner re-enables it with `enable_agent`.

### Token receiver and views

| Method | Arguments | Returns |
|---|---|---|
| `ft_on_transfer` *(NEP-141, called by tokens)* | `sender_id`, `amount`, `msg` | registered token: credits the vault, `income` receipt (memo = `msg`), split applied, returns `"0"`; otherwise returns the full amount (refunded) |
| `simulate` | `agent_id?`, `payee`, `amount`, `asset?` | `{verdict: allow\|needs_approval\|block, reason?, remaining_budget, budget_resets_at_ns, vault_available, ...}` (in the asset's units) |
| `verify_receipt` | `receipt_id`, `payee`, `min_amount`, `request_hash?`, `asset?` (default NEAR) | `true` iff the receipt is a **paid** agent payment to `payee` of at least `min_amount` **in that asset**, bound to `request_hash` when given |
| `get_vault` | | owner, approver, paused, balance, available, token balances, split, counters, `block_timestamp_ns`, version |
| `get_token` | `token_id` | `{token_id, balance, min_deposit}` |
| `get_agent` / `get_agents` | `agent_id` / `from_index?`, `limit?` | agent, policy, counters, remaining budget |
| `get_policy` / `get_agent_state` | `agent_id` | |
| `get_receipt` / `get_receipts` | `receipt_id` / `from_id?`, `limit?` | |
| `get_pending` / `get_pending_by_id` | / `pending_id` | open approval requests |
| `get_denylist` | | |

Example (near-cli-rs 0.30):

```sh
near contract call-function as-read-only vault.you.testnet simulate \
  json-args '{"agent_id":{"key":"ed25519:<agent pk>"},"payee":"api.you.testnet","amount":"20000000000000000000000"}' \
  network-config testnet now
```

## Policy

```jsonc
{
  "asset": "near",                                   // or {"ft": "usdc.example.near"}: every amount below is then in token base units
  "per_tx_cap": "1000000000000000000000000",         // 1 NEAR: hard ceiling for one payment, approved or not
  "budget": {"amount": "2000000000000000000000000", "period_ns": "86400000000000"},   // 2 NEAR per day, optional
  "allow": {"list": [
    {"account_id": "api.you.testnet"},
    {"account_id": "partner-vault.you.testnet", "methods": ["deposit"]}   // another Allowance vault: paid through its deposit
  ]},                                                // or "any"
  "time_window": {"start_h": 9, "end_h": 17, "days": [1,2,3,4,5]},   // UTC hours, ISO weekdays; optional
  "cooldown_ns": "5000000000",                       // 5 s between payments; default 0
  "approval_threshold": "500000000000000000000000",  // above 0.5 NEAR a human approves; must be < per_tx_cap; optional
  "expires_at_ns": null,                             // optional
  "ft_storage_deposit": null,                        // token policies: NEAR (<= 0.1) the vault may attach to register an unregistered payee on the token
  "max_consecutive_rejections": 5,                   // the vault disables the agent after this many rejected payments in a row; default 5
  "max_open_approvals": 3                            // asking for one approval more than this disables the agent; default 3
}
```

`evaluate(policy, state, request, context)` is a pure function
(`src/policy.rs`). Checks run in a fixed order and the first failure is the
reason, so the verdict is deterministic:

1. `paused` - vault paused or killed
2. `agent_disabled`
3. `policy_expired` - `now >= expires_at_ns`
4. `asset_not_allowed` - the request's asset is not the policy's
5. `denylisted` - the vault denylist beats any allowlist
6. `not_allowlisted`
7. `over_per_tx_cap` - `amount > per_tx_cap` (the cap itself is allowed)
8. `outside_time_window` - with `opens_at_ns`
9. `cooldown` - `now < last_payment + cooldown`, with `retry_at_ns`
10. `over_budget` - `spent_in_window + amount > budget.amount`, with `remaining` and `resets_at_ns`
11. `insufficient_vault_balance` - NEAR above the storage reserve, or the vault's token balance
12. `too_many_open_approvals` - the payment needs an approval and the agent already has `max_open_approvals` open

Then: `needs_approval` if `amount > approval_threshold` (unless a human already
approved this exact payment), otherwise `pay`. A rejection from `pay` counts
towards `max_consecutive_rejections`; a payment that goes through resets the
count.

**Budget windows** are fixed buckets aligned to the epoch:
`window_start = now - now % period_ns`; counters from an older window count as
zero, so a budget resets exactly at `window_start + period_ns` with no
per-agent bookkeeping. The budget is **reserved before the transfer** and
released by the callback if the transfer fails. Approval requests reserve
nothing; the policy is evaluated again when a human approves (pause, expiry,
budget and balance are checked at that moment).

One key = one sequential nonce, so budgets are exact under concurrency. Several
keys for one agent are allowed, each with its own policy and counters. One
policy has one asset: a vault that pays in NEAR and in a token registers two
keys.

## NEP-141 payments

The owner registers a token (`register_token`; attaching ~0.00125 NEAR lets
the vault register itself on the token) and funds the vault with
`ft_transfer_call` (`ft_on_transfer` credits it and writes an `income`
receipt). The vault keeps its own per-token accounting: tokens sent with a
plain `ft_transfer` are not seen, so the accounting can only under-state.

A token `pay` reserves the budget and the tokens, then, in the same
transaction: `storage_balance_of(payee)`; if the payee has no storage and the
policy sets `ft_storage_deposit`, `storage_deposit(payee,
registration_only)` with at most that much NEAR (the token refunds the
excess; recorded on the receipt as `storage_deposit`); then `ft_transfer`
with 1 yoctoNEAR and the memo `allowance:<vault>#<receipt id>`; the callback
marks the receipt `paid`, or `failed {reason}` (`ft_transfer_failed`,
`payee_not_registered`, `insufficient_near_for_storage`,
`storage_check_failed`) and releases everything. Callbacks read promise
results themselves, so a token returning something odd cannot leave a
receipt pending.

## Revenue split and vault-to-vault payments

`set_split({beneficiaries: [{account_id, bps}]})` (up to 4, at most 100%)
forwards a share of every income (`deposit`, `ft_on_transfer`) right away:
one joined promise, one settlement callback, each share recorded on the
income receipt as `paid` or `failed` (a failed share stays in the vault).
A plain NEAR transfer runs no code on the receiver, so a vault paid that way
could not split: an allowlist entry with `methods: ["deposit"]` makes the
paying vault call the payee vault's `deposit` with the amount attached, and
the payee's split runs in the same transaction.

## Vault factory (`factory/`)

The vault wasm is published once as a NEAR **global contract by code hash**
(immutable; the publisher burns 10x the storage: 39.05 NEAR for the
390 KB build on the sandbox). `create_vault(name, owner_id?, approver_id?, ...)`
creates `<name>.<factory>` with one batch (`CreateAccount`, `Transfer`,
`UseGlobalContract`, `new`); the new vault stores ~312 bytes (~0.003 NEAR of
stake) instead of its own ~3.9 NEAR copy of the code, has **no access key**
(managed only by `owner_id`), and reports the code in `global_contract_hash`,
which the SDK's receipt verifier accepts. A failed creation refunds the
caller. Tested on neard-sandbox (`tests/factory.rs`: two vaults, payments
from each, isolation of keys, owners, budgets, receipts and kill switch).

From TypeScript (`sdk/src/factory.ts`) and the CLI:

```ts
import { FactoryClient, OwnerClient, buildPolicy, parseNear } from '@allowance/sdk';

const factory = new FactoryClient({ factoryId: 'factory.x', rpcUrl, signerId: 'you.testnet', signerKey: ownerKey });
const v = await factory.createVault({ name: 'bot', deposit: parseNear('1') });   // owner = signer unless ownerId; also approverId, approvalTtlNs, keyGasAllowance
// v: {vaultId: 'bot.factory.x', created: true, ownerId, codeHash, txHash, events}; created: false = the factory refunded the deposit
const owner = new OwnerClient({ vaultId: v.vaultId, ownerId: 'you.testnet', rpcUrl, ownerKey });
await owner.deposit(parseNear('5'));
await owner.addAgent({ key: agentPublicKey }, 'worker', buildPolicy({ perTxCap: '1', allow: ['api.x'] }));
await factory.vaults();                                                          // [{vault_id, owner_id, code_hash, created_by, created_at_ns}]
```

```sh
npx allowance factory create --factory factory.x --name bot --owner you.testnet [--approver dao.x] \
    [--deposit 1] [--approval-ttl 1d] [--key-gas-allowance 0.5] [--signer platform.x] --owner-key-file owner.json
npx allowance factory list --factory factory.x [--from 0] [--limit 50]
npx allowance factory info --factory factory.x     # owner, vault code hash, minimum deposit, number of vaults
```

The name, accounts and deposit (at least the factory's `min_deposit`, read
from `get_info`) are checked before anything is signed. The sandbox
end-to-end test (`sdk/test/e2e.sandbox.test.ts`) publishes the vault code as a
global contract, deploys the factory, creates a vault with `FactoryClient`,
funds it, adds an agent key, pays, and has the payee verify the receipt by the
global code hash.

## MVP vs stretch

| # | Feature (DESIGN.md section 5) | Status |
|---|---|---|
| 1-4 | Contract core, `evaluate` unit tests, sandbox tests, approval queue | done |
| 5 | TS agent SDK + CLI, agent loop with optional LLM and one counteroffer | done |
| 6 | Paid demo API (402 + receipt verification via RPC) | done (NEAR and NEP-141 prices) |
| 7 | Attack demo, log in [docs/attack-log.md](attack-log.md) | done (now three layers: risk check, simulate, contract) |
| 8 | Ledger and policy page (static, RPC views + events) | done; GitHub Pages workflow ready (`.github/workflows/pages.yml`), runs once the repository is public |
| 9 | `make demo`, README, `.env.example`, CI, LICENSE | done (11 checks) |
| 10 | Testnet deployment, accounts, hosted ledger | **prepared, not run**: `make demo-testnet`, `scripts/testnet/`, [docs/TESTNET.md](TESTNET.md); needs the owner's accounts and explicit go |
| stretch | Account-based agents | done (one sandbox test) |
| stretch | NEP-141 / USDC-style payments with storage check and payee registration | done (8 unit, 1 sandbox, demo scenario) |
| stretch | Counterparty-risk service (age, code change, prior receipts, deny-list) | done (`risk/`, 16 tests, in the agent loop and the attack demo) |
| stretch | Revenue split on income + vault-to-vault payments | done (7 unit, 1 sandbox, demo step) |
| stretch | A key that keeps getting refused disables itself (rejections in a row, open approval requests) | done (7 unit, 1 sandbox; added after review) |
| stretch | Vault factory on a global contract | done (5 unit, 1 sandbox test; TypeScript `FactoryClient` + `allowance factory` CLI, 10 unit tests, 1 sandbox end-to-end test; testnet/mainnet publishing is the documented plan) |
| stretch | Sputnik DAO approver, Agent Market, NEAR Intents, owner web UI, NEP-413 relayer, TEE proofs | not started |
