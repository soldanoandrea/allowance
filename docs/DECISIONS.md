# Decisions and deviations from DESIGN.md

Scope of this milestone: features 1-4 of DESIGN.md section 5 (contract core,
unit tests of `evaluate`, sandbox tests, approval queue). Everything below is
where the implementation deviates from, or has to make precise, what the
design says.

## Policy semantics

1. **`per_tx_cap` is a hard ceiling, approved or not; `approval_threshold`
   must be below it.** DESIGN's walk-through (cap 0.1, approve above 0.5, pay
   0.8) is not self-consistent: 0.8 would be `over_per_tx_cap`. The tier
   model is `amount <= threshold` autonomous, `threshold < amount <= cap`
   human approval, `amount > cap` refused. `Policy::validate` rejects
   `approval_threshold >= per_tx_cap`. The tests use cap 1 / threshold 0.5.
2. **`budget` is optional** (`None` = no cumulative limit) instead of a
   mandatory `{amount, period_ns}`; `period_ns` and `amount` must be > 0.
3. **`asset`** keeps the `near | ft(token)` enum for forward compatibility,
   but `validate` refuses `ft` until NEP-141 payments land (stretch).
   `AllowEntry.methods` is kept and ignored for NEAR transfers.
4. **Time windows** are same-day UTC windows (`start_h < end_h <= 24`) on
   ISO weekdays (empty `days` = every day). Overnight windows are not
   supported; the rejection carries `opens_at_ns`.
5. **Cooldown** is measured from the last payment that reached the transfer
   stage (`last_payment_ns`), paid or failed. Rejections and queued requests
   do not start a cooldown.
6. **Evaluation order** is fixed and documented on `evaluate`; the DESIGN
   example "NotAllowlisted (and OverPerTxCap)" is honoured: allowlist before
   amount.
7. Added rejection reasons: `asset_not_allowed` and `unknown_agent` (the
   latter only from `simulate`; `pay` panics for unregistered callers so that
   strangers cannot write receipts).

## Contract behaviour

8. **`add_agent` for key agents completes in a callback.** The agent is
   inserted only after the protocol accepted `AddKey`, so a refused `AddKey`
   (key already on the account) leaves no half-registered agent. The method
   returns `true`/`false` instead of panicking in the callback, because a
   panic there could not roll anything back anyway. Account agents are
   registered immediately.
9. **`kill` removes the agents** (DESIGN: "pause + delete every agent key").
   Keeping them would break the invariant "agent in map <=> key on account"
   and make re-arming awkward. Receipts keep the `AgentId`, so history
   survives; re-arming is `unpause` + `add_agent`. `kill` also denies every
   queued approval, with one independent `DeleteKey` receipt per key so one
   odd key cannot block the others.
10. **`remove_agent`** denies the agent's queued approvals before deleting
    the key.
11. **`pay` returns `PromiseOrValue<PayOutcome>`**: rejections and
    needs-approval are plain values; a transfer returns the promise chain so
    the transaction's final value is the callback's `paid`/`failed`. Same for
    `approve`.
12. **Approval requests reserve nothing** and the policy is re-evaluated at
    `approve` time with only the threshold waived (DESIGN section 9,
    "approve must re-evaluate the policy"). Expired requests are marked
    `expired` (a new receipt status, more informative than "auto-denied") by
    `approve`, `deny` or the public `expire_pending`.
13. **Receipts live in a `LookupMap<u64, Receipt>`** with `next_receipt_id`
    and `first_receipt_id` instead of a `Vector`, so `prune_receipts` can
    drop old settled receipts from the front. Pending receipts are never
    pruned.
14. **`deposit` requires >= 0.01 NEAR** so that a stranger cannot make the
    vault pay for the storage of dust-deposit receipts. Withdrawals are
    recorded as receipts of kind `refund`.
15. **Storage reserve**: `available = balance - storage_byte_cost *
    storage_usage - 0.01 NEAR`. `pay` rejects with
    `insufficient_vault_balance` and `withdraw` panics beyond it.
16. **Account-based agents** (`AgentId::Account`, listed as stretch) are
    implemented because the data model already had the variant and the cost
    is one branch in identity resolution; covered by one sandbox test.
17. Extra events beyond DESIGN's list: `agent_disabled`, `agent_enabled`,
    `key_allowance_topped_up`, `approval_expired`, `vault_unpaused`,
    `withdrawn`, `denylist_set`.
18. **JSON conventions** for the SDK: enum variants in `snake_case`;
    `Rejection` tagged by `code`, `ReceiptStatus` by `status`, `PayOutcome` by
    `outcome`; `U64` for every nanosecond timestamp (JSON numbers would lose
    precision above 2^53).
19. `request_hash` is `Base64VecU8` (validated to 32 bytes) rather than a
    bespoke `[u8; 32]` newtype, to get JSON/ABI schema support for free.

## Toolchain and tests

20. `rust-toolchain.toml` pins `channel = "stable"` (>= 1.95 required by
    near-sdk 5.30) rather than DESIGN's 1.97.1: the build machine runs
    1.99.1 and a patch pin would only force a second toolchain download for
    every screener. The reproducible-build image descriptor is kept in
    `Cargo.toml` for machines with Docker.
21. Test stack is the `cargo near new` template's (`near-sandbox` 0.4.0,
    `near-api` 0.8.7, `cargo-near-build` 0.11.5); `near-workspaces` was not
    needed. `near-sandbox` and `near-api` pin different `near-account-id`
    majors, hence the double parse in `create_account`.
22. `near-api` drops the details of `InvalidTxError` (it surfaces as
    `InvalidTransaction({})`), so the sandbox tests sign with near-api and
    broadcast through the raw `send_tx` JSON-RPC call when they need the
    exact protocol refusal (`MethodNameMismatch`, `DepositWithFunctionCall`,
    `AccessKeyNotFound`). `reqwest` is a dev-dependency for that.
23. The sandbox clock is driven with `fast_forward` in 5-block steps and the
    tests read `get_vault().block_timestamp_ns` back instead of assuming a
    block time, so the budget-window and TTL tests do not depend on the
    sandbox's timestamp policy.
24. The wasm is ~320 KB with the embedded ABI (DESIGN estimated ~250 KB);
    `cargo near build non-reproducible-wasm --no-abi` would cut it, but the
    ABI is what the TypeScript SDK (feature 5) will be generated from.
25. The template's deploy/undeploy GitHub workflows were removed (no
    deployment in this milestone); the test workflow is kept and runs
    `cargo test` on Linux.

## TypeScript side (features 5-9)

26. **Node runs the TypeScript directly** (native type stripping, Node 24;
    22.22+ also works, `near-api-js` 7 needs >= 22.22.2). No bundler, no
    `dist/`, no `tsx`: `tsc` is used for type-checking only
    (`erasableSyntaxOnly`, `verbatimModuleSyntax`, strict,
    `noUncheckedIndexedAccess`). A screener needs `npm ci` and nothing else.
27. **near-api-js 7.4.0** (current major, single package) rather than
    `near-kit` or the older `@near-js/*` 2.x packages. The agent signs with
    `new Account(vaultId, provider, agentKey)`: the key lives on the vault
    account, so the signer *is* the vault. TypeScript 6.0.3 (the last
    JavaScript-based compiler; 7.x ships a native binary), vitest 4.1.12,
    `@types/node` 24. All pinned exactly; one npm workspace (`sdk`,
    `demo-api`) with a single lockfile.
28. **The demo API is plain `node:http`** (no Hono/Express): one file, zero
    dependencies beyond the SDK.
29. **Payment protocol details** (DESIGN sketched `X-Allowance-Receipt:
    vault:7`): the retry also carries `X-Allowance-Nonce`, so the server
    finds its quote and recomputes `request_hash = sha256(utf8(nonce))`
    itself; nonces and receipts are single-use; a bare receipt id is
    accepted only with a default vault. See docs/PAYMENT_FLOW.md.
30. **Vault trust on the payee side**: `verify_receipt` is a view on an
    account the client names, and any contract can answer `true`. The API
    therefore trusts vaults by name or by contract code hash; the code hash is
    read at the block of the `verify_receipt` answer. The local demo uses the
    code-hash mode ("any vault running this Allowance build").
31. **Counteroffer semantics**: the scripted planner offers the owner's
    approval threshold (the most it may pay alone), once; the seller has a
    floor per product. A planner, scripted or LLM, can only choose pay /
    counteroffer / refuse; guardrails keep `block` final and the counteroffer
    below the asking price.
32. **LLM planner defaults are unverified**: NEAR AI Cloud's base URL
    (`https://cloud-api.near.ai/v1`) and default model
    (`deepseek-ai/DeepSeek-V3.1`) come from memory of the quickstart, not
    from a call made during this milestone (no network beyond npm/crates was
    allowed). Both are env-overridable, and any failure falls back to the
    scripted planner. Check them before recording the video.
33. **`make demo` is orchestrated in TypeScript, the sandbox is hosted by a
    tiny Rust example** (`examples/local_demo/sandbox_node.rs`, built as the
    `sandbox_node` example). It reuses the `near-sandbox` crate the tests
    already depend on (binary download, ports, genesis), prints the RPC URL
    and stops the node when its stdin closes, so a crashed orchestrator never
    leaves `neard` behind. DESIGN's `cargo run --example local_demo` became
    `make demo`, because the agent, the API and the attacker are Node
    processes.
34. **The sandbox keeps old blocks** (`gc_num_epochs_to_keep = 100000`): its
    epochs are 60 blocks and it produces several blocks per second, so with
    the default (5 epochs) the ledger's event scan lost the demo's events
    after a few minutes.
35. **The owner approval in `make demo` is automated**: the orchestrator
    plays the human and calls `approve` when the request appears (logged as
    such). The CLI has `approve`/`deny`/`kill` for doing it by hand
    (`make demo-keep`).
36. **The ledger page is classic scripts, not ES modules**, because browsers
    refuse module scripts from `file://`. Its data layer (`core.js`) has no
    DOM access and is unit-tested in a Node VM; every string is inserted with
    `textContent` (memos and labels are agent-controlled).
37. **Events without an indexer**: the page scans blocks for transactions
    whose receiver is the vault and reads their outcomes (`tx`). It misses
    events of receipts sent to the vault by other contracts and blocks a
    non-archival node has dropped; the receipts table remains the
    authoritative history.
38. The SDK adds `OwnerClient` and owner CLI commands (not in the feature
    list) because the demo needs `deposit`/`add_agent`/`approve` and the
    video storyboard uses `kill`.

## Stretch features (milestone of 2026-10-31)

### NEP-141 payments

39. **Token amounts reuse `NearToken` on the wire.** Policies, receipts,
    simulations and events keep their `NearToken` fields (a `u128` as a
    decimal string); when the asset is `{"ft": "<token>"}` the number is the
    token's base unit. A parallel amount type would have doubled every
    struct and broken the ABI the SDK reads, for no difference on the wire.
    The asset travels next to every amount (`asset` on receipts, pending
    requests and the 1.1.0 money events).
40. **The vault keeps its own token accounting** (`tokens: token -> {balance,
    min_deposit}`): `ft_on_transfer` credits, payments and `withdraw_ft`
    debit, failures credit back. Reading `ft_balance_of` before each payment
    was rejected: it is asynchronous, so `simulate` (a view) could not use
    it, and a pay would need one more callback. Tokens sent with a plain
    `ft_transfer` are not seen, so the accounting can only under-state.
41. **Tokens are opt-in**: the owner calls `register_token(token,
    min_deposit?)` (attached NEAR, if any, registers the vault itself on the
    token). Token policies for unregistered tokens are refused;
    `ft_on_transfer` from an unregistered contract or below `min_deposit`
    returns the full amount (the token refunds the sender), so strangers
    cannot make the vault pay storage for dust receipts.
42. **Payment chain**: `storage_balance_of(payee)` -> `on_ft_storage_checked`
    -> [`storage_deposit(payee, registration_only)`] -> `ft_transfer(payee,
    amount, memo "allowance:<vault>#<receipt id>")` -> `on_paid`. Budget and
    token balance are reserved before the first call and released on any
    failure, exactly like a failed NEAR transfer. `ReceiptStatus::Failed`
    and `PayOutcome::Failed` now carry a `reason` (`transfer_failed`,
    `ft_transfer_failed`, `payee_not_registered`,
    `insufficient_near_for_storage`, `storage_check_failed`): a breaking
    JSON change for `failed`, acceptable before any deployment.
43. **"storage_deposit only if the policy allows and within budget"** is
    read as: `Policy.ft_storage_deposit` is the most NEAR the vault attaches
    per payment (<= 0.1 NEAR; `None` = never register), it must fit in the
    vault's NEAR above the storage reserve at that moment, `registration_only`
    makes the token refund the excess, and the receipt records it
    (`storage_deposit`) with an `ft_payee_registration` event. That NEAR is
    not counted in the agent's token budget (another asset); it is bounded
    by the allowlist, the per-payment cap and the payment budget instead.
44. **Callbacks read promise results themselves** (`promise_result_checked`
    with a byte bound) instead of `#[callback_result]` deserialization, so a
    token that returns something unexpected cannot make the settlement panic
    and leave a receipt `pending` with budget and tokens reserved. Unit tests
    drive the callbacks with mocked promise results (`testing_env!` with
    `promise_results`).
45. **`verify_receipt(..., asset?)` defaults to NEAR**: a token receipt
    never verifies against a NEAR price, whatever the numbers.
46. **One asset per agent policy.** A vault that pays in NEAR and in a token
    registers two agent keys (the demo's `worker` and `usd-worker`). Mixed
    budgets would need a price oracle.
47. **402 quote**: `amount_yocto` became `amount` (base units of `asset`),
    the counteroffer fields `offered` / `list_price`. The agent refuses a
    counteroffer answer that changes the asset.
48. **Test token**: the stock `near-contract-standards` FT (NEP-141, 145,
    148) in `tests/fixtures/test-token`, a workspace member built by `make
    build` and by the sandbox test itself (no wasm committed). Its symbol is
    `SUSD` ("sandbox USD", 6 decimals) rather than USDC, so nothing suggests
    a real asset.
49. **Gas**: the SDK attaches 150 TGas to token payments and to `approve`
    (the sandbox test passes with the default 100); the settlement callback
    got 10 TGas (was 5).
50. **Ledger page**: token deposits arrive as `ft_transfer_call`
    transactions sent to the token, so the block scan (which looks for
    transactions sent to the vault) does not show their events; the receipts
    table does. The page reads each token's `ft_metadata` to show symbols.
51. `make demo` runs the token scenario by default (about 2 s more,
    `--no-ft` skips it): a second agent buys `/dataset/fx` for 2 SUSD, the
    vault registers the API on the token, two more checks (9 in total).

### Counterparty-risk service (`risk/`)

52. **Off-chain, keyless, in TypeScript** (`@allowance/risk`, a workspace
    package with a CLI `allowance-risk`). It reads public data only: a
    regular RPC, optionally an archival RPC and the FastNear transactions
    API. Nothing is written on-chain; the contract's policy remains the
    enforcement point.
53. **Account age** = time since the first block the account is seen at.
    Sources, in order: the FastNear transactions API (`POST
    <base>/v0/account`, oldest-first by default, `limit: 1`; the mainnet base
    `https://tx.main.fastnear.com` is from FastNear's docs, a testnet base
    was not verified), then a binary search over `view_account` at block
    heights on an archival node (log2(height) probes; skipped heights are
    probed forward; on a pruned node the answer is "at least N days", never a
    guess). Assumes the account was not deleted and recreated. Warn below
    `minAgeDays` (7), block below `blockBelowAgeMinutes` (off by default).
54. **Code change**: the current `code_hash` is compared with the one
    `codeWindowHours` (72) ago, the height being estimated from the recent
    block rate; if it differs, a second binary search finds the first block
    with the current code. A contract payee is only an info signal; a code
    swap inside the window is a warning.
55. **History in this vault**: the newest `maxReceipts` (500) receipts, paid
    totals per asset, rejected/failed counts, and the agents' own
    `confirm_delivery` verdicts: any delivery marked failed is a warning
    (on-chain reputation from the receipts the vault already keeps).
56. **Deny-lists**: a local/shared list (`--deny`, `$ALLOWANCE_DENYLIST`) and
    the vault's on-chain denylist; either one blocks.
57. **Fail-safe, not fail-open**: an RPC error becomes a `check_error`
    warning, never a silent allow. Account facts are cached 60 s; deny-lists
    and receipts are read on every check.
58. **Integration**: `runPaidTask` takes an optional `precheck` that runs
    before `simulate`: `block` refuses the task without a transaction; `warn`
    and `allow` go on, and the verdict (`risk=warn[new_account]`) is appended
    to the payment memo, which the contract stores in the receipt (the memo
    is the contract's free-text field, so no contract change was needed).
    DESIGN's "ask a human on warn" is left to the vault's approval threshold
    rather than a second, off-chain approval path. In `make demo` every
    sandbox account is minutes old, so the API payments carry
    `risk=warn[new_account]`, and the attacker, passed as the shared
    deny-list, is blocked before `simulate` (a tenth check).

### Vault factory on a global contract (`factory/`)

59. **Global contract by code hash, verified on the sandbox.** neard-sandbox
    2.14 runs NEP-591 global contracts, so no embedded-wasm fallback was
    needed. The vault wasm is published once with `DeployGlobalContract`
    (hash mode: immutable); `create_vault` creates `<name>.<factory>` with
    one batch `CreateAccount + Transfer + UseGlobalContract(hash) +
    FunctionCall(new)`, then a callback records it or refunds the caller (a
    failed batch is rolled back as a whole, and its deposit returns to the
    factory, not to the caller, hence the explicit refund). Measured on the
    sandbox: publishing the 364,576-byte vault burned 36.47 NEAR (10x the
    storage rate); each vault then stores ~312 bytes (about 0.003 NEAR of
    storage stake, versus ~3.6 NEAR for its own copy of the code).
    DESIGN's "<0.001 NEAR to spin up" is therefore 0.003 NEAR of stake plus
    the deposit the owner chooses (default minimum 0.1 NEAR).
60. **Hash mode, not account-id mode**: a vault created by the factory can
    never have its code changed under it, by the factory owner or anyone;
    `set_vault_code_hash` only affects vaults created afterwards. The
    account-id mode (upgradable by the publisher) would let one key change
    every vault's rules.
61. **Factory vaults have no access key** (lock mode by construction):
    they are managed by `owner_id` through the owner methods, and agent keys
    are added by the vault itself, as before.
62. **`view_account` of a global-contract user reports `code_hash` as all
    ones** and the hash in `global_contract_hash` (or
    `global_contract_account_id` in account mode). The SDK's
    `ReceiptVerifier` (payee trust by code hash) and the risk check use
    `global_contract_hash` when present and never trust account-mode code,
    which can change; the risk check flags it as `mutable_code`.
63. The factory is a second crate in the cargo workspace (vault, factory,
    test token); `cargo test` runs the vault's unit and sandbox tests plus
    the factory sandbox test (`tests/factory.rs`), `cargo test --workspace`
    (what `make test` and CI run) adds the factory's unit tests. The
    TypeScript client came later (76); the testnet scripts still deploy a
    vault directly.

### Revenue split (`src/split.rs`)

64. **Vault-wide rule on income**, set by the owner with `set_split`: up to 4
    beneficiaries with shares in basis points (total <= 100%, no duplicates,
    not the vault itself). It applies to every income: `deposit` (NEAR) and
    `ft_on_transfer` (tokens). Shares are rounded down; zero shares are
    skipped; the vault keeps the remainder. Per-agent splits were rejected:
    income is not tied to an agent.
65. **The income receipt records the split** (`split: [{account_id, bps,
    amount, status}]`); all share transfers are issued at once, joined with
    `Promise::and`, with one settlement callback (`on_split_settled`) that
    marks each share `paid` or `failed` and emits `split_settled`. A failed
    NEAR share is refunded to the vault by the protocol; a failed token
    share is credited back to the vault's token accounting (token shares are
    debited before the transfers so agents cannot spend them meanwhile).
66. **"Vault as payee"**: a plain NEAR transfer runs no code on the receiver,
    so a vault paid that way could not split. An allowlist entry with
    `methods: ["deposit"]` (the field DESIGN reserved for function-call
    payments) makes the paying vault call the payee vault's `deposit` with
    the amount attached (40 TGas); the payee records the income and applies
    its split in the same receipt tree. `deposit` on an account that is not
    a vault fails, the NEAR comes back, the payment settles as `failed
    {transfer_failed}` and the budget is released. No other method is
    accepted in `methods`, so the field cannot become a generic call gate.
    Token payments still use `ft_transfer` (an `ft_transfer_call` path
    would need the "unused amount" accounting of NEP-141 resolution).
67. **Gas**: a split deposit needs the shares' transfers plus a 10 TGas
    callback; with 4 beneficiaries and a token, send `ft_transfer_call` with
    150 TGas. This is why beneficiaries are capped at 4.
68. **Bug found and fixed while adding this**: near-sdk schedules a
    `Promise` when it is dropped, so building the `ft_transfer` and the
    settlement callback before choosing a branch (as the first NEP-141
    version did) would have sent the transfer even on the
    `payee_not_registered` / `storage_check_failed` paths, and a stray
    `on_paid` without a promise result. Promises are now built only on the
    branch that returns them; unit tests assert that a failed payment
    schedules nothing.
69. `make demo` adds a business step: the API operator's revenue vault
    `shop.sandbox` with a 10% / 5% split; the worker's policy allowlists it
    as a vault payee (policy v2) and pays it 0.1 NEAR; the provider receives
    exactly 0.01 NEAR in the same transaction (11 checks in total).

### Testnet preparation and documentation

70. **Feature 10 is prepared, not executed.** `scripts/testnet/demo.ts`
    (`make demo-testnet`) works only on accounts the human created, refuses
    mainnet endpoints and non-`.testnet` accounts, and is a dry run unless
    `TESTNET_CONFIRM=yes` / `--yes`. Its tests cover the configuration and
    prove the dry run does not touch the network (an unroutable RPC URL).
71. **Keys from the environment first**: every key can be given as a value
    (`TESTNET_OWNER_KEY`, ...) injected at run time by a password manager
    (e.g. `op run`), or as a key file. The scripts never write keys;
    `scripts/testnet/agent-key.ts` prints a fresh agent key on stdout.
72. **Testnet defaults mirror the local demo's policy** (cap 1, 2 per day,
    approval above 0.5) so the three datasets show the same three paths;
    about 8 testnet NEAR in all.
73. The testnet run does not include the factory: publishing the vault as a
    global contract burns ~36.5 NEAR; docs/TESTNET.md gives the commands as
    the mainnet plan.
74. **`make demo-manual`** (`--keep --manual-approve`) lets the human
    approve the waiting payment with the printed CLI command, for the video;
    with `--keep`/`--manual-approve` the sandbox owner key (the genesis key,
    a public constant) is written to the ignored `.tmp/` for the CLI.
75. **Submission timing (open question for the human)**: the repository's
    commits are dated 2026-10-30/31, before the hackathon window
    (2026-11-01 to 2026-11-14). HACKATHON.md asks that work building on an
    earlier project be separable (tags `pre-hackathon` /
    `hackathon-submission`, a README section linking the diff). The
    decision is the owner's; docs/SUBMISSION.md lists it in the checklist.

## Polishing for the submission (2026-10-31)

76. **`FactoryClient` and `allowance factory create|list|info`.** The
    client reuses `NearTransport` with the factory as the contract and the
    creator's account as the signer (the owner by default; `--signer` lets a
    platform create a vault for someone else). It validates the vault name
    with the factory's own rule, the account ids and the deposit against
    `get_info().min_deposit` before signing, and returns `created: false`
    (the factory refunded the deposit) as a value, like a policy rejection,
    rather than throwing. Factory events have their own NEP-297 standard
    (`allowance_factory`), so they are parsed by `parseFactoryEvents`, not
    the vault's `parseEvents`. The sandbox end-to-end test now starts one
    node for two scenarios (the existing vault story and the factory story)
    instead of a second node, to keep the run short and avoid two
    neard-sandbox processes competing in CI.

