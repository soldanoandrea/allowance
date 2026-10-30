//! Allowance vault factory.
//!
//! The vault code is published once as a NEAR **global contract** identified
//! by its code hash (NEP-591, `DeployGlobalContract` in hash mode: immutable,
//! the publisher pays the storage once, burned). `create_vault` then creates
//! `<name>.<factory>` in one batch: `CreateAccount`, `Transfer` (the caller's
//! deposit), `UseGlobalContract(code_hash)` and the vault's `new` call. Each
//! vault stores only a reference to the code, so a new vault costs the
//! storage of its own state (well under 0.01 NEAR) instead of ~3.6 NEAR for a
//! private copy of the wasm.
//!
//! The created account has **no access key**: it is managed only by its
//! `owner_id` through the vault's owner methods ("lock mode"), and agent
//! keys are added by the vault itself. A vault created here reports the
//! global code hash in `view_account.code_hash`, so payees that trust "any
//! vault running this Allowance build" (by code hash) accept its receipts.

use near_sdk::json_types::{Base58CryptoHash, U64};
use near_sdk::store::IterableMap;
use near_sdk::{
    AccountId, BorshStorageKey, CryptoHash, Gas, NearToken, PanicOnDefault, Promise, PromiseError,
    env, near, require, serde_json,
};

/// Gas for the vault's `new` inside the creation batch.
const GAS_FOR_VAULT_INIT: Gas = Gas::from_tgas(20);
const GAS_FOR_CALLBACK: Gas = Gas::from_tgas(10);
/// Default smallest deposit for a new vault (it pays its own state storage
/// and the first receipts; the owner deposits the real budget later).
pub const DEFAULT_MIN_DEPOSIT: NearToken = NearToken::from_millinear(100);
const DEFAULT_PAGE: u32 = 50;

#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    Vaults,
}

/// A vault created by this factory.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VaultRecord {
    pub owner_id: AccountId,
    /// The global contract the vault runs.
    pub code_hash: Base58CryptoHash,
    pub created_by: AccountId,
    pub created_at_ns: U64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct VaultView {
    pub vault_id: AccountId,
    #[serde(flatten)]
    pub record: VaultRecord,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct FactoryInfo {
    pub owner_id: AccountId,
    pub vault_code_hash: Base58CryptoHash,
    pub min_deposit: NearToken,
    pub vaults: u32,
}

#[near(event_json(standard = "allowance_factory"))]
pub enum Event {
    #[event_version("1.0.0")]
    VaultCreated {
        vault_id: AccountId,
        owner_id: AccountId,
        code_hash: Base58CryptoHash,
    },
    #[event_version("1.0.0")]
    VaultCreationFailed {
        vault_id: AccountId,
        refunded_to: AccountId,
        amount: NearToken,
    },
    #[event_version("1.0.0")]
    VaultCodeSet { code_hash: Base58CryptoHash },
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Factory {
    owner_id: AccountId,
    vault_code_hash: CryptoHash,
    min_deposit: NearToken,
    vaults: IterableMap<AccountId, VaultRecord>,
}

#[near]
impl Factory {
    /// `vault_code_hash`: base58 sha256 of the vault wasm, already published
    /// as a global contract by hash (e.g. `near contract deploy-as-global
    /// use-file allowance.wasm as-global-hash <publisher> ...`).
    #[init]
    pub fn new(
        owner_id: AccountId,
        vault_code_hash: Base58CryptoHash,
        min_deposit: Option<NearToken>,
    ) -> Self {
        Self {
            owner_id,
            vault_code_hash: vault_code_hash.into(),
            min_deposit: min_deposit.unwrap_or(DEFAULT_MIN_DEPOSIT),
            vaults: IterableMap::new(StorageKey::Vaults),
        }
    }

    /// Anyone: create `<name>.<factory>` running the vault global contract,
    /// initialized with `owner_id` (default: the caller). The attached
    /// deposit (>= `min_deposit`) becomes the vault's balance. On failure
    /// (e.g. the account exists) the deposit is refunded to the caller.
    #[payable]
    pub fn create_vault(
        &mut self,
        name: String,
        owner_id: Option<AccountId>,
        approver_id: Option<AccountId>,
        approval_ttl_ns: Option<U64>,
        key_gas_allowance: Option<NearToken>,
    ) -> Promise {
        let deposit = env::attached_deposit();
        require!(
            deposit >= self.min_deposit,
            format!("attach at least {} to create a vault", self.min_deposit)
        );
        let vault_id = self.vault_account(&name);
        require!(
            !self.vaults.contains_key(&vault_id),
            "a vault with this name already exists"
        );
        let caller = env::predecessor_account_id();
        let owner_id = owner_id.unwrap_or_else(|| caller.clone());
        let init_args = serde_json::to_vec(&serde_json::json!({
            "owner_id": owner_id,
            "approver_id": approver_id,
            "approval_ttl_ns": approval_ttl_ns,
            "key_gas_allowance": key_gas_allowance,
        }))
        .unwrap_or_else(|_| env::panic_str("cannot encode init args"));
        Promise::new(vault_id.clone())
            .create_account()
            .transfer(deposit)
            .use_global_contract(self.vault_code_hash)
            .function_call(
                "new",
                init_args,
                NearToken::from_yoctonear(0),
                GAS_FOR_VAULT_INIT,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_CALLBACK)
                    .on_vault_created(vault_id, owner_id, caller, deposit),
            )
    }

    /// Callback of `create_vault`: record the vault, or refund the caller
    /// (a failed batch is rolled back as a whole and its deposit returns to
    /// the factory).
    #[private]
    pub fn on_vault_created(
        &mut self,
        vault_id: AccountId,
        owner_id: AccountId,
        caller: AccountId,
        deposit: NearToken,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool {
        if result.is_err() {
            Event::VaultCreationFailed {
                vault_id,
                refunded_to: caller.clone(),
                amount: deposit,
            }
            .emit();
            Promise::new(caller).transfer(deposit).detach();
            return false;
        }
        let code_hash = Base58CryptoHash::from(self.vault_code_hash);
        self.vaults.insert(
            vault_id.clone(),
            VaultRecord {
                owner_id: owner_id.clone(),
                code_hash,
                created_by: caller,
                created_at_ns: U64(env::block_timestamp()),
            },
        );
        Event::VaultCreated {
            vault_id,
            owner_id,
            code_hash,
        }
        .emit();
        true
    }

    /// Factory owner: point new vaults at another published build. Existing
    /// vaults keep the code they were created with (by-hash globals are
    /// immutable).
    pub fn set_vault_code_hash(&mut self, vault_code_hash: Base58CryptoHash) {
        require!(
            env::predecessor_account_id() == self.owner_id,
            "only the factory owner can call this method"
        );
        self.vault_code_hash = vault_code_hash.into();
        Event::VaultCodeSet {
            code_hash: vault_code_hash,
        }
        .emit();
    }

    pub fn get_info(&self) -> FactoryInfo {
        FactoryInfo {
            owner_id: self.owner_id.clone(),
            vault_code_hash: self.vault_code_hash.into(),
            min_deposit: self.min_deposit,
            vaults: self.vaults.len(),
        }
    }

    pub fn get_vault(&self, vault_id: AccountId) -> Option<VaultRecord> {
        self.vaults.get(&vault_id).cloned()
    }

    pub fn get_vaults(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<VaultView> {
        self.vaults
            .iter()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(DEFAULT_PAGE) as usize)
            .map(|(vault_id, record)| VaultView {
                vault_id: vault_id.clone(),
                record: record.clone(),
            })
            .collect()
    }
}

impl Factory {
    /// `<name>.<factory>`; `name` must be one lowercase label.
    fn vault_account(&self, name: &str) -> AccountId {
        let valid_label = !name.is_empty()
            && name.len() <= 32
            && name
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
            && !name.starts_with(['-', '_'])
            && !name.ends_with(['-', '_']);
        require!(
            valid_label,
            "name must be one label of lowercase letters, digits, - or _"
        );
        format!("{name}.{}", env::current_account_id())
            .parse()
            .unwrap_or_else(|_| env::panic_str("the vault account id would be invalid (too long?)"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{VMContextBuilder, get_created_receipts, get_logs};
    use near_sdk::testing_env;

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }
    const HASH: [u8; 32] = [7u8; 32];

    fn set(predecessor: &str, deposit: NearToken) {
        testing_env!(
            VMContextBuilder::new()
                .current_account_id(acc("factory.test"))
                .predecessor_account_id(acc(predecessor))
                .signer_account_id(acc(predecessor))
                .attached_deposit(deposit)
                .build()
        );
    }

    fn factory() -> Factory {
        set("owner.test", NearToken::from_near(0));
        Factory::new(acc("owner.test"), HASH.into(), None)
    }

    #[test]
    fn create_vault_issues_one_batch_with_the_global_contract() {
        let mut f = factory();
        set("alice.test", NearToken::from_near(1));
        let _ = f.create_vault("alice".into(), None, None, None, None);
        let receipts = get_created_receipts();
        let batch = receipts
            .iter()
            .find(|r| r.receiver_id == acc("alice.factory.test"))
            .expect("a receipt to the new account");
        let actions = format!("{:?}", batch.actions);
        assert!(actions.contains("CreateAccount"), "{actions}");
        assert!(actions.contains("Transfer"), "{actions}");
        assert!(actions.contains("UseGlobalContract"), "{actions}");
        assert!(actions.contains("FunctionCall"), "{actions}");
    }

    #[test]
    fn the_callback_records_the_vault_or_refunds_the_caller() {
        let mut f = factory();
        set("factory.test", NearToken::from_near(0));
        assert!(f.on_vault_created(
            acc("alice.factory.test"),
            acc("alice.test"),
            acc("alice.test"),
            NearToken::from_near(1),
            Ok(())
        ));
        assert_eq!(
            f.get_vault(acc("alice.factory.test")).unwrap().owner_id,
            acc("alice.test")
        );
        assert!(get_logs().iter().any(|l| l.contains("vault_created")));
        assert!(!f.on_vault_created(
            acc("bob.factory.test"),
            acc("bob.test"),
            acc("bob.test"),
            NearToken::from_near(1),
            Err(PromiseError::Failed)
        ));
        assert!(f.get_vault(acc("bob.factory.test")).is_none());
        assert!(
            get_created_receipts()
                .iter()
                .any(|r| r.receiver_id == acc("bob.test")),
            "refund to the caller"
        );
        assert_eq!(f.get_info().vaults, 1);
        assert_eq!(f.get_vaults(None, None).len(), 1);
    }

    #[test]
    #[should_panic(expected = "attach at least")]
    fn a_vault_needs_a_deposit() {
        let mut f = factory();
        set("alice.test", NearToken::from_millinear(1));
        let _ = f.create_vault("alice".into(), None, None, None, None);
    }

    #[test]
    #[should_panic(expected = "name must be one label")]
    fn names_are_single_labels() {
        let mut f = factory();
        set("alice.test", NearToken::from_near(1));
        let _ = f.create_vault("a.b".into(), None, None, None, None);
    }

    #[test]
    #[should_panic(expected = "only the factory owner")]
    fn only_the_owner_changes_the_code() {
        let mut f = factory();
        set("mallory.test", NearToken::from_near(0));
        f.set_vault_code_hash([1u8; 32].into());
    }
}
