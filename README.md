# Allowance - a sandboxed treasury for AI agents on NEAR

**An agent gets an allowance, not your keys.** A human funds a vault contract,
writes the spending policy on-chain and registers each agent as a
**function-call access key on the vault account itself**. The agent needs no
NEAR account, no faucet and no custodian: it signs `pay` with its key, the
vault pays the gas inside the key's allowance, and two layers decide whether
money moves:

| Layer | Enforced by | Limits |
|---|---|---|
| Access key | NEAR protocol, before the contract runs | only `pay`, `confirm_delivery`, `ping` on this contract; gas allowance; **no deposits can be attached** |
| Policy | this contract, on every `pay` | per-payment cap, budget per window, payee allowlist, vault denylist, time window, cooldown, human approval above a threshold, expiry, pause, kill |

Every payment, rejection, approval and deposit leaves a **receipt** that a payee
can verify with one free view call, and a NEP-297 event for ledgers and
indexers. `simulate` is a free view that returns `allow`, `needs_approval` or
`block` + reason, so an agent plans before it spends. The kill switch deletes
every agent key at the protocol level: a compromised agent's next transaction
is refused by the network, not by a flag the contract has to remember.

This repository is the contract and its tests (MVP features 1-4 of
[DESIGN.md](DESIGN.md)). The TypeScript agent SDK, the paid demo API, the
ledger page and the testnet deployment are later milestones.

## Build and test

Requirements: Rust stable >= 1.95 with the `wasm32-unknown-unknown` target,
[`cargo-near`](https://github.com/near/cargo-near) 0.22. No Docker needed.

```sh
rustup target add wasm32-unknown-unknown
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/near/cargo-near/releases/download/cargo-near-v0.22.0/cargo-near-installer.sh | sh

make build          # cargo near build non-reproducible-wasm -> target/near/allowance.wasm (~320 KB, ABI embedded)
make test-unit      # cargo test --lib        : 45 tests of the pure policy core and the contract logic (seconds)
make test-sandbox   # cargo test --test sandbox: 7 end-to-end flows on a local neard-sandbox (first run downloads the binary)
make test           # both
```

What the tests prove, in the words of the spec:

* `src/policy.rs` - every rejection reason, the fixed order they are checked
  in, per-tx cap inclusive, budget accumulation and **window rollover**,
  cooldown, time windows (UTC, weekdays), expiry at the boundary, approval
  threshold, policy validation, JSON round-trips.
* `src/lib.rs` (unit tests with a mocked VM) - receipts for deposits, payments,
  rejections; budget reserved before the transfer and released on failure;
  approval queue (approve re-evaluates the policy, deny, expiry sweep);
  kill; delivery confirmation; storage reserve on withdraw; pruning.
* `tests/sandbox.rs` (real node) - fund, add an agent (key is on the vault
  account with the right `method_names` and allowance), `pay` **signed with
  the function-call key**, payee balance moves by exactly the amount,
  `verify_receipt`, `confirm_delivery`; rejections write receipts and move
  nothing; a failed transfer settles as `failed` and releases the budget;
  cooldown and budget rollover on the live chain clock; needs-approval ->
  approve / deny / expire, approver account, strangers refused; **kill deletes
  the keys and the network refuses the agent's next transaction**
  (`AccessKeyNotFound`); the key cannot call owner methods
  (`MethodNameMismatch`) or attach a deposit (`DepositWithFunctionCall`);
  key allowance top-up; account-based agents.

## How a payment flows

```
Owner  -> vault.deposit() + 5 NEAR                                  event vault_funded
Owner  -> vault.add_agent({key: pk_A}, "worker", policy)            AddKey(pk_A, FunctionCall{vault, [pay,confirm_delivery,ping], 1 NEAR})
                                                                    events agent_added, policy_set
Agent  -> vault.simulate(payee, 0.02)          (view, free)         {"verdict":"allow", ...}
Agent  -(pk_A)-> vault.pay(payee, 0.02, memo, request_hash)        evaluate -> Pay; receipt #1 pending; budget reserved
                                                                    Transfer(0.02) -> payee; callback -> receipt paid; event payment_paid
Payee  -> vault.verify_receipt(1, payee, 0.02, request_hash)        true  (one RPC view, no facilitator)
Agent  -(pk_A)-> vault.confirm_delivery(1, true)                    event delivery_confirmed

Agent  -(pk_A)-> vault.pay(attacker, 2)                             receipt #2 rejected {code: not_allowlisted}; event payment_rejected; no transfer
Agent  -(pk_A)-> vault.pay(payee, 0.8)                              receipt #3 pending, approval request #0 (expires in 24h); event approval_requested
Owner  -> vault.approve(0)                                          policy re-evaluated; Transfer(0.8); receipt paid; events approval_granted, payment_paid
Owner  -> vault.kill()                                              paused; agents removed; DeleteKey(pk_A); event vault_killed
Agent  -(pk_A)-> vault.pay(...)                                     refused by the network: AccessKeyNotFound
```

## Interface

Amounts are `NearToken` (JSON string in yoctoNEAR); timestamps ending in `_ns`
are `U64` (JSON string of nanoseconds since the epoch, like
`env::block_timestamp`). Enum variants are `snake_case`. `AgentId` is
`{"key": "ed25519:..."}` or `{"account": "bot.near"}`.

### Owner (`predecessor == owner_id`)

| Method | Arguments | Effect / returns |
|---|---|---|
| `new` | `owner_id`, `approver_id?`, `approval_ttl_ns?` (default 24h), `key_gas_allowance?` (default 1 NEAR) | init |
| `deposit` *(payable, anyone)* | attached >= 0.01 NEAR | `income` receipt; returns receipt id |
| `withdraw` | `amount`, `to?` | transfer to owner (or `to`); the storage reserve cannot be withdrawn; `refund` receipt |
| `add_agent` | `agent_id`, `label`, `policy`, `gas_allowance?` | key agents: `AddKey` on the vault account, registration completed in a callback (returns `true`); account agents: immediate |
| `set_policy` | `agent_id`, `policy` | validates; bumps `policy_version`; counters kept |
| `disable_agent` / `enable_agent` | `agent_id` | cheap, reversible; key untouched |
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
| `pay` | `payee`, `amount`, `asset?` (`"near"`), `memo?` (<= 256 bytes), `request_hash?` (32 bytes, base64) | `{"outcome":"paid"\|"failed"\|"needs_approval"\|"rejected", "receipt_id", ...}` as the transaction's final value |
| `confirm_delivery` | `receipt_id`, `passed` | records the agent's verdict on a paid receipt (once) |
| `ping` | | `{agent, registered, label, active, paused, block_timestamp_ns}` |

`pay` never panics for policy reasons; it panics only for malformed input or an
unregistered caller (so strangers cannot write receipts).

### Views (free)

| Method | Arguments | Returns |
|---|---|---|
| `simulate` | `agent_id?`, `payee`, `amount`, `asset?` | `{verdict: allow\|needs_approval\|block, reason?, remaining_budget, budget_resets_at_ns, vault_available, ...}` |
| `verify_receipt` | `receipt_id`, `payee`, `min_amount`, `request_hash?` | `true` iff the receipt is a **paid** agent payment to `payee` of at least `min_amount`, bound to `request_hash` when given |
| `get_vault` | | owner, approver, paused, balance, available, counters, `block_timestamp_ns`, version |
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
  "asset": "near",                                   // only `near` in this version
  "per_tx_cap": "1000000000000000000000000",         // 1 NEAR: hard ceiling for one payment, approved or not
  "budget": {"amount": "2000000000000000000000000", "period_ns": "86400000000000"},   // 2 NEAR per day, optional
  "allow": {"list": [{"account_id": "api.you.testnet"}]},   // or "any"
  "time_window": {"start_h": 9, "end_h": 17, "days": [1,2,3,4,5]},   // UTC hours, ISO weekdays; optional
  "cooldown_ns": "5000000000",                       // 5 s between payments; default 0
  "approval_threshold": "500000000000000000000000",  // above 0.5 NEAR a human approves; must be < per_tx_cap; optional
  "expires_at_ns": null                              // optional
}
```

`evaluate(policy, state, request, context)` is a pure function
(`src/policy.rs`). Checks run in a fixed order and the first failure is the
reason, so the verdict is deterministic:

1. `paused` - vault paused or killed
2. `agent_disabled`
3. `policy_expired` - `now >= expires_at_ns`
4. `asset_not_allowed`
5. `denylisted` - the vault denylist beats any allowlist
6. `not_allowlisted`
7. `over_per_tx_cap` - `amount > per_tx_cap` (the cap itself is allowed)
8. `outside_time_window` - with `opens_at_ns`
9. `cooldown` - `now < last_payment + cooldown`, with `retry_at_ns`
10. `over_budget` - `spent_in_window + amount > budget.amount`, with `remaining` and `resets_at_ns`
11. `insufficient_vault_balance` - the vault never pays out of its storage reserve

Then: `needs_approval` if `amount > approval_threshold` (unless a human already
approved this exact payment), otherwise `pay`.

**Budget windows** are fixed buckets aligned to the epoch:
`window_start = now - now % period_ns`; counters from an older window count as
zero, so a budget resets exactly at `window_start + period_ns` with no
per-agent bookkeeping. The budget is **reserved before the transfer** and
released by the callback if the transfer fails. Approval requests reserve
nothing; the policy is evaluated again when a human approves (pause, expiry,
budget and balance are checked at that moment).

One key = one sequential nonce, so budgets are exact under concurrency. Several
keys for one agent are allowed, each with its own policy and counters.

## Receipts and events

`Receipt { id, kind: pay|income|refund, status, agent, payee, amount, asset,
memo, request_hash, ts_ns, policy_version, delivered, pending_id, approved_by }`

Status: `pending` -> `paid` | `failed`; `rejected {reason}`;
`pending` -> `approved` -> `paid` | `failed`; `denied`; `expired`.

A paid HTTP API verifies a payment with one view call and no facilitator:
the agent pays with `request_hash = sha256(nonce)` and retries the request
with the receipt id; the server calls
`verify_receipt(id, its_account, price, hash)`. Receipts cost about
0.003-0.004 NEAR of storage each; the owner can `prune_receipts`.

Events (NEP-297, `standard: "allowance"`, `version: "1.0.0"`):
`vault_funded`, `withdrawn`, `agent_added`, `agent_removed`, `agent_disabled`,
`agent_enabled`, `policy_set`, `key_allowance_topped_up`, `payment_paid`,
`payment_failed`, `payment_rejected`, `approval_requested`,
`approval_granted`, `approval_denied`, `approval_expired`,
`delivery_confirmed`, `denylist_set`, `vault_paused`, `vault_unpaused`,
`vault_killed`.

## Security notes and limits

* The owner is `owner_id`, checked on `predecessor_account_id`, never
  "whoever holds a key on the vault account". The vault account's own
  full-access key (left for upgrades) is not an owner key for the contract;
  **lock mode** = delete it and manage the vault from `owner_id` only.
* The key allowance is **gas only**: it caps what the agent can burn, not what
  it can spend. Spending limits are the policy. A key cannot attach deposits.
* An exhausted gas allowance locks the agent, not the vault: `top_up_allowance`.
* `kill` and `remove_agent` are protocol-level: `DeleteKey` is executed by the
  vault itself in the same transaction.
* Receipts are written only by the contract; agents can only append their
  `delivered` verdict to their own paid receipts.
* Not in this version: NEP-141 payments (`asset: ft`), account age / code-hash
  counterparty signals, Sputnik DAO approver tests, global-contract factory.

## Repository layout

```
src/policy.rs     policy model, pure evaluate(), unit tests
src/types.rs      AgentId, Agent, Receipt, Pending, PayOutcome, views
src/events.rs     NEP-297 events
src/lib.rs        the Vault contract + unit tests with a mocked VM
tests/sandbox.rs  end-to-end tests on neard-sandbox (near-sandbox + near-api)
docs/DECISIONS.md deviations from DESIGN.md and why
DESIGN.md         product spec
```

## Disclosure

All code in this repository was written by an AI coding agent (Claude) from
`DESIGN.md`, reviewed and run by its human owner. Third-party libraries:
`near-sdk` 5.30, and for tests `near-sandbox` 0.4, `near-api` 0.8,
`cargo-near-build` 0.11, `tokio`, `testresult`, `reqwest`.

## License

MIT, see [LICENSE](LICENSE).
