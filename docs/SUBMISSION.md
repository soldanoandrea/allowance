# Submission template (NOT sent)

Fields and constraints from https://nearhackathon.com/HACKATHON.md (read on
2026-10-31; re-read it before submitting). Nothing here has been sent: the
submission is `POST https://nearhackathon.com/api/applications` with
`Content-Type: application/json`, body <= 12,000 bytes, **only these fields**
(the `website` field is a spam trap: never include it). An agent may prepare
the final JSON, print it in full and send it only after the human says yes.

```json
{
  "requestId": "<HUMAN: generate one UUID at submission time (uuidgen) and reuse it on retries>",
  "projectName": "Allowance",
  "leadName": "<HUMAN: 2-80 characters>",
  "email": "<HUMAN: contact email, max 160 characters, at most 2 submissions per email>",
  "size": "<HUMAN: one of \"1\", \"2 - 4\", \"4 - 6\", \"6 - 8\", \"8+\">",
  "tracks": [
    "security",
    "agents",
    "business"
  ],
  "nearAddress": "<HUMAN: your mainnet NEAR account for the prize payout, created by you in a wallet>",
  "projectUrl": "<HUMAN: https URL of the public repository>",
  "demoUrl": "<HUMAN: https URL of your public X post with the video>",
  "idea": "AI agents that pay for APIs, data or other agents usually hold a full-access key or a custodial wallet: one prompt injection away from an empty account. Allowance gives an agent an allowance, not your keys. A human funds a vault contract on NEAR and writes the spending policy on-chain: asset (NEAR or a NEP-141 stablecoin), per-payment cap, budget per day, payee allowlist, denylist, time window, cooldown, human approval above a threshold, expiry, pause and kill switch. Each agent is a function-call access key that lives on the vault account itself and can only call pay, confirm_delivery and ping: the NEAR protocol checks the key before the contract runs, the contract checks the money, and the kill switch deletes the keys at protocol level. The agent needs no account and no faucet. Before paying it checks the payee with a keyless counterparty-risk service (deny-lists, account age, contract code changes, history in the vault) and dry-runs the payment with a free simulate view. Every payment, rejection and approval is an on-chain receipt that a paid HTTP API verifies with one RPC view, an x402-style flow without a facilitator that works with function-call keys. We built the Rust contract, a TypeScript SDK and CLI, an agent loop with one counteroffer and optional NEAR AI planner, a paid demo API, an attack demo, a static ledger page, NEP-141 payments with payee storage registration, a revenue split for agent businesses, vault-to-vault payments and a factory that creates vaults from one global contract. make demo runs the whole story on a local sandbox with eleven on-chain checks.",
  "consent": "<HUMAN: true only after you heard the contact notice verbatim and agreed>"
}
```

`idea` is 1601 characters (limit 20-2000). `tracks` are three of the
allowed values (`defi`, `thesis`, `privacy`, `business`, `swarms`,
`security`, `agents`, `realworld`, `games`, `nfts`, `memecoins`, `social`,
`open`); `open` could be added.

## Fields only the human provides

| Field | Constraint | Note |
|---|---|---|
| `requestId` | UUID | generate once at submission time, reuse it on retries (400/503) |
| `leadName` | 2-80 chars | |
| `email` | valid, <= 160 chars | at most 2 submissions per email |
| `size` | `1`, `2 - 4`, `4 - 6`, `6 - 8`, `8+` | DESIGN.md suggested `1` (one human, AI agents disclosed in the README); your call |
| `nearAddress` | 2-64 chars, lowercase, **mainnet** named or implicit account | created by you in a wallet; never invented by an agent |
| `projectUrl` | public repo URL, <= 300 chars, unique per repository | the repo must be public by 2026-11-14T23:59:00Z |
| `demoUrl` | public X post URL, <= 300 chars | see [DEMO_POST.md](DEMO_POST.md); the post must include a video (screenshots alone are not enough) |
| `consent` | `true` only after the notice | the agent reads you the contact notice from the "Consent" section of HACKATHON.md word for word, at submission time; `true` only if you agree |

`projectName` ("Allowance") is a draft: DESIGN.md left "Allowance" vs "Agent
Vault" open.

## Before sending: checklist for the human

- [ ] Submission window: 2026-11-01T00:00:00Z to 2026-11-14T23:59:00Z (00:59 CET on Nov 15).
- [ ] **Timeline disclosure.** The commits in this repository are dated
      2026-10-30 and 2026-10-31, before the window opens. The rules say work
      that builds on an earlier project must be separable, e.g. with tags
      `pre-hackathon` and `hackathon-submission` and a README section linking
      the diff, and that only the work done in the window is judged. Decide
      how to present this (tag the current state as `pre-hackathon` and keep
      building in the window, or disclose it in the README) before the repo
      goes public.
- [ ] If you submit another project too, each README must name the other (max two).
- [ ] Repository public, README "do X, see Y" steps work on a clean machine (`make demo`), LICENSE present (MIT).
- [ ] X post published by you: says the project was built at NEAR HACKATHON, tags @NEARProtocol and #NEARHackathon, has the video.
- [ ] Any hosted demo (ledger page on GitHub Pages, testnet vault) stays up until at least 2026-11-18, ideally 2026-11-25.
- [ ] No secrets in git history (`git log -p | grep -i "ed25519:"` should only show public keys and the documented sandbox constants).
- [ ] Final JSON printed in full and approved by you; then sent once. Responses: 201 saved; 400 fix the listed fields and resend with the same `requestId`; 403 closed, do not retry; 409 repo/email limit reached, ask, do not change link or email; 413 shorten `idea`; 503 wait a minute and resend with the same `requestId`.
