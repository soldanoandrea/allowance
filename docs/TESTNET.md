# Running Allowance on NEAR testnet (manual steps for the human)

`make demo` runs everything on a throw-away local sandbox. This page is the
same story on **testnet**, with accounts you create and keys you hold. It is
prepared, not executed: no account, key or transaction in this repository
comes from it.

What the scripts do and do not do:

* `scripts/testnet/demo.ts` (`make demo-testnet`) deploys the vault on an
  account **you** created, initialises it, deposits, registers the agent key
  and runs the agent loop against a local copy of the paid demo API.
* It **never creates accounts and never writes keys**. Keys are read from
  an environment variable (best: injected by your password manager) or from
  a key file you created.
* It is a **dry run unless `TESTNET_CONFIRM=yes`** (or `--yes`): by default
  it prints the plan and signs nothing.
* It refuses `mainnet` RPC endpoints and any account that is not
  `*.testnet`.

## 0. Prerequisites

Same as the local demo (Rust + `cargo-near` 0.22, Node 24), plus
[near-cli-rs](https://github.com/near/near-cli-rs) 0.30 to create accounts.
Build once: `make build` (writes `target/near/allowance.wasm`).

Budget: the faucet sponsors the owner account with free testnet NEAR (top it
up with the faucet described at https://docs.near.org/getting-started/faucet
if needed). The vault needs about **4.5 NEAR** on its account before the
deploy (the 385 KB contract locks ~3.9 NEAR of storage stake), plus the
deposit (2 NEAR by default, which covers the demo's 0.02 + 0.5 + 0.8 NEAR of
purchases), plus 1 NEAR for the API account: about 8 NEAR in all.

## 1. Accounts (you create them)

Replace `you` with your name. Three accounts: the owner, the vault (a
sub-account of the owner) and the paid API's account.

```sh
# Owner, sponsored by the testnet faucet. print-to-terminal shows the key once:
# store it in your password manager (or use save-to-legacy-keychain, which
# writes ~/.near-credentials/testnet/you.testnet.json).
near account create-account sponsor-by-faucet-service you.testnet \
  autogenerate-new-keypair print-to-terminal network-config testnet create

# The vault account, funded by the owner with 5 NEAR.
near account create-account fund-myself vault.you.testnet '5 NEAR' \
  autogenerate-new-keypair print-to-terminal \
  sign-as you.testnet network-config testnet sign-with-plaintext-private-key   # or another signer you use

# The API's account (receives the payments; the scripts never need its key).
near account create-account fund-myself api.you.testnet '1 NEAR' \
  autogenerate-new-keypair print-to-terminal \
  sign-as you.testnet network-config testnet sign-with-plaintext-private-key
```

The CLI is interactive: run `near` with fewer arguments and it asks for the
rest. Check: `near account view-account-summary vault.you.testnet
network-config testnet now`.

## 2. The agent key

The agent gets **no account**: its key will live on the vault account as a
function-call key. Generate it without writing a file:

```sh
node scripts/testnet/agent-key.ts vault.you.testnet
```

It prints near-cli JSON on stdout and the public key on stderr. Store the
`private_key` in your password manager (or redirect stdout to a file
**outside the repository** with `umask 077`). It does nothing until the
owner registers it in step 4.

## 3. Configuration

```sh
cp .env.testnet.example .env.testnet      # git-ignored
```

Fill in the account ids. For each key choose one:

* the key itself in `TESTNET_OWNER_KEY`, `TESTNET_VAULT_KEY`,
  `TESTNET_AGENT_KEY`, injected at run time by your password manager so it
  never touches the disk, e.g. with 1Password CLI references
  (`TESTNET_AGENT_KEY=op://<vault>/<item>/private_key`) and
  `op run --env-file=.env.testnet -- make demo-testnet`;
* or a path in `TESTNET_OWNER_KEY_FILE`, `TESTNET_VAULT_KEY_FILE`,
  `TESTNET_AGENT_KEY_FILE` (near-cli JSON or a bare `ed25519:...` line;
  `chmod 600`).

Optional: `TESTNET_APPROVER_ID` (a second human or a DAO that may approve),
the policy (default: the local demo's, `TESTNET_PER_TX_CAP` 1,
`TESTNET_BUDGET` 2 per `TESTNET_BUDGET_PERIOD` 1d,
`TESTNET_APPROVAL_THRESHOLD` 0.5),
`TESTNET_DEPOSIT_NEAR` (2), `TESTNET_DENYLIST`, `TESTNET_ARCHIVAL_RPC_URL`
(for the counterparty-risk check's account age; without it the check says
"at least N days" from what the regular node keeps), `TESTNET_AUTO_APPROVE=1`.

## 4. Dry run, then run

```sh
make demo-testnet                               # prints the plan, sends nothing
TESTNET_CONFIRM=yes make demo-testnet           # deploy, fund, add agent, run the agent loop
TESTNET_CONFIRM=yes make demo-testnet STEP=run  # one step: deploy | fund | add-agent | run
```

(With 1Password: `op run --env-file=.env.testnet -- env TESTNET_CONFIRM=yes make demo-testnet`.)

What happens, in order:

1. **deploy**: `DeployContract` + `new(owner_id, approver_id)` on
   `vault.you.testnet`, signed by the vault account's own key. Skipped if
   this exact build is already there; refused if other code is.
2. **fund**: `you.testnet` calls `deposit` with 2 NEAR (income receipt #0).
3. **add-agent**: `you.testnet` calls `add_agent`; the vault adds the agent
   key to **its own account** as a function-call key limited to `pay`,
   `confirm_delivery`, `ping` with a 1 NEAR gas allowance.
4. **run**: starts `demo-api` on `127.0.0.1:8402` (payee `api.you.testnet`,
   trusting receipts of `vault.you.testnet`), runs `sdk/examples/agent-loop.ts`
   with the agent key: 402 -> counterparty check -> `simulate` -> `pay` ->
   retry with the receipt -> `confirm_delivery`, for the three datasets of the
   local demo (0.02 NEAR alone; 0.8 NEAR countered at 0.5; 0.8 NEAR waiting for
   the owner). When a payment waits for a human, approve it from another
   terminal (or set `TESTNET_AUTO_APPROVE=1`):

   ```sh
   npx allowance approve <request id> --vault vault.you.testnet --rpc https://test.rpc.fastnear.com \
     --owner you.testnet --owner-key-file <owner key file>    # or ALLOWANCE_OWNER_KEY in the environment
   ```

   At the end it prints the receipts table and the ledger page URL.

## 5. Check it on-chain

```sh
near account list-keys vault.you.testnet network-config testnet now   # the agent's FunctionCall key: receiver vault, methods pay/confirm_delivery/ping
npx allowance ledger --vault vault.you.testnet --rpc https://test.rpc.fastnear.com
```

Open the printed `ledger/index.html?rpc=...&vault=...` URL (works from
`file://`). Explorer: `https://testnet.nearblocks.io/address/vault.you.testnet`.

Kill switch (deletes every agent key at the protocol level; the agent's next
transaction fails with `AccessKeyNotFound`):

```sh
npx allowance kill --vault vault.you.testnet --rpc https://test.rpc.fastnear.com --owner you.testnet --owner-key-file <owner key file>
```

Lock mode (optional, for the video): delete the vault account's own
full-access key so that only `owner_id` can manage it through the contract
(no more code upgrades):
`near account delete-keys vault.you.testnet public-keys <its ed25519 key> network-config testnet sign-with-... send`.

## 6. Global contract and factory on testnet (not part of the demo)

The factory (`factory/`) is tested on the sandbox. On testnet or mainnet it
needs the vault code published once as a global contract by hash, which
**burns** 10x the storage of the wasm (38.55 NEAR for the current
385 KB build, measured on the sandbox), more than a faucet account holds:

```sh
near contract deploy-as-global use-file target/near/allowance.wasm as-global-hash you.testnet network-config testnet sign-with-... send
near contract deploy factory.you.testnet use-file target/near/allowance_factory/allowance_factory.wasm \
  with-init-call new json-args '{"owner_id":"you.testnet","vault_code_hash":"<base58 sha256 of allowance.wasm>"}' \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-... send
near contract call-function as-transaction factory.you.testnet create_vault json-args '{"name":"alice"}' \
  prepaid-gas '100 Tgas' attached-deposit '1 NEAR' sign-as you.testnet network-config testnet sign-with-... send
```

or, for the last step, the TypeScript client (`FactoryClient` in the SDK):

```sh
npx allowance factory create --factory factory.you.testnet --rpc https://test.rpc.fastnear.com \
  --name alice --owner you.testnet --deposit 1 --owner-key-file you.json
npx allowance factory list --factory factory.you.testnet --rpc https://test.rpc.fastnear.com
```

Each vault then costs ~0.003 NEAR of storage stake plus its deposit. This is
the mainnet plan; it was not run.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `configuration problems: ... is not set` | missing variable in `.env.testnet` (the dry run lists all of them) |
| `already runs other code` | the vault account has a contract: use a fresh account |
| `needs about 4.5 NEAR of storage stake` | send more NEAR to the vault account before `deploy` |
| `add_agent did not register the agent` | the key is already on the vault account (as a full-access key?) |
| agent: `access_key_not_found` | the key was removed (`kill` / `remove_agent`) or `add-agent` was not run |
| agent: `not_enough_allowance` | the key's gas allowance is used up: owner `top_up_allowance` |
| API: `untrusted_vault` | `ALLOWANCE_VAULTS` must name the vault (the script sets it) |
