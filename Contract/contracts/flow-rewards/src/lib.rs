#![no_std]
//! `FlowRewards` releases rewards to verified submitters and verifiers.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Env, Map, Symbol,
    Vec,
};

/// Supported reward roles.
pub const ROLE_SUBMITTER: Symbol = symbol_short!("submitter");
pub const ROLE_VERIFIER: Symbol = symbol_short!("verifier");

/// Maximum number of grants accepted by one `grant_batch` call.
pub const MAX_BATCH: u32 = 20;
/// Maximum number of per-grant records retained at a time.
pub const MAX_GRANT_HISTORY: u32 = 100;
/// Maximum records that one archival call may process.
pub const MAX_ARCHIVE_BATCH: u32 = 20;

const HISTORY_TTL_THRESHOLD: u32 = 100;
const HISTORY_TTL_EXTEND_TO: u32 = 500_000;
const INSTANCE_TTL_THRESHOLD: u32 = 100;
const INSTANCE_TTL_EXTEND_TO: u32 = 500_000;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    InvalidAmount = 1,
    UnsupportedRole = 2,
    DuplicateGrant = 3,
    NothingToClaim = 4,
    InsufficientTreasury = 5,
    InsufficientClaimable = 6,
    GrantNotFound = 7,
    GrantAlreadyClaimed = 8,
    GrantAlreadyRevoked = 9,
    HistoryFull = 10,
    GrantIdNotSequential = 11,
    InvalidArchiveLimit = 12,
    ArithmeticOverflow = 13,
    InvalidBatchSize = 14,
    /// A grant batch is empty or larger than `MAX_BATCH`.
    InvalidBatchSize = 10,
    /// The caller is not authorized to perform the admin operation.
    Unauthorized = 11,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Granted,
    Claimed,
    Treasury,
    GrantId(u64),
    GrantRecord(u64),
    GrantIds,
    FirstGrantId,
    LastGrantId,
    LegacyMaxGrantId,
    ArchivedTotals,
    Admin,
    /// The current rewards admin.
    Admin,
    /// The proposed rewards admin awaiting acceptance.
    PendingAdmin,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GrantRecord {
    pub recipient: Address,
    pub asset: Address,
    pub amount: i128,
    pub claimed: i128,
    pub revoked: i128,
}

/// Lifetime sums for detailed grant records already archived.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArchivedTotals {
    pub grant_count: u64,
    pub granted: i128,
    pub claimed: i128,
    pub revoked: i128,
}

impl ArchivedTotals {
    fn zero() -> Self {
        Self {
            grant_count: 0,
            granted: 0,
            claimed: 0,
            revoked: 0,
        }
    }
}

#[contract]
pub struct FlowRewards;

fn balances(env: &Env, key: &DataKey) -> Map<(Address, Address), i128> {
    env.storage()
        .instance()
        .get(key)
        .unwrap_or_else(|| Map::new(env))
}

fn treasury(env: &Env) -> Map<Address, i128> {
    env.storage()
        .instance()
        .get(&DataKey::Treasury)
        .unwrap_or_else(|| Map::new(env))
}

fn grant_ids(env: &Env) -> Vec<u64> {
    env.storage()
        .persistent()
        .get(&DataKey::GrantIds)
        .unwrap_or_else(|| Vec::new(env))
}

fn extend_history_ttl(env: &Env, key: &DataKey) {
    env.storage().persistent().extend_ttl(
        key,
        HISTORY_TTL_THRESHOLD,
        HISTORY_TTL_EXTEND_TO,
    );
}

fn extend_instance_ttl(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND_TO);
    if env.storage().persistent().has(&DataKey::GrantIds) {
        extend_history_ttl(env, &DataKey::GrantIds);
    }
}

fn add_to_archived_totals(
    env: &Env,
    record: &GrantRecord,
) -> Result<(), Error> {
    let mut totals: Map<(Address, Address), ArchivedTotals> = env
        .storage()
        .instance()
        .get(&DataKey::ArchivedTotals)
        .unwrap_or_else(|| Map::new(env));
    let key = (record.recipient.clone(), record.asset.clone());
    let mut value = totals.get(key.clone()).unwrap_or_else(ArchivedTotals::zero);
    value.grant_count = value
        .grant_count
        .checked_add(1)
        .ok_or(Error::ArithmeticOverflow)?;
    value.granted = value
        .granted
        .checked_add(record.amount)
        .ok_or(Error::ArithmeticOverflow)?;
    value.claimed = value
        .claimed
        .checked_add(record.claimed)
        .ok_or(Error::ArithmeticOverflow)?;
    value.revoked = value
        .revoked
        .checked_add(record.revoked)
        .ok_or(Error::ArithmeticOverflow)?;
    totals.set(key, value);
    env.storage()
        .instance()
        .set(&DataKey::ArchivedTotals, &totals);
    Ok(())
}

fn archive_settled(env: &Env, limit: u32) -> Result<u32, Error> {
    let ids = grant_ids(env);
    let first_new_id: Option<u64> = env.storage().instance().get(&DataKey::FirstGrantId);
    let mut retained = Vec::new(env);
    let mut archived = 0;

    for grant_id in ids.iter() {
        let key = DataKey::GrantRecord(grant_id);
        let record: Option<GrantRecord> = env.storage().persistent().get(&key);
        match record {
            Some(record)
                if archived < limit
                    && record.claimed + record.revoked == record.amount =>
            {
                add_to_archived_totals(env, &record)?;
                env.storage().persistent().remove(&key);
                if first_new_id.is_some_and(|first| grant_id >= first) {
                    env.storage()
                        .persistent()
                        .remove(&DataKey::GrantId(grant_id));
                }
                archived += 1;
            }
            Some(_) => retained.push_back(grant_id),
            None => {
                if first_new_id.is_some_and(|first| grant_id >= first) {
                    env.storage()
                        .persistent()
                        .remove(&DataKey::GrantId(grant_id));
                }
            }
        }
    }

    env.storage()
        .persistent()
        .set(&DataKey::GrantIds, &retained);
    extend_history_ttl(env, &DataKey::GrantIds);
    Ok(archived)
}

#[contractimpl]
impl FlowRewards {
    /// Add funds to the treasury for `asset`.
    pub fn fund_treasury(
        env: Env,
        admin: Address,
        asset: Address,
        amount: i128,
    ) -> Result<(), Error> {
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        admin.require_auth();
        extend_instance_ttl(&env);

        let mut funds = treasury(&env);
        let current = funds.get(asset.clone()).unwrap_or(0);
        let updated = current.checked_add(amount).ok_or(Error::ArithmeticOverflow)?;
        funds.set(asset, updated);
        env.storage().instance().set(&DataKey::Treasury, &funds);
        Ok(())
    }

    /// Record a reward grant to a verified participant.
    ///
    /// The first grant ID may be any value; subsequent IDs must increase by
    /// exactly one. This compact sequence watermark prevents replay after an
    /// individual ID marker has been removed during archival.
    pub fn grant(
        env: Env,
        admin: Address,
        recipient: Address,
        asset: Address,
        role: Symbol,
        amount: i128,
        grant_id: u64,
    ) -> Result<(), Error> {
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if !Self::is_supported_role(&role) {
            return Err(Error::UnsupportedRole);
        }
        admin.require_auth();
        extend_instance_ttl(&env);

        Self::apply_grant(&env, recipient, asset, amount, grant_id)
    }

    /// Record up to `MAX_BATCH` grants in one call. Entries must use
    /// consecutive grant IDs, and any failing entry aborts the whole batch.
    pub fn grant_batch(
        env: Env,
        admin: Address,
        entries: Vec<(Address, Symbol, Address, i128, u64)>,
    ) -> Result<(), Error> {
        if entries.is_empty() || entries.len() > MAX_BATCH {
            return Err(Error::InvalidBatchSize);
        }
        admin.require_auth();
        extend_instance_ttl(&env);

        for (recipient, role, asset, amount, grant_id) in entries.iter() {
            if amount <= 0 {
                return Err(Error::InvalidAmount);
            }
            if !Self::is_supported_role(&role) {
                return Err(Error::UnsupportedRole);
            }
            Self::apply_grant(&env, recipient, asset, amount, grant_id)?;
        }
        Ok(())
    }

    /// Archive up to `limit` settled grant records. Anyone may call this
    /// storage-maintenance operation; active claimable amounts are never
    /// archived.
    pub fn archive_history(env: Env, limit: u32) -> Result<u32, Error> {
        if limit == 0 || limit > MAX_ARCHIVE_BATCH {
            return Err(Error::InvalidArchiveLimit);
        }
        extend_instance_ttl(&env);

        // Preserve the legacy ID high-water mark before pruning the old index.
        let last_grant_id: Option<u64> =
            env.storage().instance().get(&DataKey::LastGrantId);
        if last_grant_id.is_none() {
            if let Some(max_id) = max_grant_id(&grant_ids(&env)) {
                env.storage()
                    .instance()
                    .set(&DataKey::LegacyMaxGrantId, &max_id);
            }
        }
        archive_settled(&env, limit)
    }

    /// Set the rewards admin and emit an `("admin", "changed")` event.
    pub fn set_admin(env: Env, new_admin: Address) {
        extend_instance_ttl(&env);
    /// Set the initial rewards admin. Later changes must use the two-step
    /// proposal and acceptance flow.
    pub fn set_admin(env: Env, new_admin: Address) -> Result<(), Error> {
        let old: Option<Address> = env.storage().instance().get(&DataKey::Admin);
        if old.is_some() {
            return Err(Error::Unauthorized);
        }
        new_admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        env.events().publish(
            (symbol_short!("admin"), symbol_short!("changed")),
            (old, new_admin),
        );
        Ok(())
    }

    /// Propose `new_admin` as the next rewards admin. The active admin remains
    /// unchanged until the proposed address accepts; a new proposal replaces
    /// any earlier pending proposal.
    pub fn propose_admin(env: Env, admin: Address, new_admin: Address) -> Result<(), Error> {
        admin.require_auth();
        let current: Option<Address> = env.storage().instance().get(&DataKey::Admin);
        match current {
            Some(current) if current == admin => {
                env.storage()
                    .instance()
                    .set(&DataKey::PendingAdmin, &new_admin);
                Ok(())
            }
            _ => Err(Error::Unauthorized),
        }
    }

    /// Accept the pending rewards admin proposal. Only the proposed address
    /// can accept, and acceptance clears the pending proposal.
    pub fn accept_admin(env: Env, new_admin: Address) -> Result<(), Error> {
        new_admin.require_auth();
        let pending: Option<Address> = env.storage().instance().get(&DataKey::PendingAdmin);
        match pending {
            Some(pending) if pending == new_admin => {
                let old: Option<Address> = env.storage().instance().get(&DataKey::Admin);
                env.storage().instance().set(&DataKey::Admin, &new_admin);
                env.storage().instance().remove(&DataKey::PendingAdmin);
                env.events().publish(
                    (symbol_short!("admin"), symbol_short!("changed")),
                    (old, new_admin),
                );
                Ok(())
            }
            _ => Err(Error::Unauthorized),
        }
    }

    /// The rewards admin awaiting acceptance, if one has been proposed.
    pub fn pending_admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::PendingAdmin)
    }

    /// The current rewards admin, if one has been set.
    pub fn admin(env: Env) -> Option<Address> {
        extend_instance_ttl(&env);
        env.storage().instance().get(&DataKey::Admin)
    }

    /// Claim part or all of the recipient's claimable balance for `asset`.
    pub fn claim(
        env: Env,
        recipient: Address,
        asset: Address,
        amount: i128,
    ) -> Result<(), Error> {
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        recipient.require_auth();
        extend_instance_ttl(&env);
        if amount > Self::claimable(env.clone(), recipient.clone(), asset.clone()) {
            return Err(Error::InsufficientClaimable);
        }

        let mut remaining = amount;
        for grant_id in grant_ids(&env).iter() {
            if remaining == 0 {
                break;
            }
            let key = DataKey::GrantRecord(grant_id);
            let Some(mut record): Option<GrantRecord> =
                env.storage().persistent().get(&key)
            else {
                continue;
            };
            if record.recipient != recipient || record.asset != asset {
                continue;
            }

            let unclaimed = record.amount - record.claimed - record.revoked;
            let claimed = remaining.min(unclaimed);
            if claimed > 0 {
                record.claimed += claimed;
                remaining -= claimed;
                env.storage().persistent().set(&key, &record);
                extend_history_ttl(&env, &key);
            }
        }

        let mut claimed = balances(&env, &DataKey::Claimed);
        let balance_key = (recipient, asset);
        let current = claimed.get(balance_key.clone()).unwrap_or(0);
        let updated = current.checked_add(amount).ok_or(Error::ArithmeticOverflow)?;
        claimed.set(balance_key, updated);
        env.storage().instance().set(&DataKey::Claimed, &claimed);
        Ok(())
    }

    /// Revoke the unclaimed portion of a grant and return it to the treasury.
    pub fn revoke(env: Env, admin: Address, grant_id: u64) -> Result<i128, Error> {
        admin.require_auth();
        extend_instance_ttl(&env);

        let key = DataKey::GrantRecord(grant_id);
        let mut record: GrantRecord = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::GrantNotFound)?;
        let amount = record.amount - record.claimed - record.revoked;
        if amount == 0 {
            if record.claimed == record.amount {
                return Err(Error::GrantAlreadyClaimed);
            }
            return Err(Error::GrantAlreadyRevoked);
        }

        let mut granted = balances(&env, &DataKey::Granted);
        let balance_key = (record.recipient.clone(), record.asset.clone());
        let current = granted.get(balance_key.clone()).unwrap_or(0);
        let updated = current.checked_sub(amount).ok_or(Error::ArithmeticOverflow)?;
        granted.set(balance_key, updated);

        let mut funds = treasury(&env);
        let available = funds.get(record.asset.clone()).unwrap_or(0);
        let updated = available.checked_add(amount).ok_or(Error::ArithmeticOverflow)?;
        funds.set(record.asset.clone(), updated);
        record.revoked += amount;

        env.storage().instance().set(&DataKey::Granted, &granted);
        env.storage().instance().set(&DataKey::Treasury, &funds);
        env.storage().persistent().set(&key, &record);
        extend_history_ttl(&env, &key);
        Ok(amount)
    }

    /// Total rewards granted to `recipient` in `asset`, excluding revoked amounts.
    pub fn total_granted(env: Env, recipient: Address, asset: Address) -> i128 {
        extend_instance_ttl(&env);
        balances(&env, &DataKey::Granted)
            .get((recipient, asset))
            .unwrap_or(0)
    }

    /// Total rewards claimed by `recipient` in `asset`.
    pub fn total_claimed(env: Env, recipient: Address, asset: Address) -> i128 {
        extend_instance_ttl(&env);
        balances(&env, &DataKey::Claimed)
            .get((recipient, asset))
            .unwrap_or(0)
    }

    /// Rewards earned but not yet claimed.
    pub fn claimable(env: Env, recipient: Address, asset: Address) -> i128 {
        extend_instance_ttl(&env);
        Self::total_granted(env.clone(), recipient.clone(), asset.clone())
            - Self::total_claimed(env, recipient, asset)
    }

    /// Treasury funds available for new grants in `asset`.
    pub fn treasury_balance(env: Env, asset: Address) -> i128 {
        extend_instance_ttl(&env);
        treasury(&env).get(asset).unwrap_or(0)
    }

    /// Whether a grant ID has already been processed, including archived IDs.
    pub fn is_grant_processed(env: Env, grant_id: u64) -> bool {
        extend_instance_ttl(&env);
        if env
            .storage()
            .persistent()
            .has(&DataKey::GrantId(grant_id))
        {
            return true;
        }
        let first: Option<u64> = env.storage().instance().get(&DataKey::FirstGrantId);
        let last: Option<u64> = env.storage().instance().get(&DataKey::LastGrantId);
        matches!((first, last), (Some(first), Some(last)) if grant_id >= first && grant_id <= last)
    }

    /// Cumulative totals for archived records belonging to `recipient` and `asset`.
    pub fn archived_totals(env: Env, recipient: Address, asset: Address) -> ArchivedTotals {
        extend_instance_ttl(&env);
        env.storage()
            .instance()
            .get::<_, Map<(Address, Address), ArchivedTotals>>(&DataKey::ArchivedTotals)
            .and_then(|totals| totals.get((recipient, asset)))
            .unwrap_or_else(ArchivedTotals::zero)
    }

    /// Amount revoked from a grant while its detailed record is retained.
    /// Returns zero when that detail has expired or been archived.
    pub fn revoked_amount(env: Env, grant_id: u64) -> i128 {
        extend_instance_ttl(&env);
        let record: Option<GrantRecord> = env
            .storage()
            .persistent()
            .get(&DataKey::GrantRecord(grant_id));
        record.map(|record| record.revoked).unwrap_or(0)
    }
}

impl FlowRewards {
    fn apply_grant(
        env: &Env,
        recipient: Address,
        asset: Address,
        amount: i128,
        grant_id: u64,
    ) -> Result<(), Error> {
        if Self::is_grant_processed(env.clone(), grant_id) {
            return Err(Error::DuplicateGrant);
        }

        let (first_id, last_id) = Self::next_sequence_ids(env, grant_id)?;
        let mut ids = grant_ids(env);
        if ids.len() >= MAX_GRANT_HISTORY {
            archive_settled(env, 1)?;
            ids = grant_ids(env);
            if ids.len() >= MAX_GRANT_HISTORY {
                return Err(Error::HistoryFull);
            }
        }

        let mut funds = treasury(env);
        let available = funds.get(asset.clone()).unwrap_or(0);
        if amount > available {
            return Err(Error::InsufficientTreasury);
        }

        let mut granted = balances(env, &DataKey::Granted);
        let balance_key = (recipient.clone(), asset.clone());
        let current = granted.get(balance_key.clone()).unwrap_or(0);
        let updated = current.checked_add(amount).ok_or(Error::ArithmeticOverflow)?;
        granted.set(balance_key, updated);

        funds.set(asset.clone(), available - amount);
        env.storage().instance().set(&DataKey::Treasury, &funds);
        env.storage().instance().set(&DataKey::Granted, &granted);
        env.storage()
            .instance()
            .set(&DataKey::FirstGrantId, &first_id);
        env.storage()
            .instance()
            .set(&DataKey::LastGrantId, &last_id);

        let record_key = DataKey::GrantRecord(grant_id);
        env.storage().persistent().set(
            &record_key,
            &GrantRecord {
                recipient,
                asset,
                amount,
                claimed: 0,
                revoked: 0,
            },
        );
        extend_history_ttl(env, &record_key);
        env.storage()
            .persistent()
            .set(&DataKey::GrantId(grant_id), &true);
        extend_history_ttl(env, &DataKey::GrantId(grant_id));
        ids.push_back(grant_id);
        env.storage()
            .persistent()
            .set(&DataKey::GrantIds, &ids);
        extend_history_ttl(env, &DataKey::GrantIds);
        Ok(())
    }

    fn next_sequence_ids(env: &Env, grant_id: u64) -> Result<(u64, u64), Error> {
        let last: Option<u64> = env.storage().instance().get(&DataKey::LastGrantId);
        if let Some(last) = last {
            let next = last.checked_add(1).ok_or(Error::GrantIdNotSequential)?;
            if grant_id != next {
                return Err(Error::GrantIdNotSequential);
            }
            let first: u64 = env
                .storage()
                .instance()
                .get(&DataKey::FirstGrantId)
                .unwrap_or(grant_id);
            return Ok((first, grant_id));
        }

        let legacy_max: Option<u64> = env
            .storage()
            .instance()
            .get(&DataKey::LegacyMaxGrantId)
            .or_else(|| max_grant_id(&grant_ids(env)));
        if let Some(max_id) = legacy_max {
            let next = max_id.checked_add(1).ok_or(Error::GrantIdNotSequential)?;
            if grant_id != next {
                return Err(Error::GrantIdNotSequential);
            }
            env.storage()
                .instance()
                .set(&DataKey::LegacyMaxGrantId, &max_id);
        }
        Ok((grant_id, grant_id))
    }

    fn is_supported_role(role: &Symbol) -> bool {
        *role == ROLE_SUBMITTER || *role == ROLE_VERIFIER
    }
}

fn max_grant_id(ids: &Vec<u64>) -> Option<u64> {
    let mut max_id = None;
    for id in ids.iter() {
        max_id = Some(max_id.map_or(id, |current: u64| current.max(id)));
    }
    max_id
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    #[test]
    fn normal_record_claim_and_archived_totals_remain_consistent() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(FlowRewards, ());
        let client = FlowRewardsClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let recipient = Address::generate(&env);
        let asset = Address::generate(&env);

        client.fund_treasury(&admin, &asset, &100);
        client.grant(&admin, &recipient, &asset, &ROLE_SUBMITTER, &40, &50);
        assert_eq!(client.total_granted(&recipient, &asset), 40);
        assert_eq!(client.claimable(&recipient, &asset), 40);
        client.claim(&recipient, &asset, &40);
        assert_eq!(client.total_claimed(&recipient, &asset), 40);

        assert_eq!(client.archive_history(&1), 1);
        assert_eq!(
            client.archived_totals(&recipient, &asset),
            ArchivedTotals {
                grant_count: 1,
                granted: 40,
                claimed: 40,
                revoked: 0,
            }
        );
        assert_eq!(client.total_granted(&recipient, &asset), 40);
        assert_eq!(client.total_claimed(&recipient, &asset), 40);
        assert!(client.is_grant_processed(&50));
    }

    #[test]
    fn active_records_fill_the_limit_without_changing_claimable_rewards() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(FlowRewards, ());
        let client = FlowRewardsClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let recipient = Address::generate(&env);
        let asset = Address::generate(&env);

        client.fund_treasury(&admin, &asset, &(MAX_GRANT_HISTORY as i128 + 1));
        for id in 1..=MAX_GRANT_HISTORY {
            client.grant(&admin, &recipient, &asset, &ROLE_SUBMITTER, &1, &(id as u64));
        }

        assert_eq!(
            client.try_grant(
                &admin,
                &recipient,
                &asset,
                &ROLE_SUBMITTER,
                &1,
                &((MAX_GRANT_HISTORY + 1) as u64)
            ),
            Err(Ok(Error::HistoryFull))
        );
        assert_eq!(
            client.total_granted(&recipient, &asset),
            MAX_GRANT_HISTORY as i128
        );
        assert_eq!(
            client.claimable(&recipient, &asset),
            MAX_GRANT_HISTORY as i128
        );
    }

    #[test]
    fn auto_archival_bounds_multiple_settled_reward_cycles() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(FlowRewards, ());
        let client = FlowRewardsClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let recipient = Address::generate(&env);
        let asset = Address::generate(&env);

        client.fund_treasury(&admin, &asset, &150);
        for id in 1..=150u64 {
            client.grant(&admin, &recipient, &asset, &ROLE_SUBMITTER, &1, &id);
            client.claim(&recipient, &asset, &1);
        }

        assert_eq!(client.total_granted(&recipient, &asset), 150);
        assert_eq!(client.total_claimed(&recipient, &asset), 150);
        assert_eq!(client.claimable(&recipient, &asset), 0);
        assert_eq!(
            client.archived_totals(&recipient, &asset).grant_count,
            50
        );
        assert_eq!(client.archived_totals(&recipient, &asset).granted, 50);
        assert!(client.is_grant_processed(&1));
        assert!(client.is_grant_processed(&150));
    }

    #[test]
    fn repeated_archival_does_not_double_count() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(FlowRewards, ());
        let client = FlowRewardsClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let recipient = Address::generate(&env);
        let asset = Address::generate(&env);

        client.fund_treasury(&admin, &asset, &10);
        client.grant(&admin, &recipient, &asset, &ROLE_SUBMITTER, &10, &1);
        client.claim(&recipient, &asset, &10);
        assert_eq!(client.archive_history(&1), 1);
        assert_eq!(client.archive_history(&1), 0);

        let totals = client.archived_totals(&recipient, &asset);
        assert_eq!(totals.grant_count, 1);
        assert_eq!(totals.granted, 10);
        assert_eq!(totals.claimed, 10);
    }

    #[test]
    fn archived_revocations_preserve_net_reward_totals() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(FlowRewards, ());
        let client = FlowRewardsClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let recipient = Address::generate(&env);
        let asset = Address::generate(&env);

        client.fund_treasury(&admin, &asset, &10);
        client.grant(&admin, &recipient, &asset, &ROLE_SUBMITTER, &10, &1);
        assert_eq!(client.revoke(&admin, &1), 10);
        assert_eq!(client.total_granted(&recipient, &asset), 0);
        assert_eq!(client.archive_history(&1), 1);

        let totals = client.archived_totals(&recipient, &asset);
        assert_eq!(totals.granted, 10);
        assert_eq!(totals.revoked, 10);
        assert_eq!(client.total_granted(&recipient, &asset), 0);
        assert_eq!(client.claimable(&recipient, &asset), 0);
    }

    #[test]
    fn grant_ids_must_be_sequential_after_the_first_grant() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(FlowRewards, ());
        let client = FlowRewardsClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let recipient = Address::generate(&env);
        let asset = Address::generate(&env);

        client.fund_treasury(&admin, &asset, &10);
        client.grant(&admin, &recipient, &asset, &ROLE_SUBMITTER, &1, &9);
        assert_eq!(
            client.try_grant(&admin, &recipient, &asset, &ROLE_SUBMITTER, &1, &11),
            Err(Ok(Error::GrantIdNotSequential))
        );
        assert_eq!(client.total_granted(&recipient, &asset), 1);
    }

    #[test]
    fn missing_detail_does_not_block_aggregate_claims() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(FlowRewards, ());
        let client = FlowRewardsClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let recipient = Address::generate(&env);
        let asset = Address::generate(&env);

        client.fund_treasury(&admin, &asset, &10);
        client.grant(&admin, &recipient, &asset, &ROLE_SUBMITTER, &10, &1);
        env.as_contract(&contract_id, || {
            env.storage()
                .persistent()
                .remove(&DataKey::GrantRecord(1));
        });

        client.claim(&recipient, &asset, &10);
        assert_eq!(client.total_claimed(&recipient, &asset), 10);
        assert_eq!(
            client.try_revoke(&admin, &1),
            Err(Ok(Error::GrantNotFound))
        );
    }
}
