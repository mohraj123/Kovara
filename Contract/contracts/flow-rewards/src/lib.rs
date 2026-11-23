#![no_std]
//! FlowRewards: grant, claim, revoke, archive, administer, and pause reward grants.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Env, Map,
    Symbol, Vec,
};

pub const ROLE_SUBMITTER: Symbol = symbol_short!("submitter");
pub const ROLE_VERIFIER: Symbol = symbol_short!("verifier");
pub const MAX_BATCH: u32 = 20;
pub const MAX_GRANT_HISTORY: u32 = 100;
pub const MAX_ARCHIVE_BATCH: u32 = 20;
pub const MAX_HISTORY_PAGE_SIZE: u32 = 50;

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
    InvalidBatchSize = 7,
    GrantNotFound = 8,
    GrantAlreadyClaimed = 9,
    GrantAlreadyRevoked = 10,
    InvalidPageSize = 11,
    HistoryFull = 12,
    GrantIdNotSequential = 13,
    InvalidArchiveLimit = 14,
    ArithmeticOverflow = 15,
    Unauthorized = 16,
    GrantsPaused = 17,
    GrantPaused = 18,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Granted,
    /// Lifetime granted per `(recipient, role, asset)`, net of revocations.
    /// Kept alongside `Granted` so the aggregate view keeps its original
    /// key layout and meaning: the aggregate is the sum over all roles.
    GrantedByRole,
    Claimed,
    Treasury,
    GrantId(u64),
    GrantRecord(u64),
    /// Role attached to a grant at creation time, so a later revocation can
    /// reduce the same role's total rather than an unrelated one.
    GrantRole(u64),
    Admin,
    PendingAdmin,
    RecipientIndex(Address),
    GrantIds,
    FirstGrantId,
    LastGrantId,
    ArchivedTotals,
    Paused,
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
        Self { grant_count: 0, granted: 0, claimed: 0, revoked: 0 }
    }
}

#[contract]
pub struct FlowRewards;

fn balances(env: &Env, key: &DataKey) -> Map<(Address, Address), i128> {
    env.storage().instance().get(key).unwrap_or_else(|| Map::new(env))
}

fn role_balances(env: &Env) -> Map<(Address, Symbol, Address), i128> {
    env.storage()
        .instance()
        .get(&DataKey::GrantedByRole)
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

fn extend_instance_ttl(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND_TO);
}

fn extend_history_ttl(env: &Env, key: &DataKey) {
    env.storage().persistent().extend_ttl(
        key,
        HISTORY_TTL_THRESHOLD,
        HISTORY_TTL_EXTEND_TO,
    );
}

fn push_recipient_index(env: &Env, recipient: &Address, grant_id: u64) {
    let key = DataKey::RecipientIndex(recipient.clone());
    let mut index: Vec<u64> = env
        .storage()
        .persistent()
        .get(&key)
        .unwrap_or_else(|| Vec::new(env));
    index.push_back(grant_id);
    env.storage().persistent().set(&key, &index);
    extend_history_ttl(env, &key);
}

#[contractimpl]
impl FlowRewards {
    pub fn fund_treasury(
        env: Env,
        admin: Address,
        asset: Address,
        amount: i128,
    ) -> Result<(), Error> {
        if amount <= 0 { return Err(Error::InvalidAmount); }
        admin.require_auth();
        Self::require_admin_if_configured(&env, &admin)?;
        extend_instance_ttl(&env);

        let mut funds = treasury(&env);
        let current = funds.get(asset.clone()).unwrap_or(0);
        let updated = current.checked_add(amount).ok_or(Error::ArithmeticOverflow)?;
        funds.set(asset, updated);
        env.storage().instance().set(&DataKey::Treasury, &funds);
        Ok(())
    }

    pub fn grant(
        env: Env,
        admin: Address,
        recipient: Address,
        asset: Address,
        role: Symbol,
        amount: i128,
        grant_id: u64,
    ) -> Result<(), Error> {
        if amount <= 0 { return Err(Error::InvalidAmount); }
        if !Self::is_supported_role(&role) { return Err(Error::UnsupportedRole); }
        admin.require_auth();
        Self::require_admin_if_configured(&env, &admin)?;
        Self::require_grants_not_paused(&env)?;
        extend_instance_ttl(&env);
        Self::apply_grant(&env, recipient, asset, role, amount, grant_id)
    }

    pub fn grant_batch(
        env: Env,
        admin: Address,
        entries: Vec<(Address, Symbol, Address, i128, u64)>,
    ) -> Result<(), Error> {
        if entries.is_empty() || entries.len() > MAX_BATCH {
            return Err(Error::InvalidBatchSize);
        }
        admin.require_auth();
        Self::require_admin_if_configured(&env, &admin)?;
        Self::require_grants_not_paused(&env)?;
        extend_instance_ttl(&env);

        for (recipient, role, asset, amount, grant_id) in entries.iter() {
            if amount <= 0 { return Err(Error::InvalidAmount); }
            if !Self::is_supported_role(&role) { return Err(Error::UnsupportedRole); }
            Self::apply_grant(&env, recipient, asset, role, amount, grant_id)?;
        }
        Ok(())
    }

    /// Pause new reward grants. Existing balances and totals are unchanged.
    pub fn pause_grants(env: Env, admin: Address) -> Result<(), Error> {
        admin.require_auth();
        Self::require_active_admin(&env, &admin)?;
        env.storage().instance().set(&DataKey::Paused, &true);
        extend_instance_ttl(&env);
        env.events().publish(
            (symbol_short!("grants"), symbol_short!("paused")),
            (admin, true),
        );
        Ok(())
    }

    /// Resume reward grants. Pausing has no effect on lifetime totals.
    pub fn resume_grants(env: Env, admin: Address) -> Result<(), Error> {
        admin.require_auth();
        Self::require_active_admin(&env, &admin)?;
        env.storage().instance().set(&DataKey::Paused, &false);
        extend_instance_ttl(&env);
        env.events().publish(
            (symbol_short!("grants"), symbol_short!("paused")),
            (admin, false),
        );
        Ok(())
    }

    pub fn pause(env: Env, admin: Address) -> Result<(), Error> {
        Self::pause_grants(env, admin)
    }

    pub fn resume(env: Env, admin: Address) -> Result<(), Error> {
        Self::resume_grants(env, admin)
    }

    pub fn unpause(env: Env, admin: Address) -> Result<(), Error> {
        Self::resume_grants(env, admin)
    }

    pub fn grants_paused(env: Env) -> bool {
        extend_instance_ttl(&env);
        env.storage().instance().get(&DataKey::Paused).unwrap_or(false)
    }

    pub fn is_paused(env: Env) -> bool {
        Self::grants_paused(env)
    }

    pub fn set_admin(env: Env, new_admin: Address) -> Result<(), Error> {
        let old: Option<Address> = env.storage().instance().get(&DataKey::Admin);
        if old.is_some() { return Err(Error::Unauthorized); }
        new_admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        extend_instance_ttl(&env);
        env.events().publish(
            (symbol_short!("admin"), symbol_short!("changed")),
            (old, new_admin),
        );
        Ok(())
    }

    pub fn propose_admin(env: Env, admin: Address, new_admin: Address) -> Result<(), Error> {
        admin.require_auth();
        Self::require_active_admin(&env, &admin)?;
        env.storage().instance().set(&DataKey::PendingAdmin, &new_admin);
        extend_instance_ttl(&env);
        Ok(())
    }

    pub fn accept_admin(env: Env, new_admin: Address) -> Result<(), Error> {
        new_admin.require_auth();
        let pending: Option<Address> = env.storage().instance().get(&DataKey::PendingAdmin);
        match pending {
            Some(pending) if pending == new_admin => {
                let old: Option<Address> = env.storage().instance().get(&DataKey::Admin);
                env.storage().instance().set(&DataKey::Admin, &new_admin);
                env.storage().instance().remove(&DataKey::PendingAdmin);
                extend_instance_ttl(&env);
                env.events().publish(
                    (symbol_short!("admin"), symbol_short!("changed")),
                    (old, new_admin),
                );
                Ok(())
            }
            _ => Err(Error::Unauthorized),
        }
    }

    pub fn pending_admin(env: Env) -> Option<Address> {
        extend_instance_ttl(&env);
        env.storage().instance().get(&DataKey::PendingAdmin)
    }

    pub fn admin(env: Env) -> Option<Address> {
        extend_instance_ttl(&env);
        env.storage().instance().get(&DataKey::Admin)
    }

    pub fn archive_history(env: Env, limit: u32) -> Result<u32, Error> {
        if limit == 0 || limit > MAX_ARCHIVE_BATCH { return Err(Error::InvalidArchiveLimit); }
        extend_instance_ttl(&env);
        let mut ids = grant_ids(&env);
        let mut retained = Vec::new(&env);
        let mut archived = 0u32;

        for grant_id in ids.iter() {
            let key = DataKey::GrantRecord(grant_id);
            match env.storage().persistent().get::<_, GrantRecord>(&key) {
                Some(record) if archived < limit && record.claimed.checked_add(record.revoked).unwrap_or(i128::MAX) == record.amount => {
                    let mut totals: Map<(Address, Address), ArchivedTotals> = env
                        .storage().instance().get(&DataKey::ArchivedTotals)
                        .unwrap_or_else(|| Map::new(&env));
                    let balance_key = (record.recipient.clone(), record.asset.clone());
                    let mut value = totals.get(balance_key.clone()).unwrap_or_else(ArchivedTotals::zero);
                    value.grant_count = value.grant_count.checked_add(1).ok_or(Error::ArithmeticOverflow)?;
                    value.granted = value.granted.checked_add(record.amount).ok_or(Error::ArithmeticOverflow)?;
                    value.claimed = value.claimed.checked_add(record.claimed).ok_or(Error::ArithmeticOverflow)?;
                    value.revoked = value.revoked.checked_add(record.revoked).ok_or(Error::ArithmeticOverflow)?;
                    totals.set(balance_key, value);
                    env.storage().instance().set(&DataKey::ArchivedTotals, &totals);
                    env.storage().persistent().remove(&key);
                    env.storage().persistent().remove(&DataKey::GrantId(grant_id));
                    env.storage().persistent().remove(&DataKey::GrantRole(grant_id));
                    archived += 1;
                }
                Some(_) => retained.push_back(grant_id),
                None => {}
            }
        }
        env.storage().persistent().set(&DataKey::GrantIds, &retained);
        extend_history_ttl(&env, &DataKey::GrantIds);
        Ok(archived)
    }

    pub fn claim(env: Env, recipient: Address, asset: Address, amount: i128) -> Result<(), Error> {
        if amount <= 0 { return Err(Error::InvalidAmount); }
        recipient.require_auth();
        extend_instance_ttl(&env);
        if amount > Self::claimable(env.clone(), recipient.clone(), asset.clone()) {
            return Err(Error::InsufficientClaimable);
        }

        let mut remaining = amount;
        let index_key = DataKey::RecipientIndex(recipient.clone());
        let ids: Vec<u64> = env.storage().persistent().get(&index_key).unwrap_or_else(|| Vec::new(&env));
        for grant_id in ids.iter() {
            if remaining == 0 { break; }
            let key = DataKey::GrantRecord(grant_id);
            let mut record: GrantRecord = match env.storage().persistent().get(&key) { Some(r) => r, None => continue };
            if record.recipient != recipient || record.asset != asset { continue; }
            let unclaimed = record.amount.checked_sub(record.claimed).and_then(|v| v.checked_sub(record.revoked)).unwrap_or(0);
            if unclaimed <= 0 { continue; }
            let take = remaining.min(unclaimed);
            record.claimed = record.claimed.checked_add(take).ok_or(Error::ArithmeticOverflow)?;
            remaining = remaining.checked_sub(take).ok_or(Error::ArithmeticOverflow)?;
            env.storage().persistent().set(&key, &record);
            extend_history_ttl(&env, &key);
        }

        let mut claimed = balances(&env, &DataKey::Claimed);
        let balance_key = (recipient, asset);
        let current = claimed.get(balance_key.clone()).unwrap_or(0);
        let updated = current.checked_add(amount).ok_or(Error::ArithmeticOverflow)?;
        claimed.set(balance_key, updated);
        env.storage().instance().set(&DataKey::Claimed, &claimed);
        Ok(())
    }

    pub fn revoke(env: Env, admin: Address, grant_id: u64) -> Result<i128, Error> {
        admin.require_auth();
        Self::require_admin_if_configured(&env, &admin)?;
        extend_instance_ttl(&env);
        let key = DataKey::GrantRecord(grant_id);
        let mut record: GrantRecord = env.storage().persistent().get(&key).ok_or(Error::GrantNotFound)?;
        let reclaimable = record.amount.checked_sub(record.claimed).and_then(|v| v.checked_sub(record.revoked)).ok_or(Error::ArithmeticOverflow)?;
        if reclaimable == 0 {
            if record.claimed == record.amount { return Err(Error::GrantAlreadyClaimed); }
            return Err(Error::GrantAlreadyRevoked);
        }

        let mut granted = balances(&env, &DataKey::Granted);
        let balance_key = (record.recipient.clone(), record.asset.clone());
        let current = granted.get(balance_key.clone()).unwrap_or(0);
        let updated = current.checked_sub(reclaimable).ok_or(Error::ArithmeticOverflow)?;
        granted.set(balance_key, updated);

        // The role recorded at grant time identifies which role total to
        // reduce. Grants created before role tracking have no role marker;
        // their aggregate total is still corrected, and no role total is
        // guessed at. All arithmetic here precedes any write.
        let role_totals = match env
            .storage()
            .persistent()
            .get::<_, Symbol>(&DataKey::GrantRole(grant_id))
        {
            Some(role) => {
                let mut by_role = role_balances(&env);
                let role_key = (record.recipient.clone(), role, record.asset.clone());
                let role_current = by_role.get(role_key.clone()).unwrap_or(0);
                let role_updated = role_current
                    .checked_sub(reclaimable)
                    .ok_or(Error::ArithmeticOverflow)?;
                by_role.set(role_key, role_updated);
                Some(by_role)
            }
            None => None,
        };

        let mut funds = treasury(&env);
        let available = funds.get(record.asset.clone()).unwrap_or(0);
        let updated_funds = available.checked_add(reclaimable).ok_or(Error::ArithmeticOverflow)?;
        funds.set(record.asset.clone(), updated_funds);
        record.revoked = record.revoked.checked_add(reclaimable).ok_or(Error::ArithmeticOverflow)?;

        env.storage().instance().set(&DataKey::Granted, &granted);
        if let Some(by_role) = role_totals {
            env.storage().instance().set(&DataKey::GrantedByRole, &by_role);
        }
        env.storage().instance().set(&DataKey::Treasury, &funds);
        env.storage().persistent().set(&key, &record);
        extend_history_ttl(&env, &key);
        Ok(reclaimable)
    }

    pub fn total_granted(env: Env, recipient: Address, asset: Address) -> i128 {
        extend_instance_ttl(&env);
        balances(&env, &DataKey::Granted).get((recipient, asset)).unwrap_or(0)
    }

    /// Granted amount for one `(recipient, asset, role)` triple, net of
    /// revocations. The aggregate `total_granted` remains the sum of the
    /// supported roles' totals, so existing callers see unchanged values.
    pub fn total_granted_by_role(
        env: Env,
        recipient: Address,
        asset: Address,
        role: Symbol,
    ) -> i128 {
        extend_instance_ttl(&env);
        role_balances(&env).get((recipient, role, asset)).unwrap_or(0)
    }

    pub fn total_claimed(env: Env, recipient: Address, asset: Address) -> i128 {
        extend_instance_ttl(&env);
        balances(&env, &DataKey::Claimed).get((recipient, asset)).unwrap_or(0)
    }

    pub fn claimable(env: Env, recipient: Address, asset: Address) -> i128 {
        extend_instance_ttl(&env);
        let granted = balances(&env, &DataKey::Granted).get((recipient.clone(), asset.clone())).unwrap_or(0);
        let claimed = balances(&env, &DataKey::Claimed).get((recipient, asset)).unwrap_or(0);
        granted.checked_sub(claimed).unwrap_or(0)
    }

    pub fn treasury_balance(env: Env, asset: Address) -> i128 {
        extend_instance_ttl(&env);
        treasury(&env).get(asset).unwrap_or(0)
    }

    pub fn is_grant_processed(env: Env, grant_id: u64) -> bool {
        extend_instance_ttl(&env);
        if env.storage().persistent().has(&DataKey::GrantId(grant_id)) { return true; }
        let first: Option<u64> = env.storage().instance().get(&DataKey::FirstGrantId);
        let last: Option<u64> = env.storage().instance().get(&DataKey::LastGrantId);
        matches!((first, last), (Some(first), Some(last)) if grant_id >= first && grant_id <= last)
    }

    pub fn archived_totals(env: Env, recipient: Address, asset: Address) -> ArchivedTotals {
        extend_instance_ttl(&env);
        env.storage()
            .instance()
            .get::<_, Map<(Address, Address), ArchivedTotals>>(&DataKey::ArchivedTotals)
            .and_then(|totals| totals.get((recipient, asset)))
            .unwrap_or_else(ArchivedTotals::zero)
    }

    pub fn revoked_amount(env: Env, grant_id: u64) -> i128 {
        let record: Option<GrantRecord> = env.storage().persistent().get(&DataKey::GrantRecord(grant_id));
        record.map(|r| r.revoked).unwrap_or(0)
    }

    pub fn reward_history(env: Env, recipient: Address, offset: u32, limit: u32) -> Result<Vec<GrantRecord>, Error> {
        if limit == 0 || limit > MAX_HISTORY_PAGE_SIZE { return Err(Error::InvalidPageSize); }
        let key = DataKey::RecipientIndex(recipient);
        let ids: Vec<u64> = env.storage().persistent().get(&key).unwrap_or_else(|| Vec::new(&env));
        let total = ids.len();
        let mut page = Vec::new(&env);
        if offset >= total { return Ok(page); }
        let end = (offset + limit).min(total);
        for i in offset..end {
            let grant_id = ids.get(i).unwrap();
            if let Some(record) = env.storage().persistent().get::<_, GrantRecord>(&DataKey::GrantRecord(grant_id)) {
                page.push_back(record);
            }
        }
        Ok(page)
    }

    pub fn grant_count(env: Env, recipient: Address) -> u32 {
        let key = DataKey::RecipientIndex(recipient);
        let ids: Vec<u64> = env.storage().persistent().get(&key).unwrap_or_else(|| Vec::new(&env));
        ids.len()
    }

    fn require_active_admin(env: &Env, caller: &Address) -> Result<(), Error> {
        let current: Option<Address> = env.storage().instance().get(&DataKey::Admin);
        match current { Some(admin) if admin == *caller => Ok(()), _ => Err(Error::Unauthorized) }
    }

    fn require_admin_if_configured(env: &Env, caller: &Address) -> Result<(), Error> {
        let current: Option<Address> = env.storage().instance().get(&DataKey::Admin);
        match current { Some(admin) if admin != *caller => Err(Error::Unauthorized), _ => Ok(()) }
    }

    fn require_grants_not_paused(env: &Env) -> Result<(), Error> {
        let paused: bool = env.storage().instance().get(&DataKey::Paused).unwrap_or(false);
        if paused { Err(Error::GrantsPaused) } else { Ok(()) }
    }

    fn is_supported_role(role: &Symbol) -> bool {
        *role == ROLE_SUBMITTER || *role == ROLE_VERIFIER
    }

    fn apply_grant(env: &Env, recipient: Address, asset: Address, role: Symbol, amount: i128, grant_id: u64) -> Result<(), Error> {
    fn apply_grant(
        env: &Env,
        recipient: Address,
        asset: Address,
        role: Symbol,
        amount: i128,
        grant_id: u64,
    ) -> Result<(), Error> {
        if Self::is_grant_processed(env.clone(), grant_id) { return Err(Error::DuplicateGrant); }

        let last: Option<u64> = env.storage().instance().get(&DataKey::LastGrantId);
        let (first_id, last_id) = match last {
            Some(last) => {
                let next = last.checked_add(1).ok_or(Error::GrantIdNotSequential)?;
                if grant_id != next { return Err(Error::GrantIdNotSequential); }
                let first = env.storage().instance().get(&DataKey::FirstGrantId).unwrap_or(grant_id);
                (first, grant_id)
            }
            None => (grant_id, grant_id),
        };

        let mut ids = grant_ids(env);
        if ids.len() >= MAX_GRANT_HISTORY {
            Self::archive_settled_one(env, &mut ids)?;
            if ids.len() >= MAX_GRANT_HISTORY { return Err(Error::HistoryFull); }
        }

        let mut funds = treasury(env);
        let available = funds.get(asset.clone()).unwrap_or(0);
        if amount > available { return Err(Error::InsufficientTreasury); }

        let mut granted = balances(env, &DataKey::Granted);
        let balance_key = (recipient.clone(), asset.clone());
        let current = granted.get(balance_key.clone()).unwrap_or(0);
        let updated = current.checked_add(amount).ok_or(Error::ArithmeticOverflow)?;
        granted.set(balance_key, updated);

        // The role total is additive alongside the aggregate: the aggregate
        // key layout and `total_granted` semantics stay exactly as before,
        // while each role can be queried independently.
        let mut by_role = role_balances(env);
        let role_key = (recipient.clone(), role.clone(), asset.clone());
        let role_current = by_role.get(role_key.clone()).unwrap_or(0);
        let role_updated = role_current
            .checked_add(amount)
            .ok_or(Error::ArithmeticOverflow)?;
        by_role.set(role_key, role_updated);

        let updated_funds = available.checked_sub(amount).ok_or(Error::ArithmeticOverflow)?;
        funds.set(asset.clone(), updated_funds);

        env.storage().instance().set(&DataKey::Granted, &granted);
        env.storage().instance().set(&DataKey::GrantedByRole, &by_role);
        env.storage().instance().set(&DataKey::Treasury, &funds);
        env.storage().instance().set(&DataKey::FirstGrantId, &first_id);
        env.storage().instance().set(&DataKey::LastGrantId, &last_id);

        let record_key = DataKey::GrantRecord(grant_id);
        env.storage().persistent().set(&record_key, &GrantRecord {
            recipient: recipient.clone(), asset, amount, claimed: 0, revoked: 0,
        });
        env.storage().persistent().set(&DataKey::GrantId(grant_id), &true);
        env.storage().persistent().set(&DataKey::GrantRole(grant_id), &role);
        extend_history_ttl(env, &record_key);
        extend_history_ttl(env, &DataKey::GrantId(grant_id));
        extend_history_ttl(env, &DataKey::GrantRole(grant_id));
        push_recipient_index(env, &recipient, grant_id);

        ids.push_back(grant_id);
        env.storage().persistent().set(&DataKey::GrantIds, &ids);
        extend_history_ttl(env, &DataKey::GrantIds);
        env.events().publish(
            (symbol_short!("grants"), symbol_short!("granted")),
            (recipient, role, amount, grant_id),
        );
        Ok(())
    }

    fn archive_settled_one(env: &Env, ids: &mut Vec<u64>) -> Result<(), Error> {
        let mut retained = Vec::new(env);
        let mut archived = false;
        for grant_id in ids.iter() {
            let key = DataKey::GrantRecord(grant_id);
            if let Some(record) = env.storage().persistent().get::<_, GrantRecord>(&key) {
                if !archived && record.claimed.checked_add(record.revoked).unwrap_or(i128::MAX) == record.amount {
                    let mut totals: Map<(Address, Address), ArchivedTotals> = env
                        .storage().instance().get(&DataKey::ArchivedTotals)
                        .unwrap_or_else(|| Map::new(env));
                    let balance_key = (record.recipient.clone(), record.asset.clone());
                    let mut value = totals.get(balance_key.clone()).unwrap_or_else(ArchivedTotals::zero);
                    value.grant_count = value.grant_count.checked_add(1).ok_or(Error::ArithmeticOverflow)?;
                    value.granted = value.granted.checked_add(record.amount).ok_or(Error::ArithmeticOverflow)?;
                    value.claimed = value.claimed.checked_add(record.claimed).ok_or(Error::ArithmeticOverflow)?;
                    value.revoked = value.revoked.checked_add(record.revoked).ok_or(Error::ArithmeticOverflow)?;
                    totals.set(balance_key, value);
                    env.storage().instance().set(&DataKey::ArchivedTotals, &totals);
                    env.storage().persistent().remove(&key);
                    env.storage().persistent().remove(&DataKey::GrantId(grant_id));
                    env.storage().persistent().remove(&DataKey::GrantRole(grant_id));
                    archived = true;
                } else {
                    retained.push_back(grant_id);
                }
            }
        }
        env.storage().persistent().set(&DataKey::GrantIds, &retained);
        extend_history_ttl(env, &DataKey::GrantIds);
        *ids = retained;
        Ok(())
    }
}
// COMMENT_BLOCK_END
*/
