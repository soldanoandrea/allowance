# Demo post for X (draft, for the human to publish)

Not posted. The rules ask for a public X post that says the project was
built at NEAR HACKATHON, tags @NEARProtocol and #NEARHackathon, and attaches
the demo video (screenshots alone are not enough). Replace `<REPO_URL>`
before posting; attach the video from [DEMO_SCRIPT.md](DEMO_SCRIPT.md).

## Main post (under 280 characters)

```
AI agents that pay for things hold your keys: one poisoned page and the wallet is empty.

Allowance gives agents an allowance, not your keys: a NEAR vault, a key that can only call pay, rules on-chain.

Built at NEAR HACKATHON @NEARProtocol #NEARHackathon
<REPO_URL>
```

## Optional thread

```
1/ My agent needed market data. The API answered 402 at 0.8 NEAR. Its limit without me is 0.5, so it offered 0.5 once, the seller took it, it paid from its vault, and the API checked the receipt with a single RPC view. Data delivered, receipt on-chain.
```

```
2/ Then a web page told it to send 2 NEAR to an attacker. The risk check and the free dry-run said no. Forced anyway, the contract refused and wrote a receipt. Trying the owner's methods, NEAR itself rejected the key.
```

```
3/ Why NEAR: the agent's key is a function-call access key that lives on the vault and can only call pay. The protocol enforces that before any code runs; the kill switch deletes the key. No custodian, no TEE, MIT. Try it: make demo
```

Optional tags: @NearLegion @NearBuilders.
