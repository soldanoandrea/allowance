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
