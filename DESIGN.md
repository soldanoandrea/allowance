# Allowance — a sandboxed treasury for AI agents on NEAR

*Design document, 2026-10-30. Target: NEAR Hackathon (Nov 1–14, 2026), tracks `security`, `agents`, `business` (+ `open`). Working name "Allowance"; repo `near-agent-vault`. No code exists yet; this is the plan the build agents execute from Nov 1.*

> **Status note (2026-10-31).** This is the plan as written before the first line of code, kept unedited below. The build started the same day, 2026-10-30, not on Nov 1: that is inside the window that opened with the 2026-10-19 announcement (HACKATHON.md Q-001), so the whole repository is hackathon work (README, "Timeline"). The day-by-day schedule in section 8 and some names in sections 3 and 6 (`allowance init`, `cargo run --example local_demo`) therefore differ from what was built; README.md and docs/DECISIONS.md describe the code as it is.

## 1. Pitch

AI agents that spend money today hold either a full-access key (one prompt injection away from an empty wallet) or a custodial API wallet whose rules live in a vendor's TEE. **Allowance** is an open-source NEAR contract that gives an agent an *allowance, not your keys*: a human funds a vault, writes the policy on-chain (per-payment cap, daily/weekly budget, payee/contract/method allowlist, time windows, cooldowns, human approval above a threshold, kill switch), and the agent spends through a **function-call access key that lives on the vault account itself** and can only call `pay`. Every payment, rejection and approval is an on-chain receipt that a payee (a paid HTTP API, another agent) can verify with one free view call. NEAR is the only chain where this is native rather than bolted on: access keys with per-contract/per-method scope are a protocol primitive, so enforcement is two-layered (protocol: *which contract/methods, how much gas*; contract: *how much money, to whom, when*), the agent needs no funded account at all (the vault pays its gas within the key's allowance), and the kill switch is a protocol-level `DeleteKey`, not a flag a buggy contract might forget to check. It is built, tested and documented by the very agent that will use it to buy its own inference and API calls — the "company of none" paying its own bills under rules a human set once.

## 2. Prior art and originality

**On NEAR**
- *Function-call access keys* ([docs](https://docs.near.org/protocol/accounts-contracts/access-keys)): scoped to one `receiver_id` and optional `method_names`; `allowance` caps **gas only**; such keys **cannot attach NEAR deposits** and cannot transfer tokens. Precedent for keys-on-the-contract-account: [Keypom](https://github.com/keypom/keypom) (function-call keys on the Keypom contract limited to `claim`).
- *OutLayer Agent Custody* ([docs](https://app.outlayer.ai/docs/agent-custody)): TEE-held keys, a rich **off-chain** policy engine (per-tx, hourly/daily/monthly caps, allow/deny lists, time windows, multisig above threshold, freeze), policies stored encrypted and evaluated only inside the TEE; cumulative caps are "best-effort under concurrent requests". Testnet available; Intents mainnet-only. Also "payment checks" (gasless key-redeemable escrow via `intents.near`).
- *Agent API / Agents on Intents* ([overview](https://docs.agentsonintents.com/integration/agent-api/overview)): per-agent wallet on NEAR Intents, owner-signed policy (actions, assets, USD budget, destinations, delays/time windows, emergency stop), executed in an attested TEE service with partner API keys.
- *Shade Agents* ([deprecation notice on docs.near.org](https://docs.near.org/ai/shade-agents/key-components)): TEE agents with on-chain attestation registry; framework unmaintained as standalone tooling since April 19, 2026.
- *near-mcp* ([repo](https://github.com/nearai/near-mcp)): gives LLMs full account control with an **unencrypted local keystore**; no spending policy. *near-hydra* (seen via [PolicyLayer](https://policylayer.com/tools/nikshepsvn-near-hydra/hydra-create-agent-key)): MCP tool that mints per-contract function-call keys for agents — key layer only, no amount policy.
- *x402 on NEAR* ([@fastnear/x402](https://js.fastnear.com/x402)): NEP-141-only, payer signs a NEP-366 delegate action, needs a **full-access key**; facilitator relays. *PingPay Agent Pay* ([x402 integration](https://pingpay.gitbook.io/docs/pingpay-api/agent-pay-facilitator/x402-integration)): payer sends USDC on Base, facilitator settles to a NEAR recipient via NEAR Intents.

**Elsewhere**
- *Safe Allowance module* ([quickstart](https://docs.safe.global/home/ai-agent-quickstarts/agent-with-spending-limit)): per-token, per-delegate allowance with reset interval; agent signs `executeAllowanceTransfer`; no allowlists/approvals; owner key bypasses. Zodiac Roles adds per-target/per-function permissions. *Olas*: agents as Safe signers behind a quorum.
- *Coinbase Agentic Wallets* (Feb 2026, via secondary sources): session caps, per-transaction limits, allowlists, enforced in Coinbase's MPC/enclave policy engine, custodial.
- Hackathon-grade EVM contracts (AgentScope, PGAP, AgentBlox, AgentSafe on Solana): per-tx + daily caps + cooldowns on-chain.

**What is original here**
1. **Two-layer, fully on-chain, non-custodial enforcement**: protocol access key (contract + method + gas) × contract policy (amount, budget window, allowlist, time, cooldown, approval). No TEE, no vendor, no API key; the policy is public and auditable, and a leaked agent key is bound by exactly the same rules.
2. **Agent = key, not account**: the agent needs no NEAR, no account, no faucet; the vault pays gas inside the key allowance; the vault itself adds/rotates/deletes the key. Kill switch = `DeleteKey` + pause.
3. **Free dry-run**: `simulate` is a view call returning *allow / needs-approval / block(reason)* — the "counterparty check" the security track asks for, with zero gas, so the agent plans before it spends.
4. **Receipts as payment proof for HTTP**: an x402-style 402 flow where the resource server verifies a vault receipt (payee, amount, request hash) with one RPC view — no facilitator, works with function-call keys (which real x402-on-NEAR cannot).
5. **Receipts carry the agent's own verdict** (`delivered: pass/fail`), giving the Agent Economy track its per-task receipt and a basis for on-chain payee reputation.

## 3. Architecture

### Accounts and trust
- `vault.<owner>.testnet` — the vault contract account. Owner is `owner_id` (predecessor check), never "whoever holds a key on this account". The owner's full-access key stays during the hackathon (upgradability); README documents "lock mode" (delete it; owner acts from `owner_id`).
- Each agent is a **function-call key on the vault account**: `receiver_id = vault`, `method_names = ["pay","confirm_delivery","ping"]`, `allowance = Limited(1 NEAR)` for gas. Identity inside the contract = `env::signer_account_pk()` (when a key on the account calls the account, predecessor == signer == current account, so the key is the only identity).
- Stretch: `AgentId::Account(account_id)` for agents that already own an account (OutLayer, TEE agents); same policy map, predecessor-based identity.
- Approver = `owner_id` or an optional `approver_id` (a human #2 or a Sputnik DAO; a DAO approves with a `FunctionCall` proposal to `approve`).

### Data model (near-sdk-rs, Borsh)
```
Vault { owner_id, approver_id: Option<AccountId>, paused: bool,
        agents: IterableMap<AgentId, Agent>, denylist: IterableSet<AccountId>,
        receipts: Vector<Receipt>, pending: IterableMap<u64, Pending>, next_pending: u64 }
AgentId = PublicKey | Account(AccountId)
Agent  { label, policy: Policy, state: SpendState, active: bool, policy_version: u32 }
Policy { asset: Near | Ft(token_id), per_tx_cap: u128, budget: {amount: u128, period_ns: u64},
         allow: Vec<{account_id, methods: Option<Vec<String>>}> | Any, time_window: Option<{start_h, end_h, days}>,
         cooldown_ns, approval_threshold: Option<u128>, expires_at_ns: Option<u64> }
SpendState { window_start_ns, spent_in_window: u128, last_payment_ns, payments: u64 }
Receipt { id, agent, payee, amount, asset, memo, request_hash: Option<[u8;32]>, kind: Pay|Income|Refund,
          status: Paid|Rejected(reason)|Pending|Approved|Denied|Failed, ts_ns, policy_version, delivered: Option<bool> }
```
Budget windows are fixed buckets (`window_start = now - now % period`), deterministic and cheap. Storage: ~300 B/receipt ≈ 0.003 NEAR at 1e19 yocto/byte ([storage staking](https://docs.near.org/protocol/storage/storage-staking.md)); owner tops up; a `prune_receipts(before_id)` keeps the chain tidy (events remain in logs).

### Policy evaluation
A pure function, unit-tested without a chain:
```
evaluate(policy, state, req, now_ns, denylist, vault_balance) -> Ok(Pay | NeedsApproval) | Err(Rejection)
Rejection = Paused | AgentDisabled | PolicyExpired | OverPerTxCap{cap} | OverBudget{remaining, resets_at}
          | NotAllowlisted{payee} | Denylisted | OutsideTimeWindow{opens_at} | Cooldown{retry_at} | InsufficientVaultBalance
```
`pay` and `simulate` share it; `simulate` is `#[view]` (free). On `Pay`: reserve budget, append `Receipt{Pending}`, `Promise::new(payee).transfer(amount)` (or `ft_transfer` with 1 yocto, 30 TGas) `.then(on_paid(receipt_id))`; callback marks `Paid` or `Failed` (and releases the budget). On `NeedsApproval`: a `Pending` record with expiry; no funds move until `approve`. We considered [yield/resume](https://docs.near.org/smart-contracts/anatomy/yield-resume.md) but its 200-block timeout is too short for a human.

### Interface
- Owner: `new(owner_id)`, `deposit()` (payable; records `Income` receipt), `add_agent(pk|account, label, policy)` → `Promise::add_access_key_allowance(pk, Allowance::limited(1 NEAR), current_account_id, "pay,confirm_delivery,ping")`, `set_policy`, `disable_agent`/`remove_agent` → `delete_key`, `top_up_allowance(pk)` (delete+re-add; allowances are immutable on NEAR), `pause`/`unpause`, `kill()` (pause + delete every agent key), `approve(id)`/`deny(id)`, `set_denylist`, `withdraw`.
- Agent: `pay(payee, amount, asset?, memo, request_hash?) -> PayOutcome{receipt_id | pending_id | rejection}`, `confirm_delivery(receipt_id, passed: bool)`, `ping()`.
- Views: `simulate(agent?, payee, amount, asset?)`, `get_policy`, `get_agent_state`, `get_receipt(id)`, `get_receipts(from, limit)`, `get_pending`, `verify_receipt(id, payee, min_amount, request_hash) -> bool`.
- Events ([NEP-297](https://docs.near.org/smart-contracts/anatomy/events.md), `standard: "allowance", version: "1.0.0"`): `vault_funded, agent_added, agent_removed, policy_set, payment_paid, payment_failed, payment_rejected, approval_requested, approval_granted, approval_denied, delivery_confirmed, vault_paused, vault_killed`. The ledger page and the agent both consume them.

### Sequence diagrams (text)
```
FUND                                SET POLICY
Owner -> vault: deposit() +5 NEAR   Owner -> vault: add_agent(pk_A, "worker", policy{cap .1, day 1, allow [api.demo], approve>.5})
vault -> log: vault_funded          vault -> protocol: AddKey(pk_A, FunctionCall{vault, [pay,...], 1 NEAR})
                                    vault -> log: agent_added, policy_set

AGENT PAYS AN API (x402-style)
Agent -> api.demo: GET /v1/quote
api.demo -> Agent: 402 {payee: api.demo, amount: .02, asset: NEAR, nonce}
Agent -> vault (view): simulate(api.demo, .02)            -> Pay
Agent -(key pk_A)-> vault: pay(api.demo, .02, memo, h=sha256(nonce))
vault: evaluate -> Pay; receipt#7 Pending; Transfer(.02) -> api.demo; callback -> Paid; log payment_paid
Agent -> api.demo: GET /v1/quote  X-Allowance-Receipt: vault:7
api.demo -> RPC view: verify_receipt(7, api.demo, .02, h) -> true  ; 200 {quote}
Agent -(key)-> vault: confirm_delivery(7, true)

POLICY REJECTION (prompt-injected agent)
Agent -> vault: pay(attacker.testnet, 2)   -> Rejected{NotAllowlisted} (and OverPerTxCap); receipt#8 Rejected; log payment_rejected
(no transfer created; the agent wrapper also refused at simulate() = block before even signing)

HUMAN APPROVAL OF A LARGE PAYMENT
Agent -> vault: pay(api.demo, .8)  -> NeedsApproval; pending#3 (expires 24h); log approval_requested
Owner (phone, ledger page / CLI) -> vault: approve(3) -> Transfer(.8) -> Paid; log approval_granted, payment_paid
(deny(3) -> Denied; expiry -> auto-Denied on next touch)

KILL SWITCH
Owner -> vault: kill()  -> paused=true; DeleteKey(pk_A) for every agent; log vault_killed
Agent -> vault: pay(...) -> protocol rejects: key does not exist (never reaches the contract)
```

## 4. Tech stack

**Contract: Rust / near-sdk-rs** (not near-sdk-js: npm `near-sdk-js` is at 2.0.0, published mid-2024, heavier WASM, weaker typing; every current NEAR doc, template and the `near-smart-contracts` agent skill are Rust-first). Verified versions (crates.io / GitHub, 2026-10-28):
- `near-sdk` **5.30.0** (2026-10-27, edition 2024, MSRV **1.95**); features `unit-testing` for `VMContextBuilder` tests, `#[near(event_json)]` for NEP-297, `Allowance::{limited, unlimited}`, `Promise::add_access_key_allowance / delete_key`.
- `cargo-near` **0.22.0** stable (0.23.0-rc.2 is pre-release); its `cargo near new` template pins `rust-toolchain.toml` to 1.93.0 and `near-sdk = "5.29"`, with tests on `near-sandbox 0.3.x` + `near-api 0.8` + `cargo-near-build 0.11`. We pin **rust 1.97.1** (matches the template's reproducible-build image `sourcescan/cargo-near:0.22.0-rust-1.97.1`), `near-sdk 5.30`, `near-sandbox 0.4.0`, `near-api 0.8.7` (or `near-workspaces 0.24.0`, still maintained, if `fast_forward`/`dev_deploy` ergonomics win on day 1).
- `near-cli-rs` **0.30.1** stable.
- Agent/API side: TypeScript (Node 22) with `near-api-js` (or `near-kit`) signing with the function-call key; LLM calls via NEAR AI Cloud's OpenAI-compatible API ([quickstart](https://docs.near.ai/cloud/quickstart.md)), credits from NEAR Builders ($10).

**macOS Apple Silicon setup** (all native; Docker only for optional reproducible builds):
```
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh        # rustup; toolchain pinned by rust-toolchain.toml
rustup target add wasm32-unknown-unknown
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/near/cargo-near/releases/latest/download/cargo-near-installer.sh | sh
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/near/near-cli-rs/releases/latest/download/near-cli-rs-installer.sh | sh
cargo near build non-reproducible-wasm        # -> target/near/allowance.wasm (~250 KB ≈ 2.5 NEAR storage)
cargo test                                    # unit + sandbox tests (near-sandbox downloads neard-sandbox, aarch64 ok)
```
Testnet: `near account create-account sponsor-by-faucet-service <name>.testnet autogenerate-new-keypair save-to-keychain network-config testnet create` ([CLI docs](https://docs.near.org/tools/cli.md)); top-ups of 5 NEAR via the docs faucet API ([faucet](https://docs.near.org/getting-started/faucet.md)). Deploy: `near contract deploy vault.<x>.testnet use-file target/near/allowance.wasm with-init-call new json-args '{"owner_id":"<x>.testnet"}' ...`.

**Reproducibility for the Claude Code/Codex screen**: `make check` = `cargo test` (no secrets, no testnet); `cargo run --example local_demo` runs the six flows above on a throw-away sandbox and prints receipts (Rust, via near-sandbox + near-api, zero config); `make demo-testnet` needs only `.env` with the agent's function-call key. README is numbered "do X, see Y"; `.env.example`, `LICENSE` (MIT), `rust-toolchain.toml`, `Makefile`, GitHub Actions running the same `cargo test` on Linux x86 so the screener's environment is covered.

## 5. MVP vs stretch (agent-hours)

**Must-have by Nov 14 (~61 h)**
| # | Feature | h |
|---|---|---|
| 1 | Contract core: vault, agents-as-keys (add/remove key via promises), `Policy`, pure `evaluate`, `pay` NEAR with callback, receipts, NEP-297 events, pause/kill, `simulate`, `verify_receipt` | 14 |
| 2 | Unit tests of `evaluate` (every rejection, window rollover, cooldown, expiry, threshold) | 5 |
| 3 | Sandbox integration tests: fund → add agent → pay with FC key → reject → approve → kill deletes key → protocol error | 8 |
| 4 | Approval queue (pending/approve/deny/expiry, approver_id) | 4 |
| 5 | TS agent SDK + CLI (`simulate`, `pay`, `receipts`), task loop with NEAR AI Cloud (optional LLM) and one counteroffer on 402 (agents track) | 8 |
| 6 | Paid demo API (402 + receipt verification via RPC) | 5 |
| 7 | Attack demo: injected instruction → blocked at simulate and on-chain, log captured to `docs/attack-log.md` | 3 |
| 8 | Ledger & policy page (static, RPC views + events; GitHub Pages) | 6 |
| 9 | `local_demo` example, Makefile, README, `.env.example`, CI, LICENSE | 6 |
| 10 | Testnet deployment, accounts, hosted ledger | 2 |

**Stretch (pick by Nov 9 at the latest)**: NEP-141/USDC payments with storage check (6 h); account-based agents (3 h); Sputnik DAO as approver, documented + tested in sandbox (4 h); off-chain counterparty-risk service (account age via RPC/NearBlocks, code-hash change, prior receipts → allow/warn/block) (6 h); revenue split on `deposit` (business track) (4 h); hire a second agent via Agent Market REST API (public API exists per [docs](https://docs.market.near.ai); payouts in USD/USDC, 5% fee) (6 h); NEAR Intents 1Click dry-run quote from the vault (mainnet only, tiny amounts) (8 h); deploy as a [global contract](https://docs.near.org/smart-contracts/global-contracts.md) by hash + `create_vault` factory (5 h); owner web UI with wallet (8 h); NEP-413 signed-intent path with relayer (8 h); TEE-attested inference proof attached to receipts (6 h).

## 6. Demo plan

**Video (≤3 min, screen capture + voice-over, one take per scene)**
1. 0:00–0:15 — Problem: an agent with a full-access key and one injected prompt; wallet empty.
2. 0:15–0:45 — Andrea runs `allowance init`: funds 5 NEAR, sets policy (cap 0.1, 1 NEAR/day, allowlist `api.demo`, approval > 0.5, kill switch). Ledger page shows policy and `agent_added`; `near account list-keys` shows the agent's function-call key scoped to `pay`.
3. 0:45–1:30 — The agent gets a task ("quote the NEAR/USDC spread"), hits the paid API, gets 402, `simulate` → allow, pays 0.02 NEAR, retries with the receipt, delivers the answer; ledger updates live with receipt #7 and `delivered: true`.
4. 1:30–2:15 — Attack: a poisoned web page tells the agent to send 2 NEAR to `attacker.testnet`; wrapper logs *block: NotAllowlisted*; forced call shows on-chain rejection receipt. Then a legit 0.8 NEAR payment → *needs approval*; Andrea approves from the ledger page on his phone; paid.
5. 2:15–2:45 — Kill switch: `allowance kill` → `vault_killed`, keys gone; agent's next call fails at protocol level.
6. 2:45–3:00 — "Built by the agent that uses it. Policy on-chain, keys on NEAR, code MIT."

**Demo access**: hosted ledger page (GitHub Pages) pointing at `vault.<x>.testnet` (stays up past Nov 25 at no cost) + local path (`cargo run --example local_demo`) for judges without accounts. X post by Andrea with the video.

## 7. Mapping to judging and tracks

*Criteria named on nearhackathon.com (technical implementation, design, impact, originality, sustainability) and the AI screen (runs and does what the README says).*
- **Technical**: Rust contract with pure policy core, promise-based key management, callbacks with budget release, NEP-297 events, sandbox tests for the protocol-level key behaviour. **Design**: three commands (`init`, `pay`, `kill`), free `simulate`, readable receipts. **Impact**: every agent that spends needs this; non-custodial and chain-native. **Originality**: §2. **Sustainability**: MIT, global-contract deployment makes a vault cost <0.001 NEAR to spin up; the author's own agents are customer #1.

*NEAR-native features used*: function-call access keys with `method_names` and gas `allowance` (added/deleted by the contract via `promise_batch_action_add_key_with_function_call` / `delete_key`); `signer_account_pk` identity; promises + callbacks; NEP-297 events; storage staking accounting; NEP-141/NEP-145 (stretch); NEAR Intents 1Click and Sputnik DAO (stretch); global contracts (stretch); NEAR AI Cloud inference.

*Track prompt expectations* ([prompt examples](https://github.com/nearai/near-hackathon-prompt-examples)):
- **security**: "signing with a function-call key scoped to one contract, never a full-access key; README explains the key's limits" ✔ (and we explain that the allowance is gas-only, hence the contract layer); "attack demo: injected agent tries to pay a known-bad address and is stopped, show the log" ✔; "agent-side wrapper refuses on block, asks a human on warn" ✔ (`simulate` → block / needs-approval); counterparty signals (age, contract code change, prior interactions, shared blocklist) → on-chain denylist + receipts history in MVP, risk service as stretch.
- **agents**: "receipt per task: what, from whom, price, whether the work passed the check" ✔ (`confirm_delivery`); "payments in NEAR or USDC" ✔ (USDC stretch); "one counteroffer with reasoning" ✔ (402 price negotiation header in the demo API); "research Agent Market programmatic posting" — documented finding: REST API + MCP exist, USD/USDC balances, marketplace-held escrow.
- **business**: "own account, no full-access key in plain text" ✔ (agent holds a function-call key only); config rules "max inference spend/day, min price, revenue split, kill switch" ✔ except split (stretch); "every sale, cost, payout on a public ledger page" ✔; "demo loop on testnet under two minutes" ✔ (`make demo-testnet`).

## 8. Build plan

| Day | Milestone (done = tests green + README step added) |
|---|---|
| Nov 1 | Repo, toolchain pins, CI, `cargo near new` skeleton, `Policy`/`evaluate` pure core + unit tests; AGENT_AUTHORIZATION.md (Andrea's standing approval for testnet ops) |
| Nov 2 | Vault state, `deposit`, `add_agent` (AddKey promise), `remove_agent`, `pay` NEAR + callback, receipts; first sandbox test: agent pays with its function-call key |
| Nov 3 | Rejections, events, `simulate`, `verify_receipt`, pause/kill (DeleteKey), sandbox tests for kill → protocol error |
| Nov 4 | Approval queue + approver_id; budget window rollover tests with `fast_forward`; `local_demo` example running all six flows |
| Nov 5 | Testnet deploy; TS agent SDK/CLI with FC key; `pay`/`simulate` from Node |
| Nov 6 | Paid demo API (402 + verify) and agent task loop with NEAR AI Cloud; counteroffer |
| Nov 7 | Attack demo + log; ledger page v1 (views + events) on GitHub Pages |
| Nov 8 | Stretch #1: USDC (NEP-141) or revenue split — whichever the business/agents demo needs more; storage/receipt pruning |
| Nov 9 | Stretch #2: Sputnik DAO approver or risk service; freeze scope |
| Nov 10 | Hardening: reentrancy on callbacks, overflow, budget release on failure, key allowance top-up; `make check` on a clean machine |
| Nov 11 | README rewrite for machine readers; `.env.example`; license/AI-code disclosure; re-read live HACKATHON.md |
| Nov 12 | Video script + recording assets; dry run of the 3-minute storyline on testnet |
| Nov 13 | Andrea: mainnet payout account, X post; agent: submission payload prepared, shown, not sent |
| Nov 14 | Buffer; final re-read of rules; Andrea confirms; submit before 23:59 UTC (00:59 CET Nov 15) |

## 9. Risks and open questions

- **"Just another spending-limit contract."** Mitigation: lead with the key-on-vault model, free `simulate`, receipt-verified HTTP payments and the kill switch at protocol level; keep the "built by its own user" story as the closing line, not the pitch.
- **Function-call key gotchas**: allowance is gas-only and immutable (we expose `top_up_allowance`); exhausted allowance locks the agent, not the vault; allowance is charged at buy price and refunded, so set 1 NEAR not 0.05. A key cannot attach deposits — correct for us, but it also means the agent cannot call `ft_transfer`/x402 directly; all value moves through the vault.
- **Concurrency**: one key = sequential nonces, so budgets are exact (unlike OutLayer's best-effort caps); several keys per agent are allowed but each is a separate policy state (documented).
- **Callback atomicity**: budget is reserved before the transfer and released on `Failed`; receipts must not be mutable by agents; `approve` must re-evaluate the policy at execution time (pause, expiry).
- **Storage growth**: receipts cost real NEAR; prune + event logs; owner is warned on the ledger page when the vault's free balance is below 0.5 NEAR.
- **Screening environment**: sandbox binary download needs network and a supported platform (Linux x86 / macOS arm64 OK); CI proves the Linux path; no Docker on the main path.
- **Rules we could trip**: (1) HACKATHON.md tells coding agents not to sign transactions, spend tokens, push, or make the repo public without explicit human confirmation — we need Andrea's written standing approval for testnet operations in-repo and his explicit go for `git push`, repo-public, X post and the submission payload; (2) one submission per repo, max two per email, no edits after sending; (3) README must list AI-generated code (all of it) and third-party libraries; (4) hosted demo must stay up until Nov 18 (ideally 25); (5) no secrets in git history ever (function-call key in `.env` only; pre-commit secret scan); (6) NEAR Intents has no testnet — any Intents work is mainnet with Andrea's funds, so it stays a stretch with `dry: true` quotes; (7) prize payout needs Andrea's mainnet account in the form.
- **Open questions for Andrea**: project name ("Allowance" vs "Agent Vault"); which GitHub account hosts the repo; X account and contact email for the form; team size "1" with AI agents listed in README; whether to spend any mainnet NEAR (recommendation: no); whether a second human approver or a Sputnik DAO is shown in the video; whether the demo API sells something real (e.g., a tiny market-data endpoint the author could keep).

### Sources
Rules: https://nearhackathon.com/HACKATHON.md · https://nearhackathon.com/ · prompts: https://github.com/nearai/near-hackathon-prompt-examples (tracks/04-business.md, 06-security.md, 07-agents.md, 00-setup.md, SUBMITTING.md). NEAR docs: access keys https://docs.near.org/protocol/accounts-contracts/access-keys · quickstart https://docs.near.org/smart-contracts/quickstart · integration tests https://docs.near.org/smart-contracts/testing/integration-test · events https://docs.near.org/smart-contracts/anatomy/events.md · storage https://docs.near.org/protocol/storage/storage-staking.md · yield/resume https://docs.near.org/smart-contracts/anatomy/yield-resume.md · global contracts https://docs.near.org/smart-contracts/global-contracts.md · FT https://docs.near.org/primitives/ft/standard.md · CLI https://docs.near.org/tools/cli.md · faucet https://docs.near.org/getting-started/faucet.md · Intents index https://docs.near-intents.org/llms.txt. Versions: https://crates.io/crates/near-sdk · https://crates.io/crates/near-sandbox · https://crates.io/crates/near-api · https://crates.io/crates/near-workspaces · https://github.com/near/cargo-near/releases · https://github.com/near/near-cli-rs/releases · https://docs.rs/near-sdk/latest/near_sdk/struct.Promise.html · https://docs.rs/near-sdk/latest/near_sdk/enum.Allowance.html · template https://github.com/near/cargo-near/tree/main/cargo-near/src/commands/new/new-project-template · https://registry.npmjs.org/near-sdk-js/latest. Prior art: https://app.outlayer.ai/docs/agent-custody · https://app.outlayer.ai/docs/payment-checks · https://docs.agentsonintents.com/integration/agent-api/overview · https://github.com/nearai/near-mcp · https://github.com/keypom/keypom · https://js.fastnear.com/x402 · https://pingpay.gitbook.io/docs/pingpay-api/agent-pay-facilitator/x402-integration · https://docs.safe.global/home/ai-agent-quickstarts/agent-with-spending-limit · https://github.com/near-daos/sputnik-dao-contract · https://docs.market.near.ai · https://docs.near.ai/cloud/quickstart.md · https://github.com/near/agent-skills · https://github.com/r-near/near-kit.
