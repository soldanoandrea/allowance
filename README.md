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

## Quickstart (local, nothing to sign up for)

Requirements: Rust stable >= 1.95 with the `wasm32-unknown-unknown` target,
[`cargo-near`](https://github.com/near/cargo-near) 0.22, Node.js 24 (22.22+
works), `make`. macOS on Apple Silicon or Linux x86_64/aarch64 (the platforms
`neard-sandbox` ships for). No Docker, no NEAR account, no API key.

```sh
rustup target add wasm32-unknown-unknown
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/near/cargo-near/releases/download/cargo-near-v0.22.0/cargo-near-installer.sh | sh

make demo         # build, start a local sandbox, run the whole story, exit (first run: a few minutes of Rust compile + sandbox download; then ~15 s)
make demo-keep    # same, then keep the chain and the API running and print the ledger URL
make check        # everything CI runs: cargo test, TypeScript type-check + tests, make demo
```

`make demo` runs `npm ci`, `cargo near build`, starts `neard-sandbox`
(downloaded on first use by the `near-sandbox` crate) and then, on that
throw-away chain:

1. **owner**: creates `owner/api/attacker.sandbox`, deploys the vault on
   `vault.sandbox`, deposits 5 NEAR, registers a freshly generated agent key
   with the policy *cap 1 NEAR per payment, 2 NEAR per day, payees
   [api.sandbox], human approval above 0.5 NEAR*;
2. **paid API** (`demo-api/`) starts and answers HTTP 402 with a price;
3. **agent loop** (`sdk/examples/agent-loop.ts`, a separate process holding
   only the function-call key) buys three datasets: 0.02 NEAR is paid on its
   own; a 0.8 NEAR quote `needs_approval`, so it makes **one counteroffer**
   (0.5 NEAR, accepted); another 0.8 NEAR quote is refused at 0.5, so it pays
   the list price and **waits for the owner**, whom the demo plays by calling
   `approve`; every purchase is retried with the receipt, verified by the API
   with one `verify_receipt` view, checked, and confirmed on-chain
   (`confirm_delivery`);
4. **attack** (`sdk/examples/attack.ts`): a page with a hidden prompt
   injection makes the naive agent try to pay 2 NEAR to `attacker.sandbox`
   and 5 NEAR to the API; `simulate` blocks both before signing
   (`not_allowlisted`, `over_per_tx_cap`); the "compromised" process then
   signs `pay` anyway and the contract writes a `rejected` receipt and a
   `payment_rejected` event; its attempts to call `withdraw` / `set_policy`
   are refused by the protocol; the attacker's balance does not move;
5. prints the receipts, seven checks and the ledger page URL, and exits 0.

Expected tail of the output (the real attack transcript is in
[docs/attack-log.md](docs/attack-log.md)):

```
id  kind    status                      agent                   payee             amount     delivered  memo
#0  income  paid                        owner.sandbox           vault.sandbox     5 NEAR
#1  pay     paid                        ed25519:GKYWKx...iFURT  api.sandbox       0.02 NEAR  pass       daily candles for the NEAR/USDC report ~
#2  pay     paid                        ed25519:GKYWKx...iFURT  api.sandbox       0.5 NEAR   pass       order-book depth to estimate slippage |~
#3  pay     paid                        ed25519:GKYWKx...iFURT  api.sandbox       0.8 NEAR   pass       a year of hourly candles for the backte~
#4  pay     rejected (not_allowlisted)  ed25519:GKYWKx...iFURT  attacker.sandbox  2 NEAR
...
demo OK
```

Keys: the sandbox's genesis key (a public constant of the `near-sandbox`
crate) signs the owner's transactions; the agent key is generated per run and
written only to `examples/local_demo/.tmp/agent-key.json` (git-ignored, mode
600) because the agent runs as its own process. Nothing touches testnet or
mainnet.

## Architecture

```
  owner (human, full-access key of owner_id)           paid API (demo-api/, account api.x)
   | deposit, add_agent(policy), approve/deny, kill       ^  402 quote {payee, price, nonce}
   v                                                      |  retry with X-Allowance-Receipt
 +------------------------------------------------+       |  verify_receipt(id, api.x, price, sha256(nonce))  (view)
 |  vault.x  (Allowance contract, Rust)           |<------+
 |   policy per agent: cap, budget window,        |
 |   allowlist, denylist, time window, cooldown,  |       agent process (sdk/, examples/)
 |   approval threshold, expiry, pause, kill      |        - AllowanceClient, holds ONLY the function-call key
 |   receipts + NEP-297 events                    |        - simulate (view) -> plan -> pay -> confirm_delivery
 |   access keys ON THIS ACCOUNT:                 |<-------- signs as vault.x with key pk_A
 |     pk_A: FunctionCall{vault.x,                |
 |           [pay, confirm_delivery, ping], gas}  |       ledger page (ledger/, static)
 +------------------------------------------------+------> get_vault / get_agents / get_pending / get_receipts
            | Transfer (only from pay/approve)             + block scan for NEP-297 logs
            v
          payee
```

Two layers: the **protocol** checks the key (which contract, which methods,
how much gas, no deposits) before the contract runs; the **contract** checks
the money (how much, to whom, when, with whose approval). A leaked agent key
is bound by both.

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

## Agent SDK and CLI (`sdk/`)

TypeScript (strict, ESM), executed directly by Node (native type stripping:
no build step), on [near-api-js](https://github.com/near/near-api-js) 7.4.0.

```ts
import { AllowanceClient, loadKey, parseNear, requestHash } from '@allowance/sdk';

const key = loadKey({ keyFile: process.argv[2] });        // or $ALLOWANCE_AGENT_KEY; never written
const vault = new AllowanceClient({ vaultId: 'vault.you.testnet', rpcUrl: 'https://test.rpc.fastnear.com', agentKey: key.secretKey });

const sim = await vault.simulate('api.you.testnet', parseNear('0.02'));   // free view: allow | needs_approval | block
const hash = requestHash(quote.nonce);                                    // quote = the API's 402 body
const res = await vault.pay({ payee: 'api.you.testnet', amount: parseNear('0.02'), memo: 'dataset', requestHash: hash });
// res.outcome: {outcome: 'paid', receipt_id} | {outcome: 'needs_approval', pending_id} | {outcome: 'rejected', reason}
await vault.confirmDelivery(res.outcome.receipt_id, true);
const ok = await vault.verifyReceipt({ receiptId: 7, payee: 'api.you.testnet', minAmount: parseNear('0.02'), requestHash: hash });
```

`AllowanceClient` also has `ping`, `receipts` (paged), `receipt`, `vault`,
`agents`, `pending`, `waitForSettlement`; `OwnerClient` has `deposit`,
`addAgent`, `setPolicy`, `approve`, `deny`, `pause`, `kill`;
`ReceiptVerifier` is the payee side; `runPaidTask` is the 402 loop with a
pluggable planner. Errors carry a stable `code` (`access_key_not_found`,
`method_not_allowed`, `not_enough_allowance`, `contract_panic`, `config`,
`rpc`).

CLI (after `npm ci`; `--vault`/`--rpc` or `$ALLOWANCE_VAULT`/`$ALLOWANCE_RPC_URL`):

```sh
npx allowance simulate --payee api.x --amount 0.02 --key-file agent.json   # exit 0 allow, 2 needs approval, 3 block
npx allowance pay --payee api.x --amount 0.02 --nonce <402 nonce> --key-file agent.json   # refuses to sign on block (--force to let the contract decide)
npx allowance receipts                  # table of receipts
npx allowance ledger                    # vault, agents + policy, pending approvals, recent receipts, ledger page URL
npx allowance verify --receipt 7 --payee api.x --amount 0.02 --nonce <nonce>
npx allowance approve 0 --owner you.testnet --owner-key-file owner.json     # also: deny <id>, kill
```

The agent key comes from `--key-file <path>` (near-cli JSON or a bare
`ed25519:...` line; a warning if the file is readable by others) or
`$ALLOWANCE_AGENT_KEY`. The SDK and CLI never write keys.

**Agent loop** (`sdk/examples/agent-loop.ts`): `--planner scripted` (default,
deterministic, no network) or `--planner llm` (NEAR AI Cloud,
OpenAI-compatible, reads `NEAR_AI_API_KEY`; base URL and model overridable
with `NEAR_AI_BASE_URL` / `NEAR_AI_MODEL`). The LLM only picks pay /
counteroffer / refuse: blocked payments never reach it, seller text is fenced
as untrusted data, a guardrail enforces one counteroffer below the asking
price, and any error falls back to the scripted planner.

## Paid demo API (`demo-api/`)

A plain `node:http` server selling three datasets for NEAR through the 402
flow above, plus a free page carrying the prompt injection. It trusts vaults
by account name or by contract code hash (read at the same block as the
`verify_receipt` call), uses single-use nonces and redeems each receipt once.
The protocol, headers and checks are specified in
[docs/PAYMENT_FLOW.md](docs/PAYMENT_FLOW.md).

## Ledger page (`ledger/`)

`ledger/index.html?rpc=<rpc url>&vault=<vault account>` - a static page (one
HTML file + two classic scripts, no framework, no build) that works from
`file://` or any static host. It polls the views every 3 s and shows the
balance and what is actually available to pay, each agent with its policy
and budget meter, pending approvals (with the CLI command to approve),
receipts and recent NEP-297 events. Optional `interval=`, `scan=`, `from=`.

Limitation: without an indexer, events are found by scanning blocks over
plain RPC (one `block` call per height, plus `chunk` and `tx` calls when a
chunk has transactions) for transactions **sent to the vault**, starting
`scan` blocks back (default 300) or at `from`. Non-archival nodes forget old
blocks (testnet RPC: about 5 epochs; the demo sandbox is configured to keep
them), and events emitted by receipts that other contracts send to the vault
(e.g. a DAO calling `approve`) are not found. The receipts table is the
complete, authoritative history either way.

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

## MVP vs stretch

| # | Feature (DESIGN.md section 5) | Status |
|---|---|---|
| 1-4 | Contract core, `evaluate` unit tests, sandbox tests, approval queue | done (45 unit + 7 sandbox tests) |
| 5 | TS agent SDK + CLI, agent loop with optional LLM and one counteroffer | done |
| 6 | Paid demo API (402 + receipt verification via RPC) | done |
| 7 | Attack demo, log in [docs/attack-log.md](docs/attack-log.md) | done |
| 8 | Ledger and policy page (static, RPC views + events) | done (hosting on GitHub Pages pending) |
| 9 | `make demo`, README, `.env.example`, CI, LICENSE | done |
| 10 | Testnet deployment, accounts, hosted ledger | not started (needs the owner's explicit go) |
| stretch | Account-based agents | done in the contract (one sandbox test) |
| stretch | NEP-141/USDC payments, Sputnik DAO approver, counterparty-risk service, revenue split, Agent Market, Intents, global-contract factory, owner web UI with wallet, NEP-413 relayer, TEE proofs | not started |

## Tests

| Command | What |
|---|---|
| `cargo test` | 45 unit tests (policy core, contract on a mocked VM) + 7 sandbox tests (function-call key flows on neard-sandbox) |
| `npm test` | 85 vitest tests: SDK, CLI, verifier and ledger against a mocked JSON-RPC node (real near-api-js signing, decoded transactions), the agent loop against the real demo API with an in-memory vault, the demo API's 402 rules, and **one end-to-end run on neard-sandbox** (pay with the function-call key, verified receipt, injected payment blocked and rejected, owner methods refused by the protocol, kill -> `access_key_not_found`). The end-to-end test skips itself, saying why, until `make build sandbox-node` has run. |
| `npm run typecheck` | `tsc` strict over SDK, CLI, examples, demo API, demo orchestrator and tests |
| `make demo` | the whole story on a sandbox with seven on-chain checks; non-zero exit if one fails |

Contract-only targets: `make build` (wasm, ~320 KB with the ABI embedded),
`make test-unit` (seconds), `make test-sandbox`, `make clippy`, `make fmt`.

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


## Repository layout

```
src/                 the vault contract (Rust): policy.rs (pure evaluate), types.rs, events.rs, lib.rs
tests/sandbox.rs     contract end-to-end tests on neard-sandbox (near-sandbox + near-api)
sdk/src/             AllowanceClient, OwnerClient, ReceiptVerifier, 402 protocol, planners, CLI
sdk/bin/allowance.ts CLI entry point (`npx allowance`)
sdk/examples/        agent-loop.ts (feature 5), attack.ts (feature 7)
sdk/test/            vitest: unit tests with a mocked RPC + e2e.sandbox.test.ts
demo-api/            paid HTTP API (402 + verify_receipt), tests
ledger/              static ledger page: index.html, core.js (data), app.js (rendering)
examples/local_demo/ run.ts (`make demo`), sandbox_node.rs (hosts neard-sandbox), .tmp/ (ignored, sandbox keys)
docs/                DECISIONS.md, PAYMENT_FLOW.md, attack-log.md
DESIGN.md            product spec
```

## Disclosure

**AI-generated code**: all code and documentation in this repository were
written by AI coding agents (Claude, by Anthropic, working in Claude Code)
from `DESIGN.md`, and reviewed and run by the human owner of the project.

**Third-party libraries**

| Where | Library | Version | License |
|---|---|---|---|
| contract | `near-sdk` | 5.30 | MIT / Apache-2.0 |
| contract tests, sandbox host | `near-sandbox`, `near-api`, `cargo-near-build`, `tokio`, `testresult`, `reqwest` | 0.4, 0.8, 0.11, 1, 0.4, 0.12 | MIT / Apache-2.0 |
| SDK, CLI, demo API | `near-api-js` (and its dependencies: `@noble/curves`, `@noble/hashes`, `@scure/base`, `borsh`, ...) | 7.4.0 | MIT / Apache-2.0 |
| dev tooling | `typescript`, `vitest`, `@types/node` | 6.0.3, 4.1.12, 24.19.2 | Apache-2.0, MIT, MIT |
| runtime binaries | `neard-sandbox` (nearcore), downloaded by `near-sandbox` | 2.14.0 | MIT / Apache-2.0 |

The ledger page uses no third-party code. The optional LLM planner calls the
NEAR AI Cloud HTTP API directly (no SDK).

## License

MIT, see [LICENSE](LICENSE).
