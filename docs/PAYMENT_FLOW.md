# Paying an HTTP API from an Allowance vault (HTTP 402 flow)

An x402-style flow where the payment proof is a **vault receipt** that the
API checks with **one free view call**. No facilitator, no signature from a
full-access key: the agent signs `pay` with its function-call key on the
vault, and the API asks the vault whether that receipt paid it.

Implemented by `demo-api/src/server.ts` (seller), `sdk/src/agent/paid-task.ts`
(buyer) and `sdk/src/verifier.ts` (seller-side verification). Protocol
constants and the quote parser are in `sdk/src/x402.ts`.

## Sequence

```
Agent                                   API (payee api.x)                       Vault contract
  | GET /dataset                          |                                         |
  |-------------------------------------->|                                         |
  | 402 PaymentRequired{payee, amount_yocto, nonce, request_hash_base64, accepts}  |
  |<--------------------------------------|                                         |
  | simulate(agent, payee, amount)  (view, free)                                    |
  |-------------------------------------------------------------------------------->|
  | allow | needs_approval | block(reason)                                          |
  |<--------------------------------------------------------------------------------|
  |  block          -> refuse, log the reason, stop                                 |
  |  needs_approval -> optionally ONE counteroffer (below), else pay and wait       |
  | pay(payee, amount, memo, request_hash)   signed by the agent key as the vault  |
  |-------------------------------------------------------------------------------->|
  | {outcome: paid, receipt_id: N}   (or needs_approval -> wait for the owner)     |
  |<--------------------------------------------------------------------------------|
  | GET /dataset                          |                                         |
  |   X-Allowance-Receipt: vault.x:N      |                                         |
  |   X-Allowance-Nonce: <nonce>          |                                         |
  |-------------------------------------->| verify_receipt(N, api.x, amount,        |
  |                                       |   sha256(nonce))  (view, final)         |
  |                                       |---------------------------------------->|
  |                                       | true                                    |
  |                                       |<----------------------------------------|
  | 200 {data}   X-Allowance-Paid: vault.x:N                                        |
  |<--------------------------------------|                                         |
  | confirm_delivery(N, passed)  signed by the agent key                            |
  |-------------------------------------------------------------------------------->|
```

## The 402 body

```json
{
  "scheme": "allowance-receipt/v1",
  "resource": "/dataset",
  "description": "NEAR/USDC daily candles, last 30 days",
  "payee": "api.sandbox",
  "asset": "near",
  "amount_yocto": "20000000000000000000000",
  "nonce": "EvHWTWIbh3wmv_DxQs0qUA",
  "request_hash_base64": "<base64(sha256(utf8(nonce)))>",
  "expires_at": "2026-10-31T20:25:37.000Z",
  "accepts": { "vaults": ["vault.sandbox"], "code_hashes": ["HUoGyXRv..."] },
  "instructions": "Pay 0.02 NEAR to api.sandbox from an Allowance vault: ...",
  "counteroffer": { "status": "accepted", "offered_yocto": "...", "list_price_yocto": "...", "reason": "..." },
  "error": "not_paid",
  "error_detail": "receipt #3 is pending (not paid yet)"
}
```

- `nonce` is random (128 bits) and **single-use**; the server keeps the quote
  (resource, price) under it.
- `request_hash_base64 = base64(sha256(utf8(nonce)))`, exactly 32 bytes, which
  is what the contract stores in `Receipt.request_hash` and what
  `verify_receipt` compares. The agent recomputes it and refuses a quote whose
  hash does not match its nonce.
- `accepts` tells the agent whose receipts the API trusts (see below).
- `counteroffer` is present on the quote that answers a counteroffer;
  `error`/`error_detail` on a 402 that answers a refused retry (the quote and
  its nonce stay valid, so the agent can retry once a pending receipt is paid).

## Headers

| Header | Direction | Value |
|---|---|---|
| `X-Allowance-Receipt` | agent -> API | `<vault account>:<receipt id>` (a bare `<id>` if the API has a default vault). Account ids cannot contain `:`. |
| `X-Allowance-Nonce` | agent -> API | the quote's `nonce` |
| `X-Allowance-Offer` | agent -> API | counteroffer in yoctoNEAR, on an unpaid request |
| `X-Allowance-Offer-Reason` | agent -> API | one sentence of reasoning (<= 300 chars) |
| `X-Allowance-Paid` | API -> agent | the redeemed receipt, on the 200 |

## What the API checks before serving

1. The nonce exists and belongs to this resource (otherwise a fresh 402,
   `error: unknown_nonce`).
2. The receipt `<vault>:<id>` has not been redeemed before (`receipt_already_used`).
3. The vault is trusted:
   - **by name** (`ALLOWANCE_VAULTS`), or
   - **by code**: the vault account runs a contract whose `code_hash` is in
     `ALLOWANCE_CODE_HASHES` (base58 sha256 of `allowance.wasm`). The code hash
     is read with `view_account` **at the same block** as the
     `verify_receipt` call, so a vault cannot swap its code in between.

   This matters because `verify_receipt` is a view on the vault account: a
   contract that is not Allowance could simply answer `true`. A vault
   running the genuine code can only mark a receipt `paid` from the callback
   of a transfer that succeeded.
4. `verify_receipt(id, payee = the API's account, min_amount = the quoted
   price, request_hash = sha256(nonce))` is `true` at `final` finality
   (`VERIFY_FINALITY=optimistic` answers a block earlier). A receipt that is
   still `pending`/`approved`, or not visible yet, is polled for up to 8 s;
   otherwise the API reads `get_receipt` to say why it refused (wrong payee,
   amount below the price, different request, rejected/denied/failed).
5. On success the nonce is deleted and the receipt marked used (in memory:
   this is a demo, a real API would persist both).

## Counteroffer (one, agents track)

When `simulate` says `needs_approval` (price above the owner's approval
threshold), the scripted planner offers the threshold itself, the most it may
pay without waking a human, once, with its reasoning:

```
X-Allowance-Offer: 500000000000000000000000
X-Allowance-Offer-Reason: My owner pre-approved payments up to 0.5 NEAR; above that a human has to sign off, which can take hours. I can pay 0.5 NEAR right now.
```

The demo API accepts any offer at or above the product's floor and below the
list price (new quote at the offer), otherwise it answers with a new quote at
the list price. If the counteroffer fails the agent pays the list price; the
vault queues it (`needs_approval`, an `approval_requested` event) and the
agent polls `get_receipt` until the owner approves (`paid`), denies or the
request expires. The API serves the data once the receipt is `paid`.

Planner guardrails (`enforceGuardrails`): a `block` verdict always wins; at
most one counteroffer, strictly below the asking price; the planner (scripted
or LLM) never chooses the payee or raises the amount. The contract evaluates
the same policy again on-chain regardless.

## Demo prices

| Resource | List price | Floor | What happens with cap 1 / approval above 0.5 |
|---|---|---|---|
| `/dataset` | 0.02 NEAR | 0.02 | allow -> paid autonomously |
| `/dataset/premium` | 0.8 NEAR | 0.5 | needs approval -> counteroffer 0.5 accepted -> paid autonomously |
| `/dataset/archive` | 0.8 NEAR | 0.75 | needs approval -> counteroffer refused -> owner approves -> paid |
| `/web/market-news` | free | - | carries the prompt injection used by the attack demo |

## Running the API on its own

```sh
ALLOWANCE_RPC_URL=http://127.0.0.1:3030 API_PAYEE=api.sandbox \
ALLOWANCE_VAULTS=vault.sandbox PORT=8402 node demo-api/src/main.ts
curl -i http://127.0.0.1:8402/dataset        # 402 + quote
```

Environment: `ALLOWANCE_RPC_URL`, `API_PAYEE` (required), `ALLOWANCE_VAULTS`
and/or `ALLOWANCE_CODE_HASHES` (at least one), `ATTACKER_ACCOUNT`,
`VERIFY_FINALITY`, `PORT`, `HOST`.

## Differences from x402

x402 on NEAR (`@fastnear/x402`) has the payer sign a NEP-366 delegate action
with a **full-access key** and a facilitator relay it; function-call keys
cannot attach deposits, so a sandboxed agent cannot use it. Here the money
moves inside the vault under the owner's policy, the proof is a receipt
anyone can read, and the seller needs only an RPC endpoint.
