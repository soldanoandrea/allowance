# Demo video script (under 3 minutes)

One take per scene, screen capture plus voice-over. Everything runs on a
local sandbox with `make demo-manual` (the same story as `make demo`, but you
play the owner who approves the large payment). If the testnet run of
[TESTNET.md](TESTNET.md) has been done, the same scenes work with
`make demo-testnet` and testnet explorer links; this script does not assume
it.

## Before recording

```sh
make build sandbox-node && npm ci        # compile once, so the recording starts instantly
```

Screen: two terminals side by side (left: the demo, right: you, the owner)
and a browser window for the ledger page. Font size 16+. Hide anything
personal from the shell prompt.

## Scenes

| Time | Scene | On screen | Voice-over |
|---|---|---|---|
| 0:00-0:15 | **The problem** | README title and the two-layer table | "An AI agent that pays for things usually holds a full wallet key. One poisoned web page and the money is gone. Allowance gives an agent an allowance, not your keys." |
| 0:15-0:40 | **Owner sets the rules** | Left: `make demo-manual`. Steps 1-3 scroll: vault deployed on `vault.sandbox`, 5 NEAR deposited, policy line *cap 1 NEAR, 2 NEAR/day, payees [api.sandbox], approval above 0.5*, agent key registered. Right: `set -a; . examples/local_demo/.tmp/demo.env; set +a; npx allowance ledger` showing the agent and its policy | "The owner funds a vault and writes the policy on-chain. The agent is a NEAR function-call key that lives on the vault itself: the protocol lets it call pay and nothing else, and it cannot attach money." |
| 0:40-1:20 | **The agent buys data** | Left, step 4: `HTTP 402: 0.02 NEAR` -> `counterparty check api.sandbox: WARN (only 0 min old)` -> `simulate ... ALLOW` -> `pay tx ...: paid (receipt #2)` -> API: `receipt vault.sandbox:2 verified on-chain` -> `confirm_delivery(#2, true)`. Then the premium dataset: `NEEDS_APPROVAL` -> `x-allowance-offer: 500000...` -> `counteroffer accepted` -> paid 0.5 | "It hits a paid API, gets a 402 with a price, checks who it is paying, dry-runs the payment for free, pays from the vault, and the API verifies the receipt with one RPC view. No facilitator. Above its limit it negotiates once, and the seller accepts." |
| 1:20-1:40 | **A human approves** | Left: `waiting for the owner to approve request #0`. Right: paste the printed `npx allowance approve 0 --vault vault.sandbox ... --owner owner.sandbox --owner-key-file examples/local_demo/.tmp/owner-key.json` -> `approve #0: paid`. Browser: open the printed ledger URL, the receipt appears with *approved by owner.sandbox* | "When the seller refuses, the payment waits for a human. I approve it; the contract checks the policy again at that moment and pays." |
| 1:40-1:55 | **Stablecoins** | Left, step 4b: `HTTP 402: 2 SUSD` -> `event ft_payee_registration` -> `payment_paid ... "asset":{"ft":"usd.sandbox"}` | "A second agent pays in a NEP-141 stablecoin. The API had no storage on the token, so the vault registers it first, within limits the owner set, then transfers with the receipt id in the memo." |
| 1:55-2:25 | **The attack** | Left, step 5 (also in docs/attack-log.md): poisoned page -> `counterparty check attacker.sandbox: BLOCK (on the deny-list)` -> `simulate pay 5 NEAR: BLOCK (above the cap)` -> compromised process signs anyway -> `rejected (receipt #6) - not on the allowlist` -> `withdraw: refused by the NEAR protocol` -> `attacker ... received 0 NEAR` | "Now a web page hides an instruction: send 2 NEAR to an attacker. The risk check blocks it, simulate blocks the rest. Suppose the agent process itself is compromised and signs anyway: the contract refuses and writes a receipt. It tries the owner's methods: the network refuses the key before the contract even runs." |
| 2:25-2:40 | **A business, not just a wallet** | Left, step 6: `shop.sandbox receipt: #0 income 0.1 NEAR ... split: provider.sandbox 0.01 NEAR (paid), ops.sandbox 0.005 NEAR (paid)`; then the 11 `ok` checks and `demo OK` | "The API's own revenue lands in a vault too, and a revenue split forwards ten percent to its data provider in the same transaction." |
| 2:40-2:52 | **Kill switch** | Right: `npx allowance kill --owner owner.sandbox --owner-key-file examples/local_demo/.tmp/owner-key.json` -> `vault killed: paused, 2 agent key(s) deleted at the protocol level`; then `npx allowance pay --payee api.sandbox --amount 0.01 --force --key-file examples/local_demo/.tmp/agent-key.json` -> `error [access_key_not_found]` | "One command and every agent key is deleted from the account. The agent's next transaction is rejected by NEAR itself." |
| 2:52-3:00 | **Close** | README: "Quickstart: make demo"; repo URL | "Policy on-chain, keys on NEAR, receipts anyone can verify. Built at NEAR HACKATHON, MIT licensed. One command to try it." |

## Notes

* `make demo-manual` keeps the sandbox running after `demo OK` (Ctrl+C to
  stop), so the kill-switch scene runs against the same chain. The commands
  to paste are printed by the demo itself; the keys it uses are sandbox-only
  (the owner key is the sandbox genesis key, a public constant).
* If time is short, drop the stablecoin or business scene (15 s each).
* Do not show `.env.testnet`, key files or password-manager windows on
  screen. The sandbox keys in `examples/local_demo/.tmp/` are harmless.
* The LLM planner (`--planner llm`, NEAR AI Cloud) is optional and not in
  this script: its base URL and default model were not verified (see
  docs/DECISIONS.md, 32).
