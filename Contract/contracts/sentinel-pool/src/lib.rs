#![no_std]
//! `SentinelPool` — manages verifier staking, governance thresholds, withdrawals,
//! and fraud slashing for the sentinel set.
//!
//! # Slashing is a governed, reversible process, not a one-way write
//!
//! A slash takes a sentinel's stake immediately, but it is the start of a
//! process rather than the end of one:
//!
//! ```text
//!  slash ──► Pending ──appeal──► Pending ──resolve──► Upheld | Reversed
//!              │                  │
//!              └──────────────────┘
//!         appeal only until `appeal_deadline`
//! ```
//!
//! * **Evidence.** [`SlashEvidence`] carries a proof reference, a URI and a
//!   content hash. They are stored on the record and republished on
//!   [`SlashedEvent`], so an off-chain audit consumer never has to infer *why*
//!   a balance changed.
//! * **A bounded appeal window.** A slash records `appeal_deadline =
//!   slashed_at + appeal_window`. An appeal after that ledger is refused with
//!   [`Error::AppealWindowClosed`] — the window is what stops an appeal from
//!   being raised at an arbitrary point in the future to relitigate a settled
//!   matter.
//! * **Exactly one resolution.** [`SentinelPool::resolve_slash`] upholds or
//!   reverses a slash once. A reversal restores the slashed amount with
//!   `checked_add`; a second resolution is [`Error::AlreadyResolved`].
//!
//! # Governance authorization
//!
//! Every slash operation — applying, appealing, resolving — requires the
//! configured governance address, resolved from storage by [`SentinelPool::require_governance`].
//! A missing configuration is [`Error::GovernanceNotConfigured`], not a
//! fall-through to the caller: an ungoverned pool cannot be slashed at all,
//! rather than being governed by whoever happened to sign the transaction.
//! Refused calls leave the stake and the replay state untouched.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, Bytes, Env, Map,
    String, Symbol,
};

/// Default appeal window: seven days expressed in ledger sequence numbers.
///
/// Long enough for a sentinel to gather evidence and for governance to convene;
/// short enough that a dispute is resolved while the stake still means
/// something.
pub const DEFAULT_APPEAL_WINDOW_LEDGERS: u64 = 604_800;

/// Upper bound on the appeal window, in ledger sequence numbers.
///
/// The deadline is `slashed_at + appeal_window` and is stored in a `u64`. An
/// unrepresentable window would not be a long appeal period — it would be an
/// appeal period that cannot be expressed at all, so the boundary would have to
/// be special-cased everywhere. Bounding it keeps the deadline representable for
/// every reachable `slashed_at`.
pub const MAX_APPEAL_WINDOW_LEDGERS: u64 = 6_000_000;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    InvalidStake = 1,
    Unauthorized = 2,
    StakeBelowMinimum = 3,
    LockPeriodActive = 4,
    InvalidThreshold = 5,
    InvalidAmount = 6,
    FraudProofAlreadyUsed = 7,
    InsufficientBalance = 8,
    /// The caller is not the configured governance address.
    NotGovernance = 9,
    /// No governance address has been configured.
    GovernanceNotConfigured = 10,
    /// The appeal window is zero or above [`MAX_APPEAL_WINDOW_LEDGERS`].
    InvalidAppealWindow = 11,
    /// The appeal arrived at or after the recorded deadline.
    AppealWindowClosed = 12,
    /// The slash has already been resolved.
    AlreadyResolved = 13,
    /// No slash is recorded under the supplied proof reference.
    UnknownProof = 14,
    /// The evidence is missing a proof reference or a URI.
    InvalidEvidence = 15,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    // Existing variants keep their positions: `contracttype` discriminants are
    // the variant index, so inserting here would rename the storage key of every
    // later variant. New keys are appended.
    Admin,
    MinStake,
    LockPeriod,
    Threshold,
    Stakes,
    StakedAt,
    /// `proof_ref` -> [`SlashRecord`].
    SlashProofs,
    /// The address authorized to apply, appeal and resolve slashes.
    ///
    /// Distinct from [`DataKey::Admin`]: the admin configures the pool, the
    /// governance address operates the slashing process. Collapsing the two
    /// would mean whoever can change `min_stake` can also confiscate stake.
    Governance,
    /// Appeal window in ledger sequence numbers.
    AppealWindow,
}

/// The lifecycle of a single slash.
///
/// ```text
/// Pending ──► Upheld   (terminal)
///         └─► Reversed (terminal)
/// ```
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum SlashOutcome {
    /// Applied, awaiting appeal or resolution.
    Pending = 0,
    /// Confirmed by resolution; the stake stays removed.
    Upheld = 1,
    /// Overturned by resolution; the stake has been restored.
    Reversed = 2,
}

/// The evidence a slash is justified by.
///
/// Stored on the record and republished on [`SlashedEvent`]. The three fields
/// answer the three questions an auditor asks: *which case*, *where is the
/// record*, and *is this the record I am looking at* — the hash pins the content
/// so a mutable URI cannot quietly change what the evidence says.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SlashEvidence {
    /// Unique reference for the underlying case. The replay key.
    pub proof_ref: String,
    /// Where the evidence is retrievable.
    pub uri: String,
    /// Hash of the evidence contents.
    pub content_hash: Bytes,
}

/// Everything recorded about one applied slash.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SlashRecord {
    /// The sentinel the slash was applied to.
    pub sentinel: Address,
    /// Reason code, retained as an event topic for filtering.
    pub reason: Symbol,
    /// Amount removed from the stake.
    pub amount: i128,
    /// Ledger the slash was applied on.
    pub slashed_at: u64,
    /// Proof reference, URI and content hash the slash was justified by.
    pub evidence: SlashEvidence,
    /// The window in force when this slash was applied, copied onto the record
    /// so a later `set_appeal_window` cannot retroactively close an open appeal.
    pub appeal_window: u64,
    /// `slashed_at + appeal_window`. Appeals are refused at or after this ledger.
    pub appeal_deadline: u64,
    /// Whether an appeal was filed.
    pub appealed: bool,
    /// Where the record is in its lifecycle.
    pub outcome: SlashOutcome,
    /// Ledger of the resolution. `0` while `outcome == Pending`.
    pub resolved_at: u64,
}

#[contractevent]
#[derive(Clone)]
pub struct StakedEvent {
    #[topic]
    pub sentinel: Address,
    pub amount: i128,
    pub total: i128,
}

#[contractevent]
#[derive(Clone)]
pub struct WithdrawnEvent {
    #[topic]
    pub sentinel: Address,
    pub amount: i128,
    pub remaining: i128,
}

#[contractevent]
#[derive(Clone)]
pub struct ThresholdUpdatedEvent {
    #[topic]
    pub actor: Address,
    pub threshold: u32,
}

/// Emitted when a slash is applied.
#[contractevent]
#[derive(Clone)]
pub struct SlashedEvent {
    #[topic]
    pub sentinel: Address,
    #[topic]
    pub reason: Symbol,
    /// The proof reference this slash was recorded under. **Not** a topic: it is
    /// high-cardinality and would bloat the topic list of a consumer filtering
    /// on "every slash for this reason".
    pub proof_ref: String,
    /// Where the justifying evidence can be retrieved.
    pub evidence_uri: String,
    /// Hash pinning the evidence contents.
    pub evidence_hash: Bytes,
    pub amount: i128,
    /// The sentinel's stake after the slash.
    pub remaining: i128,
    /// Ledger the slash was applied on.
    pub slashed_at: u64,
    /// Last ledger at which an appeal is accepted.
    pub appeal_deadline: u64,
}

/// Emitted when a sentinel or governance files an appeal.
#[contractevent]
#[derive(Clone)]
pub struct SlashAppealedEvent {
    #[topic]
    pub sentinel: Address,
    #[topic]
    pub proof_ref: String,
    /// The appealing address.
    pub appellant: Address,
    /// Free-text grounds supplied with the appeal.
    pub note: String,
    pub appealed_at: u64,
    /// The deadline the appeal was filed against, recorded so a later
    /// `set_appeal_window` cannot be used to argue the window was different.
    pub appeal_deadline: u64,
}

/// Emitted when a slash is upheld or reversed. Terminal.
#[contractevent]
#[derive(Clone)]
pub struct SlashResolvedEvent {
    #[topic]
    pub sentinel: Address,
    #[topic]
    pub proof_ref: String,
    pub outcome: SlashOutcome,
    /// The address that resolved it.
    pub resolver: Address,
    /// Amount returned to the stake. `0` for an upheld slash.
    pub restored: i128,
    /// The sentinel's stake after resolution.
    pub remaining: i128,
    pub resolved_at: u64,
}

/// Emitted when the admin changes the appeal window.
#[contractevent]
#[derive(Clone)]
pub struct AppealWindowUpdatedEvent {
    #[topic]
    pub actor: Address,
    pub appeal_window: u64,
}

/// Emitted when the admin rotates the governance address.
#[contractevent]
#[derive(Clone)]
pub struct GovernanceUpdatedEvent {
    #[topic]
    pub actor: Address,
    pub governance: Address,
}

#[contract]
pub struct SentinelPool;

#[contractimpl]
impl SentinelPool {
    /// # Configure the pool
    ///
    /// `admin` configures the pool. `governance` operates the slashing process.
    /// They are separate keys on purpose: collapsing them would mean whoever can
    /// change `min_stake` can also confiscate stake.
    ///
    /// `governance` may be the same address as `admin` for a single-operator
    /// deployment, but the contract never *infers* it — the lookup has no
    /// fallback, so an unset governance key refuses every slash rather than
    /// accepting the caller.
    pub fn initialize(
        env: Env,
        admin: Address,
        governance: Address,
        min_stake: i128,
        lock_period: u64,
        threshold: u32,
    ) -> Result<(), Error> {
        if min_stake <= 0 {
            return Err(Error::InvalidStake);
        }
        if threshold == 0 {
            return Err(Error::InvalidThreshold);
        }

        admin.require_auth();

        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::Unauthorized);
        }

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::Governance, &governance);
        env.storage().instance().set(&DataKey::MinStake, &min_stake);
        env.storage().instance().set(&DataKey::LockPeriod, &lock_period);
        env.storage().instance().set(&DataKey::Threshold, &threshold);
        env.storage()
            .instance()
            .set(&DataKey::AppealWindow, &DEFAULT_APPEAL_WINDOW_LEDGERS);
        env.storage().instance().set(&DataKey::Stakes, &Map::<Address, i128>::new(&env));
        env.storage().instance().set(&DataKey::StakedAt, &Map::<Address, u64>::new(&env));
        env.storage()
            .instance()
            .set(&DataKey::SlashProofs, &Map::<String, SlashRecord>::new(&env));

        Ok(())
    }

    /// The address authorized to apply, appeal and resolve slashes.
    pub fn governance(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Governance)
    }

    /// The appeal window in force, in ledger sequence numbers.
    ///
    /// `0` when unset — which also means "no appeal is possible", because a zero
    /// window closes the deadline on the ledger the slash was applied.
    pub fn appeal_window(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::AppealWindow)
            .unwrap_or(0)
    }

    /// Fail unless `caller` is the configured governance address.
    ///
    /// Two distinct refusals, because they are two different operational
    /// problems: a pool that was never configured for governance, and a caller
    /// that is not the configured address.
    fn require_governance(env: &Env, caller: &Address) -> Result<(), Error> {
        let stored: Option<Address> = env.storage().instance().get(&DataKey::Governance);
        match stored {
            Some(governance) if governance == *caller => Ok(()),
            Some(_) => Err(Error::NotGovernance),
            None => Err(Error::GovernanceNotConfigured),
        }
    }

    /// Fail unless `caller` is the configured admin.
    fn require_admin(env: &Env, caller: &Address) -> Result<(), Error> {
        let stored: Option<Address> = env.storage().instance().get(&DataKey::Admin);
        match stored {
            Some(admin) if admin == *caller => Ok(()),
            _ => Err(Error::Unauthorized),
        }
    }

    /// # Rotate the governance address
    ///
    /// Admin-only. Rotating governance does not disturb any open appeal window:
    /// each [`SlashRecord`] copies the window that was in force when its slash
    /// was applied.
    ///
    /// # Errors
    /// * [`Error::Unauthorized`] — `admin` is not the configured admin.
    pub fn set_governance(env: Env, admin: Address, governance: Address) -> Result<(), Error> {
        admin.require_auth();
        Self::require_admin(&env, &admin)?;

        env.storage()
            .instance()
            .set(&DataKey::Governance, &governance);

        GovernanceUpdatedEvent {
            actor: admin,
            governance,
        }
        .publish(&env);

        Ok(())
    }

    /// # Set the appeal window
    ///
    /// Admin-only, and **not retroactive**: records already written keep the
    /// window that was in force when their slash was applied, so shortening the
    /// window cannot be used to close an appeal a sentinel is already entitled
    /// to file.
    ///
    /// # Errors
    /// * [`Error::InvalidAppealWindow`] — zero, or above
    ///   [`MAX_APPEAL_WINDOW_LEDGERS`].
    /// * [`Error::Unauthorized`] — `admin` is not the configured admin.
    pub fn set_appeal_window(env: Env, admin: Address, window: u64) -> Result<(), Error> {
        if window == 0 || window > MAX_APPEAL_WINDOW_LEDGERS {
            return Err(Error::InvalidAppealWindow);
        }

        admin.require_auth();
        Self::require_admin(&env, &admin)?;

        env.storage().instance().set(&DataKey::AppealWindow, &window);

        AppealWindowUpdatedEvent {
            actor: admin,
            appeal_window: window,
        }
        .publish(&env);

        Ok(())
    }

    pub fn stake(env: Env, sentinel: Address, amount: i128) -> Result<(), Error> {
        if amount <= 0 {
            return Err(Error::InvalidStake);
        }

        sentinel.require_auth();

        let mut stakes: Map<Address, i128> = env
            .storage()
            .instance()
            .get(&DataKey::Stakes)
            .unwrap_or_else(|| Map::new(&env));

        let current = stakes.get(sentinel.clone()).unwrap_or(0);
        let new_total = current
            .checked_add(amount)
            .ok_or(Error::InvalidStake)?;

        let min_stake = Self::min_stake(env.clone());
        if new_total < min_stake {
            return Err(Error::StakeBelowMinimum);
        }

        stakes.set(sentinel.clone(), new_total);
        env.storage().instance().set(&DataKey::Stakes, &stakes);

        let mut staked_at: Map<Address, u64> = env
            .storage()
            .instance()
            .get(&DataKey::StakedAt)
            .unwrap_or_else(|| Map::new(&env));
        staked_at.set(sentinel.clone(), u64::from(env.ledger().sequence()));
        env.storage().instance().set(&DataKey::StakedAt, &staked_at);

        StakedEvent {
            sentinel: sentinel.clone(),
            amount,
            total: new_total,
        }
        .publish(&env);

        Ok(())
    }

    pub fn balance(env: Env, sentinel: Address) -> i128 {
        let stakes: Map<Address, i128> = env
            .storage()
            .instance()
            .get(&DataKey::Stakes)
            .unwrap_or_else(|| Map::new(&env));
        stakes.get(sentinel).unwrap_or(0)
    }

    pub fn threshold(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::Threshold)
            .unwrap_or(0)
    }

    pub fn min_stake(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::MinStake)
            .unwrap_or(0)
    }

    pub fn quorum_threshold(env: Env, required: u32) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::Threshold)
            .unwrap_or(required)
    }

    pub fn set_threshold(env: Env, admin: Address, threshold: u32) -> Result<(), Error> {
        if threshold == 0 {
            return Err(Error::InvalidThreshold);
        }

        admin.require_auth();

        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| admin.clone());

        if admin != stored_admin {
            return Err(Error::Unauthorized);
        }

        env.storage().instance().set(&DataKey::Threshold, &threshold);

        ThresholdUpdatedEvent {
            actor: admin.clone(),
            threshold,
        }
        .publish(&env);

        Ok(())
    }

    pub fn set_min_stake(env: Env, admin: Address, min_stake: i128) -> Result<(), Error> {
        if min_stake <= 0 {
            return Err(Error::InvalidStake);
        }

        admin.require_auth();

        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| admin.clone());

        if admin != stored_admin {
            return Err(Error::Unauthorized);
        }

        env.storage().instance().set(&DataKey::MinStake, &min_stake);
        Ok(())
    }

    pub fn withdraw(env: Env, sentinel: Address, amount: i128) -> Result<(), Error> {
        if amount <= 0 {
            return Err(Error::InvalidStake);
        }

        sentinel.require_auth();

        let mut stakes: Map<Address, i128> = env
            .storage()
            .instance()
            .get(&DataKey::Stakes)
            .unwrap_or_else(|| Map::new(&env));

        let current = stakes.get(sentinel.clone()).unwrap_or(0);
        if amount > current {
            return Err(Error::InsufficientBalance);
        }

        let lock_period: u64 = env
            .storage()
            .instance()
            .get(&DataKey::LockPeriod)
            .unwrap_or(0);

        if lock_period > 0 {
            let staked_at: Map<Address, u64> = env
                .storage()
                .instance()
                .get(&DataKey::StakedAt)
                .unwrap_or_else(|| Map::new(&env));
            let last_staked = staked_at.get(sentinel.clone()).unwrap_or(0);
            let elapsed = u64::from(env.ledger().sequence()).saturating_sub(last_staked);
            if elapsed < lock_period {
                return Err(Error::LockPeriodActive);
            }
        }

        let remaining = current
            .checked_sub(amount)
            .ok_or(Error::InsufficientBalance)?;

        let min_stake = Self::min_stake(env.clone());
        if remaining < min_stake {
            return Err(Error::StakeBelowMinimum);
        }

        stakes.set(sentinel.clone(), remaining);
        env.storage().instance().set(&DataKey::Stakes, &stakes);

        WithdrawnEvent {
            sentinel: sentinel.clone(),
            amount,
            remaining,
        }
        .publish(&env);

        Ok(())
    }

    /// # Apply a fraud slash
    ///
    /// Requires the configured governance address. The check is a pure storage
    /// comparison against [`DataKey::Governance`] with **no fallback to the
    /// caller** — an unconfigured pool refuses every slash with
    /// [`Error::GovernanceNotConfigured`] instead of being governed by whoever
    /// signed the transaction.
    ///
    /// # Evidence
    ///
    /// `evidence` is stored on the record and republished on [`SlashedEvent`],
    /// so an off-chain consumer can tell *why* a balance changed without
    /// correlating against a separate evidence store. A record with no proof
    /// reference or no URI is [`Error::InvalidEvidence`]: the stake is taken
    /// immediately, and a confiscation that cannot be pointed at its
    /// justification cannot be appealed on evidence either.
    ///
    /// # Order
    ///
    /// Authorization is resolved before the stake is touched, and the stake and
    /// the proof map are written only after every check passes — so a refused
    /// call changes neither the stake nor the replay state.
    ///
    /// # Errors
    /// * [`Error::GovernanceNotConfigured`] — no governance address is set.
    /// * [`Error::NotGovernance`] — `caller` is not the governance address.
    /// * [`Error::InvalidEvidence`] — `proof_ref` or `uri` is empty.
    /// * [`Error::FraudProofAlreadyUsed`] — the proof reference is taken.
    /// * [`Error::InvalidStake`] — `amount <= 0`.
    /// * [`Error::InsufficientBalance`] — `amount` exceeds the stake.
    /// * [`Error::StakeBelowMinimum`] — the remainder would fall under
    ///   `min_stake`.
    /// * [`Error::InvalidAppealWindow`] — the deadline is not representable.
    pub fn slash(
        env: Env,
        caller: Address,
        sentinel: Address,
        amount: i128,
        evidence: SlashEvidence,
        reason: Symbol,
    ) -> Result<(), Error> {
        if evidence.proof_ref.is_empty() || evidence.uri.is_empty() {
            return Err(Error::InvalidEvidence);
        }
        if amount <= 0 {
            return Err(Error::InvalidStake);
        }

        caller.require_auth();
        Self::require_governance(&env, &caller)?;

        let proof_ref = evidence.proof_ref.clone();

        let mut records: Map<String, SlashRecord> = env
            .storage()
            .instance()
            .get(&DataKey::SlashProofs)
            .unwrap_or_else(|| Map::new(&env));

        if records.contains_key(proof_ref.clone()) {
            return Err(Error::FraudProofAlreadyUsed);
        }

        let mut stakes: Map<Address, i128> = env
            .storage()
            .instance()
            .get(&DataKey::Stakes)
            .unwrap_or_else(|| Map::new(&env));

        let current = stakes.get(sentinel.clone()).unwrap_or(0);
        if amount > current {
            return Err(Error::InsufficientBalance);
        }

        let remaining = current
            .checked_sub(amount)
            .ok_or(Error::InsufficientBalance)?;

        let min_stake = Self::min_stake(env.clone());
        if remaining < min_stake {
            return Err(Error::StakeBelowMinimum);
        }

        let slashed_at = u64::from(env.ledger().sequence());
        let appeal_window = Self::appeal_window(env.clone());
        let appeal_deadline = slashed_at
            .checked_add(appeal_window)
            .ok_or(Error::InvalidAppealWindow)?;

        stakes.set(sentinel.clone(), remaining);
        env.storage().instance().set(&DataKey::Stakes, &stakes);

        records.set(
            proof_ref.clone(),
            SlashRecord {
                sentinel: sentinel.clone(),
                reason: reason.clone(),
                amount,
                slashed_at,
                evidence: evidence.clone(),
                appeal_window,
                appeal_deadline,
                appealed: false,
                outcome: SlashOutcome::Pending,
                resolved_at: 0,
            },
        );
        env.storage().instance().set(&DataKey::SlashProofs, &records);

        SlashedEvent {
            sentinel: sentinel.clone(),
            reason,
            proof_ref,
            evidence_uri: evidence.uri,
            evidence_hash: evidence.content_hash,
            amount,
            remaining,
            slashed_at,
            appeal_deadline,
        }
        .publish(&env);

        Ok(())
    }

    /// # Appeal an applied slash
    ///
    /// The appellant may be the slashed sentinel or the governance address;
    /// either is a party to the dispute. Appeals are accepted while
    /// `ledger.sequence() <= appeal_deadline` and refused with
    /// [`Error::AppealWindowClosed`] from the ledger after it.
    ///
    /// The window is copied onto the record when the slash is applied, so
    /// `set_appeal_window` afterwards cannot retroactively close an open window.
    ///
    /// # Errors
    /// * [`Error::UnknownProof`] — no record under `proof_ref`.
    /// * [`Error::AppealWindowClosed`] — the deadline has passed, or the window
    ///   in force was zero.
    /// * [`Error::AlreadyResolved`] — the slash has been resolved.
    /// * [`Error::NotGovernance`] — the appellant is neither the sentinel nor
    ///   governance.
    pub fn appeal_slash(
        env: Env,
        appellant: Address,
        proof_ref: String,
        note: String,
    ) -> Result<(), Error> {
        let mut records: Map<String, SlashRecord> = env
            .storage()
            .instance()
            .get(&DataKey::SlashProofs)
            .unwrap_or_else(|| Map::new(&env));

        let mut record: SlashRecord = records.get(proof_ref.clone()).ok_or(Error::UnknownProof)?;

        appellant.require_auth();

        // The sentinel is a party to the dispute; governance is the other one.
        if appellant != record.sentinel {
            Self::require_governance(&env, &appellant)?;
        }

        if record.outcome != SlashOutcome::Pending {
            return Err(Error::AlreadyResolved);
        }

        let now = u64::from(env.ledger().sequence());
        if record.appeal_window == 0 || now > record.appeal_deadline {
            return Err(Error::AppealWindowClosed);
        }

        record.appealed = true;
        records.set(proof_ref.clone(), record.clone());
        env.storage().instance().set(&DataKey::SlashProofs, &records);

        SlashAppealedEvent {
            sentinel: record.sentinel,
            proof_ref,
            appellant,
            note,
            appealed_at: now,
            appeal_deadline: record.appeal_deadline,
        }
        .publish(&env);

        Ok(())
    }

    /// # Resolve a slash, upholding or reversing it
    ///
    /// Terminal, and **exactly once**: a second call on the same `proof_ref` is
    /// [`Error::AlreadyResolved`], whichever outcome it asks for. Without that
    /// constraint a reversed slash could be reversed again, restoring the same
    /// stake twice.
    ///
    /// A reversal restores `amount` with `checked_add`. An upheld slash leaves
    /// the stake where it is.
    ///
    /// # Errors
    /// * [`Error::GovernanceNotConfigured`] — no governance address is set.
    /// * [`Error::NotGovernance`] — `caller` is not the governance address.
    /// * [`Error::UnknownProof`] — no record under `proof_ref`.
    /// * [`Error::AlreadyResolved`] — the slash is already resolved.
    /// * [`Error::InsufficientBalance`] — the restoration would overflow.
    pub fn resolve_slash(
        env: Env,
        caller: Address,
        proof_ref: String,
        uphold: bool,
    ) -> Result<(), Error> {
        caller.require_auth();
        Self::require_governance(&env, &caller)?;

        let mut records: Map<String, SlashRecord> = env
            .storage()
            .instance()
            .get(&DataKey::SlashProofs)
            .unwrap_or_else(|| Map::new(&env));

        let mut record: SlashRecord = records.get(proof_ref.clone()).ok_or(Error::UnknownProof)?;

        // The check precedes every write, so a refused resolution leaves both
        // the record and the stake untouched.
        if record.outcome != SlashOutcome::Pending {
            return Err(Error::AlreadyResolved);
        }

        let mut stakes: Map<Address, i128> = env
            .storage()
            .instance()
            .get(&DataKey::Stakes)
            .unwrap_or_else(|| Map::new(&env));

        let sentinel = record.sentinel.clone();
        let current = stakes.get(sentinel.clone()).unwrap_or(0);

        // A reversal adds the slashed amount back with `checked_add`, so an
        // overflow is a refusal rather than a wrapped balance. An upholding
        // resolution leaves the balance exactly where the slash put it.
        let restored = if uphold { 0 } else { record.amount };
        let remaining = if uphold {
            current
        } else {
            current
                .checked_add(record.amount)
                .ok_or(Error::InsufficientBalance)?
        };

        stakes.set(sentinel.clone(), remaining);
        env.storage().instance().set(&DataKey::Stakes, &stakes);

        record.outcome = if uphold {
            SlashOutcome::Upheld
        } else {
            SlashOutcome::Reversed
        };
        record.resolved_at = u64::from(env.ledger().sequence());
        records.set(proof_ref.clone(), record);
        env.storage().instance().set(&DataKey::SlashProofs, &records);

        SlashResolvedEvent {
            sentinel,
            proof_ref,
            outcome: if uphold {
                SlashOutcome::Upheld
            } else {
                SlashOutcome::Reversed
            },
            resolver: caller,
            restored,
            remaining,
            resolved_at: u64::from(env.ledger().sequence()),
        }
        .publish(&env);

        Ok(())
    }

    /// The record stored under `proof_ref`, if any.
    ///
    /// The audit view: proof reference, evidence, ledger, appeal state and
    /// outcome, without replaying the event stream.
    pub fn slash_record(env: Env, proof_ref: String) -> Option<SlashRecord> {
        let records: Map<String, SlashRecord> = env
            .storage()
            .instance()
            .get(&DataKey::SlashProofs)
            .unwrap_or_else(|| Map::new(&env));

        records.get(proof_ref)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        Env,
    };

    #[test]
    fn stake_and_balance_persist_across_queries() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let governance = Address::generate(&env);
        let sentinel = Address::generate(&env);

        env.mock_all_auths();
        client.initialize(&admin, &governance, &100, &10, &2);
        client.stake(&sentinel, &150);

        assert_eq!(client.balance(&sentinel), 150);
        assert_eq!(client.min_stake(), 100);
        assert_eq!(client.threshold(), 2);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #3)")]
    fn stake_below_required_minimum_is_rejected() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let governance = Address::generate(&env);
        let sentinel = Address::generate(&env);

        env.mock_all_auths();
        client.initialize(&admin, &governance, &100, &10, &2);
        client.stake(&sentinel, &99);
    }

    #[test]
    fn governance_threshold_updates_are_authorized_and_persisted() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let governance = Address::generate(&env);

        env.mock_all_auths();
        client.initialize(&admin, &governance, &100, &10, &2);
        client.set_threshold(&admin, &4);

        assert_eq!(client.threshold(), 4);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #2)")]
    fn unauthorized_threshold_update_fails_without_state_change() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let governance = Address::generate(&env);
        let attacker = Address::generate(&env);

        env.mock_all_auths();
        client.initialize(&admin, &governance, &100, &10, &2);
        client.set_threshold(&attacker, &5);
    }

    #[test]
    fn withdrawals_respect_lock_period_and_minimums() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let governance = Address::generate(&env);
        let sentinel = Address::generate(&env);

        env.mock_all_auths();
        client.initialize(&admin, &governance, &100, &10, &2);
        client.stake(&sentinel, &250);

        assert!(client.try_withdraw(&sentinel, &50).is_err());

        env.ledger().with_mut(|l| l.sequence_number = 20);
        client.withdraw(&sentinel, &100);
        assert_eq!(client.balance(&sentinel), 150);

        client.withdraw(&sentinel, &50);
        assert_eq!(client.balance(&sentinel), 100);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #4)")]
    fn withdrawal_during_lock_period_raises_explicit_error() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let governance = Address::generate(&env);
        let sentinel = Address::generate(&env);

        env.mock_all_auths();
        client.initialize(&admin, &governance, &100, &10, &2);
        client.stake(&sentinel, &250);
        client.withdraw(&sentinel, &50);
    }

    #[test]
    fn slashing_records_the_penalty_and_rejects_replay() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let governance = Address::generate(&env);
        let sentinel = Address::generate(&env);
        let reason = Symbol::new(&env, "fraudulent_submission");
        let case_42 = evidence(&env, "case-42");

        env.mock_all_auths();
        client.initialize(&admin, &governance, &100, &10, &2);
        client.stake(&sentinel, &250);
        client.slash(&governance, &sentinel, &50, &case_42, &reason);

        assert_eq!(client.balance(&sentinel), 200);
        assert!(client
            .try_slash(&governance, &sentinel, &10, &case_42, &reason)
            .is_err());
    }

    fn evidence(env: &Env, proof_ref: &str) -> SlashEvidence {
        SlashEvidence {
            proof_ref: String::from_str(env, proof_ref),
            uri: String::from_str(env, "ipfs://kovara/cases"),
            content_hash: Bytes::from_slice(env, &[0xab; 32]),
        }
    }

    // ── CT-46: slashing is restricted to governance ─────────────────────────

    #[test]
    #[should_panic(expected = "Error(Contract, #9)")]
    fn a_non_governance_caller_cannot_apply_a_slash() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let governance = Address::generate(&env);
        let sentinel = Address::generate(&env);
        let reason = Symbol::new(&env, "fraudulent_submission");

        env.mock_all_auths();
        client.initialize(&admin, &governance, &100, &10, &2);
        client.stake(&sentinel, &250);

        // Not even the admin may slash without being governance.
        client.slash(&admin, &sentinel, &50, &evidence(&env, "case-1"), &reason);
    }

    #[test]
    fn a_refused_slash_changes_neither_stake_nor_replay_state() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let governance = Address::generate(&env);
        let attacker = Address::generate(&env);
        let sentinel = Address::generate(&env);
        let reason = Symbol::new(&env, "fraudulent_submission");
        let case_1 = evidence(&env, "case-1");

        env.mock_all_auths();
        client.initialize(&admin, &governance, &100, &10, &2);
        client.stake(&sentinel, &250);

        assert!(client
            .try_slash(&attacker, &sentinel, &50, &case_1.clone(), &reason)
            .is_err());
        assert_eq!(client.balance(&sentinel), 250);
        // The proof reference was never consumed, so governance can still use
        // it exactly once.
        assert_eq!(client.slash_record(&case_1.proof_ref), None);

        client.slash(&governance, &sentinel, &50, &case_1.clone(), &reason);
        assert_eq!(client.balance(&sentinel), 200);
        assert!(client.slash_record(&case_1.proof_ref).is_some());
    }

    #[test]
    fn an_unconfigured_pool_refuses_every_slash_operation() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let sentinel = Address::generate(&env);
        let reason = Symbol::new(&env, "fraudulent_submission");
        let case_1 = evidence(&env, "case-1");

        env.mock_all_auths();
        // No `initialize`: there is no configured governance to match against.
        client.stake(&sentinel, &250);
        assert_eq!(client.governance(), None);

        // The caller is the only address that could ever be stored, and it is
        // still refused: the lookup has no fallback to the caller.
        assert!(client
            .try_slash(&admin, &sentinel, &50, &case_1.clone(), &reason)
            .is_err());
        assert!(client
            .try_resolve_slash(&admin, &case_1.proof_ref, &true)
            .is_err());
        assert!(client
            .try_appeal_slash(&sentinel, &case_1.proof_ref, &String::from_str(&env, "n"))
            .is_err());

        assert_eq!(client.balance(&sentinel), 250);
        assert_eq!(client.slash_record(&case_1.proof_ref), None);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #10)")]
    fn a_missing_governance_address_has_its_own_error() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let sentinel = Address::generate(&env);
        let reason = Symbol::new(&env, "fraudulent_submission");

        env.mock_all_auths();
        client.stake(&sentinel, &250);
        client.slash(&admin, &sentinel, &50, &evidence(&env, "case-1"), &reason);
    }

    #[test]
    fn governance_can_be_rotated_by_the_admin() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let governance = Address::generate(&env);
        let successor = Address::generate(&env);
        let sentinel = Address::generate(&env);
        let reason = Symbol::new(&env, "fraudulent_submission");

        env.mock_all_auths();
        client.initialize(&admin, &governance, &100, &10, &2);
        client.stake(&sentinel, &250);

        // Only the admin may rotate.
        assert!(client.try_set_governance(&governance, &successor).is_err());
        client.set_governance(&admin, &successor.clone());
        assert_eq!(client.governance(), Some(successor.clone()));

        // The old governance address loses the power immediately.
        assert!(client
            .try_slash(
                &governance,
                &sentinel,
                &50,
                &evidence(&env, "case-1"),
                &reason
            )
            .is_err());
        assert_eq!(client.balance(&sentinel), 250);

        client.slash(&successor, &sentinel, &50, &evidence(&env, "case-2"), &reason);
        assert_eq!(client.balance(&sentinel), 200);
    }

    // ── CT-43: evidence references ──────────────────────────────────────────

    #[test]
    fn a_slash_records_and_republishes_its_evidence() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let governance = Address::generate(&env);
        let sentinel = Address::generate(&env);
        let reason = Symbol::new(&env, "fraudulent_submission");
        let case_1 = evidence(&env, "case-1");

        env.mock_all_auths();
        client.initialize(&admin, &governance, &100, &10, &2);
        client.set_appeal_window(&admin, &100);
        client.stake(&sentinel, &250);

        env.ledger().with_mut(|l| l.sequence_number = 500);
        client.slash(&governance, &sentinel, &50, &case_1.clone(), &reason);

        // The whole record, including the evidence, is readable afterwards.
        let record = client.slash_record(&case_1.proof_ref).unwrap();
        assert_eq!(record.sentinel, sentinel);
        assert_eq!(record.reason, reason);
        assert_eq!(record.amount, 50);
        assert_eq!(record.slashed_at, 500);
        assert_eq!(record.appeal_deadline, 600);
        assert_eq!(record.evidence, case_1);
        assert!(!record.appealed);
        assert_eq!(record.outcome, SlashOutcome::Pending);
        assert_eq!(record.resolved_at, 0);
    }

    #[test]
    fn a_slash_without_evidence_is_refused() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let governance = Address::generate(&env);
        let sentinel = Address::generate(&env);
        let reason = Symbol::new(&env, "fraudulent_submission");

        env.mock_all_auths();
        client.initialize(&admin, &governance, &100, &10, &2);
        client.stake(&sentinel, &250);

        let no_ref = SlashEvidence {
            proof_ref: String::from_str(&env, ""),
            uri: String::from_str(&env, "ipfs://kovara/cases"),
            content_hash: Bytes::from_slice(&env, &[0xab; 32]),
        };
        let no_uri = SlashEvidence {
            proof_ref: String::from_str(&env, "case-1"),
            uri: String::from_str(&env, ""),
            content_hash: Bytes::from_slice(&env, &[0xab; 32]),
        };

        assert!(client
            .try_slash(&governance, &sentinel, &50, &no_ref, &reason)
            .is_err());
        assert!(client
            .try_slash(&governance, &sentinel, &50, &no_uri, &reason)
            .is_err());
        assert_eq!(client.balance(&sentinel), 250);
        assert_eq!(
            client.slash_record(&String::from_str(&env, "case-1")),
            None
        );
    }

    // ── CT-44: bounded appeal window ────────────────────────────────────────

    #[test]
    fn an_appeal_is_accepted_up_to_the_deadline_and_refused_after_it() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let governance = Address::generate(&env);
        let sentinel = Address::generate(&env);
        let reason = Symbol::new(&env, "fraudulent_submission");
        let case_1 = evidence(&env, "case-1");
        let case_2 = evidence(&env, "case-2");
        let case_3 = evidence(&env, "case-3");

        env.mock_all_auths();
        client.initialize(&admin, &governance, &100, &10, &2);
        client.set_appeal_window(&admin, &100);
        client.stake(&sentinel, &500);

        env.ledger().with_mut(|l| l.sequence_number = 1_000);
        client.slash(&governance, &sentinel, &50, &case_1.clone(), &reason);
        client.slash(&governance, &sentinel, &50, &case_2.clone(), &reason);
        client.slash(&governance, &sentinel, &50, &case_3.clone(), &reason);
        // All three deadlines are 1_100.

        // One ledger inside the window.
        env.ledger().with_mut(|l| l.sequence_number = 1_099);
        client.appeal_slash(
            &sentinel,
            &case_1.proof_ref,
            &String::from_str(&env, "mislabelled"),
        );
        assert!(client
            .slash_record(&case_1.proof_ref)
            .unwrap()
            .appealed);

        // Exactly on the deadline: still open.
        env.ledger().with_mut(|l| l.sequence_number = 1_100);
        client.appeal_slash(
            &sentinel,
            &case_2.proof_ref,
            &String::from_str(&env, "on_time"),
        );
        assert!(client
            .slash_record(&case_2.proof_ref)
            .unwrap()
            .appealed);

        // One ledger later: closed.
        env.ledger().with_mut(|l| l.sequence_number = 1_101);
        assert!(client
            .try_appeal_slash(
                &sentinel,
                &case_3.proof_ref,
                &String::from_str(&env, "too_late")
            )
            .is_err());
        assert!(!client
            .slash_record(&case_3.proof_ref)
            .unwrap()
            .appealed);
    }

    #[test]
    fn an_appeal_exactly_on_the_deadline_is_accepted() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let governance = Address::generate(&env);
        let sentinel = Address::generate(&env);
        let reason = Symbol::new(&env, "fraudulent_submission");
        let case_1 = evidence(&env, "case-1");

        env.mock_all_auths();
        client.initialize(&admin, &governance, &100, &10, &2);
        client.set_appeal_window(&admin, &100);
        client.stake(&sentinel, &250);

        env.ledger().with_mut(|l| l.sequence_number = 200);
        client.slash(&governance, &sentinel, &50, &case_1.clone(), &reason);
        assert_eq!(
            client.slash_record(&case_1.proof_ref)
                .unwrap()
                .appeal_deadline,
            300
        );

        env.ledger().with_mut(|l| l.sequence_number = 300);
        client.appeal_slash(
            &sentinel,
            &case_1.proof_ref,
            &String::from_str(&env, "right_on_time"),
        );

        let record = client.slash_record(&case_1.proof_ref).unwrap();
        assert!(record.appealed);
        assert_eq!(record.outcome, SlashOutcome::Pending);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #12)")]
    fn an_appeal_after_the_deadline_is_refused() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let governance = Address::generate(&env);
        let sentinel = Address::generate(&env);
        let reason = Symbol::new(&env, "fraudulent_submission");
        let case_1 = evidence(&env, "case-1");

        env.mock_all_auths();
        client.initialize(&admin, &governance, &100, &10, &2);
        client.set_appeal_window(&admin, &100);
        client.stake(&sentinel, &250);

        env.ledger().with_mut(|l| l.sequence_number = 200);
        client.slash(&governance, &sentinel, &50, &case_1.clone(), &reason);

        env.ledger().with_mut(|l| l.sequence_number = 301);
        client.appeal_slash(&sentinel, &case_1.proof_ref, &String::from_str(&env, "late"));
    }

    #[test]
    fn shortening_the_window_does_not_close_an_already_open_appeal() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let governance = Address::generate(&env);
        let sentinel = Address::generate(&env);
        let reason = Symbol::new(&env, "fraudulent_submission");
        let case_1 = evidence(&env, "case-1");

        env.mock_all_auths();
        client.initialize(&admin, &governance, &100, &10, &2);
        client.set_appeal_window(&admin, &1_000);
        client.stake(&sentinel, &250);

        env.ledger().with_mut(|l| l.sequence_number = 100);
        client.slash(&governance, &sentinel, &50, &case_1.clone(), &reason);
        assert_eq!(
            client.slash_record(&case_1.proof_ref)
                .unwrap()
                .appeal_deadline,
            1_100
        );

        // The admin shortens the window *after* the slash.
        client.set_appeal_window(&admin, &1);

        // The deadline recorded on the slash is unchanged, so the appeal the
        // sentinel was already entitled to still lands.
        env.ledger().with_mut(|l| l.sequence_number = 1_050);
        client.appeal_slash(&sentinel, &case_1.proof_ref, &String::from_str(&env, "still_open"));

        // A slash applied under the new, shorter window closes quickly.
        let case_2 = evidence(&env, "case-2");
        env.ledger().with_mut(|l| l.sequence_number = 1_100);
        client.slash(&governance, &sentinel, &50, &case_2.clone(), &reason);
        assert_eq!(
            client.slash_record(&case_2.proof_ref)
                .unwrap()
                .appeal_deadline,
            1_101
        );
        env.ledger().with_mut(|l| l.sequence_number = 1_102);
        assert!(client
            .try_appeal_slash(&sentinel, &case_2.proof_ref, &String::from_str(&env, "late"))
            .is_err());
    }

    #[test]
    fn the_appeal_window_is_bounded_and_admin_only() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let governance = Address::generate(&env);
        let attacker = Address::generate(&env);

        env.mock_all_auths();
        client.initialize(&admin, &governance, &100, &10, &2);

        assert_eq!(client.appeal_window(), DEFAULT_APPEAL_WINDOW_LEDGERS);

        assert!(client.try_set_appeal_window(&attacker, &10).is_err());
        assert!(client.try_set_appeal_window(&admin, &0).is_err());
        assert!(client
            .try_set_appeal_window(&admin, &(MAX_APPEAL_WINDOW_LEDGERS + 1))
            .is_err());
        assert_eq!(client.appeal_window(), DEFAULT_APPEAL_WINDOW_LEDGERS);

        client.set_appeal_window(&admin, &MAX_APPEAL_WINDOW_LEDGERS);
        assert_eq!(client.appeal_window(), MAX_APPEAL_WINDOW_LEDGERS);
    }

    #[test]
    fn an_unknown_proof_cannot_be_appealed_or_resolved() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let governance = Address::generate(&env);
        let sentinel = Address::generate(&env);
        let missing = String::from_str(&env, "case-404");

        env.mock_all_auths();
        client.initialize(&admin, &governance, &100, &10, &2);

        assert!(client
            .try_appeal_slash(&sentinel, &missing, &String::from_str(&env, "n"))
            .is_err());
        assert!(client.try_resolve_slash(&governance, &missing, &true).is_err());
        assert_eq!(client.slash_record(&missing), None);
    }

    // ── CT-45: reversible resolution, exactly once ──────────────────────────

    #[test]
    fn an_upheld_slash_is_terminal_and_leaves_the_stake_removed() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let governance = Address::generate(&env);
        let sentinel = Address::generate(&env);
        let reason = Symbol::new(&env, "fraudulent_submission");
        let case_1 = evidence(&env, "case-1");

        env.mock_all_auths();
        client.initialize(&admin, &governance, &100, &10, &2);
        client.stake(&sentinel, &250);
        client.slash(&governance, &sentinel, &50, &case_1.clone(), &reason);

        env.ledger().with_mut(|l| l.sequence_number = 20);
        client.resolve_slash(&governance, &case_1.proof_ref, &true);

        let record = client.slash_record(&case_1.proof_ref).unwrap();
        assert_eq!(record.outcome, SlashOutcome::Upheld);
        assert_eq!(record.resolved_at, 20);
        assert_eq!(client.balance(&sentinel), 200);

        // Upholding again is refused; so is reversing afterwards.
        assert!(client
            .try_resolve_slash(&governance, &case_1.proof_ref, &true)
            .is_err());
        assert!(client
            .try_resolve_slash(&governance, &case_1.proof_ref, &false)
            .is_err());
        assert_eq!(client.balance(&sentinel), 200);
    }

    #[test]
    fn a_reversed_slash_restores_the_stake_exactly_once() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let governance = Address::generate(&env);
        let sentinel = Address::generate(&env);
        let reason = Symbol::new(&env, "fraudulent_submission");
        let case_1 = evidence(&env, "case-1");

        env.mock_all_auths();
        client.initialize(&admin, &governance, &100, &10, &2);
        client.stake(&sentinel, &250);
        client.slash(&governance, &sentinel, &50, &case_1.clone(), &reason);
        assert_eq!(client.balance(&sentinel), 200);

        client.resolve_slash(&governance, &case_1.proof_ref, &false);

        let record = client.slash_record(&case_1.proof_ref).unwrap();
        assert_eq!(record.outcome, SlashOutcome::Reversed);
        assert_eq!(client.balance(&sentinel), 250);

        // The restore cannot be replayed.
        assert!(client
            .try_resolve_slash(&governance, &case_1.proof_ref, &false)
            .is_err());
        assert!(client
            .try_resolve_slash(&governance, &case_1.proof_ref, &true)
            .is_err());
        assert_eq!(client.balance(&sentinel), 250);
    }

    #[test]
    fn an_appeal_does_not_by_itself_restore_the_stake() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let governance = Address::generate(&env);
        let sentinel = Address::generate(&env);
        let reason = Symbol::new(&env, "fraudulent_submission");
        let case_1 = evidence(&env, "case-1");

        env.mock_all_auths();
        client.initialize(&admin, &governance, &100, &10, &2);
        client.stake(&sentinel, &250);
        client.slash(&governance, &sentinel, &50, &case_1.clone(), &reason);

        client.appeal_slash(&sentinel, &case_1.proof_ref, &String::from_str(&env, "dispute"));

        let record = client.slash_record(&case_1.proof_ref).unwrap();
        assert!(record.appealed);
        assert_eq!(record.outcome, SlashOutcome::Pending);
        // The slash stands until governance resolves it.
        assert_eq!(client.balance(&sentinel), 200);
    }

    #[test]
    fn a_resolved_slash_can_no_longer_be_appealed() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let governance = Address::generate(&env);
        let sentinel = Address::generate(&env);
        let reason = Symbol::new(&env, "fraudulent_submission");
        let case_1 = evidence(&env, "case-1");

        env.mock_all_auths();
        client.initialize(&admin, &governance, &100, &10, &2);
        client.stake(&sentinel, &250);
        client.slash(&governance, &sentinel, &50, &case_1.clone(), &reason);
        client.resolve_slash(&governance, &case_1.proof_ref, &true);

        // Still inside the appeal window, but the record is terminal.
        assert!(client
            .try_appeal_slash(&sentinel, &case_1.proof_ref, &String::from_str(&env, "late"))
            .is_err());
    }

    #[test]
    fn governance_may_appeal_as_the_counterparty() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let governance = Address::generate(&env);
        let sentinel = Address::generate(&env);
        let stranger = Address::generate(&env);
        let reason = Symbol::new(&env, "fraudulent_submission");
        let case_1 = evidence(&env, "case-1");

        env.mock_all_auths();
        client.initialize(&admin, &governance, &100, &10, &2);
        client.stake(&sentinel, &250);
        client.slash(&governance, &sentinel, &50, &case_1.clone(), &reason);

        client.appeal_slash(&governance, &case_1.proof_ref, &String::from_str(&env, "ours"));

        // A third party is a party to nothing.
        assert!(client
            .try_appeal_slash(&stranger, &case_1.proof_ref, &String::from_str(&env, "nosy"))
            .is_err());
    }

    #[test]
    fn a_reversal_that_would_overflow_is_refused_rather_than_wrapping() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let governance = Address::generate(&env);
        let sentinel = Address::generate(&env);
        let reason = Symbol::new(&env, "fraudulent_submission");
        let case_1 = evidence(&env, "case-1");

        env.mock_all_auths();
        client.initialize(&admin, &governance, &100, &10, &2);
        client.stake(&sentinel, &i128::MAX);
        client.slash(&governance, &sentinel, &100, &case_1.clone(), &reason);
        assert_eq!(client.balance(&sentinel), i128::MAX - 100);

        // Top the balance back up to the ceiling while the slash is unresolved.
        client.stake(&sentinel, &100);
        assert_eq!(client.balance(&sentinel), i128::MAX);

        // Restoring the slashed 100 would overflow, so the reversal is refused.
        assert!(client
            .try_resolve_slash(&governance, &case_1.proof_ref, &false)
            .is_err());
        assert_eq!(client.balance(&sentinel), i128::MAX);

        // The refusal left the record unresolved, so it is not half-resolved.
        let record = client.slash_record(&case_1.proof_ref).unwrap();
        assert_eq!(record.outcome, SlashOutcome::Pending);
        assert_eq!(record.resolved_at, 0);

        // Upholding leaves the balance alone and still resolves cleanly.
        client.resolve_slash(&governance, &case_1.proof_ref, &true);
        assert_eq!(client.balance(&sentinel), i128::MAX);
        assert_eq!(
            client.slash_record(&case_1.proof_ref)
                .unwrap()
                .outcome,
            SlashOutcome::Upheld
        );
    }
}
