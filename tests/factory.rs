//! The vault factory on neard-sandbox: the vault code is published once as a
//! global contract (by code hash), the factory creates two vaults that use
//! it, each pays from its own budget, and nothing leaks between them.

use std::sync::{Arc, OnceLock};

use near_api::signer::generate_secret_key;
use near_api::types::AccessKeyPermission;
use near_api::types::account::ContractState;
use near_api::{
    Account, AccountId, Contract, CryptoHash, NearGas, NearToken, NetworkConfig, PublicKey, Signer,
};
use near_sandbox::Sandbox;
use near_sdk::serde_json::{Value, json};
use testresult::TestResult;

fn build(manifest: Option<&str>) -> Vec<u8> {
    let opts = cargo_near_build::BuildOpts {
        manifest_path: manifest.map(Into::into),
        no_abi: manifest.is_some(),
        ..Default::default()
    };
    let path = cargo_near_build::build_with_cli(opts).expect("cargo near build failed");
    std::fs::read(path).expect("read wasm")
}

fn vault_wasm() -> &'static [u8] {
    static WASM: OnceLock<Vec<u8>> = OnceLock::new();
    WASM.get_or_init(|| build(None))
}

fn factory_wasm() -> &'static [u8] {
    static WASM: OnceLock<Vec<u8>> = OnceLock::new();
    WASM.get_or_init(|| {
        build(Some(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/factory/Cargo.toml"
        )))
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

struct Env {
    sandbox: Sandbox,
    network: NetworkConfig,
    root: Arc<Signer>,
}

impl Env {
    async fn account(&self, name: &str, balance: NearToken) -> TestResult<AccountId> {
        self.sandbox
            .create_account(name.parse::<near_sdk::AccountId>()?)
            .initial_balance(balance)
            .send()
            .await?;
        Ok(name.parse()?)
    }

    /// Signed by `signer`'s genesis key; returns (final value, logs, success).
    async fn call(
        &self,
        signer: &AccountId,
        contract: &AccountId,
        method: &str,
        args: Value,
        deposit: NearToken,
    ) -> TestResult<(Value, Vec<String>, bool)> {
        let result = Contract(contract.clone())
            .call_function(method, args)
            .transaction()
            .deposit(deposit)
            .gas(NearGas::from_tgas(150))
            .with_signer(signer.clone(), self.root.clone())
            .send_to(&self.network)
            .await?;
        let logs = result.logs().into_iter().map(str::to_string).collect();
        Ok(match result.into_result() {
            Ok(success) => (success.json().unwrap_or(Value::Null), logs, true),
            Err(err) => (Value::String(format!("{err:?}")), logs, false),
        })
    }

    async fn view(&self, contract: &AccountId, method: &str, args: Value) -> TestResult<Value> {
        Ok(Contract(contract.clone())
            .call_function(method, args)
            .read_only::<Value>()
            .fetch_from(&self.network)
            .await?
            .data)
    }

    async fn balance(&self, id: &AccountId) -> TestResult<NearToken> {
        Ok(Account(id.clone())
            .tokens()
            .near_balance()
            .fetch_from(&self.network)
            .await?
            .total)
    }
}

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
}

/// `pay` signed by an agent key as `vault`; `Err` carries near-api's error.
async fn agent_pay(
    env: &Env,
    agent: &AgentKey,
    vault: &AccountId,
    payee: &AccountId,
    amount: NearToken,
) -> Result<Value, String> {
    let result = Contract(vault.clone())
        .call_function("pay", json!({"payee": payee, "amount": yocto(amount)}))
        .transaction()
        .with_signer(vault.clone(), agent.signer.clone())
        .send_to(&env.network)
        .await
        .map_err(|e| format!("{e:?}"))?;
    result
        .into_result()
        .map_err(|e| format!("{e:?}"))?
        .json::<Value>()
        .map_err(|e| format!("{e:?}"))
}

#[tokio::test]
async fn factory_creates_isolated_vaults_on_one_global_contract() -> TestResult<()> {
    let sandbox = Sandbox::start_sandbox().await?;
    let network = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
    let root = Signer::from_secret_key(
        near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?,
    )?;
    let env = Env {
        sandbox,
        network,
        root,
    };

    // Publish the vault code once, by hash (immutable; 10x storage, burned).
    let publisher = env.account("publisher.sandbox", near(100)).await?;
    let before = env.balance(&publisher).await?;
    Contract::deploy_global_contract_code(vault_wasm().to_vec())
        .as_hash()
        .with_signer(publisher.clone(), env.root.clone())
        .send_to(&env.network)
        .await?
        .assert_success();
    let burned = before.saturating_sub(env.balance(&publisher).await?);
    let code_hash = CryptoHash::hash(vault_wasm()).to_string();
    println!(
        "published {} bytes as a global contract {code_hash}: {burned} burned",
        vault_wasm().len()
    );
    assert!(burned > near(30), "global code costs 10x storage, burned");

    // The factory points at that hash.
    let factory_owner = env.account("factory-owner.sandbox", near(10)).await?;
    let factory = env.account("factory.sandbox", near(10)).await?;
    Contract::deploy(factory.clone())
        .use_code(factory_wasm().to_vec())
        .with_init_call(
            "new",
            json!({"owner_id": factory_owner, "vault_code_hash": code_hash}),
        )?
        .with_signer(env.root.clone())
        .send_to(&env.network)
        .await?
        .assert_success();

    let alice = env.account("alice.sandbox", near(20)).await?;
    let bob = env.account("bob.sandbox", near(20)).await?;
    let payee = env.account("api.sandbox", near(5)).await?;

    // Two vaults, two owners.
    let mut vaults = Vec::new();
    for (owner, name) in [(&alice, "alice"), (&bob, "bob")] {
        let (value, logs, ok) = env
            .call(
                owner,
                &factory,
                "create_vault",
                json!({"name": name}),
                near(3),
            )
            .await?;
        assert!(ok && value == json!(true), "{value}");
        assert!(logs.iter().any(|l| l.contains("vault_created")));
        let vault: AccountId = format!("{name}.factory.sandbox").parse()?;
        let account = Account(vault.clone())
            .view()
            .fetch_from(&env.network)
            .await?
            .data;
        assert_eq!(
            account.contract_state,
            ContractState::GlobalHash(CryptoHash::hash(vault_wasm())),
            "the vault runs the global code"
        );
        // What a payee sees over plain JSON-RPC (the SDK's ReceiptVerifier
        // trusts vaults by code hash).
        let raw: Value = reqwest::Client::new()
            .post(&env.sandbox.rpc_addr)
            .json(&json!({"jsonrpc": "2.0", "id": "t", "method": "query", "params": {"request_type": "view_account", "finality": "final", "account_id": vault}}))
            .send()
            .await?
            .json()
            .await?;
        println!("view_account {vault}: {}", raw["result"]);
        assert_eq!(raw["result"]["global_contract_hash"], json!(code_hash));
        println!(
            "{vault}: storage {} bytes (code not counted)",
            account.storage_usage
        );
        assert!(
            account.storage_usage < 2_000,
            "a vault stores a reference to the code, not the code"
        );
        let keys = Account(vault.clone())
            .list_keys()
            .fetch_from(&env.network)
            .await?
            .data;
        assert!(keys.is_empty(), "no access key: managed by owner_id only");
        let info = env.view(&vault, "get_vault", json!({})).await?;
        assert_eq!(info["owner_id"], json!(owner));
        vaults.push((owner.clone(), vault));
    }
    let listed = env.view(&factory, "get_vaults", json!({})).await?;
    assert_eq!(listed.as_array().map(Vec::len), Some(2));

    // Each owner funds its vault and registers its own agent key.
    let policy = json!({
        "per_tx_cap": yocto(near(1)),
        "budget": {"amount": yocto(millinear(300)), "period_ns": (86_400u64 * 1_000_000_000).to_string()},
        "allow": {"list": [{"account_id": payee}]},
    });
    let mut agents = Vec::new();
    for (owner, vault) in &vaults {
        let (_, _, ok) = env
            .call(owner, vault, "deposit", json!({}), near(1))
            .await?;
        assert!(ok);
        let agent = AgentKey::generate()?;
        let (value, _, ok) = env
            .call(
                owner,
                vault,
                "add_agent",
                json!({"agent_id": {"key": agent.public_key.to_string()}, "label": "worker", "policy": policy}),
                NearToken::from_yoctonear(0),
            )
            .await?;
        assert!(ok && value == json!(true), "{value}");
        let keys = Account(vault.clone())
            .list_keys()
            .fetch_from(&env.network)
            .await?
            .data;
        assert!(matches!(
            keys.iter()
                .find(|(pk, _)| pk == &agent.public_key)
                .map(|(_, k)| &k.permission),
            Some(AccessKeyPermission::FunctionCall(_))
        ));
        agents.push(agent);
    }
    let (alice_vault, bob_vault) = (&vaults[0].1, &vaults[1].1);

    // Each agent pays from its own vault.
    let payee_before = env.balance(&payee).await?;
    let paid_a = agent_pay(&env, &agents[0], alice_vault, &payee, millinear(100)).await?;
    let paid_b = agent_pay(&env, &agents[1], bob_vault, &payee, millinear(200)).await?;
    assert_eq!(paid_a["outcome"], json!("paid"));
    assert_eq!(paid_b["outcome"], json!("paid"));
    assert_eq!(
        env.balance(&payee).await?,
        payee_before.saturating_add(millinear(300))
    );

    // Isolation: a key of one vault means nothing on the other...
    let cross = agent_pay(&env, &agents[0], bob_vault, &payee, millinear(1)).await;
    assert!(
        cross.is_err(),
        "alice's agent key does not exist on bob's vault: {cross:?}"
    );
    let sim = env
        .view(
            bob_vault,
            "simulate",
            json!({"agent_id": {"key": agents[0].public_key.to_string()}, "payee": payee, "amount": yocto(millinear(1))}),
        )
        .await?;
    assert_eq!(sim["reason"], json!({"code": "unknown_agent"}));
    // ...an owner cannot touch the other vault...
    let (msg, _, ok) = env
        .call(
            &alice,
            bob_vault,
            "pause",
            json!({}),
            NearToken::from_yoctonear(0),
        )
        .await?;
    assert!(!ok && msg.to_string().contains("only the owner"), "{msg}");
    // ...budgets and receipts are separate...
    let a_state = env
        .view(
            alice_vault,
            "get_agent_state",
            json!({"agent_id": {"key": agents[0].public_key.to_string()}}),
        )
        .await?;
    let b_state = env
        .view(
            bob_vault,
            "get_agent_state",
            json!({"agent_id": {"key": agents[1].public_key.to_string()}}),
        )
        .await?;
    assert_eq!(a_state["spent_in_window"], json!(yocto(millinear(100))));
    assert_eq!(b_state["spent_in_window"], json!(yocto(millinear(200))));
    let a_receipts = env.view(alice_vault, "get_receipts", json!({})).await?;
    let b_receipts = env.view(bob_vault, "get_receipts", json!({})).await?;
    assert_eq!(a_receipts[1]["amount"], json!(yocto(millinear(100))));
    assert_eq!(b_receipts[1]["amount"], json!(yocto(millinear(200))));
    // ...and killing one vault leaves the other running.
    let (_, _, ok) = env
        .call(
            &alice,
            alice_vault,
            "kill",
            json!({}),
            NearToken::from_yoctonear(0),
        )
        .await?;
    assert!(ok);
    assert!(
        agent_pay(&env, &agents[0], alice_vault, &payee, millinear(1))
            .await
            .is_err()
    );
    let again = agent_pay(&env, &agents[1], bob_vault, &payee, millinear(50)).await?;
    assert_eq!(again["outcome"], json!("paid"));

    // A failed creation (here the vault's `new` panics) is rolled back and
    // the caller gets the deposit back; a taken name is refused up front.
    let bob_before = env.balance(&bob).await?;
    let (value, logs, ok) = env
        .call(
            &bob,
            &factory,
            "create_vault",
            json!({"name": "broken", "approval_ttl_ns": "0"}),
            near(3),
        )
        .await?;
    assert!(ok && value == json!(false), "{value}");
    assert!(logs.iter().any(|l| l.contains("vault_creation_failed")));
    let spent = bob_before.saturating_sub(env.balance(&bob).await?);
    assert!(
        spent < millinear(50),
        "deposit refunded, only gas spent ({spent})"
    );
    let (msg, _, ok) = env
        .call(
            &bob,
            &factory,
            "create_vault",
            json!({"name": "alice"}),
            near(3),
        )
        .await?;
    assert!(!ok && msg.to_string().contains("already exists"), "{msg}");
    Ok(())
}
