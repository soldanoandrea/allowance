//! Revenue split: a share of every incoming payment is forwarded to
//! beneficiaries (business track: "revenue split" as a config rule).
//!
//! Applies to income only: `deposit` (NEAR, including payments from another
//! Allowance vault whose policy pays this one through `deposit`) and
//! `ft_on_transfer` (NEP-141 tokens sent with `ft_transfer_call`). The vault
//! keeps the remainder. Each share is recorded on the income receipt with
//! its own status.

use near_sdk::{AccountId, NearToken, near};

/// Basis points in 100%.
pub const BPS_DENOMINATOR: u32 = 10_000;
/// At most this many beneficiaries: every share is a transfer (and, for
/// tokens, an `ft_transfer`) inside the depositor's transaction.
pub const MAX_BENEFICIARIES: usize = 4;

/// One beneficiary and its share in basis points (100 = 1%).
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SplitShare {
    pub account_id: AccountId,
    pub bps: u16,
}

/// The vault-wide split rule.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Split {
    pub beneficiaries: Vec<SplitShare>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SplitStatus {
    /// Transfer issued, not settled yet.
    Pending,
    Paid,
    /// The transfer failed; the amount stayed in (or came back to) the vault.
    Failed,
}

/// One forwarded share, recorded on the income receipt.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SplitPayout {
    pub account_id: AccountId,
    pub bps: u16,
    pub amount: NearToken,
    pub status: SplitStatus,
}

impl Split {
    /// Check the rule; `vault` may not be a beneficiary of itself.
    pub fn validate(&self, vault: &AccountId) -> Result<(), String> {
        if self.beneficiaries.is_empty() || self.beneficiaries.len() > MAX_BENEFICIARIES {
            return Err(format!(
                "split: 1 to {MAX_BENEFICIARIES} beneficiaries (use null to remove the split)"
            ));
        }
        let mut total: u32 = 0;
        for (i, share) in self.beneficiaries.iter().enumerate() {
            if share.bps == 0 {
                return Err("split: every share must be > 0 bps".into());
            }
            if &share.account_id == vault {
                return Err("split: the vault cannot be its own beneficiary".into());
            }
            if self.beneficiaries[..i]
                .iter()
                .any(|s| s.account_id == share.account_id)
            {
                return Err("split: duplicate beneficiary".into());
            }
            total += u32::from(share.bps);
        }
        if total > BPS_DENOMINATOR {
            return Err("split: shares add up to more than 100% (10000 bps)".into());
        }
        Ok(())
    }

    /// Shares of `amount` (rounded down; zero shares are skipped). The vault
    /// keeps `amount - sum(shares)`.
    pub fn payouts(&self, amount: u128) -> Vec<SplitPayout> {
        self.beneficiaries
            .iter()
            .filter_map(|share| {
                let bps = u128::from(share.bps);
                let value = amount
                    .checked_mul(bps)
                    .map(|v| v / u128::from(BPS_DENOMINATOR))
                    .unwrap_or_else(|| amount / u128::from(BPS_DENOMINATOR) * bps);
                (value > 0).then(|| SplitPayout {
                    account_id: share.account_id.clone(),
                    bps: share.bps,
                    amount: NearToken::from_yoctonear(value),
                    status: SplitStatus::Pending,
                })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }
    fn split(shares: &[(&str, u16)]) -> Split {
        Split {
            beneficiaries: shares
                .iter()
                .map(|(a, bps)| SplitShare {
                    account_id: acc(a),
                    bps: *bps,
                })
                .collect(),
        }
    }

    #[test]
    fn payouts_round_down_and_skip_zero_shares() {
        let s = split(&[("carol.test", 1_000), ("dave.test", 500)]);
        let p = s.payouts(1_000_000);
        assert_eq!(p.len(), 2);
        assert_eq!(p[0].amount, NearToken::from_yoctonear(100_000));
        assert_eq!(p[1].amount, NearToken::from_yoctonear(50_000));
        assert!(p.iter().all(|x| x.status == SplitStatus::Pending));
        // 5% of 19 base units is 0.95: nothing to forward.
        assert_eq!(s.payouts(19).len(), 1);
        // No overflow on huge amounts.
        assert_eq!(
            s.payouts(u128::MAX)[0].amount.as_yoctonear(),
            u128::MAX / 10_000 * 1_000
        );
    }

    #[test]
    fn validation() {
        let vault = acc("vault.test");
        assert!(split(&[("carol.test", 1_000)]).validate(&vault).is_ok());
        assert!(split(&[("carol.test", 10_000)]).validate(&vault).is_ok());
        assert!(split(&[]).validate(&vault).is_err());
        assert!(split(&[("carol.test", 0)]).validate(&vault).is_err());
        assert!(
            split(&[("carol.test", 6_000), ("dave.test", 5_000)])
                .validate(&vault)
                .is_err()
        );
        assert!(split(&[("vault.test", 100)]).validate(&vault).is_err());
        assert!(
            split(&[("carol.test", 100), ("carol.test", 100)])
                .validate(&vault)
                .is_err()
        );
        assert!(
            split(&[
                ("a.test", 1),
                ("b.test", 1),
                ("c.test", 1),
                ("d.test", 1),
                ("e.test", 1)
            ])
            .validate(&vault)
            .is_err()
        );
    }
}
