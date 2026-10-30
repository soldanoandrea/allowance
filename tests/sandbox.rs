//! Integration tests against a local NEAR sandbox node.
//!
//! They compile the contract with `cargo near build` (through
//! `cargo-near-build`), start a throw-away `neard-sandbox` per test and drive
//! the vault the way the owner, the agent and a payee would: the agent signs
//! with a function-call key that lives on the vault account, so the tests
//! also cover what the *protocol* does with such a key (method restriction,
//! no deposits, deletion on kill).
//!
//! The agent key is generated in memory and never written anywhere.

use std::sync::{Arc, OnceLock};

use near_api::errors::ExecuteTransactionError;
use near_api::signer::generate_secret_key;
use near_api::types::AccessKeyPermission;
use near_api::types::transaction::result::TransactionResult;
use near_api::{Account, AccountId, Chain, Contract, NearToken, NetworkConfig, PublicKey, Signer};
use near_sandbox::Sandbox;
use near_sdk::base64::Engine as _;
use near_sdk::serde::de::DeserializeOwned;
use near_sdk::serde_json::{Value, json};
use testresult::TestResult;

const NS_PER_SEC: u64 = 1_000_000_000;
const DAY_NS: u64 = 86_400 * NS_PER_SEC;

fn wasm() -> &'static [u8] {
    static WASM: OnceLock<Vec<u8>> = OnceLock::new();
    WASM.get_or_init(|| {
        let path = cargo_near_build::build_with_cli(Default::default())
            .expect("cargo near build non-reproducible-wasm failed");
        std::fs::read(path).expect("read compiled wasm")
    })
}

fn near(n: u128) -> NearToken {
    NearToken::from_near(n)
}
fn millinear(n: u128) -> NearToken {
    NearToken::from_millinear(n)
}
fn yocto(t: NearToken) -> String {
    t.as_yoctonear().to_string()
}
fn ns(v: &Value) -> u64 {
    v.as_str().expect("U64 is a JSON string").parse().unwrap()
}
fn token(v: &Value) -> NearToken {
    NearToken::from_yoctonear(
        v.as_str()
            .expect("NearToken is a JSON string")
            .parse()
            .unwrap(),
    )
}

/// Policy JSON the way an owner would write it (amounts in yoctoNEAR strings).
fn policy_json(
    per_tx_cap: NearToken,
    budget: Option<(NearToken, u64)>,
    allow: &[&AccountId],
    threshold: Option<NearToken>,
    cooldown_ns: u64,
) -> Value {
    json!({
        "per_tx_cap": yocto(per_tx_cap),
        "budget": budget.map(|(amount, period_ns)| json!({"amount": yocto(amount), "period_ns": period_ns.to_string()})),
        "allow": {"list": allow.iter().map(|a| json!({"account_id": a})).collect::<Vec<_>>()},
        "approval_threshold": threshold.map(yocto),
        "cooldown_ns": cooldown_ns.to_string(),
    })
}

/// Everything a test needs: a sandbox, the deployed vault and a few accounts.
struct Env {
    sandbox: Sandbox,
    network: NetworkConfig,
    /// Genesis key: full access on every account created through the sandbox.
    root: Arc<Signer>,
    owner: AccountId,
    approver: AccountId,
    payee: AccountId,
    vault: Contract,
}

/// An agent: an in-memory key pair registered on the vault account.
struct AgentKey {
    signer: Arc<Signer>,
    public_key: PublicKey,
}

impl AgentKey {
    fn generate() -> TestResult<Self> {
        let secret = generate_secret_key()?;
        Ok(Self {
            public_key: secret.public_key(),
            signer: Signer::from_secret_key(secret)?,
        })
    }
    fn id(&self) -> Value {
        json!({"key": self.public_key.to_string()})
    }
}

impl Env {
    async fn new() -> TestResult<Self> {
        Self::with_approval_ttl(DAY_NS).await
    }

    async fn with_approval_ttl(approval_ttl_ns: u64) -> TestResult<Self> {
        let sandbox = Sandbox::start_sandbox().await?;
        let network = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
        let root = Signer::from_secret_key(
            near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?,
        )?;
        let owner = create_account(&sandbox, "owner.sandbox").await?;
        let approver = create_account(&sandbox, "approver.sandbox").await?;
        let payee = create_account(&sandbox, "api.sandbox").await?;
        let vault_id = create_account(&sandbox, "vault.sandbox").await?;
        Contract::deploy(vault_id.clone())
            .use_code(wasm().to_vec())
            .with_init_call(
                "new",
                json!({
                    "owner_id": owner,
                    "approver_id": approver,
                    "approval_ttl_ns": approval_ttl_ns.to_string(),
                }),
            )?
            .with_signer(root.clone())
            .send_to(&network)
            .await?
            .assert_success();
        Ok(Self {
            sandbox,
            network,
            root,
            owner,
            approver,
            payee,
            vault: Contract(vault_id),
        })
    }

    fn vault_id(&self) -> &AccountId {
        &self.vault.0
    }

    /// Transaction signed by `signer_id`'s full-access (genesis) key.
    async fn call(
        &self,
        signer_id: &AccountId,
        method: &str,
        args: Value,
    ) -> TestResult<TransactionResult> {
        Ok(self
            .vault
            .call_function(method, args)
            .transaction()
            .with_signer(signer_id.clone(), self.root.clone())
            .send_to(&self.network)
            .await?)
    }

    async fn call_ok(
        &self,
        signer_id: &AccountId,
        method: &str,
        args: Value,
    ) -> TestResult<(Value, Vec<String>)> {
        let result = self.call(signer_id, method, args).await?.assert_success();
        let logs = result.logs().into_iter().map(str::to_string).collect();
        Ok((result.json().unwrap_or(Value::Null), logs))
    }

    /// Transaction signed by an agent key: `signer_id` is the vault itself.
    /// Returns near-api's error untouched so tests can expect protocol-level
    /// refusals (`testresult` would turn a `?` into a panic).
    async fn agent_call(
        &self,
        agent: &AgentKey,
        method: &str,
        args: Value,
    ) -> Result<TransactionResult, Box<ExecuteTransactionError>> {
        self.vault
            .call_function(method, args)
            .transaction()
            .with_signer(self.vault_id().clone(), agent.signer.clone())
            .send_to(&self.network)
            .await
            .map_err(Box::new)
    }

    /// Sign a transaction with the agent key and broadcast it through the raw
    /// `send_tx` JSON-RPC call, returning the node's `error` object (or
    /// `null` on success). near-api swallows the details of
    /// `InvalidTxError`, and those details are exactly what these tests are
    /// about: the protocol refusing the key before the contract runs.
    ///
    /// `nonce = None` fetches the key's nonce from the chain; `Some(n)` signs
    /// offline, which lets us submit a transaction for a key that no longer
    /// exists.
    async fn protocol_error(
        &self,
        agent: &AgentKey,
        method: &str,
        args: Value,
        deposit: NearToken,
        nonce: Option<u64>,
    ) -> TestResult<Value> {
        let unsigned = self
            .vault
            .call_function(method, args)
            .transaction()
            .deposit(deposit)
            .with_signer(self.vault_id().clone(), agent.signer.clone());
        let signed = match nonce {
            None => unsigned.presign_with(&self.network).await?,
            Some(nonce) => {
                let block_hash = Chain::block_hash().fetch_from(&self.network).await?;
                unsigned
                    .presign_offline(agent.public_key, block_hash, nonce)
                    .await?
            }
        }
        .transaction
        .signed()
        .expect("presigned");
        let signed_tx_base64 = near_sdk::base64::engine::general_purpose::STANDARD
            .encode(near_sdk::borsh::to_vec(&signed)?);
        let response: Value = reqwest::Client::new()
            .post(&self.sandbox.rpc_addr)
            .json(&json!({
                "jsonrpc": "2.0",
                "id": "allowance-test",
                "method": "send_tx",
                "params": {"signed_tx_base64": signed_tx_base64, "wait_until": "EXECUTED_OPTIMISTIC"},
            }))
            .send()
            .await?
            .json()
            .await?;
        Ok(response["error"].clone())
    }

    async fn agent_pay(
        &self,
        agent: &AgentKey,
        payee: &AccountId,
        amount: NearToken,
    ) -> TestResult<(Value, Vec<String>)> {
        let result = self
            .agent_call(
                agent,
                "pay",
                json!({"payee": payee, "amount": yocto(amount), "memo": "test"}),
            )
            .await?
            .assert_success();
        let logs = result.logs().into_iter().map(str::to_string).collect();
        Ok((result.json()?, logs))
    }

    async fn view<T: DeserializeOwned + Send + Sync>(
        &self,
        method: &str,
        args: Value,
    ) -> TestResult<T> {
        Ok(self
            .vault
            .call_function(method, args)
            .read_only::<T>()
            .fetch_from(&self.network)
            .await?
            .data)
    }

    async fn receipt(&self, id: u64) -> TestResult<Value> {
        self.view("get_receipt", json!({"receipt_id": id})).await
    }

    async fn balance(&self, id: &AccountId) -> TestResult<NearToken> {
        Ok(Account(id.clone())
            .tokens()
            .near_balance()
            .fetch_from(&self.network)
            .await?
            .total)
    }

    async fn now_ns(&self) -> TestResult<u64> {
        let info: Value = self.view("get_vault", json!({})).await?;
        Ok(ns(&info["block_timestamp_ns"]))
    }

    /// Produce blocks until the chain clock passes `target_ns`, in small
    /// steps so that we do not overshoot budget windows by much.
    async fn advance_past(&self, target_ns: u64) -> TestResult<()> {
        let start = self.now_ns().await?;
        for step in 0..400 {
            let now = self.now_ns().await?;
            if now > target_ns {
                println!(
                    "advanced the sandbox clock by {:.1}s in {step} steps",
                    (now - start) as f64 / NS_PER_SEC as f64
                );
                return Ok(());
            }
            self.sandbox.fast_forward(5).await?;
        }
        Err("sandbox clock did not reach the target".into())
    }

    async fn deposit(&self, from: &AccountId, amount: NearToken) -> TestResult<Vec<String>> {
        let result = self
            .vault
            .call_function("deposit", json!({}))
            .transaction()
            .deposit(amount)
            .with_signer(from.clone(), self.root.clone())
            .send_to(&self.network)
            .await?
            .assert_success();
        Ok(result.logs().into_iter().map(str::to_string).collect())
    }

    async fn add_key_agent(
        &self,
        agent: &AgentKey,
        label: &str,
        policy: Value,
    ) -> TestResult<Vec<String>> {
        let (value, logs) = self
            .call_ok(
                &self.owner,
                "add_agent",
                json!({"agent_id": agent.id(), "label": label, "policy": policy}),
            )
            .await?;
        assert_eq!(
            value,
            json!(true),
            "add_agent returns true once the key is on the account"
        );
        Ok(logs)
    }

    /// Function-call keys currently on the vault account, by public key.
    async fn function_call_keys(
        &self,
    ) -> TestResult<Vec<(PublicKey, Option<NearToken>, String, Vec<String>)>> {
        let keys = Account(self.vault_id().clone())
            .list_keys()
            .fetch_from(&self.network)
            .await?
            .data;
        Ok(keys
            .into_iter()
            .filter_map(|(pk, key)| match key.permission {
                AccessKeyPermission::FunctionCall(p) => {
                    Some((pk, p.allowance, p.receiver_id, p.method_names))
                }
                AccessKeyPermission::FullAccess => None,
            })
            .collect())
    }
}

async fn create_account(sandbox: &Sandbox, name: &str) -> TestResult<AccountId> {
    // near-sandbox and near-api pin different `near-account-id` majors, so the
    // id is parsed once per crate.
    sandbox
        .create_account(name.parse::<near_sdk::AccountId>()?)
        .initial_balance(near(20))
        .send()
        .await?;
    Ok(name.parse()?)
}

fn has_event(logs: &[String], event: &str) -> bool {
    logs.iter()
        .any(|l| l.starts_with("EVENT_JSON:") && l.contains(&format!("\"event\":\"{event}\"")))
}

fn failure_message(result: TransactionResult) -> String {
    match result.into_result() {
        Ok(_) => panic!("expected the transaction to fail"),
        Err(e) => format!("{e:?}"),
    }
}

/// The standard policy of the DESIGN walk-through: cap 1 NEAR, 2 NEAR/day,
/// allowlist [api], human approval above 0.5 NEAR.
fn worker_policy(payee: &AccountId) -> Value {
    policy_json(
        near(1),
        Some((near(2), DAY_NS)),
        &[payee],
        Some(millinear(500)),
        0,
    )
}

// ----------------------------------------------------------------------
// 1. fund -> add agent -> pay with the function-call key -> verify -> confirm
// ----------------------------------------------------------------------

#[tokio::test]
async fn fund_add_agent_and_pay_with_the_function_call_key() -> TestResult<()> {
    let env = Env::new().await?;

    // Fund: anyone may deposit, the deposit is receipt #0.
    let logs = env.deposit(&env.owner, near(5)).await?;
    assert!(has_event(&logs, "vault_funded"));
    let info: Value = env.view("get_vault", json!({})).await?;
    assert_eq!(info["owner_id"], json!(env.owner));
    assert_eq!(info["next_receipt_id"], json!(1));
    assert!(
        token(&info["available"]) > near(20),
        "20 NEAR initial + 5 deposited - storage"
    );

    // Register the agent: the vault adds the key to its own account.
    let agent = AgentKey::generate()?;
    let logs = env
        .add_key_agent(&agent, "worker", worker_policy(&env.payee))
        .await?;
    assert!(has_event(&logs, "agent_added"));
    assert!(has_event(&logs, "policy_set"));
    let keys = env.function_call_keys().await?;
    let (_, allowance, receiver, methods) = keys
        .iter()
        .find(|(pk, ..)| pk == &agent.public_key)
        .expect("agent key is on the vault account");
    assert_eq!(receiver, env.vault_id().as_str());
    assert_eq!(methods, &["pay", "confirm_delivery", "ping"]);
    assert_eq!(
        *allowance,
        Some(near(1)),
        "gas allowance, not a spending limit"
    );

    // The agent checks its identity and dry-runs the payment for free.
    let pong: Value = env
        .agent_call(&agent, "ping", json!({}))
        .await?
        .assert_success()
        .json()?;
    assert_eq!(pong["registered"], json!(true));
    assert_eq!(pong["agent"], agent.id());
    assert_eq!(pong["label"], json!("worker"));
    let sim: Value = env
        .view(
            "simulate",
            json!({"agent_id": agent.id(), "payee": env.payee, "amount": yocto(millinear(20))}),
        )
        .await?;
    assert_eq!(sim["verdict"], json!("allow"));
    assert_eq!(sim["reason"], Value::Null);
    assert_eq!(token(&sim["remaining_budget"]), near(2));

    // Pay 0.02 NEAR with a request hash (sha256 of the request it pays for).
    let request_hash = near_sdk::base64::engine::general_purpose::STANDARD.encode([42u8; 32]);
    let payee_before = env.balance(&env.payee).await?;
    let result = env
        .agent_call(
            &agent,
            "pay",
            json!({"payee": env.payee, "amount": yocto(millinear(20)), "memo": "GET /v1/quote", "request_hash": request_hash}),
        )
        .await?
        .assert_success();
    let outcome: Value = result.json()?;
    assert_eq!(outcome, json!({"outcome": "paid", "receipt_id": 1}));
    let logs: Vec<String> = result.logs().into_iter().map(str::to_string).collect();
    assert!(has_event(&logs, "payment_paid"));
    assert_eq!(
        env.balance(&env.payee).await?,
        payee_before.saturating_add(millinear(20)),
        "the payee receives exactly the amount; gas is paid by the vault"
    );

    // Receipt and payee-side verification.
    let receipt = env.receipt(1).await?;
    assert_eq!(receipt["status"], json!({"status": "paid"}));
    assert_eq!(receipt["agent"], agent.id());
    assert_eq!(receipt["kind"], json!("pay"));
    assert_eq!(receipt["policy_version"], json!(1));
    assert_eq!(receipt["request_hash"], json!(request_hash));
    let verify = |payee: &AccountId, min: NearToken, hash: Option<&str>| {
        env.view::<bool>(
            "verify_receipt",
            json!({"receipt_id": 1, "payee": payee, "min_amount": yocto(min), "request_hash": hash}),
        )
    };
    assert!(verify(&env.payee, millinear(20), Some(&request_hash)).await?);
    assert!(verify(&env.payee, millinear(20), None).await?);
    assert!(
        !verify(&env.payee, millinear(21), None).await?,
        "too little"
    );
    assert!(
        !verify(&env.owner, millinear(20), None).await?,
        "wrong payee"
    );
    let other_hash = near_sdk::base64::engine::general_purpose::STANDARD.encode([1u8; 32]);
    assert!(
        !verify(&env.payee, millinear(20), Some(&other_hash)).await?,
        "wrong request"
    );
    assert!(
        !env.view::<bool>(
            "verify_receipt",
            json!({"receipt_id": 99, "payee": env.payee, "min_amount": "0"})
        )
        .await?
    );

    // The agent records its verdict on what it bought.
    let result = env
        .agent_call(
            &agent,
            "confirm_delivery",
            json!({"receipt_id": 1, "passed": true}),
        )
        .await?
        .assert_success();
    assert!(has_event(
        &result
            .logs()
            .into_iter()
            .map(str::to_string)
            .collect::<Vec<_>>(),
        "delivery_confirmed"
    ));
    assert_eq!(env.receipt(1).await?["delivered"], json!(true));

    // Budget bookkeeping.
    let view: Value = env
        .view("get_agent", json!({"agent_id": agent.id()}))
        .await?;
    assert_eq!(token(&view["state"]["spent_in_window"]), millinear(20));
    assert_eq!(view["state"]["payments"], json!(1));
    assert_eq!(token(&view["remaining_budget"]), millinear(1980));

    // Owner withdraws part of the funds; the storage reserve stays.
    let (_, logs) = env
        .call_ok(&env.owner, "withdraw", json!({"amount": yocto(near(1))}))
        .await?;
    assert!(has_event(&logs, "withdrawn"));
    assert_eq!(env.receipt(2).await?["kind"], json!("refund"));
    let too_much = failure_message(
        env.call(&env.owner, "withdraw", json!({"amount": yocto(near(1000))}))
            .await?,
    );
    assert!(
        too_much.contains("exceeds the balance available"),
        "{too_much}"
    );
    Ok(())
}

// ----------------------------------------------------------------------
// 2. policy rejections: receipts written, no funds moved
// ----------------------------------------------------------------------

#[tokio::test]
async fn rejected_payments_leave_a_receipt_and_move_nothing() -> TestResult<()> {
    let env = Env::new().await?;
    env.deposit(&env.owner, near(5)).await?;
    let agent = AgentKey::generate()?;
    env.add_key_agent(&agent, "worker", worker_policy(&env.payee))
        .await?;
    let attacker = create_account(&env.sandbox, "attacker.sandbox").await?;
    let attacker_before = env.balance(&attacker).await?;

    // A prompt-injected "send 2 NEAR to attacker": the free dry-run says block...
    let sim: Value = env
        .view(
            "simulate",
            json!({"agent_id": agent.id(), "payee": attacker, "amount": yocto(near(2))}),
        )
        .await?;
    assert_eq!(sim["verdict"], json!("block"));
    assert_eq!(
        sim["reason"],
        json!({"code": "not_allowlisted", "payee": attacker})
    );

    // ...and a forced call is refused on-chain with a receipt and an event.
    let (outcome, logs) = env.agent_pay(&agent, &attacker, near(2)).await?;
    assert_eq!(
        outcome,
        json!({"outcome": "rejected", "receipt_id": 1, "reason": {"code": "not_allowlisted", "payee": attacker}})
    );
    assert!(has_event(&logs, "payment_rejected"));
    assert!(!has_event(&logs, "payment_paid"));
    assert_eq!(env.balance(&attacker).await?, attacker_before);
    assert_eq!(env.receipt(1).await?["status"]["status"], json!("rejected"));

    // Over the per-transaction cap, even to an allowlisted payee.
    let (outcome, _) = env.agent_pay(&agent, &env.payee, millinear(1500)).await?;
    assert_eq!(outcome["outcome"], json!("rejected"));
    assert_eq!(outcome["reason"]["code"], json!("over_per_tx_cap"));
    assert_eq!(token(&outcome["reason"]["cap"]), near(1));

    // Vault-wide denylist beats the allowlist.
    env.call_ok(&env.owner, "set_denylist", json!({"accounts": [env.payee]}))
        .await?;
    let (outcome, _) = env.agent_pay(&agent, &env.payee, millinear(10)).await?;
    assert_eq!(outcome["reason"]["code"], json!("denylisted"));
    env.call_ok(&env.owner, "set_denylist", json!({"accounts": []}))
        .await?;

    // A transfer that fails at the protocol level (payee does not exist)
    // settles as `failed` and gives the budget back.
    let ghost: AccountId = "ghost.sandbox".parse()?;
    let mut policy = worker_policy(&env.payee);
    policy["allow"]["list"]
        .as_array_mut()
        .unwrap()
        .push(json!({"account_id": ghost}));
    env.call_ok(
        &env.owner,
        "set_policy",
        json!({"agent_id": agent.id(), "policy": policy}),
    )
    .await?;
    let (outcome, logs) = env.agent_pay(&agent, &ghost, millinear(30)).await?;
    assert_eq!(outcome, json!({"outcome": "failed", "receipt_id": 4}));
    assert!(has_event(&logs, "payment_failed"));
    assert_eq!(env.receipt(4).await?["status"], json!({"status": "failed"}));
    let state: Value = env
        .view("get_agent_state", json!({"agent_id": agent.id()}))
        .await?;
    assert_eq!(
        token(&state["spent_in_window"]),
        near(0),
        "reservation released"
    );
    assert_eq!(env.receipt(4).await?["policy_version"], json!(2));

    // Nothing was ever reserved for the rejected payments.
    let (outcome, _) = env.agent_pay(&agent, &env.payee, millinear(500)).await?;
    assert_eq!(outcome["outcome"], json!("paid"));
    Ok(())
}

// ----------------------------------------------------------------------
// 3. budget window rollover and cooldown on a live chain clock
// ----------------------------------------------------------------------

#[tokio::test]
async fn budget_window_rolls_over_and_cooldown_is_enforced() -> TestResult<()> {
    let env = Env::new().await?;
    env.deposit(&env.owner, near(5)).await?;
    let agent = AgentKey::generate()?;
    let period_ns = 120 * NS_PER_SEC;
    let cooldown_ns = 5 * NS_PER_SEC;
    env.add_key_agent(
        &agent,
        "metered",
        policy_json(
            millinear(100),
            Some((millinear(100), period_ns)),
            &[&env.payee],
            None,
            cooldown_ns,
        ),
    )
    .await?;

    let (outcome, _) = env.agent_pay(&agent, &env.payee, millinear(100)).await?;
    assert_eq!(outcome["outcome"], json!("paid"));

    // Immediately again: the cooldown fires before the budget is looked at.
    let (outcome, _) = env.agent_pay(&agent, &env.payee, millinear(10)).await?;
    assert_eq!(outcome["reason"]["code"], json!("cooldown"));
    let retry_at = ns(&outcome["reason"]["retry_at_ns"]);
    env.advance_past(retry_at).await?;

    // After the cooldown the window budget is exhausted.
    let (outcome, _) = env.agent_pay(&agent, &env.payee, millinear(10)).await?;
    assert_eq!(outcome["reason"]["code"], json!("over_budget"));
    assert_eq!(token(&outcome["reason"]["remaining"]), near(0));
    let resets_at = ns(&outcome["reason"]["resets_at_ns"]);

    // Once the fixed window rolls over the agent may spend again.
    env.advance_past(resets_at).await?;
    let (outcome, _) = env.agent_pay(&agent, &env.payee, millinear(10)).await?;
    assert_eq!(outcome["outcome"], json!("paid"), "{outcome}");
    let view: Value = env
        .view("get_agent", json!({"agent_id": agent.id()}))
        .await?;
    assert_eq!(token(&view["state"]["spent_in_window"]), millinear(10));
    assert_eq!(view["state"]["payments"], json!(2));
    Ok(())
}

// ----------------------------------------------------------------------
// 4. approval queue: needs-approval -> approve / deny / expire
// ----------------------------------------------------------------------

#[tokio::test]
async fn large_payments_wait_for_a_human() -> TestResult<()> {
    let env = Env::with_approval_ttl(40 * NS_PER_SEC).await?;
    env.deposit(&env.owner, near(5)).await?;
    let agent = AgentKey::generate()?;
    env.add_key_agent(&agent, "worker", worker_policy(&env.payee))
        .await?;
    let payee_before = env.balance(&env.payee).await?;

    // 0.8 NEAR is above the 0.5 threshold: queued, nothing moves.
    let sim: Value = env
        .view(
            "simulate",
            json!({"agent_id": agent.id(), "payee": env.payee, "amount": yocto(millinear(800))}),
        )
        .await?;
    assert_eq!(sim["verdict"], json!("needs_approval"));
    let (outcome, logs) = env.agent_pay(&agent, &env.payee, millinear(800)).await?;
    assert_eq!(outcome["outcome"], json!("needs_approval"));
    assert_eq!(outcome["pending_id"], json!(0));
    assert_eq!(outcome["receipt_id"], json!(1));
    assert!(has_event(&logs, "approval_requested"));
    let pending: Vec<Value> = env.view("get_pending", json!({})).await?;
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0]["agent"], agent.id());
    assert_eq!(env.balance(&env.payee).await?, payee_before);

    // Strangers cannot approve (contract rule); the agent key cannot even
    // reach `approve` (protocol rule: method not in the key's list).
    let stranger = create_account(&env.sandbox, "mallory.sandbox").await?;
    let msg = failure_message(
        env.call(&stranger, "approve", json!({"pending_id": 0}))
            .await?,
    );
    assert!(msg.contains("only the owner or the approver"), "{msg}");
    assert!(
        env.agent_call(&agent, "approve", json!({"pending_id": 0}))
            .await
            .is_err()
    );
    let refusal = env
        .protocol_error(&agent, "approve", json!({"pending_id": 0}), near(0), None)
        .await?;
    assert!(
        refusal.to_string().contains("MethodNameMismatch"),
        "{refusal}"
    );

    // The second approver releases it: policy re-checked, transfer done.
    let (outcome, logs) = env
        .call_ok(&env.approver, "approve", json!({"pending_id": 0}))
        .await?;
    assert_eq!(outcome, json!({"outcome": "paid", "receipt_id": 1}));
    assert!(has_event(&logs, "approval_granted"));
    assert!(has_event(&logs, "payment_paid"));
    assert_eq!(
        env.balance(&env.payee).await?,
        payee_before.saturating_add(millinear(800))
    );
    let receipt = env.receipt(1).await?;
    assert_eq!(receipt["status"], json!({"status": "paid"}));
    assert_eq!(receipt["approved_by"], json!(env.approver));
    assert_eq!(receipt["pending_id"], json!(0));

    // Deny.
    let (outcome, _) = env.agent_pay(&agent, &env.payee, millinear(700)).await?;
    assert_eq!(outcome["pending_id"], json!(1));
    let (_, logs) = env
        .call_ok(&env.owner, "deny", json!({"pending_id": 1}))
        .await?;
    assert!(has_event(&logs, "approval_denied"));
    assert_eq!(env.receipt(2).await?["status"], json!({"status": "denied"}));

    // Expiry: after the TTL the request can be swept by anyone, and a late
    // approve marks it expired instead of paying.
    let (outcome, _) = env.agent_pay(&agent, &env.payee, millinear(600)).await?;
    assert_eq!(outcome["pending_id"], json!(2));
    let (outcome, _) = env.agent_pay(&agent, &env.payee, millinear(600)).await?;
    assert_eq!(outcome["pending_id"], json!(3));
    let expires_at = ns(&outcome["expires_at_ns"]);
    let msg = failure_message(
        env.call(&stranger, "expire_pending", json!({"pending_id": 2}))
            .await?,
    );
    assert!(msg.contains("has not expired yet"), "{msg}");
    env.advance_past(expires_at).await?;
    let (swept, logs) = env
        .call_ok(&stranger, "expire_pending", json!({"pending_id": 2}))
        .await?;
    assert_eq!(swept, json!(true));
    assert!(has_event(&logs, "approval_expired"));
    let (outcome, _) = env
        .call_ok(&env.owner, "approve", json!({"pending_id": 3}))
        .await?;
    assert_eq!(
        outcome,
        json!({"outcome": "expired", "receipt_id": 4, "pending_id": 3})
    );
    assert_eq!(
        env.receipt(3).await?["status"],
        json!({"status": "expired"})
    );
    assert_eq!(
        env.receipt(4).await?["status"],
        json!({"status": "expired"})
    );
    let pending: Vec<Value> = env.view("get_pending", json!({})).await?;
    assert!(pending.is_empty());
    assert_eq!(
        env.balance(&env.payee).await?,
        payee_before.saturating_add(millinear(800))
    );

    // Approval re-evaluates the policy: a paused vault rejects at approve time.
    let (outcome, _) = env.agent_pay(&agent, &env.payee, millinear(600)).await?;
    assert_eq!(outcome["pending_id"], json!(4));
    env.call_ok(&env.owner, "pause", json!({})).await?;
    let (outcome, _) = env
        .call_ok(&env.owner, "approve", json!({"pending_id": 4}))
        .await?;
    assert_eq!(outcome["outcome"], json!("rejected"));
    assert_eq!(outcome["reason"], json!({"code": "paused"}));
    Ok(())
}

// ----------------------------------------------------------------------
// 5. kill switch: keys deleted, next agent call fails at the protocol level
// ----------------------------------------------------------------------

#[tokio::test]
async fn kill_deletes_the_keys_and_the_protocol_rejects_the_agent() -> TestResult<()> {
    let env = Env::new().await?;
    env.deposit(&env.owner, near(5)).await?;
    let worker = AgentKey::generate()?;
    let scout = AgentKey::generate()?;
    env.add_key_agent(&worker, "worker", worker_policy(&env.payee))
        .await?;
    env.add_key_agent(&scout, "scout", worker_policy(&env.payee))
        .await?;
    assert_eq!(env.function_call_keys().await?.len(), 2);
    let (outcome, _) = env.agent_pay(&worker, &env.payee, millinear(10)).await?;
    assert_eq!(outcome["outcome"], json!("paid"));
    // A queued payment is waiting too.
    let (outcome, _) = env.agent_pay(&scout, &env.payee, millinear(900)).await?;
    assert_eq!(outcome["outcome"], json!("needs_approval"));
    let receipts_before =
        env.view::<Value>("get_vault", json!({})).await?["next_receipt_id"].clone();

    // Kill.
    let (removed, logs) = env.call_ok(&env.owner, "kill", json!({})).await?;
    assert_eq!(removed.as_array().map(Vec::len), Some(2));
    assert!(has_event(&logs, "vault_killed"));
    assert!(has_event(&logs, "approval_denied"));
    let info: Value = env.view("get_vault", json!({})).await?;
    assert_eq!(info["paused"], json!(true));
    assert_eq!(info["agents"], json!(0));
    assert_eq!(info["pending"], json!(0));
    assert!(
        env.function_call_keys().await?.is_empty(),
        "every agent key is gone"
    );
    assert_eq!(env.receipt(2).await?["status"], json!({"status": "denied"}));
    // History survives.
    assert_eq!(env.receipt(1).await?["status"], json!({"status": "paid"}));

    // The agent's next transaction never reaches the contract: the key does
    // not exist, so the network refuses to even take the transaction.
    let pay_args = json!({"payee": env.payee, "amount": yocto(millinear(10))});
    let err = env
        .agent_call(&worker, "pay", pay_args.clone())
        .await
        .expect_err("a deleted key cannot sign");
    let text = format!("{err:?}");
    assert!(
        text.contains("does not exist"),
        "nonce lookup fails for a deleted key: {text}"
    );
    // Even a transaction signed offline is thrown out by the network.
    let refusal = env
        .protocol_error(&worker, "pay", pay_args, near(0), Some(1))
        .await?;
    assert!(
        refusal.to_string().contains("AccessKeyNotFound"),
        "{refusal}"
    );
    let info: Value = env.view("get_vault", json!({})).await?;
    assert_eq!(
        info["next_receipt_id"], receipts_before,
        "no receipt was written"
    );

    // Re-arming after an incident: unpause and register the key again.
    env.call_ok(&env.owner, "unpause", json!({})).await?;
    env.add_key_agent(&worker, "worker-v2", worker_policy(&env.payee))
        .await?;
    let (outcome, _) = env.agent_pay(&worker, &env.payee, millinear(10)).await?;
    assert_eq!(outcome["outcome"], json!("paid"));
    Ok(())
}

// ----------------------------------------------------------------------
// 6. what the protocol itself enforces on an agent key
// ----------------------------------------------------------------------

#[tokio::test]
async fn the_function_call_key_is_boxed_in_by_the_protocol() -> TestResult<()> {
    let env = Env::new().await?;
    env.deposit(&env.owner, near(5)).await?;
    let agent = AgentKey::generate()?;
    env.add_key_agent(&agent, "worker", worker_policy(&env.payee))
        .await?;

    // Owner-only methods are not in the key's method list.
    for method in [
        "pause",
        "withdraw",
        "add_agent",
        "approve",
        "kill",
        "set_policy",
    ] {
        assert!(
            env.agent_call(&agent, method, json!({})).await.is_err(),
            "{method}"
        );
        let refusal = env
            .protocol_error(&agent, method, json!({}), near(0), None)
            .await?;
        assert!(
            refusal.to_string().contains("MethodNameMismatch"),
            "{method}: {refusal}"
        );
    }

    // A function-call key cannot attach a deposit, so an agent can never
    // smuggle value into a call.
    let pay_args = json!({"payee": env.payee, "amount": yocto(millinear(10))});
    let refusal = env
        .protocol_error(&agent, "pay", pay_args, NearToken::from_yoctonear(1), None)
        .await?;
    assert!(
        refusal.to_string().contains("DepositWithFunctionCall"),
        "{refusal}"
    );

    // The owner can refresh the gas allowance (delete + re-add in one batch).
    env.call_ok(
        &env.owner,
        "top_up_allowance",
        json!({"public_key": agent.public_key.to_string(), "allowance": yocto(near(2))}),
    )
    .await?;
    let keys = env.function_call_keys().await?;
    assert_eq!(keys.len(), 1);
    assert_eq!(keys[0].1, Some(near(2)));
    assert_eq!(keys[0].3, ["pay", "confirm_delivery", "ping"]);
    let (outcome, _) = env.agent_pay(&agent, &env.payee, millinear(10)).await?;
    assert_eq!(outcome["outcome"], json!("paid"));

    // Removing the agent deletes the key in the same transaction.
    let (_, logs) = env
        .call_ok(&env.owner, "remove_agent", json!({"agent_id": agent.id()}))
        .await?;
    assert!(has_event(&logs, "agent_removed"));
    assert!(env.function_call_keys().await?.is_empty());
    assert!(env.agent_call(&agent, "ping", json!({})).await.is_err());

    // Registering a key that is already on the account rolls back cleanly:
    // the owner's genesis key is a full-access key on the vault.
    let genesis_pk: PublicKey = near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PUBLIC_KEY.parse()?;
    let (value, _) = env
        .call_ok(
            &env.owner,
            "add_agent",
            json!({"agent_id": {"key": genesis_pk.to_string()}, "label": "dup", "policy": worker_policy(&env.payee)}),
        )
        .await?;
    assert_eq!(value, json!(false), "AddKey refused, agent not registered");
    let info: Value = env.view("get_vault", json!({})).await?;
    assert_eq!(info["agents"], json!(0));
    Ok(())
}

// ----------------------------------------------------------------------
// 7. agents that already own an account
// ----------------------------------------------------------------------

#[tokio::test]
async fn account_based_agents_pay_from_their_own_account() -> TestResult<()> {
    let env = Env::new().await?;
    env.deposit(&env.owner, near(5)).await?;
    let bot = create_account(&env.sandbox, "bot.sandbox").await?;
    let (value, logs) = env
        .call_ok(
            &env.owner,
            "add_agent",
            json!({"agent_id": {"account": bot}, "label": "bot", "policy": worker_policy(&env.payee)}),
        )
        .await?;
    assert_eq!(value, json!(true));
    assert!(has_event(&logs, "agent_added"));
    assert!(
        env.function_call_keys().await?.is_empty(),
        "no key is added for account agents"
    );

    let (outcome, _) = env
        .call_ok(
            &bot,
            "pay",
            json!({"payee": env.payee, "amount": yocto(millinear(10))}),
        )
        .await?;
    assert_eq!(outcome, json!({"outcome": "paid", "receipt_id": 1}));
    assert_eq!(env.receipt(1).await?["agent"], json!({"account": bot}));

    // A stranger with an account is not an agent and writes no receipt.
    let stranger = create_account(&env.sandbox, "stranger.sandbox").await?;
    let msg = failure_message(
        env.call(
            &stranger,
            "pay",
            json!({"payee": env.payee, "amount": yocto(millinear(10))}),
        )
        .await?,
    );
    assert!(msg.contains("unknown agent"), "{msg}");
    let info: Value = env.view("get_vault", json!({})).await?;
    assert_eq!(info["next_receipt_id"], json!(2));
    Ok(())
}
