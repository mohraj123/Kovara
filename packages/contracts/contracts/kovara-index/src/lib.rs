#![no_std]
//! Kōvara smart contracts — PriceVault and KovaraIndex.
//!
//! # PriceVault (CT-002, CT-003, CT-004, CT-005)
//!
//! Stores raw price submissions on-ledger. The entry point for all price
//! submissions. Stores unverified prices and emits events consumed by the
//! `@kovara/sentinel` oracle daemon.
//!
//! | Issue | Description |
//! |---|---|
//! | CT-002 | Implement PriceVault contract |
//! | CT-003 | Key price submissions deterministically |
//! | CT-004 | Validate countries and categories |
//! | CT-005 | Reject invalid price values |
//!
//! # KovaraIndex (CT-030 through CT-037)
//!
//! Daily Kōvara Value Index (KVI) records, one per country per day.
//!
//! | Issue | Adds |
//! |---|---|
//! | CT-030 | Daily index storage semantics beyond the single record below |
//! | CT-031 | KVI rounding rules for `value` |
//! | CT-032 | Deterministic aggregation producing `value` |
//! | CT-033 | Rejection of duplicate index updates |
//! | CT-034 | The authorization policy for who may update |

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, Env, Symbol, Vec,
};

pub mod price_vault;

#[cfg(test)]
mod test;

#[cfg(test)]
mod price_vault_test;

/// The storage schema this build of the contract understands.
///
/// Bump this in the same commit as any change to the shape of a stored value
/// or to the meaning of a key. A deployment initialized under an older schema
/// then rejects every operation until it is migrated, which is the intended
/// outcome — the alternative is reading a v1 record as though it were v2.
pub const SCHEMA_VERSION: u32 = 1;

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

    /// The index value, in the contract's fixed-point representation.
    ///
    /// CT-031 defines the rounding rules that produce this; CT-032 defines
    /// the aggregation. This crate stores whatever it is given.
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
    /// # Errors
    /// * `NotInitialized` — the contract has no schema version yet
    /// * `IncompatibleSchema` — stored schema differs from [`SCHEMA_VERSION`]
    /// * `SentinelsNotConfigured` — no sentinel set has been installed
    /// * `NotASentinel` — a signer is not on the roster
    /// * `DuplicateSigner` — the same address appears twice
    /// * `InsufficientSignatures` — fewer signers than the threshold
    /// * `InvalidBasketVersion` — `basket_version` is zero
    /// * `InvalidSourcePeriod` — the period ends before it starts
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

        // Only the two fields CT-035 introduces are validated here. Country,
        // date and value validation belong to CT-004, CT-005 and CT-030.
        if basket_version == 0 {
            return Err(Error::InvalidBasketVersion);
        }

        if source_period_end < source_period_start {
            return Err(Error::InvalidSourcePeriod);
        }

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

        DailyIndexUpdated {
            country,
            date,
            value,
            basket_version,
            source_period_start,
            source_period_end,
            updater,
            schema_version,
        }
        .publish(&env);

        Ok(())
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
}
