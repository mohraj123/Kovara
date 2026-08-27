#![no_std]
//! `KovaraIndex` — daily Kōvara Value Index (KVI) records, one per country
//! per day.
//!
//! The full **CT-030..CT-037** series for the daily index lands in this
//! crate:
//!
//! | Issue | Adds |
//! |---|---|
//! | CT-030 | Daily storage: one immutable record per country/day, plus `latest` and range queries |
//! | CT-031 | Fixed-point scale, rounding, overflow bounds, missing-basket and baseline rules for `value` |
//! | CT-032 | Deterministic weighted trimmed-median aggregation producing `value` |
//! | CT-033 | Rejection of duplicate and out-of-order updates — finalized history is immutable |
//! | CT-034 | The authorization policy for who may update |
//! | CT-035 | The complete daily index event |
//! | CT-036 | Storage versioning |
//! | CT-037 | Admin transfer and recovery |
//!
//! # Storage versioning (CT-036)
//!
//! Two mechanisms, and they do different jobs.
//!
//! **The schema version is recorded at initialization** and every operation
//! checks it. A contract deployed under one schema and then handed code
//! expecting another fails with [`Error::IncompatibleSchema`] rather than
//! reading records it does not understand. That is the "incompatible changes
//! are rejected" half.
//!
//! **Record keys embed the schema version**, so `DailyIndex(1, "NG", d)` and
//! `DailyIndex(2, "NG", d)` are different entries. That is the "storage keys
//! are versioned" half, and it is what makes a future migration possible: v2
//! records can be written alongside v1 rather than on top of them, so a
//! migration is resumable and a failed one leaves the old data intact.
//!
//! Executing a migration is out of scope here — CT-036 asks for versioning
//! and rejection, not a migration engine. The keyspace above is the
//! precondition for one.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, Env, Symbol, Vec,
};

#[cfg(test)]
mod test;

/// The storage schema this build of the contract understands.
///
/// Bump this in the same commit as any change to the shape of a stored value
/// or to the meaning of a key. A deployment initialized under an older schema
/// then rejects every operation until it is migrated, which is the intended
/// outcome — the alternative is reading a v1 record as though it were v2.
pub const SCHEMA_VERSION: u32 = 1;

// ── CT-031: the fixed-point representation of `value` ────────────────────

/// The fixed-point scale every KVI `value` is expressed in.
///
/// Stored values are integers; dividing by [`KVI_SCALE`] yields the
/// human-readable index. One scale, everywhere, is what makes two
/// implementations of the aggregation produce numbers a consumer can compare.
pub const KVI_SCALE: i128 = 10_000;

/// The baseline index value: 100.0000 in [`KVI_SCALE`] units.
///
/// KVI is normalized so that a country's reference period reads as
/// [`KVI_BASELINE`]: a value above it means prices moved up relative to that
/// baseline, below it means they moved down. The contract stores absolute
/// values and does not re-normalize; this constant pins what "parity with the
/// baseline" means for every consumer of the data.
pub const KVI_BASELINE: i128 = 100 * KVI_SCALE;

/// The largest absolute `value` the contract will store.
///
/// This is the overflow rule (CT-031). Bounding stored and aggregated values
/// at 10^18 keeps every arithmetic step in the contract — including the
/// half-away-from-zero rounding of two medians — far inside `i128`, so a
/// value can never wrap silently. Values beyond the bound are rejected with
/// [`Error::ValueOutOfRange`].
pub const KVI_VALUE_MAX: i128 = 1_000_000_000_000_000_000;

// ── CT-032: deterministic aggregation ────────────────────────────────────

/// How much of each end of the observation distribution is trimmed before
/// the median is taken, in percent (CT-032).
///
/// A 10% trim drops the lowest and highest `len * TRIMMING_PERCENT / 100`
/// observations (floored). The percentage, not a fixed count, is what keeps
/// the behaviour stable as the observation count grows.
pub const TRIMMING_PERCENT: u32 = 10;

// ── CT-030: range queries ────────────────────────────────────────────────

/// The widest `daily_index_history` range, in days.
///
/// A range query iterates one storage read per day, so the window must be
/// bounded or a caller could make the contract spin. Ten years is far wider
/// than any real use and still cheap.
pub const MAX_HISTORY_WINDOW: u64 = 3660;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    /// `initialize` has already run.
    AlreadyInitialized = 1,

    /// The contract has not been initialized, so it has no schema version.
    NotInitialized = 2,

    /// The deployment's stored schema version does not match
    /// [`SCHEMA_VERSION`]. The data must be migrated before this code can
    /// safely operate on it.
    IncompatibleSchema = 3,

    /// `basket_version` was zero. Zero is reserved for "no basket recorded",
    /// which is exactly the ambiguity CT-035 exists to remove.
    InvalidBasketVersion = 4,

    /// The source period ends before it starts.
    InvalidSourcePeriod = 5,

    // ── CT-034: authorization ────────────────────────────────────────────
    /// The caller is not the administrator.
    NotAdmin = 6,

    /// No sentinel set has been configured, so no update can be authorized.
    SentinelsNotConfigured = 7,

    /// A signer is not a registered sentinel.
    NotASentinel = 8,

    /// The same address appears twice in the signer list. Without this,
    /// one sentinel could sign N times and satisfy an N-of-M threshold alone.
    DuplicateSigner = 9,

    /// Fewer valid sentinel signatures than the configured threshold.
    InsufficientSignatures = 10,

    /// A threshold of zero, or one larger than the sentinel set.
    InvalidThreshold = 11,

    /// The same address appears twice in the sentinel set.
    DuplicateSentinel = 12,

    /// An empty sentinel set.
    EmptySentinelSet = 13,

    // ── CT-037: admin transfer and recovery ──────────────────────────────
    /// No admin transfer is pending.
    NoPendingTransfer = 14,

    /// The pending transfer's expiry has passed.
    TransferExpired = 15,

    /// The caller is not the address the transfer was proposed to.
    NotProposedAdmin = 16,

    /// A transfer expiry that is already in the past.
    InvalidExpiry = 17,

    /// No admin recovery is pending.
    NoPendingRecovery = 18,

    /// The recovery timelock has not yet elapsed.
    RecoveryNotReady = 19,

    /// The proposed admin is already the current admin.
    AlreadyAdmin = 20,

    // ── CT-030: daily storage and queries ─────────────────────────────────
    /// A `daily_index_history` range wider than [`MAX_HISTORY_WINDOW`] days.
    HistoryWindowTooLarge = 21,

    /// A range whose end precedes its start.
    InvalidHistoryRange = 22,

    // ── CT-031: KVI rounding rules ────────────────────────────────────────
    /// A `value` outside [`KVI_VALUE_MAX`]. This is the overflow rule.
    ValueOutOfRange = 23,

    // ── CT-032: deterministic aggregation ─────────────────────────────────
    /// Aggregation called with no observations.
    EmptyObservations = 24,

    /// An observation with zero weight.
    ZeroWeight = 25,

    // ── CT-033: immutable history ─────────────────────────────────────────
    /// A record already exists for this `(country, date)`. Finalized history
    /// cannot be overwritten.
    IndexAlreadyFinalized = 26,

    /// A `date` at or before the latest finalized date for the country.
    /// History moves strictly forward; backdating is rejected.
    OutOfOrderUpdate = 27,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    /// Instance: the schema version this deployment was initialized at.
    Schema,

    /// Instance: the administrator address recorded at initialization.
    Admin,

    /// Persistent: `(schema_version, country, date)` → [`DailyIndex`].
    ///
    /// The schema version leads the key so that records written under
    /// different schemas never collide.
    DailyIndex(u32, Symbol, u64),

    /// Persistent: `(schema_version, country)` → the latest finalized date
    /// for that country.
    ///
    /// Feeds the CT-033 out-of-order check: once a later day is finalized,
    /// writing any earlier day is rejected.
    LatestDate(u32, Symbol),

    /// Instance: the addresses permitted to sign a daily index update.
    Sentinels,

    /// Instance: how many distinct sentinel signatures an update requires.
    Threshold,

    /// Instance: an in-flight two-step admin handover.
    PendingTransfer,

    /// Instance: an in-flight sentinel-initiated admin recovery.
    PendingRecovery,
}

/// One country's index value for one day.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DailyIndex {
    /// ISO country code the index covers.
    pub country: Symbol,

    /// The day this index describes, as days since the Unix epoch.
    pub date: u64,

    /// The index value, in the contract's fixed-point representation
    /// ([`KVI_SCALE`], bounded by [`KVI_VALUE_MAX`]).
    ///
    /// CT-031 defines the rounding rules that produce this; CT-032 defines
    /// the aggregation.
    pub value: i128,

    /// Which basket definition the value was computed against.
    ///
    /// Without this a consumer cannot tell a real movement in prices from a
    /// change in what is being measured.
    pub basket_version: u32,

    /// Start of the period the underlying observations cover (Unix seconds).
    pub source_period_start: u64,

    /// End of the period the underlying observations cover (Unix seconds).
    pub source_period_end: u64,

    /// The address that submitted this record.
    pub updater: Address,

    /// The schema version in force when the record was written.
    pub schema_version: u32,
}

/// One input to the deterministic daily aggregation (CT-032).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Observation {
    /// A verified price or price-basket aggregate, in [`KVI_SCALE`] units.
    ///
    /// Values outside [`KVI_VALUE_MAX`] are rejected by the aggregation,
    /// matching the storage rule, so the pure function is total over its
    /// documented domain.
    pub value: i128,

    /// How many verified submissions this observation represents.
    ///
    /// Zero is rejected: an observation that contributes nothing must be
    /// omitted, not passed as zero, or a caller could silently deflate the
    /// median.
    pub weight: u32,
}

/// Emitted whenever a daily index record is written (CT-035).
///
/// Carries every field CT-035 requires — country, date, value, basket,
/// source period, updater — so a consumer can act on the event alone without
/// a follow-up read. `country` and `date` are topics because those are the
/// two dimensions an indexer filters on.
///
/// `schema_version` rides along so a consumer can tell which storage schema
/// produced the record, which matters the moment a migration is in progress
/// and both schemas are briefly live.
#[contractevent]
#[derive(Clone)]
pub struct DailyIndexUpdated {
    #[topic]
    pub country: Symbol,

    #[topic]
    pub date: u64,

    pub value: i128,
    pub basket_version: u32,
    pub source_period_start: u64,
    pub source_period_end: u64,
    pub updater: Address,
    pub schema_version: u32,
}

/// How long a sentinel-initiated admin recovery waits before it can be
/// executed, in ledgers.
///
/// Roughly a day at five seconds per ledger. The delay is the entire safety
/// mechanism: it is the window in which a still-live administrator can veto a
/// recovery they did not ask for. Too short and a compromised sentinel quorum
/// takes the contract before anyone notices; too long and a genuine loss of
/// admin control takes a day to repair. A day errs toward the recoverable
/// failure.
pub const RECOVERY_DELAY_LEDGERS: u32 = 17_280;

/// A two-step admin handover awaiting acceptance (CT-037).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingTransfer {
    /// The address that must accept to become administrator.
    pub new_admin: Address,

    /// Ledger sequence after which the proposal can no longer be accepted.
    pub expires_at: u32,
}

/// A sentinel-initiated admin recovery awaiting its timelock (CT-037).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingRecovery {
    /// The address that becomes administrator once the delay elapses.
    pub new_admin: Address,

    /// Ledger sequence from which the recovery may be executed.
    pub ready_at: u32,
}

/// Emitted when the sentinel set or threshold changes (CT-034).
///
/// Rotation is a security-critical event: it changes who can move the index.
/// The count and threshold are emitted rather than the addresses themselves,
/// which keeps the event small; `get_sentinels` returns the roster.
#[contractevent]
#[derive(Clone)]
pub struct SentinelsRotated {
    #[topic]
    pub admin: Address,
    pub sentinel_count: u32,
    pub threshold: u32,
}

/// Emitted when an admin handover is proposed (CT-037).
#[contractevent]
#[derive(Clone)]
pub struct AdminTransferProposed {
    #[topic]
    pub current_admin: Address,
    #[topic]
    pub new_admin: Address,
    pub expires_at: u32,
}

/// Emitted when a proposed admin accepts (CT-037).
#[contractevent]
#[derive(Clone)]
pub struct AdminTransferAccepted {
    #[topic]
    pub previous_admin: Address,
    #[topic]
    pub new_admin: Address,
}

/// Emitted when a pending handover is cancelled (CT-037).
#[contractevent]
#[derive(Clone)]
pub struct AdminTransferCancelled {
    #[topic]
    pub admin: Address,
    pub cancelled_new_admin: Address,
}

/// Emitted when sentinels initiate an admin recovery (CT-037).
#[contractevent]
#[derive(Clone)]
pub struct AdminRecoveryProposed {
    #[topic]
    pub new_admin: Address,
    pub ready_at: u32,
    pub signer_count: u32,
}

/// Emitted when a recovery completes (CT-037).
#[contractevent]
#[derive(Clone)]
pub struct AdminRecoveryExecuted {
    #[topic]
    pub previous_admin: Address,
    #[topic]
    pub new_admin: Address,
}

/// Emitted when the sitting administrator vetoes a recovery (CT-037).
///
/// This is the signal that matters most to an observer: it proves the
/// administrator was still in control at that ledger.
#[contractevent]
#[derive(Clone)]
pub struct AdminRecoveryCancelled {
    #[topic]
    pub admin: Address,
    pub cancelled_new_admin: Address,
}

#[contract]
pub struct KovaraIndex;

#[contractimpl]
impl KovaraIndex {
    /// Initialize the contract, recording the admin and the schema version.
    ///
    /// # Errors
    /// * `AlreadyInitialized` — initialization has already happened
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Schema) {
            return Err(Error::AlreadyInitialized);
        }

        admin.require_auth();

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::Schema, &SCHEMA_VERSION);

        Ok(())
    }

    /// The schema version this deployment was initialized at.
    ///
    /// `None` before initialization. Deployment tooling uses this to decide
    /// whether a migration is needed without having to provoke an error.
    pub fn deployed_schema_version(env: Env) -> Option<u32> {
        env.storage().instance().get(&DataKey::Schema)
    }

    /// The schema version this build of the contract understands.
    pub fn expected_schema_version(_env: Env) -> u32 {
        SCHEMA_VERSION
    }

    /// Whether this deployment's data is compatible with this build.
    pub fn is_schema_compatible(env: Env) -> bool {
        Self::require_compatible_schema(&env).is_ok()
    }

    /// The administrator recorded at initialization.
    pub fn admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Admin)
    }

    /// Write a daily index record and emit [`DailyIndexUpdated`].
    ///
    /// **Authorization (CT-034).** A daily aggregate moves a number the whole
    /// system trusts, so it is not something one key should be able to do.
    /// The update requires `threshold` distinct sentinel signatures:
    ///
    /// - every address in `signers` must authorize the call itself;
    /// - every address in `signers` must be a registered sentinel;
    /// - `signers` must contain no duplicates;
    /// - `signers.len()` must be at least the configured threshold.
    ///
    /// The duplicate check is what makes the threshold mean anything. Without
    /// it a single sentinel could pass the same address N times and satisfy an
    /// N-of-M policy alone.
    ///
    /// The first signer is treated as the submitter and is what lands in the
    /// record's and the event's `updater` field, preserving CT-035's event
    /// shape.
    ///
    /// **Immutable history (CT-033).** A `(country, date)` record is written
    /// at most once. Replaying this call — or submitting for a date at or
    /// before the country's latest finalized date — fails, so finalized
    /// history can never be overwritten or backdated.
    ///
    /// # Errors
    /// * `NotInitialized` — the contract has no schema version yet
    /// * `IncompatibleSchema` — stored schema differs from [`SCHEMA_VERSION`]
    /// * `SentinelsNotConfigured` — no sentinel set has been installed
    /// * `NotASentinel` — a signer is not on the roster
    /// * `DuplicateSigner` — the same address appears twice
    /// * `InsufficientSignatures` — fewer signers than the threshold
    /// * `InvalidBasketVersion` — `basket_version` is zero
    /// * `InvalidSourcePeriod` — the period ends before it starts
    /// * `ValueOutOfRange` — `value` is outside [`KVI_VALUE_MAX`] (CT-031)
    /// * `IndexAlreadyFinalized` — the date already has a record (CT-033)
    /// * `OutOfOrderUpdate` — the date is not after the latest one (CT-033)
    #[allow(clippy::too_many_arguments)]
    pub fn set_daily_index(
        env: Env,
        signers: Vec<Address>,
        country: Symbol,
        date: u64,
        value: i128,
        basket_version: u32,
        source_period_start: u64,
        source_period_end: u64,
    ) -> Result<(), Error> {
        let schema_version = Self::require_compatible_schema(&env)?;

        let updater = Self::require_sentinel_quorum(&env, &signers)?;

        Self::store_index(
            &env,
            schema_version,
            &updater,
            &country,
            date,
            value,
            basket_version,
            source_period_start,
            source_period_end,
        )
    }

    /// Compute and store the daily index from raw observations (CT-032).
    ///
    /// The value is produced by [`Self::compute_daily_index`] — the same
    /// deterministic weighted trimmed median every sentinel can reproduce —
    /// and then stored and emitted exactly as [`Self::set_daily_index`]
    /// would. Returns the computed value so the caller need not read it back.
    ///
    /// Authorization, field validation, rounding bounds and immutable-history
    /// rules are all shared with [`Self::set_daily_index`].
    ///
    /// # Errors
    /// As [`Self::set_daily_index`], plus:
    /// * `EmptyObservations` — `observations` is empty (CT-032)
    /// * `ZeroWeight` — an observation has weight zero (CT-032)
    #[allow(clippy::too_many_arguments)]
    pub fn set_aggregated_index(
        env: Env,
        signers: Vec<Address>,
        country: Symbol,
        date: u64,
        observations: Vec<Observation>,
        basket_version: u32,
        source_period_start: u64,
        source_period_end: u64,
    ) -> Result<i128, Error> {
        let schema_version = Self::require_compatible_schema(&env)?;

        let updater = Self::require_sentinel_quorum(&env, &signers)?;

        let value = Self::aggregate(&observations)?;

        Self::store_index(
            &env,
            schema_version,
            &updater,
            &country,
            date,
            value,
            basket_version,
            source_period_start,
            source_period_end,
        )?;

        Ok(value)
    }

    /// The deterministic daily aggregation (CT-032): a weighted, 10%-trimmed
    /// median of `observations`.
    ///
    /// Pure and stateless, so it needs no authorization and touches no
    /// storage: any sentinel (or anyone else) can call it to verify that a
    /// submitted aggregate really is the median of the observations, and
    /// every caller computing over identical inputs gets the identical
    /// number.
    ///
    /// # Semantics
    /// * **Trim.** The lowest and highest `len * 10 / 100` observations are
    ///   dropped before the median is taken.
    /// * **Median.** The weighted median of the remainder: the first value
    ///   whose cumulative weight exceeds half the total. When cumulative
    ///   weight lands exactly on half, the two straddling values are
    ///   averaged and rounded half away from zero (CT-031).
    /// * **Weighting.** Each observation counts `weight` times; a heavier
    ///   observation pulls the median toward itself.
    /// * **Ties.** Equal values are interchangeable and the sort is by value
    ///   alone, so the result depends only on the multiset of
    ///   `(value, weight)` pairs — never on input order.
    ///
    /// # Errors
    /// * `EmptyObservations` — `observations` is empty
    /// * `ZeroWeight` — an observation has weight zero
    /// * `ValueOutOfRange` — an observation value is outside [`KVI_VALUE_MAX`]
    pub fn compute_daily_index(_env: Env, observations: Vec<Observation>) -> Result<i128, Error> {
        Self::aggregate(&observations)
    }

    /// Read a daily index record.
    ///
    /// # Errors
    /// * `NotInitialized` / `IncompatibleSchema` — as above. Reads are
    ///   guarded too: returning a record decoded under the wrong schema is
    ///   the failure mode this is meant to prevent.
    pub fn get_daily_index(
        env: Env,
        country: Symbol,
        date: u64,
    ) -> Result<Option<DailyIndex>, Error> {
        let schema_version = Self::require_compatible_schema(&env)?;

        Ok(env
            .storage()
            .persistent()
            .get(&DataKey::DailyIndex(schema_version, country, date)))
    }

    /// The most recent finalized index for a country (CT-030).
    ///
    /// `None` if the country has no records yet. Uses the per-country latest
    /// date maintained by the CT-033 out-of-order check, so it is a single
    /// read rather than a scan.
    ///
    /// # Errors
    /// * `NotInitialized` / `IncompatibleSchema` — as for reads above
    pub fn latest_daily_index(env: Env, country: Symbol) -> Result<Option<DailyIndex>, Error> {
        let schema_version = Self::require_compatible_schema(&env)?;

        let latest: Option<u64> = env
            .storage()
            .persistent()
            .get(&DataKey::LatestDate(schema_version, country.clone()));

        let latest = match latest {
            Some(date) => date,
            None => return Ok(None),
        };

        Ok(env
            .storage()
            .persistent()
            .get(&DataKey::DailyIndex(schema_version, country, latest)))
    }

    /// All finalized records for a country whose `date` is in `[from, to]`,
    /// ascending (CT-030).
    ///
    /// The window is bounded by [`MAX_HISTORY_WINDOW`] so the query cannot
    /// be weaponized into an unbounded loop.
    ///
    /// # Errors
    /// * `NotInitialized` / `IncompatibleSchema` — as for reads above
    /// * `InvalidHistoryRange` — `to < from`
    /// * `HistoryWindowTooLarge` — `to - from` exceeds [`MAX_HISTORY_WINDOW`]
    pub fn daily_index_history(
        env: Env,
        country: Symbol,
        from: u64,
        to: u64,
    ) -> Result<Vec<DailyIndex>, Error> {
        let schema_version = Self::require_compatible_schema(&env)?;

        if to < from {
            return Err(Error::InvalidHistoryRange);
        }

        if to - from > MAX_HISTORY_WINDOW {
            return Err(Error::HistoryWindowTooLarge);
        }

        let mut records = Vec::new(&env);
        let mut date = from;

        while date <= to {
            if let Some(record) =
                env.storage()
                    .persistent()
                    .get::<DataKey, DailyIndex>(&DataKey::DailyIndex(
                        schema_version,
                        country.clone(),
                        date,
                    ))
            {
                records.push_back(record);
            }
            date += 1;
        }

        Ok(records)
    }

    // ── CT-034: sentinel roster and threshold ────────────────────────────

    /// Install the sentinel roster and threshold, replacing any existing set.
    ///
    /// This is the rotation entrypoint. Replacing the roster and the threshold
    /// in one call is deliberate: doing it as separate add/remove steps would
    /// leave the contract in intermediate states where the threshold exceeds
    /// the roster, or where a removed sentinel is briefly still able to sign
    /// alongside its replacement.
    ///
    /// # Errors
    /// * `NotAdmin` — the caller is not the administrator
    /// * `EmptySentinelSet` — an empty roster
    /// * `DuplicateSentinel` — the same address listed twice
    /// * `InvalidThreshold` — zero, or larger than the roster
    pub fn set_sentinels(
        env: Env,
        admin: Address,
        sentinels: Vec<Address>,
        threshold: u32,
    ) -> Result<(), Error> {
        Self::require_admin(&env, &admin)?;

        if sentinels.is_empty() {
            return Err(Error::EmptySentinelSet);
        }

        // A duplicate in the roster would inflate its apparent size, letting a
        // threshold be met by fewer real parties than it names.
        for (i, addr) in sentinels.iter().enumerate() {
            for other in sentinels.iter().skip(i + 1) {
                if addr == other {
                    return Err(Error::DuplicateSentinel);
                }
            }
        }

        // A threshold above the roster size can never be met, which would
        // freeze the index; a threshold of zero would authorize anyone.
        if threshold == 0 || threshold > sentinels.len() {
            return Err(Error::InvalidThreshold);
        }

        env.storage()
            .instance()
            .set(&DataKey::Sentinels, &sentinels);
        env.storage()
            .instance()
            .set(&DataKey::Threshold, &threshold);

        SentinelsRotated {
            admin,
            sentinel_count: sentinels.len(),
            threshold,
        }
        .publish(&env);

        Ok(())
    }

    /// The current sentinel roster.
    pub fn get_sentinels(env: Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&DataKey::Sentinels)
            .unwrap_or_else(|| Vec::new(&env))
    }

    /// How many distinct sentinel signatures an update requires.
    pub fn get_threshold(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::Threshold)
            .unwrap_or(0)
    }

    /// Whether `addr` is on the sentinel roster.
    pub fn is_sentinel(env: Env, addr: Address) -> bool {
        Self::get_sentinels(env).contains(&addr)
    }

    // ── CT-037: admin transfer and recovery ──────────────────────────────

    /// Propose handing the administrator role to `new_admin`.
    ///
    /// Two-step by design: a single-step transfer to a mistyped or unspendable
    /// address strands administrative control permanently, which is exactly
    /// the failure CT-037 names. The proposal does nothing until the recipient
    /// accepts, which proves the address is real and controlled.
    ///
    /// `expires_at` is a ledger sequence. An expiry is required rather than
    /// optional so that a forgotten proposal cannot be accepted years later by
    /// whoever ends up holding that key.
    ///
    /// # Errors
    /// * `NotAdmin`, `AlreadyAdmin`, `InvalidExpiry` (already in the past)
    pub fn propose_admin_transfer(
        env: Env,
        admin: Address,
        new_admin: Address,
        expires_at: u32,
    ) -> Result<(), Error> {
        Self::require_admin(&env, &admin)?;

        if new_admin == admin {
            return Err(Error::AlreadyAdmin);
        }

        if expires_at <= env.ledger().sequence() {
            return Err(Error::InvalidExpiry);
        }

        env.storage().instance().set(
            &DataKey::PendingTransfer,
            &PendingTransfer {
                new_admin: new_admin.clone(),
                expires_at,
            },
        );

        AdminTransferProposed {
            current_admin: admin,
            new_admin,
            expires_at,
        }
        .publish(&env);

        Ok(())
    }

    /// Accept a pending handover. Callable only by the proposed address.
    ///
    /// # Errors
    /// * `NoPendingTransfer`, `TransferExpired`, `NotProposedAdmin`
    pub fn accept_admin_transfer(env: Env, new_admin: Address) -> Result<(), Error> {
        let pending: PendingTransfer = env
            .storage()
            .instance()
            .get(&DataKey::PendingTransfer)
            .ok_or(Error::NoPendingTransfer)?;

        if pending.new_admin != new_admin {
            return Err(Error::NotProposedAdmin);
        }

        if env.ledger().sequence() > pending.expires_at {
            return Err(Error::TransferExpired);
        }

        new_admin.require_auth();

        let previous_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;

        env.storage().instance().set(&DataKey::Admin, &new_admin);
        env.storage().instance().remove(&DataKey::PendingTransfer);

        // A completed handover invalidates any recovery aimed at the old
        // administrator's absence — control has demonstrably just moved.
        env.storage().instance().remove(&DataKey::PendingRecovery);

        AdminTransferAccepted {
            previous_admin,
            new_admin,
        }
        .publish(&env);

        Ok(())
    }

    /// Cancel a pending handover.
    pub fn cancel_admin_transfer(env: Env, admin: Address) -> Result<(), Error> {
        Self::require_admin(&env, &admin)?;

        let pending: PendingTransfer = env
            .storage()
            .instance()
            .get(&DataKey::PendingTransfer)
            .ok_or(Error::NoPendingTransfer)?;

        env.storage().instance().remove(&DataKey::PendingTransfer);

        AdminTransferCancelled {
            admin,
            cancelled_new_admin: pending.new_admin,
        }
        .publish(&env);

        Ok(())
    }

    /// The pending handover, if any.
    pub fn get_pending_transfer(env: Env) -> Option<PendingTransfer> {
        env.storage().instance().get(&DataKey::PendingTransfer)
    }

    /// Begin recovering administrative control, authorized by a sentinel
    /// quorum.
    ///
    /// This is the answer to a lost or unresponsive administrator. Without it,
    /// a two-step transfer that is never accepted — or an admin key that is
    /// simply gone — leaves the contract permanently unadministrable.
    ///
    /// It does not take effect immediately. The recovery becomes executable
    /// only after [`RECOVERY_DELAY_LEDGERS`], and a still-live administrator
    /// can cancel it in the meantime. That delay is what stops the mechanism
    /// from being a way for a sentinel quorum to seize a healthy contract:
    /// they can propose, but the sitting admin gets to say no.
    ///
    /// # Errors
    /// * `SentinelsNotConfigured`, `NotASentinel`, `DuplicateSigner`,
    ///   `InsufficientSignatures`, `AlreadyAdmin`
    pub fn propose_admin_recovery(
        env: Env,
        signers: Vec<Address>,
        new_admin: Address,
    ) -> Result<(), Error> {
        Self::require_sentinel_quorum(&env, &signers)?;

        let current: Option<Address> = env.storage().instance().get(&DataKey::Admin);

        if current.as_ref() == Some(&new_admin) {
            return Err(Error::AlreadyAdmin);
        }

        let ready_at = env
            .ledger()
            .sequence()
            .saturating_add(RECOVERY_DELAY_LEDGERS);

        env.storage().instance().set(
            &DataKey::PendingRecovery,
            &PendingRecovery {
                new_admin: new_admin.clone(),
                ready_at,
            },
        );

        AdminRecoveryProposed {
            new_admin,
            ready_at,
            signer_count: signers.len(),
        }
        .publish(&env);

        Ok(())
    }

    /// Execute a recovery whose timelock has elapsed.
    ///
    /// Deliberately callable by anyone. Requiring the incoming administrator
    /// to call it would reintroduce the liveness assumption the recovery path
    /// exists to remove, and the outcome was already fixed when the quorum
    /// proposed it.
    ///
    /// # Errors
    /// * `NoPendingRecovery`, `RecoveryNotReady`
    pub fn execute_admin_recovery(env: Env) -> Result<(), Error> {
        let pending: PendingRecovery = env
            .storage()
            .instance()
            .get(&DataKey::PendingRecovery)
            .ok_or(Error::NoPendingRecovery)?;

        if env.ledger().sequence() < pending.ready_at {
            return Err(Error::RecoveryNotReady);
        }

        let previous_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;

        env.storage()
            .instance()
            .set(&DataKey::Admin, &pending.new_admin);
        env.storage().instance().remove(&DataKey::PendingRecovery);

        // Any handover the displaced administrator had proposed dies with
        // their authority.
        env.storage().instance().remove(&DataKey::PendingTransfer);

        AdminRecoveryExecuted {
            previous_admin,
            new_admin: pending.new_admin,
        }
        .publish(&env);

        Ok(())
    }

    /// Veto a pending recovery. Only the sitting administrator may do this,
    /// and doing so is itself proof they still hold the key.
    pub fn cancel_admin_recovery(env: Env, admin: Address) -> Result<(), Error> {
        Self::require_admin(&env, &admin)?;

        let pending: PendingRecovery = env
            .storage()
            .instance()
            .get(&DataKey::PendingRecovery)
            .ok_or(Error::NoPendingRecovery)?;

        env.storage().instance().remove(&DataKey::PendingRecovery);

        AdminRecoveryCancelled {
            admin,
            cancelled_new_admin: pending.new_admin,
        }
        .publish(&env);

        Ok(())
    }

    /// The pending recovery, if any.
    pub fn get_pending_recovery(env: Env) -> Option<PendingRecovery> {
        env.storage().instance().get(&DataKey::PendingRecovery)
    }

    // ── Internal guards ──────────────────────────────────────────────────

    /// Require that `admin` is the sitting administrator and has authorized.
    fn require_admin(env: &Env, admin: &Address) -> Result<(), Error> {
        let stored: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;

        if &stored != admin {
            return Err(Error::NotAdmin);
        }

        admin.require_auth();

        Ok(())
    }

    /// Require a distinct, authorized sentinel quorum; return the submitter.
    ///
    /// The submitter is the first signer, and is what callers record as the
    /// `updater`.
    fn require_sentinel_quorum(env: &Env, signers: &Vec<Address>) -> Result<Address, Error> {
        let sentinels: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Sentinels)
            .ok_or(Error::SentinelsNotConfigured)?;

        let threshold: u32 = env
            .storage()
            .instance()
            .get(&DataKey::Threshold)
            .ok_or(Error::SentinelsNotConfigured)?;

        if signers.len() < threshold {
            return Err(Error::InsufficientSignatures);
        }

        for (i, signer) in signers.iter().enumerate() {
            // Reject repeats before checking membership, so a repeated valid
            // sentinel cannot satisfy the threshold on its own.
            for other in signers.iter().skip(i + 1) {
                if signer == other {
                    return Err(Error::DuplicateSigner);
                }
            }

            if !sentinels.contains(&signer) {
                return Err(Error::NotASentinel);
            }

            signer.require_auth();
        }

        signers.first().ok_or(Error::InsufficientSignatures)
    }

    /// Return the deployment's schema version, or fail if it is unusable.
    fn require_compatible_schema(env: &Env) -> Result<u32, Error> {
        let stored: u32 = env
            .storage()
            .instance()
            .get(&DataKey::Schema)
            .ok_or(Error::NotInitialized)?;

        if stored != SCHEMA_VERSION {
            return Err(Error::IncompatibleSchema);
        }

        Ok(stored)
    }

    // ── CT-030..CT-033: storage, rounding, aggregation ────────────────────

    /// Validate, store, and emit the event for one finalized record.
    ///
    /// Shared by [`Self::set_daily_index`] and
    /// [`Self::set_daily_index_from_observations`] so the two entrypoints can
    /// never diverge on what gets stored or emitted. Authorization must have
    /// already been checked by the caller.
    #[allow(clippy::too_many_arguments)]
    fn store_index(
        env: &Env,
        schema_version: u32,
        updater: &Address,
        country: &Symbol,
        date: u64,
        value: i128,
        basket_version: u32,
        source_period_start: u64,
        source_period_end: u64,
    ) -> Result<(), Error> {
        // Only the two fields CT-035 introduces were validated here before
        // CT-030..CT-033 landed; country and date validation still belong to
        // CT-004 and CT-005.
        if basket_version == 0 {
            return Err(Error::InvalidBasketVersion);
        }

        if source_period_end < source_period_start {
            return Err(Error::InvalidSourcePeriod);
        }

        // The overflow rule (CT-031): a value beyond KVI_VALUE_MAX could
        // wrap in downstream arithmetic; reject rather than store garbage.
        if !(-KVI_VALUE_MAX..=KVI_VALUE_MAX).contains(&value) {
            return Err(Error::ValueOutOfRange);
        }

        Self::require_not_finalized(env, schema_version, country, date)?;

        let record = DailyIndex {
            country: country.clone(),
            date,
            value,
            basket_version,
            source_period_start,
            source_period_end,
            updater: updater.clone(),
            schema_version,
        };

        env.storage().persistent().set(
            &DataKey::DailyIndex(schema_version, country.clone(), date),
            &record,
        );

        // The CT-033 out-of-order check needs the latest date per country;
        // keep it in the same write as the record so the two cannot diverge.
        env.storage()
            .persistent()
            .set(&DataKey::LatestDate(schema_version, country.clone()), &date);

        DailyIndexUpdated {
            country: country.clone(),
            date,
            value,
            basket_version,
            source_period_start,
            source_period_end,
            updater: updater.clone(),
            schema_version,
        }
        .publish(env);

        Ok(())
    }

    /// The CT-033 immutable-history guard: reject duplicate and out-of-order
    /// writes.
    fn require_not_finalized(
        env: &Env,
        schema_version: u32,
        country: &Symbol,
        date: u64,
    ) -> Result<(), Error> {
        // A replay targets a date that already has a record.
        if env.storage().persistent().has(&DataKey::DailyIndex(
            schema_version,
            country.clone(),
            date,
        )) {
            return Err(Error::IndexAlreadyFinalized);
        }

        // Backdating targets a date earlier than the latest finalized one. A
        // date *equal* to the latest can never reach here — it would have a
        // record — but `<=` keeps the guard airtight.
        if let Some(latest) = env
            .storage()
            .persistent()
            .get::<DataKey, u64>(&DataKey::LatestDate(schema_version, country.clone()))
        {
            if date <= latest {
                return Err(Error::OutOfOrderUpdate);
            }
        }

        Ok(())
    }

    /// The deterministic weighted trimmed median (CT-032).
    fn aggregate(observations: &Vec<Observation>) -> Result<i128, Error> {
        let count = observations.len();
        if count == 0 {
            return Err(Error::EmptyObservations);
        }

        for observation in observations.iter() {
            if observation.weight == 0 {
                return Err(Error::ZeroWeight);
            }

            // Bounds are enforced here too, not just at storage: the pure
            // function must be total over its documented domain, and it
            // keeps the median straddle sum (`a + b`) safely inside `i128`.
            if !(-KVI_VALUE_MAX..=KVI_VALUE_MAX).contains(&observation.value) {
                return Err(Error::ValueOutOfRange);
            }
        }

        // Trim the lowest and highest `trim` observations by count. `trim` is
        // `floor(count / 10)`, which is always less than `count / 2`, so at
        // least one observation always remains.
        let trim = (count * TRIMMING_PERCENT) / 100;

        let mut sorted = observations.clone();
        sort_by_value(&mut sorted);

        let mut total_weight: u64 = 0;
        for i in trim..(count - trim) {
            total_weight += sorted.get(i).unwrap().weight as u64;
        }

        // Walk the sorted remainder until cumulative weight crosses half.
        let mut cumulative: u64 = 0;
        let mut i = trim;
        while i < count - trim {
            let observation = sorted.get(i).unwrap();
            cumulative += observation.weight as u64;

            if cumulative * 2 > total_weight {
                // Strictly more than half the weight: this is the median.
                return Ok(observation.value);
            }

            if cumulative * 2 == total_weight {
                // Exactly half: the median straddles this and the next value.
                // Average them, rounded half away from zero (CT-031).
                return Ok(match sorted.get(i + 1) {
                    Some(next) => round_half_away(observation.value + next.value, 2),
                    None => observation.value,
                });
            }

            i += 1;
        }

        // Unreachable: total_weight > 0, so cumulative must cross half.
        Err(Error::EmptyObservations)
    }
}

/// Round `numer / denom` half away from zero (CT-031).
///
/// The one rounding rule in the crate, and the only one consumers need to
/// reproduce: `5 / 2 -> 3`, `-5 / 2 -> -3`. Ties (a remainder of exactly
/// half) round away from zero, so the rule is symmetric and never biased
/// toward either direction.
///
/// `denom` must be positive. `numer` is expected to be a sum of values
/// bounded by [`KVI_VALUE_MAX`], so the arithmetic cannot overflow `i128`.
fn round_half_away(numer: i128, denom: i128) -> i128 {
    debug_assert!(denom > 0);

    let quotient = numer / denom;
    let remainder = numer % denom;

    if remainder.abs() * 2 >= denom {
        if numer >= 0 {
            quotient + 1
        } else {
            quotient - 1
        }
    } else {
        quotient
    }
}

/// Sort observations ascending by value, in place.
///
/// Insertion sort: the observation lists a daily aggregation sees are small
/// (bounded by what fits in one transaction), and this keeps the sort
/// dependency-free and obviously deterministic. Equal values are
/// interchangeable, so the sort needs no secondary key.
fn sort_by_value(observations: &mut Vec<Observation>) {
    let count = observations.len();

    for i in 1..count {
        let mut j = i;

        while j > 0 {
            let current = observations.get(j).unwrap();
            let previous = observations.get(j - 1).unwrap();

            if previous.value <= current.value {
                break;
            }

            observations.set(j, previous);
            observations.set(j - 1, current);
            j -= 1;
        }
    }
}
