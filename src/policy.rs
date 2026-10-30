//! Policy model and the pure, deterministic policy evaluation.
//!
//! Nothing in this module touches the chain: `evaluate` is a function of its
//! arguments only, so it can be unit-tested exhaustively and is shared by
//! `pay` (state-changing) and `simulate` (free view call).

use near_sdk::json_types::U64;
use near_sdk::{AccountId, NearToken, near};

/// Nanoseconds in one second (NEAR block timestamps are in nanoseconds).
pub const NS_PER_SEC: u64 = 1_000_000_000;
const SECS_PER_HOUR: u64 = 3_600;
const SECS_PER_DAY: u64 = 86_400;
/// 1970-01-01 was a Thursday: ISO weekday 4.
const EPOCH_ISO_WEEKDAY: u64 = 4;

/// Asset a policy is denominated in: NEAR, or a NEP-141 fungible token
/// named by its contract account (`{"ft": "usdc.near"}`).
///
/// Every amount of a policy, a receipt or a simulation is a `NearToken` on the
/// wire (a decimal string of a `u128`). For `Near` it is yoctoNEAR; for `Ft` it
/// is the token's smallest unit (e.g. 1 USDC = `"1000000"` with 6 decimals).
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Asset {
    #[default]
    Near,
    Ft(AccountId),
}

/// Spending budget per fixed time bucket.
///
/// Windows are fixed buckets aligned to the epoch:
/// `window_start = now - now % period_ns`. This is deterministic, needs no
/// per-agent bookkeeping beyond one counter, and resets exactly at
/// `window_start + period_ns`.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Budget {
    /// Maximum total amount that may be paid inside one window.
    pub amount: NearToken,
    /// Window length in nanoseconds (e.g. 86_400_000_000_000 for one day).
    pub period_ns: U64,
}

impl Budget {
    /// Start of the window that contains `now_ns`.
    pub fn window_start(&self, now_ns: u64) -> u64 {
        let period = self.period_ns.0.max(1);
        now_ns - now_ns % period
    }

    /// Instant at which the window containing `now_ns` ends and the budget resets.
    pub fn resets_at(&self, now_ns: u64) -> u64 {
        self.window_start(now_ns)
            .saturating_add(self.period_ns.0.max(1))
    }
}

/// One allowlisted payee.
///
/// `methods: ["deposit"]` marks the payee as another Allowance vault: NEAR
/// payments then call its `deposit` (with the amount attached) instead of a
/// plain transfer, so the receiving vault records the income and applies its
/// revenue split. Token payments always use `ft_transfer`. No other method
/// is accepted.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AllowEntry {
    pub account_id: AccountId,
    #[serde(default)]
    pub methods: Option<Vec<String>>,
}

/// Payee allowlist.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Allow {
    /// Any payee that is not on the vault denylist.
    #[default]
    Any,
    /// Only the listed payees (the denylist still wins).
    List(Vec<AllowEntry>),
}

impl Allow {
    fn permits(&self, payee: &AccountId) -> bool {
        match self {
            Allow::Any => true,
            Allow::List(entries) => entries.iter().any(|e| &e.account_id == payee),
        }
    }

    /// True when the allowlist says to pay `payee` through its `deposit`.
    pub fn pays_via_deposit(&self, payee: &AccountId) -> bool {
        match self {
            Allow::Any => false,
            Allow::List(entries) => entries.iter().any(|e| {
                &e.account_id == payee
                    && e.methods
                        .as_ref()
                        .is_some_and(|m| m.iter().any(|x| x == "deposit"))
            }),
        }
    }
}

/// Hours of the day (UTC) and weekdays during which the agent may pay.
///
/// `start_h <= hour < end_h` on an allowed day. `end_h` may be 24 (end of day);
/// overnight windows are not supported (`start_h < end_h` is required).
/// `days` are ISO weekdays, 1 = Monday ... 7 = Sunday; an empty list means
/// every day.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TimeWindow {
    pub start_h: u8,
    pub end_h: u8,
    #[serde(default)]
    pub days: Vec<u8>,
}

impl TimeWindow {
    fn day_allowed(&self, iso_weekday: u8) -> bool {
        self.days.is_empty() || self.days.contains(&iso_weekday)
    }

    /// True when `now_ns` falls inside the window.
    pub fn contains(&self, now_ns: u64) -> bool {
        let (hour, weekday) = utc_hour_and_weekday(now_ns);
        self.day_allowed(weekday) && self.start_h <= hour && hour < self.end_h
    }

    /// Next instant at which the window opens, strictly after `now_ns` when
    /// `now_ns` is outside the window. Always within the next eight days
    /// because at least one weekday is allowed.
    pub fn next_open_ns(&self, now_ns: u64) -> u64 {
        let today = now_ns / NS_PER_SEC / SECS_PER_DAY;
        for offset in 0..=7u64 {
            let day = today + offset;
            let weekday = iso_weekday_of_day(day);
            if !self.day_allowed(weekday) {
                continue;
            }
            let opens_at =
                (day * SECS_PER_DAY + u64::from(self.start_h) * SECS_PER_HOUR) * NS_PER_SEC;
            if opens_at > now_ns {
                return opens_at;
            }
        }
        // Unreachable for a validated window; fall back to "tomorrow at start".
        ((today + 1) * SECS_PER_DAY + u64::from(self.start_h) * SECS_PER_HOUR) * NS_PER_SEC
    }
}

fn iso_weekday_of_day(days_since_epoch: u64) -> u8 {
    ((days_since_epoch + EPOCH_ISO_WEEKDAY - 1) % 7 + 1) as u8
}

/// `(hour of day in UTC, ISO weekday)` for a nanosecond timestamp.
pub fn utc_hour_and_weekday(now_ns: u64) -> (u8, u8) {
    let secs = now_ns / NS_PER_SEC;
    let hour = ((secs % SECS_PER_DAY) / SECS_PER_HOUR) as u8;
    (hour, iso_weekday_of_day(secs / SECS_PER_DAY))
}

/// Spending policy attached to one agent. All limits are enforced by
/// [`evaluate`]; the protocol-level function-call key only limits *which
/// methods* the agent may call and *how much gas* it may burn.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Policy {
    /// Asset the limits are denominated in and payments are made in.
    #[serde(default)]
    pub asset: Asset,
    /// Hard ceiling for a single payment, approved or not.
    pub per_tx_cap: NearToken,
    /// Optional budget per fixed window. `None` means no cumulative limit.
    #[serde(default)]
    pub budget: Option<Budget>,
    /// Payee allowlist.
    #[serde(default)]
    pub allow: Allow,
    /// Optional time window (UTC) in which payments are allowed.
    #[serde(default)]
    pub time_window: Option<TimeWindow>,
    /// Minimum time between two payments by this agent (0 = none).
    #[serde(default)]
    pub cooldown_ns: U64,
    /// Payments strictly above this amount wait for a human approval.
    /// Must be below `per_tx_cap`. `None` means never ask.
    #[serde(default)]
    pub approval_threshold: Option<NearToken>,
    /// The policy stops working at this instant (`None` = never).
    #[serde(default)]
    pub expires_at_ns: Option<U64>,
    /// NEP-141 policies only: the most NEAR the vault may attach, per payment,
    /// to register a payee that has no storage on the token (NEP-145
    /// `storage_deposit` with `registration_only`, so the token refunds what
    /// it does not need). `None` = never: paying an unregistered payee fails
    /// and the reservation is released. Paid from the vault's NEAR balance
    /// above the storage reserve; at most [`MAX_FT_STORAGE_DEPOSIT`].
    #[serde(default)]
    pub ft_storage_deposit: Option<NearToken>,
}

/// Upper bound for [`Policy::ft_storage_deposit`]. NEP-145 registrations cost
/// about 0.00125 NEAR on the reference token; 0.1 NEAR leaves room for tokens
/// with bigger accounts and keeps a compromised agent from turning payee
/// registrations into a NEAR drain.
pub const MAX_FT_STORAGE_DEPOSIT: NearToken = NearToken::from_millinear(100);

impl Policy {
    /// Check that the policy is internally consistent. Called by `add_agent`
    /// and `set_policy`; the message is meant for the owner.
    pub fn validate(&self) -> Result<(), String> {
        if let Some(deposit) = self.ft_storage_deposit {
            if self.asset == Asset::Near {
                return Err("ft_storage_deposit only applies to `ft` assets".into());
            }
            if deposit.is_zero() || deposit > MAX_FT_STORAGE_DEPOSIT {
                return Err("ft_storage_deposit must be > 0 and <= 0.1 NEAR".into());
            }
        }
        if self.per_tx_cap.is_zero() {
            return Err("per_tx_cap must be greater than zero".into());
        }
        if let Some(budget) = &self.budget {
            if budget.period_ns.0 == 0 {
                return Err("budget.period_ns must be greater than zero".into());
            }
            if budget.amount.is_zero() {
                return Err("budget.amount must be greater than zero".into());
            }
        }
        if let Allow::List(entries) = &self.allow {
            if entries.is_empty() {
                return Err("allow.list must not be empty (use `any` or disable the agent)".into());
            }
            if entries.iter().any(|e| {
                e.methods
                    .as_ref()
                    .is_some_and(|m| m.iter().any(|x| x != "deposit"))
            }) {
                return Err(
                    "allow.list methods: only [\"deposit\"] (pay another Allowance vault) is supported"
                        .into(),
                );
            }
        }
        if let Some(window) = &self.time_window {
            if window.start_h >= window.end_h || window.end_h > 24 {
                return Err("time_window: require start_h < end_h <= 24".into());
            }
            if window.days.iter().any(|d| !(1..=7).contains(d)) {
                return Err("time_window.days must be ISO weekdays 1 (Mon) to 7 (Sun)".into());
            }
        }
        if let Some(threshold) = self.approval_threshold
            && threshold >= self.per_tx_cap
        {
            return Err("approval_threshold must be below per_tx_cap".into());
        }
        Ok(())
    }
}

/// Mutable spending counters of one agent.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SpendState {
    /// Start of the budget window the counters refer to.
    pub window_start_ns: U64,
    /// Amount reserved or paid inside that window.
    pub spent_in_window: NearToken,
    /// Timestamp of the last payment that reached the transfer stage.
    pub last_payment_ns: U64,
    /// Number of payments that reached the transfer stage.
    pub payments: u64,
}

impl SpendState {
    /// Amount already spent in the window that contains `now_ns`.
    /// Counters from an older window count as zero (the window rolled over).
    pub fn spent_at(&self, budget: &Budget, now_ns: u64) -> NearToken {
        if self.window_start_ns.0 == budget.window_start(now_ns) {
            self.spent_in_window
        } else {
            NearToken::from_yoctonear(0)
        }
    }

    /// Budget left in the window that contains `now_ns`.
    pub fn remaining_at(&self, budget: &Budget, now_ns: u64) -> NearToken {
        budget.amount.saturating_sub(self.spent_at(budget, now_ns))
    }

    /// Reserve `amount` for a payment that is about to be transferred.
    /// Without a budget the window is 0 and `spent_in_window` is a lifetime total.
    pub fn record_payment(&mut self, budget: Option<&Budget>, amount: NearToken, now_ns: u64) {
        match budget {
            Some(budget) => {
                let spent = self.spent_at(budget, now_ns);
                self.window_start_ns = U64(budget.window_start(now_ns));
                self.spent_in_window = spent.saturating_add(amount);
            }
            None => {
                self.spent_in_window = self.spent_in_window.saturating_add(amount);
            }
        }
        self.last_payment_ns = U64(now_ns);
        self.payments = self.payments.saturating_add(1);
    }

    /// Give back a reservation after a failed transfer. Only the window the
    /// reservation was made in is touched; if the window has rolled over the
    /// reservation already expired with it.
    pub fn release(&mut self, amount: NearToken, window_start_ns: u64) {
        if self.window_start_ns.0 == window_start_ns {
            self.spent_in_window = self.spent_in_window.saturating_sub(amount);
        }
    }
}

/// What the agent asks for.
#[derive(Clone, Debug)]
pub struct PayRequest<'a> {
    pub payee: &'a AccountId,
    pub amount: NearToken,
    pub asset: &'a Asset,
}

/// Everything `evaluate` needs from the outside world, gathered by the caller.
#[derive(Clone, Debug)]
pub struct EvalContext {
    pub now_ns: u64,
    pub paused: bool,
    pub agent_active: bool,
    pub payee_denylisted: bool,
    /// Vault balance minus the storage reserve.
    pub vault_available: NearToken,
    /// True when a human already approved this exact payment (`approve`):
    /// the approval threshold is then skipped, everything else is re-checked.
    pub approval_granted: bool,
}

/// Positive outcome of [`evaluate`].
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(tag = "decision", rename_all = "snake_case")]
pub enum Decision {
    /// Transfer now.
    Pay,
    /// Park in the approval queue; no funds move until a human approves.
    NeedsApproval { threshold: NearToken },
}

/// Why a payment is refused. Serialized as `{"code": "...", ...}`.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum Rejection {
    /// The vault is paused (or killed).
    Paused,
    /// The agent exists but was disabled by the owner.
    AgentDisabled,
    /// The policy's `expires_at_ns` has passed.
    PolicyExpired { expired_at_ns: U64 },
    /// The requested asset is not the policy's asset.
    AssetNotAllowed { allowed: Asset },
    /// The payee is on the vault denylist.
    Denylisted { payee: AccountId },
    /// The payee is not on the agent's allowlist.
    NotAllowlisted { payee: AccountId },
    /// Single payment above `per_tx_cap`.
    OverPerTxCap { cap: NearToken },
    /// Outside the policy's time window; `opens_at_ns` is the next opening.
    OutsideTimeWindow { opens_at_ns: U64 },
    /// Too soon after the previous payment.
    Cooldown { retry_at_ns: U64 },
    /// Window budget exhausted.
    OverBudget {
        remaining: NearToken,
        resets_at_ns: U64,
    },
    /// The vault cannot pay without eating into its storage reserve.
    InsufficientVaultBalance { available: NearToken },
    /// The caller is not a registered agent (reported by `simulate` only;
    /// `pay` panics instead so that strangers cannot write receipts).
    UnknownAgent,
}

/// Decide whether a payment may go through.
///
/// Checks run in a fixed order and the first failure wins, so a rejection
/// reason is deterministic for a given input:
///
/// 1. `Paused` - vault paused or killed
/// 2. `AgentDisabled`
/// 3. `PolicyExpired` - `now_ns >= expires_at_ns`
/// 4. `AssetNotAllowed`
/// 5. `Denylisted` - vault-wide denylist beats any allowlist
/// 6. `NotAllowlisted`
/// 7. `OverPerTxCap` - `amount > per_tx_cap` (the cap is inclusive)
/// 8. `OutsideTimeWindow`
/// 9. `Cooldown` - `now_ns < last_payment_ns + cooldown_ns`
/// 10. `OverBudget` - `spent_in_window + amount > budget.amount`
/// 11. `InsufficientVaultBalance` - `amount > vault_available`
///
/// If everything passes: `NeedsApproval` when `amount > approval_threshold`
/// and no approval was granted yet, otherwise `Pay`.
pub fn evaluate(
    policy: &Policy,
    state: &SpendState,
    req: &PayRequest<'_>,
    ctx: &EvalContext,
) -> Result<Decision, Rejection> {
    if ctx.paused {
        return Err(Rejection::Paused);
    }
    if !ctx.agent_active {
        return Err(Rejection::AgentDisabled);
    }
    if let Some(expires_at) = policy.expires_at_ns
        && ctx.now_ns >= expires_at.0
    {
        return Err(Rejection::PolicyExpired {
            expired_at_ns: expires_at,
        });
    }
    if req.asset != &policy.asset {
        return Err(Rejection::AssetNotAllowed {
            allowed: policy.asset.clone(),
        });
    }
    if ctx.payee_denylisted {
        return Err(Rejection::Denylisted {
            payee: req.payee.clone(),
        });
    }
    if !policy.allow.permits(req.payee) {
        return Err(Rejection::NotAllowlisted {
            payee: req.payee.clone(),
        });
    }
    if req.amount > policy.per_tx_cap {
        return Err(Rejection::OverPerTxCap {
            cap: policy.per_tx_cap,
        });
    }
    if let Some(window) = &policy.time_window
        && !window.contains(ctx.now_ns)
    {
        return Err(Rejection::OutsideTimeWindow {
            opens_at_ns: U64(window.next_open_ns(ctx.now_ns)),
        });
    }
    if policy.cooldown_ns.0 > 0 && state.last_payment_ns.0 > 0 {
        let retry_at = state.last_payment_ns.0.saturating_add(policy.cooldown_ns.0);
        if ctx.now_ns < retry_at {
            return Err(Rejection::Cooldown {
                retry_at_ns: U64(retry_at),
            });
        }
    }
    if let Some(budget) = &policy.budget {
        let remaining = state.remaining_at(budget, ctx.now_ns);
        if req.amount > remaining {
            return Err(Rejection::OverBudget {
                remaining,
                resets_at_ns: U64(budget.resets_at(ctx.now_ns)),
            });
        }
    }
    if req.amount > ctx.vault_available {
        return Err(Rejection::InsufficientVaultBalance {
            available: ctx.vault_available,
        });
    }
    if !ctx.approval_granted
        && let Some(threshold) = policy.approval_threshold
        && req.amount > threshold
    {
        return Ok(Decision::NeedsApproval { threshold });
    }
    Ok(Decision::Pay)
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY_NS: u64 = SECS_PER_DAY * NS_PER_SEC;
    const HOUR_NS: u64 = SECS_PER_HOUR * NS_PER_SEC;
    /// 2026-11-02 00:00:00 UTC, a Monday.
    const MONDAY: u64 = 1_793_577_600 * NS_PER_SEC;

    fn near(n: u64) -> NearToken {
        NearToken::from_near(n as u128)
    }
    fn millinear(n: u64) -> NearToken {
        NearToken::from_millinear(n as u128)
    }
    fn api() -> AccountId {
        "api.demo.near".parse().unwrap()
    }
    fn attacker() -> AccountId {
        "attacker.near".parse().unwrap()
    }

    /// cap 1 NEAR, 2 NEAR/day, allow [api], no window, no cooldown,
    /// approval above 0.5 NEAR, never expires.
    fn policy() -> Policy {
        Policy {
            asset: Asset::Near,
            per_tx_cap: near(1),
            budget: Some(Budget {
                amount: near(2),
                period_ns: U64(DAY_NS),
            }),
            allow: Allow::List(vec![AllowEntry {
                account_id: api(),
                methods: None,
            }]),
            time_window: None,
            cooldown_ns: U64(0),
            approval_threshold: Some(millinear(500)),
            expires_at_ns: None,
            ft_storage_deposit: None,
        }
    }

    fn ctx(now_ns: u64) -> EvalContext {
        EvalContext {
            now_ns,
            paused: false,
            agent_active: true,
            payee_denylisted: false,
            vault_available: near(100),
            approval_granted: false,
        }
    }

    fn run(
        policy: &Policy,
        state: &SpendState,
        payee: &AccountId,
        amount: NearToken,
        ctx: &EvalContext,
    ) -> Result<Decision, Rejection> {
        evaluate(
            policy,
            state,
            &PayRequest {
                payee,
                amount,
                asset: &Asset::Near,
            },
            ctx,
        )
    }

    #[test]
    fn small_payment_to_allowlisted_payee_is_paid() {
        let r = run(
            &policy(),
            &SpendState::default(),
            &api(),
            millinear(20),
            &ctx(MONDAY),
        );
        assert_eq!(r, Ok(Decision::Pay));
    }

    #[test]
    fn paused_vault_rejects_everything_first() {
        let mut c = ctx(MONDAY);
        c.paused = true;
        c.agent_active = false;
        // Even a payment that would fail several later checks reports Paused.
        let r = run(&policy(), &SpendState::default(), &attacker(), near(5), &c);
        assert_eq!(r, Err(Rejection::Paused));
    }

    #[test]
    fn disabled_agent_is_rejected() {
        let mut c = ctx(MONDAY);
        c.agent_active = false;
        let r = run(&policy(), &SpendState::default(), &api(), millinear(1), &c);
        assert_eq!(r, Err(Rejection::AgentDisabled));
    }

    #[test]
    fn expired_policy_is_rejected_at_the_boundary() {
        let mut p = policy();
        p.expires_at_ns = Some(U64(MONDAY));
        let ok = run(
            &p,
            &SpendState::default(),
            &api(),
            millinear(1),
            &ctx(MONDAY - 1),
        );
        assert_eq!(ok, Ok(Decision::Pay));
        let expired = run(
            &p,
            &SpendState::default(),
            &api(),
            millinear(1),
            &ctx(MONDAY),
        );
        assert_eq!(
            expired,
            Err(Rejection::PolicyExpired {
                expired_at_ns: U64(MONDAY)
            })
        );
    }

    #[test]
    fn other_asset_is_rejected() {
        let token: AccountId = "usdc.near".parse().unwrap();
        let r = evaluate(
            &policy(),
            &SpendState::default(),
            &PayRequest {
                payee: &api(),
                amount: millinear(1),
                asset: &Asset::Ft(token),
            },
            &ctx(MONDAY),
        );
        assert_eq!(
            r,
            Err(Rejection::AssetNotAllowed {
                allowed: Asset::Near
            })
        );
    }

    #[test]
    fn denylist_beats_allowlist() {
        let mut c = ctx(MONDAY);
        c.payee_denylisted = true;
        let r = run(&policy(), &SpendState::default(), &api(), millinear(1), &c);
        assert_eq!(r, Err(Rejection::Denylisted { payee: api() }));
    }

    #[test]
    fn unknown_payee_is_rejected_before_the_amount_is_looked_at() {
        // The DESIGN example: pay(attacker, 2 NEAR) -> NotAllowlisted, not OverPerTxCap.
        let r = run(
            &policy(),
            &SpendState::default(),
            &attacker(),
            near(2),
            &ctx(MONDAY),
        );
        assert_eq!(r, Err(Rejection::NotAllowlisted { payee: attacker() }));
    }

    #[test]
    fn allow_any_accepts_unknown_payees() {
        let mut p = policy();
        p.allow = Allow::Any;
        let r = run(
            &p,
            &SpendState::default(),
            &attacker(),
            millinear(1),
            &ctx(MONDAY),
        );
        assert_eq!(r, Ok(Decision::Pay));
    }

    #[test]
    fn per_tx_cap_is_inclusive() {
        let mut p = policy();
        p.approval_threshold = None;
        let at_cap = run(&p, &SpendState::default(), &api(), near(1), &ctx(MONDAY));
        assert_eq!(at_cap, Ok(Decision::Pay));
        let over = run(
            &p,
            &SpendState::default(),
            &api(),
            NearToken::from_yoctonear(near(1).as_yoctonear() + 1),
            &ctx(MONDAY),
        );
        assert_eq!(over, Err(Rejection::OverPerTxCap { cap: near(1) }));
    }

    #[test]
    fn time_window_office_hours_on_weekdays() {
        let mut p = policy();
        p.time_window = Some(TimeWindow {
            start_h: 9,
            end_h: 17,
            days: vec![1, 2, 3, 4, 5],
        });
        let s = SpendState::default();
        // Monday 09:00 is open, 16:59 is open, 17:00 is closed.
        assert_eq!(
            run(&p, &s, &api(), millinear(1), &ctx(MONDAY + 9 * HOUR_NS)),
            Ok(Decision::Pay)
        );
        assert_eq!(
            run(
                &p,
                &s,
                &api(),
                millinear(1),
                &ctx(MONDAY + 17 * HOUR_NS - 1)
            ),
            Ok(Decision::Pay)
        );
        assert_eq!(
            run(&p, &s, &api(), millinear(1), &ctx(MONDAY + 17 * HOUR_NS)),
            Err(Rejection::OutsideTimeWindow {
                opens_at_ns: U64(MONDAY + DAY_NS + 9 * HOUR_NS)
            })
        );
        // Monday 03:00 opens later the same day.
        assert_eq!(
            run(&p, &s, &api(), millinear(1), &ctx(MONDAY + 3 * HOUR_NS)),
            Err(Rejection::OutsideTimeWindow {
                opens_at_ns: U64(MONDAY + 9 * HOUR_NS)
            })
        );
        // Saturday noon opens on Monday 09:00.
        let saturday_noon = MONDAY + 5 * DAY_NS + 12 * HOUR_NS;
        assert_eq!(
            run(&p, &s, &api(), millinear(1), &ctx(saturday_noon)),
            Err(Rejection::OutsideTimeWindow {
                opens_at_ns: U64(MONDAY + 7 * DAY_NS + 9 * HOUR_NS)
            })
        );
    }

    #[test]
    fn weekday_helper_matches_the_calendar() {
        assert_eq!(utc_hour_and_weekday(MONDAY), (0, 1));
        assert_eq!(
            utc_hour_and_weekday(MONDAY + 6 * DAY_NS + 23 * HOUR_NS),
            (23, 7)
        );
        assert_eq!(utc_hour_and_weekday(0), (0, 4)); // 1970-01-01 was a Thursday
    }

    #[test]
    fn cooldown_blocks_until_retry_at() {
        let mut p = policy();
        p.cooldown_ns = U64(10 * NS_PER_SEC);
        let mut s = SpendState::default();
        // No payment yet: cooldown does not apply.
        assert_eq!(
            run(&p, &s, &api(), millinear(1), &ctx(MONDAY)),
            Ok(Decision::Pay)
        );
        s.record_payment(p.budget.as_ref(), millinear(1), MONDAY);
        assert_eq!(
            run(&p, &s, &api(), millinear(1), &ctx(MONDAY + 9 * NS_PER_SEC)),
            Err(Rejection::Cooldown {
                retry_at_ns: U64(MONDAY + 10 * NS_PER_SEC)
            })
        );
        assert_eq!(
            run(&p, &s, &api(), millinear(1), &ctx(MONDAY + 10 * NS_PER_SEC)),
            Ok(Decision::Pay)
        );
    }

    #[test]
    fn budget_is_cumulative_inside_a_window() {
        let p = policy();
        let mut s = SpendState::default();
        s.record_payment(p.budget.as_ref(), near(1), MONDAY);
        s.record_payment(p.budget.as_ref(), millinear(500), MONDAY + HOUR_NS);
        let r = run(&p, &s, &api(), millinear(600), &ctx(MONDAY + 2 * HOUR_NS));
        assert_eq!(
            r,
            Err(Rejection::OverBudget {
                remaining: millinear(500),
                resets_at_ns: U64(MONDAY + DAY_NS)
            })
        );
        // Exactly the remaining amount still fits.
        let r = run(&p, &s, &api(), millinear(500), &ctx(MONDAY + 2 * HOUR_NS));
        assert_eq!(r, Ok(Decision::Pay));
    }

    #[test]
    fn budget_window_rolls_over() {
        let p = policy();
        let mut s = SpendState::default();
        s.record_payment(p.budget.as_ref(), near(1), MONDAY);
        s.record_payment(p.budget.as_ref(), near(1), MONDAY + HOUR_NS);
        assert!(matches!(
            run(&p, &s, &api(), millinear(1), &ctx(MONDAY + 2 * HOUR_NS)),
            Err(Rejection::OverBudget { .. })
        ));
        // Next day: counters from the old window count as zero.
        let tuesday = MONDAY + DAY_NS;
        assert_eq!(
            run(&p, &s, &api(), millinear(1), &ctx(tuesday)),
            Ok(Decision::Pay)
        );
        assert_eq!(s.remaining_at(p.budget.as_ref().unwrap(), tuesday), near(2));
        // Recording in the new window resets the counters.
        s.record_payment(p.budget.as_ref(), millinear(300), tuesday);
        assert_eq!(s.window_start_ns, U64(tuesday));
        assert_eq!(s.spent_in_window, millinear(300));
        assert_eq!(s.payments, 3);
    }

    #[test]
    fn release_only_touches_the_window_it_was_reserved_in() {
        let p = policy();
        let mut s = SpendState::default();
        s.record_payment(p.budget.as_ref(), near(1), MONDAY);
        s.release(near(1), MONDAY);
        assert_eq!(s.spent_in_window, near(0));
        s.record_payment(p.budget.as_ref(), near(1), MONDAY + DAY_NS);
        // A late release for the old window is a no-op.
        s.release(near(1), MONDAY);
        assert_eq!(s.spent_in_window, near(1));
        // Releasing more than reserved saturates at zero instead of underflowing.
        s.release(near(5), MONDAY + DAY_NS);
        assert_eq!(s.spent_in_window, near(0));
    }

    #[test]
    fn no_budget_means_lifetime_counter_only() {
        let mut p = policy();
        p.budget = None;
        let mut s = SpendState::default();
        s.record_payment(None, near(1), MONDAY);
        s.record_payment(None, near(1), MONDAY + 10 * DAY_NS);
        assert_eq!(s.spent_in_window, near(2));
        assert_eq!(s.window_start_ns, U64(0));
        let mut c = ctx(MONDAY + 11 * DAY_NS);
        c.approval_granted = true;
        assert_eq!(run(&p, &s, &api(), near(1), &c), Ok(Decision::Pay));
    }

    #[test]
    fn vault_balance_is_checked_after_the_budget() {
        let mut c = ctx(MONDAY);
        c.vault_available = millinear(10);
        let r = run(&policy(), &SpendState::default(), &api(), millinear(20), &c);
        assert_eq!(
            r,
            Err(Rejection::InsufficientVaultBalance {
                available: millinear(10)
            })
        );
    }

    #[test]
    fn payments_above_the_threshold_need_approval() {
        let p = policy();
        let s = SpendState::default();
        assert_eq!(
            run(&p, &s, &api(), millinear(500), &ctx(MONDAY)),
            Ok(Decision::Pay),
            "the threshold itself is still autonomous"
        );
        assert_eq!(
            run(&p, &s, &api(), millinear(800), &ctx(MONDAY)),
            Ok(Decision::NeedsApproval {
                threshold: millinear(500)
            })
        );
        // Once a human approved, the same request is paid...
        let mut c = ctx(MONDAY);
        c.approval_granted = true;
        assert_eq!(run(&p, &s, &api(), millinear(800), &c), Ok(Decision::Pay));
        // ...but every other rule is still enforced at approval time.
        c.paused = true;
        assert_eq!(
            run(&p, &s, &api(), millinear(800), &c),
            Err(Rejection::Paused)
        );
    }

    #[test]
    fn without_threshold_nothing_needs_approval() {
        let mut p = policy();
        p.approval_threshold = None;
        let r = run(&p, &SpendState::default(), &api(), near(1), &ctx(MONDAY));
        assert_eq!(r, Ok(Decision::Pay));
    }

    #[test]
    fn validate_rejects_inconsistent_policies() {
        assert!(policy().validate().is_ok());

        let mut p = policy();
        p.per_tx_cap = near(0);
        assert!(p.validate().unwrap_err().contains("per_tx_cap"));

        let mut p = policy();
        p.approval_threshold = Some(near(1));
        assert!(p.validate().unwrap_err().contains("approval_threshold"));

        let mut p = policy();
        p.budget = Some(Budget {
            amount: near(1),
            period_ns: U64(0),
        });
        assert!(p.validate().unwrap_err().contains("period_ns"));

        let mut p = policy();
        p.allow = Allow::List(vec![]);
        assert!(p.validate().unwrap_err().contains("allow.list"));

        let mut p = policy();
        p.time_window = Some(TimeWindow {
            start_h: 17,
            end_h: 9,
            days: vec![],
        });
        assert!(p.validate().unwrap_err().contains("time_window"));

        let mut p = policy();
        p.time_window = Some(TimeWindow {
            start_h: 0,
            end_h: 24,
            days: vec![0],
        });
        assert!(p.validate().unwrap_err().contains("days"));

        let mut p = policy();
        p.ft_storage_deposit = Some(millinear(10));
        assert!(
            p.validate().unwrap_err().contains("ft_storage_deposit"),
            "registration deposits only make sense for tokens"
        );

        let mut p = policy();
        p.asset = Asset::Ft("usdc.near".parse().unwrap());
        assert!(p.validate().is_ok(), "NEP-141 policies are accepted");
        p.ft_storage_deposit = Some(millinear(101));
        assert!(p.validate().unwrap_err().contains("ft_storage_deposit"));
        p.ft_storage_deposit = Some(millinear(10));
        assert!(p.validate().is_ok());
    }

    #[test]
    fn ft_policies_evaluate_in_token_units() {
        let token: AccountId = "usdc.near".parse().unwrap();
        let usdc = |n: u128| NearToken::from_yoctonear(n * 1_000_000);
        let mut p = policy();
        p.asset = Asset::Ft(token.clone());
        p.per_tx_cap = usdc(10);
        p.approval_threshold = Some(usdc(5));
        p.budget = Some(Budget {
            amount: usdc(20),
            period_ns: U64(DAY_NS),
        });
        let mut c = ctx(MONDAY);
        // For a token policy the caller passes the vault's token balance.
        c.vault_available = usdc(100);
        let pay = |amount: NearToken, asset: &Asset, c: &EvalContext| {
            evaluate(
                &p,
                &SpendState::default(),
                &PayRequest {
                    payee: &api(),
                    amount,
                    asset,
                },
                c,
            )
        };
        let ft = Asset::Ft(token);
        assert_eq!(pay(usdc(2), &ft, &c), Ok(Decision::Pay));
        assert_eq!(
            pay(usdc(6), &ft, &c),
            Ok(Decision::NeedsApproval { threshold: usdc(5) })
        );
        assert_eq!(
            pay(usdc(11), &ft, &c),
            Err(Rejection::OverPerTxCap { cap: usdc(10) })
        );
        assert_eq!(
            pay(usdc(2), &Asset::Near, &c),
            Err(Rejection::AssetNotAllowed {
                allowed: ft.clone()
            }),
            "a token policy never pays NEAR"
        );
        c.vault_available = usdc(1);
        assert_eq!(
            pay(usdc(2), &ft, &c),
            Err(Rejection::InsufficientVaultBalance { available: usdc(1) })
        );
    }

    #[test]
    fn policy_json_accepts_minimal_input_and_round_trips() {
        let json = r#"{"per_tx_cap":"1000000000000000000000000","allow":{"list":[{"account_id":"api.demo.near"}]}}"#;
        let p: Policy = near_sdk::serde_json::from_str(json).unwrap();
        assert_eq!(p.asset, Asset::Near);
        assert_eq!(p.budget, None);
        assert_eq!(p.cooldown_ns, U64(0));
        assert!(p.validate().is_ok());
        let back = near_sdk::serde_json::to_string(&p).unwrap();
        let again: Policy = near_sdk::serde_json::from_str(&back).unwrap();
        assert_eq!(p, again);

        let rejection =
            near_sdk::serde_json::to_string(&Rejection::OverPerTxCap { cap: near(1) }).unwrap();
        assert_eq!(
            rejection,
            r#"{"code":"over_per_tx_cap","cap":"1000000000000000000000000"}"#
        );
    }
}
