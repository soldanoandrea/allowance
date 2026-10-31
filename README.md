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
| Policy | this contract, on every `pay` | asset (NEAR or one NEP-141 token), per-payment cap, budget per window, payee allowlist, vault denylist, time window, cooldown, human approval above a threshold, expiry, pause, kill |

Before it even asks the vault, the agent checks the payee with an off-chain,
keyless **counterparty-risk service** (`risk/`: deny-lists, account age,
contract code changes, history in this vault). Every payment, rejection,
approval and deposit leaves a **receipt** that a payee can verify with one
free view call, and a NEP-297 event. `simulate` is a free view that returns
`allow`, `needs_approval` or `block` + reason, so an agent plans before it
spends. The kill switch deletes every agent key at the protocol level: a
compromised agent's next transaction is refused by the network, not by a
flag the contract has to remember.

For businesses run by agents, the same vault takes **income**: a revenue
split forwards a share of every incoming payment to beneficiaries, vaults
pay each other through `deposit`, and a **factory** spins up vaults from one
global contract for ~0.003 NEAR of storage each.

**Demo video** (1:58, recorded by a script against a live local sandbox, no
editing): [docs/media/demo.mp4](docs/media/demo.mp4). Regenerate it with
`make video` ([docs/demo.tape](docs/demo.tape), scene by scene from
[docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md)).

![Allowance demo: owner policy, an agent paying a 402 API, one counteroffer, a human approval, a stablecoin payment, a prompt-injection attack that moves no money, a revenue split, the kill switch](docs/media/demo.gif)

## Quickstart (local, nothing to sign up for)

Requirements: Rust stable >= 1.95 with the `wasm32-unknown-unknown` target,
[`cargo-near`](https://github.com/near/cargo-near) 0.22, Node.js 24 (22.22+
works), `make`. macOS on Apple Silicon or Linux x86_64/aarch64 (the platforms
`neard-sandbox` ships for). No Docker, no NEAR account, no API key.

```sh
rustup target add wasm32-unknown-unknown
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/near/cargo-near/releases/download/cargo-near-v0.22.0/cargo-near-installer.sh | sh

make demo         # build, start a local sandbox, run the whole story, exit (first run: a few minutes of Rust compile + sandbox download; then ~20 s)
make demo-keep    # same, then keep the chain and the API running and print the ledger URL and CLI commands
make demo-manual  # like demo-keep, but YOU approve the payment that waits for a human (for recording the video)
make check        # everything CI runs: cargo test --workspace, TypeScript type-check + tests, make demo
make video        # optional: re-record docs/media/demo.mp4 + demo.gif with VHS (brew install vhs)
```

`make demo` runs `npm ci`, `cargo near build` (vault, factory, test token),
starts `neard-sandbox` (downloaded on first use by the `near-sandbox` crate)
and then, on that throw-away chain:

1. **owner**: creates `owner/api/attacker.sandbox`, deploys the vault on
   `vault.sandbox`, deposits 5 NEAR, registers a freshly generated agent key
   with the policy *cap 1 NEAR per payment, 2 NEAR per day, payees
   [api.sandbox], human approval above 0.5 NEAR*; deploys a NEP-141 test
   stablecoin (`usd.sandbox`, "SUSD", 6 decimals), registers it with the
   vault, deposits 100 SUSD with `ft_transfer_call`, and registers a second
   agent key with a SUSD policy (*cap 10, 20 per day, approval above 5, may
   pay 0.01 NEAR to register a payee on the token*);
2. **paid API** (`demo-api/`) starts and answers HTTP 402 with a price, in
   NEAR or in SUSD;
3. **agent loop** (`sdk/examples/agent-loop.ts`, a separate process holding
   only the function-call key) buys three datasets. Before each payment it
   runs the counterparty check (the API account is minutes old: `warn`,
   written into the payment memo), then `simulate`: 0.02 NEAR is paid on its
   own; a 0.8 NEAR quote `needs_approval`, so it makes **one counteroffer**
   (0.5 NEAR, accepted); another 0.8 NEAR quote is refused at 0.5, so it pays
   the list price and **waits for the owner**, whom the demo plays by calling
   `approve`; every purchase is retried with the receipt, verified by the API
   with one `verify_receipt` view, checked, and confirmed on-chain
   (`confirm_delivery`);
4. **stablecoin**: the second agent buys a dataset priced 2 SUSD; the API has
   no storage on the token yet, so the vault registers it
   (`storage_deposit`) and pays with `ft_transfer`, the receipt id in the memo;
5. **attack** (`sdk/examples/attack.ts`): a page with a hidden prompt
   injection makes the naive agent try to pay 2 NEAR to `attacker.sandbox`
   and 5 NEAR to the API; the counterparty check blocks the attacker (on the
   shared deny-list), `simulate` blocks the 5 NEAR (`over_per_tx_cap`); the
   "compromised" process then signs `pay` anyway and the contract writes a
   `rejected` receipt (`not_allowlisted`); its attempts to call `withdraw` /
   `set_policy` are refused by the protocol; the attacker's balance does not
   move;
6. **business**: the API operator keeps its revenue in its own vault
   `shop.sandbox` with a 10% / 5% revenue split; the agent pays it 0.1 NEAR
   vault-to-vault and the split forwards 0.01 / 0.005 NEAR in the same
   transaction;
7. prints the receipts, eleven checks and the ledger page URL, and exits 0.

Expected tail of the output (the real attack transcript is in
[docs/attack-log.md](docs/attack-log.md)):

```
id  kind    status                      agent                   payee             amount     delivered  memo
#0  income  paid                        owner.sandbox           vault.sandbox     5 NEAR
#1  income  paid                        owner.sandbox           vault.sandbox     100 SUSD              treasury top-up
#2  pay     paid                        ed25519:HYamjH...vrPzS  api.sandbox       0.02 NEAR  pass       daily candles for the NEAR/USDC report ~
#3  pay     paid                        ed25519:HYamjH...vrPzS  api.sandbox       0.5 NEAR   pass       order-book depth to estimate slippage |~
#4  pay     paid                        ed25519:HYamjH...vrPzS  api.sandbox       0.8 NEAR   pass       a year of hourly candles for the backte~
#5  pay     paid                        ed25519:H1hfb1...f4qo7  api.sandbox       2 SUSD     pass       intraday closes for the NEAR/USDC repor~
#6  pay     rejected (not_allowlisted)  ed25519:HYamjH...vrPzS  attacker.sandbox  2 NEAR
#7  pay     paid                        ed25519:HYamjH...vrPzS  shop.sandbox      0.1 NEAR              monthly data-partner fee

checks
  ok   agent loop finished
  ...  (eleven checks: autonomous payment, counteroffer, owner approval, attacker rejected and never paid,
        protocol refusals, revenue split, risk check, NEP-141 payment with payee registration)

demo OK
```

Keys: the sandbox's genesis key (a public constant of the `near-sandbox`
crate) signs the owner's transactions; the agent keys are generated per run
and written only to `examples/local_demo/.tmp/` (git-ignored, mode 600)
because the agents run as their own processes. Nothing touches testnet or
mainnet. The same story on testnet, with your own accounts, is prepared in
[docs/TESTNET.md](docs/TESTNET.md) (`make demo-testnet`, a dry run unless you
confirm).

## Judging map

| Criterion | Where it is demonstrated | Check it with |
|---|---|---|
| Runs and does what this README says | one command builds, starts a throw-away chain and plays the whole story with eleven on-chain checks (non-zero exit if one fails); a fresh clone following only this README is recorded in [docs/FRESH_CLONE_CHECK.md](docs/FRESH_CLONE_CHECK.md) | `make demo` |
| Technical implementation | Rust vault: pure, deterministic policy core (`src/policy.rs`), receipts and NEP-297 events, approval queue, NEP-141 payment chain with payee storage registration and callbacks that cannot strand a receipt (`src/lib.rs`), revenue split (`src/split.rs`); factory on a NEP-591 global contract (`factory/`); TypeScript SDK, CLI and factory client on near-api-js (`sdk/`); 75 Rust tests (65 unit, 10 on neard-sandbox) and 131 TypeScript tests (one end-to-end run on neard-sandbox) | `make check` |
| Design | two independent layers: the protocol scopes the agent key (methods, gas, no deposits), the contract checks the money; free `simulate` before every payment; receipts a payee verifies with one view, no facilitator ([docs/PAYMENT_FLOW.md](docs/PAYMENT_FLOW.md)); every trade-off written down in [docs/DECISIONS.md](docs/DECISIONS.md); a static ledger page with no build | `npx allowance ledger`, [ledger/](ledger/) |
| Impact | an agent that pays for APIs, data or other agents with bounded loss: the prompt-injection attack in [docs/attack-log.md](docs/attack-log.md) moves no money; stablecoin prices; income, revenue split and vault-to-vault payments for agent businesses; ~0.003 NEAR of storage per vault through the factory | `make demo` (steps 4-6), [demo video](docs/media/demo.mp4) |
| Originality | the agent is a function-call key **on the vault account itself**: no agent account, no faucet, no custodian, and the kill switch is `DeleteKey` at protocol level; x402-style receipts bound to the request hash; counterparty risk from public chain data (account age, code changes, history in this vault) | [How a payment flows](#how-a-payment-flows), `risk/` |
| Sustainability | MIT; CI on every push ([.github/workflows/test.yml](.github/workflows/test.yml)); TypeScript runs without a build step, dependencies pinned with one lockfile; immutable vault code by hash for every factory vault; ledger page deployable to GitHub Pages ([.github/workflows/pages.yml](.github/workflows/pages.yml)); the testnet run is scripted and dry-run by default ([docs/TESTNET.md](docs/TESTNET.md)) | `make test`, `npm test` |

## Architecture

```
  owner (human, full-access key of owner_id)           paid API (demo-api/, account api.x)
   | deposit, add_agent(policy), approve/deny, kill       ^  402 quote {payee, asset, amount, nonce}
   | register_token, set_split                            |  retry with X-Allowance-Receipt
   v                                                      |  verify_receipt(id, api.x, price, sha256(nonce), asset)  (view)
 +------------------------------------------------+       |
 |  vault.x  (Allowance contract, Rust)           |<------+
 |   policy per agent: asset, cap, budget window, |
 |   allowlist, denylist, time window, cooldown,  |       agent process (sdk/, examples/)
 |   approval threshold, expiry, pause, kill      |        - AllowanceClient, holds ONLY the function-call key
 |   receipts + NEP-297 events                    |        - risk check (risk/) -> simulate (view) -> pay -> confirm_delivery
 |   per-asset accounting (NEAR, NEP-141 tokens)  |<-------- signs as vault.x with key pk_A
 |   revenue split on income                      |
 |   access keys ON THIS ACCOUNT:                 |       counterparty-risk service (risk/, keyless, off-chain)
 |     pk_A: FunctionCall{vault.x,                |        - deny-lists, account age, code changes, receipts history
 |           [pay, confirm_delivery, ping], gas}  |
 +------------------------------------------------+       ledger page (ledger/, static)
     | Transfer / ft_transfer / payee.deposit()   -------> get_vault / get_agents / get_pending / get_receipts + NEP-297 scan
     v
   payee  (an account, or another vault: its split forwards shares)

  factory.x (factory/): create_vault(name) -> <name>.factory.x running the vault code as a global contract (by hash)
```

Two layers: the **protocol** checks the key (which contract, which methods,
how much gas, no deposits) before the contract runs; the **contract** checks
the money (how much, which asset, to whom, when, with whose approval). A
leaked agent key is bound by both.

## How a payment flows

```
Owner  -> vault.deposit() + 5 NEAR                                  event vault_funded
Owner  -> vault.add_agent({key: pk_A}, "worker", policy)            AddKey(pk_A, FunctionCall{vault, [pay,confirm_delivery,ping], 1 NEAR})
                                                                    events agent_added, policy_set
Agent  -> risk.assess(payee)                   (off-chain, free)    allow | warn (memo note) | block (stop here)
Agent  -> vault.simulate(payee, 0.02)          (view, free)         {"verdict":"allow", ...}
Agent  -(pk_A)-> vault.pay(payee, 0.02, memo, request_hash)        evaluate -> Pay; receipt #1 pending; budget reserved
                                                                    Transfer(0.02) -> payee; callback -> receipt paid; event payment_paid
Payee  -> vault.verify_receipt(1, payee, 0.02, request_hash)        true  (one RPC view, no facilitator)
Agent  -(pk_A)-> vault.confirm_delivery(1, true)                    event delivery_confirmed

Agent  -(pk_B)-> vault.pay(payee, 2000000, {ft: usdc})              receipt pending; budget + token balance reserved
                                                                    usdc.storage_balance_of(payee) -> [storage_deposit] -> ft_transfer(memo "allowance:vault#N")
                                                                    -> callback: paid, or failed {reason} with everything released
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
// res.outcome: {outcome: 'paid', receipt_id} | {outcome: 'needs_approval', pending_id} | {outcome: 'rejected', reason} | {outcome: 'failed', reason}
await vault.confirmDelivery(res.outcome.receipt_id, true);
const ok = await vault.verifyReceipt({ receiptId: 7, payee: 'api.you.testnet', minAmount: parseNear('0.02'), requestHash: hash });

// NEP-141: same calls with an asset; amounts in the token's base units
await vault.ftMetadata('usdc.example.testnet');                           // reads symbol/decimals for display and parsing
await vault.pay({ payee: 'api.you.testnet', amount: 2_000_000n, asset: { ft: 'usdc.example.testnet' } });
```

`AllowanceClient` also has `ping`, `receipts` (paged), `receipt`, `vault`,
`agents`, `pending`, `token`, `waitForSettlement`; `OwnerClient` has
`deposit`, `addAgent`, `setPolicy`, `approve`, `deny`, `pause`, `kill`,
`registerToken`, `withdrawFt`, `setSplit`; `FactoryClient` has
`createVault`, `vaults`, `vault`, `info` (see [Vault factory](#vault-factory-factory));
`ReceiptVerifier` is the payee side; `runPaidTask` is the 402 loop with a pluggable planner and an optional
`precheck` (the risk service). Errors carry a stable `code`
(`access_key_not_found`, `method_not_allowed`, `not_enough_allowance`,
`contract_panic`, `config`, `rpc`).

CLI (after `npm ci`; `--vault`/`--rpc` or `$ALLOWANCE_VAULT`/`$ALLOWANCE_RPC_URL`):

```sh
npx allowance simulate --payee api.x --amount 0.02 --key-file agent.json   # exit 0 allow, 2 needs approval, 3 block
npx allowance pay --payee api.x --amount 0.02 --nonce <402 nonce> --key-file agent.json   # refuses to sign on block (--force to let the contract decide)
npx allowance pay --payee api.x --amount 2 --asset ft:usdc.x --key-file usd-agent.json    # token amounts in token units (decimals from ft_metadata)
npx allowance receipts                  # table of receipts
npx allowance ledger                    # vault, tokens, split, agents + policy, pending approvals, recent receipts, ledger page URL
npx allowance verify --receipt 7 --payee api.x --amount 0.02 --nonce <nonce>
npx allowance approve 0 --owner you.testnet --owner-key-file owner.json     # also: deny <id>, kill
npx allowance factory create --factory f.x --name bot --owner you.testnet --deposit 1 --owner-key-file owner.json
npx allowance factory list --factory f.x                                    # also: factory info
npx allowance-risk api.x --rpc <url> --vault vault.x                        # counterparty check, exit 0 allow / 2 warn / 3 block
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
price, and any error falls back to the scripted planner. `--scenario ft` buys
the token-priced dataset; `--risk off`, `--deny`, `--archival-rpc`,
`--fastnear-tx` configure the counterparty check.

## Counterparty-risk service (`risk/`)

`CounterpartyRisk.assess(payee)` returns `allow`, `warn` or `block` with the
signals behind it, from public data only (no API key):

| Signal | Source | Level |
|---|---|---|
| on the local/shared deny-list, or the vault's on-chain denylist | `--deny`, `get_denylist` | block |
| account does not exist | `view_account` | block |
| account age (first block seen) | FastNear transactions API (oldest transaction) or binary search over `view_account` on an archival node | warn below 7 days (configurable), optional hard block |
| contract code changed within 72 h, and when | `view_account` code hash / `global_contract_hash` at block heights | warn |
| runs a global contract by publisher account (code its publisher can change) | `global_contract_account_id` | warn |
| prior receipts to this payee in this vault: totals per asset, failed payments, deliveries the agents marked failed | `get_receipts` | warn on failed deliveries |

RPC errors are warnings, never a silent allow. The agent refuses on `block`
and goes on with `warn`, writing the verdict (`risk=warn[new_account]`) into
the payment memo, which the receipt keeps. 16 tests run against an in-memory
JSON-RPC chain (skipped heights, pruned history, code swaps).

## Paid demo API (`demo-api/`)

A plain `node:http` server selling datasets through the 402 flow above
(three priced in NEAR, one in a NEP-141 token when `API_FT_TOKEN` is set),
plus a free page carrying the prompt injection. It trusts vaults by account
name or by contract code hash (read at the same block as the
`verify_receipt` call; a factory vault's `global_contract_hash` counts), uses
single-use nonces and redeems each receipt once. The protocol, headers and
checks are specified in [docs/PAYMENT_FLOW.md](docs/PAYMENT_FLOW.md).

## Ledger page (`ledger/`)

`ledger/index.html?rpc=<rpc url>&vault=<vault account>` - a static page (one
HTML file + two classic scripts, no framework, no build) that works from
`file://` or any static host. It polls the views every 3 s and shows the
balance and what is actually available to pay, the token balances the vault
accounts for (symbols read from each token's `ft_metadata`), the revenue
split, each agent with its policy and budget meter, pending approvals (with
the CLI command to approve), receipts (with their split shares) and recent
NEP-297 events. Optional `interval=`, `scan=`, `from=`.

**Hosted on GitHub Pages.** `.github/workflows/pages.yml` publishes `ledger/`
on every push to `main` (enable it once: Settings -> Pages -> Source: GitHub
Actions). The page takes the chain and the vault from the query string, so a
testnet vault is one link:

```
https://<owner>.github.io/<repo>/?rpc=https://test.rpc.fastnear.com&vault=vault.you.testnet
https://<owner>.github.io/<repo>/?rpc=https%3A%2F%2Frpc.testnet.near.org&vault=vault.you.testnet&scan=600
```

`rpc` must be an endpoint that allows CORS (the public testnet RPCs above
do); without parameters the page shows a form. For the local sandbox use the
`file://` URL that `make demo-keep` and `npx allowance ledger` print: a page
served over https may be blocked by the browser from reading
`http://127.0.0.1`.

Limitation: without an indexer, events are found by scanning blocks over
plain RPC (one `block` call per height, plus `chunk` and `tx` calls when a
chunk has transactions) for transactions **sent to the vault**, starting
`scan` blocks back (default 300) or at `from`. Non-archival nodes forget old
blocks (testnet RPC: about 5 epochs; the demo sandbox is configured to keep
them), and events emitted by receipts that other contracts send to the vault
(a DAO calling `approve`, a token delivering `ft_transfer_call`) are not
found. The receipts table is the complete, authoritative history either way.

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
| `pay` | `payee`, `amount`, `asset?` (default `"near"`; must be the policy's asset), `memo?` (<= 256 bytes), `request_hash?` (32 bytes, base64) | `{"outcome":"paid"\|"failed"\|"needs_approval"\|"rejected", "receipt_id", ...}` as the transaction's final value |
| `confirm_delivery` | `receipt_id`, `passed` | records the agent's verdict on a paid receipt (once) |
| `ping` | | `{agent, registered, label, active, paused, block_timestamp_ns}` |

`pay` never panics for policy reasons; it panics only for malformed input or an
unregistered caller (so strangers cannot write receipts).

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
  "ft_storage_deposit": null                         // token policies: NEAR (<= 0.1) the vault may attach to register an unregistered payee on the token
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
(immutable; the publisher burns 10x the storage: 36.47 NEAR for the 365 KB
build on the sandbox). `create_vault(name, owner_id?, approver_id?, ...)`
creates `<name>.<factory>` with one batch (`CreateAccount`, `Transfer`,
`UseGlobalContract`, `new`); the new vault stores ~312 bytes (~0.003 NEAR of
stake) instead of its own 3.6 NEAR copy of the code, has **no access key**
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

## Security notes and limits

* The owner is `owner_id`, checked on `predecessor_account_id`, never
  "whoever holds a key on the vault account". The vault account's own
  full-access key (left for upgrades) is not an owner key for the contract;
  **lock mode** = delete it and manage the vault from `owner_id` only
  (factory vaults are created without any key).
* The key allowance is **gas only**: it caps what the agent can burn, not what
  it can spend. Spending limits are the policy. A key cannot attach deposits.
* An exhausted gas allowance locks the agent, not the vault: `top_up_allowance`.
* `kill` and `remove_agent` are protocol-level: `DeleteKey` is executed by the
  vault itself in the same transaction.
* Receipts are written only by the contract; agents can only append their
  `delivered` verdict to their own paid receipts.
* `verify_receipt` defaults to NEAR: a token receipt never satisfies a NEAR
  price. Payees should trust vaults by name or by immutable code hash
  (`code_hash` or `global_contract_hash`), never by a global contract used by
  account id.
* Promises are built only on the branch that returns them (near-sdk
  schedules a dropped `Promise`); tests assert that failed payments schedule
  nothing.
* The counterparty-risk service is advisory and off-chain; the contract's
  policy is the enforcement point.
* Not in this version: Sputnik DAO approver tests, Agent Market hiring, NEAR
  Intents, owner web UI with wallet, NEP-413 relayer, TEE proofs,
  `ft_transfer_call` payments.

## MVP vs stretch

| # | Feature (DESIGN.md section 5) | Status |
|---|---|---|
| 1-4 | Contract core, `evaluate` unit tests, sandbox tests, approval queue | done |
| 5 | TS agent SDK + CLI, agent loop with optional LLM and one counteroffer | done |
| 6 | Paid demo API (402 + receipt verification via RPC) | done (NEAR and NEP-141 prices) |
| 7 | Attack demo, log in [docs/attack-log.md](docs/attack-log.md) | done (now three layers: risk check, simulate, contract) |
| 8 | Ledger and policy page (static, RPC views + events) | done; GitHub Pages workflow ready (`.github/workflows/pages.yml`), runs once the repository is public |
| 9 | `make demo`, README, `.env.example`, CI, LICENSE | done (11 checks) |
| 10 | Testnet deployment, accounts, hosted ledger | **prepared, not run**: `make demo-testnet`, `scripts/testnet/`, [docs/TESTNET.md](docs/TESTNET.md); needs the owner's accounts and explicit go |
| stretch | Account-based agents | done (one sandbox test) |
| stretch | NEP-141 / USDC-style payments with storage check and payee registration | done (8 unit, 1 sandbox, demo scenario) |
| stretch | Counterparty-risk service (age, code change, prior receipts, deny-list) | done (`risk/`, 16 tests, in the agent loop and the attack demo) |
| stretch | Revenue split on income + vault-to-vault payments | done (7 unit, 1 sandbox, demo step) |
| stretch | Vault factory on a global contract | done (5 unit, 1 sandbox test; TypeScript `FactoryClient` + `allowance factory` CLI, 10 unit tests, 1 sandbox end-to-end test; testnet/mainnet publishing is the documented plan) |
| stretch | Sputnik DAO approver, Agent Market, NEAR Intents, owner web UI, NEP-413 relayer, TEE proofs | not started |

## How the tracks' criteria are met

Prompts from [near-hackathon-prompt-examples](https://github.com/nearai/near-hackathon-prompt-examples).

**security**
* Sign with a function-call key scoped to one contract, never a full-access
  key, and explain its limits: the agent key lives on the vault, limited by
  the protocol to `pay` / `confirm_delivery` / `ping`, no deposits; the gas
  allowance is explained as gas-only, hence the contract layer (sandbox tests
  prove `MethodNameMismatch`, `DepositWithFunctionCall`, `AccessKeyNotFound`
  after kill).
* Attack demo where an injected agent tries to pay a known-bad address and
  is stopped, with the log: [docs/attack-log.md](docs/attack-log.md) (deny-list
  block, `simulate` block, on-chain `rejected` receipt, owner methods refused
  by the protocol, attacker balance unchanged).
* Agent-side wrapper refuses on block and asks a human on warn: the SDK
  refuses to sign on `block`; `needs_approval` waits for the owner; risk
  warnings are recorded in the receipt memo.
* Counterparty signals (age, code change, prior interactions, shared
  blocklist): `risk/`, plus the vault's on-chain denylist.

**agents**
* Receipt per task (what, from whom, price, whether the work passed the
  check): every purchase is a receipt with memo, payee, amount, asset,
  `request_hash` and the agent's `confirm_delivery` verdict.
* Payments in NEAR or USDC: NEAR and any NEP-141 token (demo: a 6-decimal
  stablecoin on the sandbox), with payee registration on the token.
* One counteroffer with reasoning: `X-Allowance-Offer` with
  `X-Allowance-Offer-Reason`, accepted or refused by the seller, guarded so
  it is only ever lower and only once.
* Agent Market: researched (REST API and MCP exist, USD/USDC balances,
  marketplace escrow), not integrated.

**business**
* Own account, no full-access key in plain text: the agent holds only a
  function-call key; the scripts read keys from env vars or files, never
  write them.
* Config rules (max spend per day, min price, revenue split, kill switch):
  budget window, per-payment cap, approval threshold, the seller's price
  floor in the demo API, `set_split`, `kill`.
* Every sale, cost and payout on a public ledger page: `ledger/` shows
  balances, token balances, the split, receipts (with split shares) and
  events, from plain RPC.
* Demo loop on testnet: prepared (`make demo-testnet`), not run.

## Tests

| Command | What |
|---|---|
| `cargo test` | vault: 60 unit tests (policy core, NEP-141 flows, split, contract on a mocked VM with mocked promise results) + 9 sandbox tests (`tests/sandbox.rs`: function-call key flows, NEP-141 with a real token, revenue split and vault-to-vault payments) + 1 factory sandbox test (`tests/factory.rs`) |
| `cargo test --workspace` | the above + 5 factory unit tests (what `make test` and CI run) |
| `npm test` | 131 vitest tests: SDK, CLI, factory client, verifier and ledger against a mocked JSON-RPC node (real near-api-js signing, decoded transactions), the agent loop against the real demo API with an in-memory vault (NEAR, NEP-141, risk pre-check), the demo API's 402 rules, the risk service against an in-memory chain, the testnet configuration and dry run, and **one end-to-end run on neard-sandbox** (NEAR and NEP-141 purchases, injected payment blocked and rejected, owner methods refused by the protocol, kill -> `access_key_not_found`; then a vault created through the factory with `FactoryClient`, funded, given an agent key, paying, its receipt verified by global code hash). The end-to-end test skips itself, saying why, until `make build sandbox-node` has run. |
| `npm run typecheck` | `tsc` strict over SDK, CLI, examples, demo API, risk service, testnet scripts, demo orchestrator and tests |
| `make demo` | the whole story on a sandbox with eleven on-chain checks; non-zero exit if one fails |

Contract-only targets: `make build` (vault 364,576 bytes with the ABI
embedded; factory 171,067; test token 154,819), `make size`, `make test-unit`
(seconds), `make test-sandbox`, `make clippy`, `make fmt`.

## Repository layout

```
src/                 the vault contract (Rust): policy.rs (pure evaluate), split.rs, types.rs, events.rs, lib.rs
factory/             the vault factory (global contract by hash), second crate of the workspace
tests/sandbox.rs     vault end-to-end tests on neard-sandbox (near-sandbox + near-api)
tests/factory.rs     factory end-to-end test (global contract, two isolated vaults)
tests/fixtures/test-token/  NEP-141 test token (near-contract-standards) for the tests and the demo
sdk/src/             AllowanceClient, OwnerClient, FactoryClient, ReceiptVerifier, assets, 402 protocol, planners, CLI
sdk/bin/allowance.ts CLI entry point (`npx allowance`)
sdk/examples/        agent-loop.ts (feature 5), attack.ts (feature 7)
sdk/test/            vitest: unit tests with a mocked RPC + e2e.sandbox.test.ts
risk/                counterparty-risk service (`allowance-risk` CLI) and its tests
demo-api/            paid HTTP API (402 + verify_receipt), tests
ledger/              static ledger page: index.html, core.js (data), app.js (rendering)
examples/local_demo/ run.ts (`make demo`), sandbox_node.rs (hosts neard-sandbox), .tmp/ (ignored, sandbox keys)
scripts/testnet/     the testnet demo (prepared, dry run by default) and its configuration check
docs/                DECISIONS.md, PAYMENT_FLOW.md, attack-log.md, TESTNET.md, DEMO_SCRIPT.md, DEMO_POST.md, SUBMISSION.md,
                     FRESH_CLONE_CHECK.md, demo.tape (the video script for VHS), media/ (demo.mp4, demo.gif)
scripts/video/       `make video`: render.sh (records the tape in a fresh clone) and scene.ts (prints the live log scene by scene)
.github/workflows/   test.yml (CI), pages.yml (ledger page on GitHub Pages)
DESIGN.md            product spec
```

## Timeline

NEAR HACKATHON was announced on 2026-10-19. Per HACKATHON.md Q-001, code
written from the announcement onward counts; only commits before it would be
a baseline. This repository has no such baseline: **every commit is dated
2026-10-30 or later** (the first one, the vault contract, on 2026-10-30), it
was built entirely after the announcement, and it contains no pre-existing
code; the only code not written for this project is the public libraries
listed under [Disclosure](#disclosure). Check it with
`git log --reverse --format='%ad %s' --date=short | head -3`.

## Other submission by the same team

**near-thesis**: a reproducible, data-backed investment thesis on NEAR (track
`thesis`). Repository: `<REPOSITORY LINK: added before submission>`.

## Disclosure

**AI-generated code**: all code, tests and documentation in this repository,
the video script `docs/demo.tape` and the video rendered from it
(`docs/media/`), were written by AI coding agents, Claude models by Anthropic
(Claude Fable 5.1 and Claude Opus 5.5) working in Claude Code, from the
product spec in `DESIGN.md`, and reviewed and run by the human owner of the
project. Commits written by an agent carry a `Co-Authored-By: Claude ...`
trailer. At run time the agent loop can optionally ask an LLM (NEAR AI Cloud,
`--planner llm`) to choose pay / counteroffer / refuse; `make demo` and the
tests use the deterministic scripted planner.

**Third-party libraries and services**

| Where | Library / service | Version | License |
|---|---|---|---|
| contract, factory | `near-sdk` | 5.30.0 | MIT OR Apache-2.0 |
| test token (tests and demo only) | `near-contract-standards` | 5.30.0 | MIT OR Apache-2.0 |
| contract tests, sandbox host | `near-sandbox`, `near-api`, `cargo-near-build`, `testresult`, `reqwest` | 0.4.0, 0.8.7, 0.11.5, 0.4.2, 0.12.28 | MIT OR Apache-2.0 |
| contract tests, sandbox host | `tokio` | 1.54.1 | MIT |
| SDK, CLI, demo API, risk service, scripts | `near-api-js` | 7.4.0 | MIT AND Apache-2.0 |
| (installed with `near-api-js`) | about 60 transitive packages, e.g. `@noble/curves`, `@noble/hashes`, `@scure/base` 2.2.0, `borsh` 2.0.0, `tweetnacl` 1.0.3, `bip39` 3.0.2 | per `package-lock.json` | MIT, ISC, Apache-2.0, BSD-3-Clause, Unlicense |
| dev tooling | `typescript`, `vitest`, `@types/node` | 6.0.3, 4.1.12, 24.19.2 | Apache-2.0, MIT, MIT |
| build tooling | `cargo-near` (installed by the Quickstart), Rust stable | 0.22.0, >= 1.95 | MIT OR Apache-2.0 |
| runtime binaries | `neard-sandbox` (nearcore), downloaded by `near-sandbox` | 2.14.0 | MIT OR Apache-2.0 |
| CI and hosting | GitHub Actions `actions/checkout`, `actions/setup-node`, `actions/configure-pages`, `actions/upload-pages-artifact`, `actions/deploy-pages` | v4, v4, v5, v3, v4 | MIT |
| demo video only (not needed to run anything) | VHS (with ttyd and ffmpeg) | 0.12.1 | MIT (ffmpeg: LGPL/GPL) |
| optional services | NEAR AI Cloud (LLM planner), FastNear transactions API (risk check), public NEAR RPC | - | used over HTTP, no SDK |

The ledger page uses no third-party code.

## License

MIT, see [LICENSE](LICENSE).
