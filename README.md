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
| Policy | this contract, on every `pay` | asset (NEAR or one NEP-141 token), per-payment cap, budget per window, payee allowlist, vault denylist, time window, cooldown, human approval above a threshold, expiry, pause, kill; an agent that keeps getting refused is disabled by the vault itself |

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

**Demo video** (1:58, 1920x1080, recorded by a script against a live local sandbox, no
editing): [docs/media/demo.mp4](docs/media/demo.mp4). Regenerate it with
`make video` ([docs/demo.tape](docs/demo.tape), scene by scene from
[docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md)).

**Without installing anything**: the [hosted ledger page](https://soldanoandrea.github.io/allowance/) shows a recorded demo vault (receipts, the rejected attack, the split).

**Judging in five minutes**: run `make demo` (expect twelve `ok` checks and
`demo OK`), then [try the attack yourself](#try-the-attack-yourself);
read the real attack transcript in [docs/attack-log.md](docs/attack-log.md);
the [judging map](#judging-map) says where each criterion is met.

![Allowance demo: owner policy, an agent paying a 402 API, one counteroffer, a human approval, a stablecoin payment, a prompt-injection attack that moves no money, a revenue split, the kill switch](docs/media/demo.gif)

## Quickstart (local, nothing to sign up for)

Requirements: Rust stable >= 1.95 with the `wasm32-unknown-unknown` target,
[`cargo-near`](https://github.com/near/cargo-near) 0.22, Node.js 24 (22.22+
works), `make`. macOS on Apple Silicon or Linux x86_64/aarch64 (the platforms
`neard-sandbox` ships for). No Docker, no NEAR account, no API key.

```sh
rustup target add wasm32-unknown-unknown
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/near/cargo-near/releases/download/cargo-near-v0.22.0/cargo-near-installer.sh | sh

make demo         # build, start a local sandbox, run the whole story, exit (first run: a few minutes of Rust compile + sandbox download; then about 30 s)
make demo-keep    # same, then keep the chain and the API running and print the ledger URL and CLI commands
make demo-manual  # like demo-keep, but YOU approve the payment that waits for a human (for recording the video)
make check        # everything CI runs: cargo fmt --check, cargo test --workspace, TypeScript type-check + tests, make demo
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
7. **MCP** (`mcp/`): an MCP client, as Claude Desktop or Claude Code would,
   starts `allowance-mcp` with only the agent key, reads its budget, buys one
   more item (receipt #8) and, told to pay the attacker, is refused before
   anything is signed;
8. prints the receipts, twelve checks and the ledger page URL, and exits 0.

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
  ...  (twelve checks: autonomous payment, counteroffer, owner approval, attacker rejected and never paid,
        protocol refusals, revenue split, risk check, MCP payment and refusal, NEP-141 payment with payee registration)

demo OK
```

Keys: the sandbox's genesis key (a public constant of the `near-sandbox`
crate) signs the owner's transactions; the agent keys are generated per run
and written only to `examples/local_demo/.tmp/` (git-ignored, mode 600)
because the agents run as their own processes; `make demo-keep` and
`make demo-manual` also write the owner's sandbox key there
(`owner-key.json`) for the CLI. Nothing touches testnet or
mainnet. The same story on testnet needs one owner account (the script creates
the vault, the payee and the attacker as its sub-accounts) and is in
[docs/TESTNET.md](docs/TESTNET.md) (`make demo-testnet`, a dry run unless you
confirm).

### Try the attack yourself

Two minutes, after `make demo`. `make demo-keep` plays the same story, then
leaves the chain and the paid API running (Ctrl+C stops them) and prints the
ledger page URL. In a second terminal, in the repository, act as the
compromised agent and then as the owner:

```sh
set -a; . examples/local_demo/.tmp/demo.env; set +a       # RPC, vault and owner of the running sandbox
K=examples/local_demo/.tmp/agent-key.json; O=examples/local_demo/.tmp/owner-key.json
npx allowance ledger                                                          # vault, both agents and their policies, 8 receipts
npx allowance pay --payee attacker.sandbox --amount 0.1 --key-file $K          # REFUSED before signing (not on the allowlist), exit 3
npx allowance pay --payee attacker.sandbox --amount 0.1 --force --key-file $K  # signed anyway: the contract writes a `rejected` receipt, exit 3
npx allowance pay --payee api.sandbox --amount 0.55 --key-file $K             # above 0.5 NEAR: needs_approval, approval request #1, exit 2
npx allowance approve 1 --owner owner.sandbox --owner-key-file $O             # the owner approves (use the id it printed): paid
npx allowance kill --owner owner.sandbox --owner-key-file $O                  # paused, both agent keys deleted from the vault account
npx allowance pay --payee api.sandbox --amount 0.01 --force --key-file $K     # error [access_key_not_found]: NEAR refuses the key itself
```

## Judging map

| Criterion | Where it is demonstrated | Check it with |
|---|---|---|
| Runs and does what this README says | one command builds, starts a throw-away chain and plays the whole story with twelve on-chain checks (non-zero exit if one fails); a fresh clone following only this README is recorded in [docs/FRESH_CLONE_CHECK.md](docs/FRESH_CLONE_CHECK.md) | `make demo` |
| Technical implementation | Rust vault: pure, deterministic policy core (`src/policy.rs`), receipts and NEP-297 events, approval queue, NEP-141 payment chain with payee storage registration and callbacks that cannot strand a receipt (`src/lib.rs`), revenue split (`src/split.rs`); factory on a NEP-591 global contract (`factory/`); TypeScript SDK, CLI and factory client on near-api-js (`sdk/`); MCP server on the official MCP SDK (`mcp/`); 83 Rust tests (72 unit, 11 on neard-sandbox) and 142 TypeScript tests (one end-to-end run on neard-sandbox) | `make check` |
| Design | two independent layers: the protocol scopes the agent key (methods, gas, no deposits), the contract checks the money; free `simulate` before every payment; receipts a payee verifies with one view, no facilitator ([docs/PAYMENT_FLOW.md](docs/PAYMENT_FLOW.md)); every trade-off written down in [docs/DECISIONS.md](docs/DECISIONS.md); a static ledger page with no build | `npx allowance ledger`, [ledger/](ledger/) |
| Impact | an agent that pays for APIs, data or other agents with bounded loss: the prompt-injection attack in [docs/attack-log.md](docs/attack-log.md) moves no money; stablecoin prices; income, revenue split and vault-to-vault payments for agent businesses; ~0.003 NEAR of storage per vault through the factory | `make demo` (steps 4-6), [demo video](docs/media/demo.mp4) |
| Originality | none of the building blocks is new (method-scoped keys, session keys, allowance modules, policy engines, x402); the combination is: a policy enforced on-chain with a free pre-check, receipts a seller verifies in one RPC view, keyless counterparty risk, a kill switch at protocol level, and a factory, on an agent that is only a key on the vault | [Prior art, and what is new here](#prior-art-and-what-is-new-here) |
| Sustainability | MIT; CI on every push ([.github/workflows/test.yml](.github/workflows/test.yml)); TypeScript runs without a build step, dependencies pinned with one lockfile; immutable vault code by hash for every factory vault; ledger page deployable to GitHub Pages ([.github/workflows/pages.yml](.github/workflows/pages.yml)); the testnet run is scripted and dry-run by default ([docs/TESTNET.md](docs/TESTNET.md)) | `make test`, `npm test` |

## Prior art, and what is new here

Every building block of Allowance exists somewhere already:

* **Method-scoped keys on a contract account (NEAR).** NEAR's own multisig
  contract (near/core-contracts) adds each member as a function-call key on
  the multisig account, limited to its request and confirm methods;
  [Keypom](https://github.com/keypom/keypom) puts keys on its contract
  limited to its claim methods. Allowance's agent key is the same protocol
  primitive.
* **Session keys and spend permissions (EVM).** ERC-4337 / ERC-7579 smart
  accounts give a delegate a session key scoped to targets and functions,
  with spending limits, and the account or a paymaster pays its gas;
  Coinbase Spend Permissions give a spender a recurring allowance on a
  Smart Wallet. That is an agent with a scoped key and periodic limits.
* **Safe Allowance module.** A per-delegate, per-token allowance with a
  reset period, enforced on-chain; no payee allowlist, no human approval
  above a threshold, and the owner's key bypasses it.
* **OutLayer Agent Custody.** Keys held in a TEE, with a rich policy
  engine (per-transaction and periodic caps, allow and deny lists, time
  windows, multisig above a threshold, freeze), evaluated off-chain inside
  the TEE.
* **Coinbase Agentic Wallets.** Session caps, per-transaction limits and
  allowlists, enforced in Coinbase's custodial MPC / enclave
  infrastructure.
* **x402.** HTTP 402 with a price, the client pays, and the server (usually
  through a facilitator) checks the payment before serving.

What the combination adds, precisely:

1. **The policy is enforced on-chain, with a free pre-check.** Caps,
   budget windows, allow and deny lists, time windows, cooldowns, human
   approval and expiry live in a public contract, so a leaked agent key is
   bound by exactly the same rules as an honest one, without a TEE, a
   custodian or a smart-account stack; `simulate` runs the same `evaluate`
   as `pay` as a free view, so the agent knows *allow / needs approval /
   block + reason* before it signs. And a key that keeps getting refused is
   disabled by the vault itself.
2. **Receipts a seller verifies in one RPC view.** On a vault the seller
   trusts (by account, or by its immutable code hash), `verify_receipt(id,
   payee, min_amount, request_hash, asset)` answers whether this exact
   request was paid, in this asset: the 402 flow needs no facilitator and
   works with function-call keys.
3. **Keyless counterparty risk.** `risk/` judges the payee from public chain
   data only (deny-lists, account age, recent code changes, code its
   publisher can swap, history in this vault), needs no API key, and writes
   its verdict into the receipt's memo.
4. **A kill switch at the protocol level.** `kill` deletes every agent key
   from the vault account in the same transaction (`DeleteKey`): the
   network refuses the next transaction, not a flag the contract has to
   remember.
5. **A factory.** Vaults are created from one NEAR global contract by code
   hash, for about 0.003 NEAR of storage each, with no access key, and a
   payee can trust every factory vault by its immutable code hash.

The agent itself is only a key on the vault account: no account, no
faucet, its gas paid inside the key's allowance.

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
`createVault`, `vaults`, `vault`, `info` (see [Vault factory](docs/REFERENCE.md#vault-factory-factory));
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

## MCP server (`mcp/`): give Claude a budget, not a wallet

`allowance-mcp` exposes the vault to any MCP client (Claude Desktop, Claude
Code, an agent framework) over stdio, on the official
[MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
1.32.1. It holds only the agent's function-call key, so a model that is
prompt-injected through a web page or a tool result can at worst spend inside
the on-chain policy, and anything above the approval threshold waits for a
human.

| Tool | Signs? | What it does |
|---|---|---|
| `allowance_status` | no | policy in plain words, remaining budget, paused or not |
| `allowance_check_payee` | no | counterparty check: deny-lists, account age, code changes, history in this vault -> allow / warn / block |
| `allowance_simulate` | no | free `simulate` view: allow / needs_approval / block and why |
| `allowance_pay` | yes, `pay` | counterparty check, then `simulate`, then `pay`; refuses **before signing** on block; returns the receipt id, or the approval request id |
| `allowance_receipt`, `allowance_receipts` | no | read receipts (status, approval, delivery) |
| `allowance_confirm_delivery` | yes, `confirm_delivery` | record whether the purchase was delivered |

What it deliberately does not have: owner tools (approve, deny, set policy,
kill, withdraw), a "force" option, or any way to read the key back. Those
limits are in the code, not in the tool descriptions: `mcp/test/mcp.test.ts`
connects a real MCP client and checks the tool list, the refusals and that
nothing reaches the vault on a refused payment. `make demo` (step 7) runs it
against the sandbox.

Use it from Claude Desktop or Claude Code (`claude mcp add`), with the key
injected by your password manager into the environment:

```json
{ "mcpServers": { "allowance": {
    "command": "node",
    "args": ["/path/to/allowance/mcp/bin/allowance-mcp.ts", "--vault", "vault.you.testnet", "--rpc", "https://test.rpc.fastnear.com"],
    "env": { "ALLOWANCE_AGENT_KEY": "ed25519:..." } } } }
```

Do X, see Y, without Claude: `make demo-keep`, then in another terminal

```sh
set -a; . examples/local_demo/.tmp/demo.env; set +a
KEY=examples/local_demo/.tmp/agent-key.json
node mcp/bin/mcp-call.ts list -- --key-file $KEY                                    # seven tools, none of them owner tools
node mcp/bin/mcp-call.ts allowance_status -- --key-file $KEY                        # policy and budget left
node mcp/bin/mcp-call.ts allowance_pay '{"payee":"attacker.sandbox","amount":"1"}' -- --key-file $KEY --deny attacker.sandbox
                                                                                    # REFUSED before signing, exit 3
node mcp/bin/mcp-call.ts allowance_pay '{"payee":"api.sandbox","amount":"0.55"}' -- --key-file $KEY
                                                                                    # WAITING FOR A HUMAN, approval request #N
npx allowance receipts                                                                  # no receipt to the attacker beyond the demo's #6
```

`mcp-call` is a twenty-line MCP client that starts the server over stdio, as
Claude Desktop does; the
[MCP Inspector](https://github.com/modelcontextprotocol/inspector) works too.

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

**Open it now, nothing to install:** https://soldanoandrea.github.io/allowance/
shows the vault of one `make demo` run (`ledger/recording.json`: the same
views and NEP-297 events the page reads from a live node, saved by `make
ledger-recording`), labelled as a recording; nine receipts, the rejected
attack, the revenue split and the MCP payment are all there. With `?rpc=` and
`&vault=` it reads a live vault instead.

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

## Reference

The contract interface (owner, approver, agent and view methods), every policy field, NEP-141 payments, the revenue
split, the vault factory and the MVP-versus-stretch table are in [docs/REFERENCE.md](docs/REFERENCE.md).

## Security notes and limits

* The owner is `owner_id`, checked on `predecessor_account_id`, never
  "whoever holds a key on the vault account". The vault account's own
  full-access key (left for upgrades) is not an owner key for the contract;
  **lock mode** = delete it and manage the vault from `owner_id` only
  (factory vaults are created without any key).
* The key allowance is **gas only**: it caps what the agent can burn, not what
  it can spend. Spending limits are the policy. A key cannot attach deposits.
* An exhausted gas allowance locks the agent, not the vault: `top_up_allowance`.
* A leaked key that keeps trying is stopped by the vault itself: after
  `max_consecutive_rejections` refused payments in a row (default 5), or when
  it asks for one approval more than `max_open_approvals` (default 3), the
  agent is disabled (`agent_auto_disabled`), and from then on its `pay`
  fails without writing a receipt. What it can still burn is gas from its
  key's allowance (default 1 NEAR; set a smaller `gas_allowance` per key);
  before the cut-off each refused attempt costs gas plus a receipt's storage
  (about 0.002 NEAR together in the attack demo; storage is reclaimable with
  `prune_receipts`). Tested in `tests/sandbox.rs` (section 10).
* Budget windows are fixed, epoch-aligned buckets (see [Policy](docs/REFERENCE.md#policy)): an
  agent that spends its whole budget just before a boundary can spend it again
  just after, so the worst case over any rolling `period_ns` is twice the
  budget. Use `per_tx_cap` and `cooldown_ns` to bound that burst.
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
* MCP (the track's "NEAR MCP server" hint): `mcp/` lets any MCP client
  spend from the vault with only the function-call key; no owner tools, and
  a refused payment never reaches the chain.
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
| `cargo test` | vault: 67 unit tests (policy core, NEP-141 flows, split, auto-disable, contract on a mocked VM with mocked promise results) + 10 sandbox tests (`tests/sandbox.rs`: function-call key flows, NEP-141 with a real token, revenue split and vault-to-vault payments, a leaked key disabled by the vault) + 1 factory sandbox test (`tests/factory.rs`) |
| `cargo test --workspace` | the above + 5 factory unit tests (what `make test` and CI run) |
| `npm test` | 142 vitest tests: SDK, CLI, factory client, verifier and ledger against a mocked JSON-RPC node (real near-api-js signing, decoded transactions), the agent loop against the real demo API with an in-memory vault (NEAR, NEP-141, risk pre-check), the demo API's 402 rules, the risk service against an in-memory chain, the testnet configuration and dry run, the MCP server through a real MCP client (tool list without owner powers, refusals before signing, approval flow), and **one end-to-end run on neard-sandbox** (NEAR and NEP-141 purchases, injected payment blocked and rejected, owner methods refused by the protocol, kill -> `access_key_not_found`; then a vault created through the factory with `FactoryClient`, funded, given an agent key, paying, its receipt verified by global code hash). The end-to-end test skips itself, saying why, until `make build sandbox-node` has run. |
| `npm run typecheck` | `tsc` strict over SDK, CLI, examples, demo API, risk service, testnet scripts, demo orchestrator and tests |
| `make demo` | the whole story on a sandbox with twelve on-chain checks; non-zero exit if one fails |

Contract-only targets: `make build` (vault 390,385 bytes with the ABI
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
mcp/                 MCP server (`allowance-mcp`, stdio): the agent tools for Claude and other MCP clients, and its tests
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

The project was submitted on 2026-11-01 at the tag `hackathon-submission`
(`ae2ff88`). Work after the tag is still inside the window (development ends
2026-11-14T23:59Z) and is listed by `git log hackathon-submission..main`;
the first addition is the MCP server (`mcp/`).

## Other submission by the same team

**near-thesis**: a reproducible, data-backed investment thesis on NEAR (track
`thesis`). Repository: https://github.com/soldanoandrea/near-thesis

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
