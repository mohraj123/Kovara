//! `PriceVault` — stores raw price submissions on-ledger.
//!
//! This contract is the entry point for all price submissions. It stores
//! unverified prices and emits events consumed by the `@kovara/sentinel`
//! oracle daemon.
//!
//! # Issues addressed
//!
//! | Issue | Description |
//! |---|---|
//! | CT-002 | Implement PriceVault contract |
//! | CT-003 | Key price submissions deterministically |
//! | CT-004 | Validate countries and categories |
//! | CT-005 | Reject invalid price values |
//!
//! # Data model
//!
//! Every [`Submission`] record carries:
//!
//! | Field                | Type                    | Notes                                            |
//! |----------------------|-------------------------|--------------------------------------------------|
//! | `id`                 | `u64`                   | Sequential, auto-assigned                        |
//! | `submitter`          | `Address`               | Wallet address of the contributor                |
//! | `country_iso`        | `Symbol`                | ISO 3166-1 alpha-2 (validated against allow-list)|
//! | `category`           | `Symbol`                | Basket category (validated against allow-list)   |
//! | `item_name`          | `Symbol`                | Specific basket item, e.g. "Bread", "1BR_CTR"    |
//! | `price_usd_cents`    | `u64`                   | Non-zero, ≤ `MAX_PRICE_USD_CENTS`                |
//! | `currency_local`     | `Symbol`                | Local currency code, e.g. "NGN", "KES"           |
//! | `price_local`        | `u64`                   | Non-zero, ≤ `MAX_PRICE_LOCAL`                    |
//! | `timestamp`          | `u64`                   | Ledger timestamp at submission                   |
//! | `schema_version`     | `u32`                   | Schema in force when the record was written      |
//! | `verification_status`| [`VerificationStatus`]  | Starts `Pending`; set by sentinel via admin call |
//! | `reward_status`      | [`RewardStatus`]        | Starts `Unpaid`; set by FlowRewards via admin call|
//!
//! # Storage layout
//!
//! ## Instance storage (small, protocol-wide values)
//!
//! | Key                              | Type           | Purpose                                      |
//! |----------------------------------|----------------|----------------------------------------------|
//! | `DataKey::Schema`                | `u32`          | Schema version recorded at initialization    |
//! | `DataKey::Admin`                 | `Address`      | Administrator address                        |
//! | `DataKey::SubmissionCounter`     | `u64`          | Monotonically increasing ID counter          |
//! | `DataKey::AllowedCountries`      | `Vec<Symbol>`  | Validated ISO 3166-1 alpha-2 country codes   |
//! | `DataKey::AllowedCategories`     | `Vec<Symbol>`  | Validated basket category symbols            |
//!
//! ## Persistent storage (one entry per submission / per country)
//!
//! | Key                                              | Type         | Purpose                                            |
//! |--------------------------------------------------|--------------|----------------------------------------------------|
//! | `DataKey::Submission(ver, country, cat, addr, ts)` | [`Submission`] | Primary record, keyed deterministically (CT-003) |
//! | `DataKey::SubmissionById(id)`                    | [`Submission`]  | Secondary index — O(1) lookup by sequential ID   |
//! | `DataKey::CountrySubmissions(country, ver)`      | `Vec<u64>`   | All submission IDs for a country (pending query)   |
//! | `DataKey::VerifiedSubmissions(country, ver)`     | `Vec<u64>`   | Verified submission IDs for a country              |
//!
//! The sentinel oracle writes verified IDs into `VerifiedSubmissions` so that
//! index aggregation does not need to scan the full `CountrySubmissions` list.
//! Both indexes are schema-versioned, which means a future migration can write
//! v2 records alongside v1 records without collision.
//!
//! # Validation
//!
//! - Country codes must be in the allowed set (CT-004)
//! - Categories must be in the allowed set (CT-004)
//! - `price_usd_cents` and `price_local` must be non-zero and ≤ their caps (CT-005)
//!
//! # Verification and reward flows
//!
//! Verification and reward state are stored directly on each [`Submission`]
//! record so that a single `get_submission` call returns the complete picture.
//!
//! * `set_verification_status(id, status)` — admin-only; called by the
//!   `SentinelPool` contract (or its authorized proxy) once a quorum is
//!   reached. Transitioning to `Verified` also appends the ID to
//!   `VerifiedSubmissions` so `KovaraIndex` can query it directly.
//!
//! * `set_reward_status(id, status)` — admin-only; called by `FlowRewards`
//!   after a reward is released or when a submission is found ineligible.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, Env, Symbol, Vec,
};

/// The storage schema this build of the contract understands.
pub const SCHEMA_VERSION: u32 = 1;

/// Maximum price value in USD cents (1 billion = $10,000,000).
/// This prevents absurdly large values while allowing reasonable prices.
const MAX_PRICE_USD_CENTS: u64 = 1_000_000_000;

/// Maximum price value in local currency units (1 billion).
const MAX_PRICE_LOCAL: u64 = 1_000_000_000;

/// The widest `submissions_in_time_window` range, in seconds.
///
/// A window query reads one persistent entry per submission recorded for the
/// country, so the span is bounded for the same reason the daily index
/// history is: a caller must not be able to turn the query into an unbounded
/// iteration. One year (366 days) is the widest window the submission feed
/// is meant to be read at; wider windows should page instead.
pub const MAX_SUBMISSION_WINDOW: u64 = 366 * 24 * 60 * 60;

/// The unit every timestamp in this contract is expressed in.
///
/// Submission record timestamps, the `PriceSubmitted` event's `timestamp`
/// field, and the `from`/`to` bounds accepted by
/// [`PriceVault::submissions_in_time_window`] are all **Unix seconds UTC**,
/// taken from the ledger via `Env::ledger().timestamp()`. One unit, one
/// source, everywhere — a consumer never has to guess whether a stored
/// timestamp is seconds, milliseconds, or a ledger sequence.
pub const TIMESTAMP_UNIT: &str = "unix_seconds_utc";

// ── Status enums ─────────────────────────────────────────────────────────

/// Lifecycle state of a submission in the peer-verification flow.
///
/// New submissions always start as `Pending`. The `SentinelPool` contract
/// (via an admin call to [`PriceVault::set_verification_status`]) transitions
/// a record to `Verified` when the quorum threshold is met, or to `Rejected`
/// when the quorum finds the price implausible.
///
/// `Verified` is the only state that makes a submission eligible to be
/// included in a daily `KovaraIndex` aggregation.
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum VerificationStatus {
    /// Awaiting peer-verification votes.
    Pending = 0,
    /// Quorum confirmed the price as plausible.
    Verified = 1,
    /// Quorum rejected the price as implausible or fraudulent.
    Rejected = 2,
}

/// Lifecycle state of a submission in the reward flow.
///
/// New submissions always start as `Unpaid`. `FlowRewards` (via an admin
/// call to [`PriceVault::set_reward_status`]) transitions the record to
/// `Paid` once the XLM / USDC micro-reward has been released, or to
/// `Ineligible` if the submission was rejected before a reward was due.
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum RewardStatus {
    /// Reward has not yet been released.
    Unpaid = 0,
    /// Reward has been released to the submitter.
    Paid = 1,
    /// Submission was rejected; no reward will be issued.
    Ineligible = 2,
}

// ── Error codes ───────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    /// `initialize` has already run.
    AlreadyInitialized = 1,

    /// The contract has not been initialized.
    NotInitialized = 2,

    /// The deployment's stored schema version does not match SCHEMA_VERSION.
    IncompatibleSchema = 3,

    /// The caller is not the administrator.
    NotAdmin = 4,

    /// The price value is zero — zero prices corrupt the index.
    ZeroPrice = 5,

    /// The price value exceeds the maximum allowed.
    PriceTooLarge = 6,

    /// The country code is not a valid ISO 3166-1 alpha-2 code.
    InvalidCountry = 7,

    /// The category is not a valid basket category.
    InvalidCategory = 8,

    /// The submission does not exist.
    NotFound = 9,

    /// The caller is not authorized to submit prices.
    UnauthorizedSubmitter = 10,

    /// A time window whose end precedes its start.
    InvalidTimeWindow = 11,

    /// A `submissions_in_time_window` span wider than `MAX_SUBMISSION_WINDOW`.
    TimeWindowTooLarge = 12,
}

// ── Storage keys ──────────────────────────────────────────────────────────

/// Storage keys for the contract.
///
/// See the module-level documentation for the full storage layout table.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    /// Instance: the schema version this deployment was initialized at.
    Schema,

    /// Instance: the administrator address.
    Admin,

    /// Persistent: a price submission record.
    ///
    /// The key is a composite of (schema_version, country, category,
    /// submitter, timestamp) — the deterministic key from CT-003.
    Submission(u32, Symbol, Symbol, Address, u64),

    /// Instance: counter for submission IDs.
    SubmissionCounter,

    /// Persistent: maps submission ID to its full record for O(1) lookup.
    SubmissionById(u64),

    /// Persistent: all submission IDs for a given country (pending query).
    ///
    /// Appended to on every successful `submit()` call.
    CountrySubmissions(Symbol, u32),

    /// Persistent: verified submission IDs for a given country.
    ///
    /// Appended to when `set_verification_status` transitions a record to
    /// `Verified`. Used by `KovaraIndex` to aggregate only confirmed data.
    VerifiedSubmissions(Symbol, u32),

    /// Instance: allowed country codes.
    AllowedCountries,

    /// Instance: allowed categories.
    AllowedCategories,
}

// ── Core data types ───────────────────────────────────────────────────────

/// A price submission record — the primary unit of data in the Kōvara protocol.
///
/// Stored under both `DataKey::Submission` (deterministic composite key, CT-003)
/// and `DataKey::SubmissionById` (sequential ID index). Both copies are updated
/// whenever `set_verification_status` or `set_reward_status` mutates the record.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Submission {
    /// Unique submission ID (sequential, assigned at submission time).
    pub id: u64,

    /// The submitter's Stellar address.
    pub submitter: Address,

    /// ISO 3166-1 alpha-2 country code (e.g., "US", "NG", "KE").
    pub country_iso: Symbol,

    /// Basket category (e.g., "Food", "Rent", "Transport", "Utilities", "Health").
    pub category: Symbol,

    /// Specific basket item within the category.
    ///
    /// Short Symbol label that identifies which item in the basket this price
    /// refers to. Examples:
    /// - Food → "Bread", "Rice", "Milk", "Eggs", "Oil"
    /// - Rent → "1BR_CTR" (1-bedroom city centre), "1BR_OUT" (outside centre)
    /// - Transport → "MonPass", "Petrol", "TaxiFare"
    /// - Utilities → "Elec", "Net60", "Water"
    /// - Health → "GPVisit", "RxMed"
    ///
    /// Keeping this as a `Symbol` (max 32 bytes, stack-allocated in Soroban)
    /// avoids heap allocation overhead on-chain while remaining human-readable
    /// in explorers and event logs.
    pub item_name: Symbol,

    /// Price in USD cents (integer; CT-005 rejects zero and values > MAX).
    pub price_usd_cents: u64,

    /// Local currency code (e.g., "USD", "NGN", "KES").
    pub currency_local: Symbol,

    /// Price in local currency units (integer; CT-005 rejects zero and values > MAX).
    pub price_local: u64,

    /// Unix timestamp (seconds) of the submission, taken from the ledger.
    pub timestamp: u64,

    /// The schema version in force when the record was written.
    pub schema_version: u32,

    /// Current state in the peer-verification flow.
    ///
    /// Starts as [`VerificationStatus::Pending`] on every new submission.
    /// Transitions to `Verified` or `Rejected` via `set_verification_status`,
    /// which is callable only by the admin (expected to be the SentinelPool).
    pub verification_status: VerificationStatus,

    /// Current state in the reward flow.
    ///
    /// Starts as [`RewardStatus::Unpaid`] on every new submission.
    /// Transitions to `Paid` when FlowRewards releases the micro-reward, or
    /// to `Ineligible` when the submission is rejected before payout.
    pub reward_status: RewardStatus,
}

// ── Events ────────────────────────────────────────────────────────────────

/// Emitted when a price is submitted (CT-002).
///
/// `country_iso`, `category`, and `item_name` are topics so that an indexer
/// (the Sentinel daemon) can filter by country, category, or specific item
/// without decoding the full event body.
#[contractevent]
#[derive(Clone)]
pub struct PriceSubmitted {
    #[topic]
    pub submission_id: u64,

    #[topic]
    pub country_iso: Symbol,

    #[topic]
    pub category: Symbol,

    #[topic]
    pub item_name: Symbol,

    pub submitter: Address,
    pub price_usd_cents: u64,
    pub currency_local: Symbol,
    pub price_local: u64,
    pub timestamp: u64,
    pub schema_version: u32,
}

/// Emitted when a submission's verification status changes.
///
/// The `country_iso` topic lets the sentinel aggregate per-country
/// verification events efficiently.
#[contractevent]
#[derive(Clone)]
pub struct VerificationStatusChanged {
    #[topic]
    pub submission_id: u64,

    #[topic]
    pub country_iso: Symbol,

    pub new_status: VerificationStatus,
}

/// Emitted when a submission's reward status changes.
#[contractevent]
#[derive(Clone)]
pub struct RewardStatusChanged {
    #[topic]
    pub submission_id: u64,

    pub new_status: RewardStatus,
}

/// Emitted when a submission is queried.
#[contractevent]
#[derive(Clone)]
pub struct SubmissionQueried {
    #[topic]
    pub submission_id: u64,

    pub requester: Address,
}

// ── Default allow-lists ───────────────────────────────────────────────────

/// Default allowed country codes (ISO 3166-1 alpha-2).
/// These are the initial supported countries for the Kōvara protocol.
fn default_allowed_countries(env: &Env) -> Vec<Symbol> {
    soroban_sdk::vec![
        env,
        Symbol::new(env, "US"), // United States
        Symbol::new(env, "GB"), // United Kingdom
        Symbol::new(env, "NG"), // Nigeria
        Symbol::new(env, "KE"), // Kenya
        Symbol::new(env, "IN"), // India
        Symbol::new(env, "BR"), // Brazil
        Symbol::new(env, "DE"), // Germany
        Symbol::new(env, "FR"), // France
        Symbol::new(env, "JP"), // Japan
        Symbol::new(env, "CN"), // China
        Symbol::new(env, "ZA"), // South Africa
        Symbol::new(env, "GH"), // Ghana
        Symbol::new(env, "EG"), // Egypt
        Symbol::new(env, "TZ"), // Tanzania
        Symbol::new(env, "UG"), // Uganda
        Symbol::new(env, "ET"), // Ethiopia
        Symbol::new(env, "PH"), // Philippines
        Symbol::new(env, "ID"), // Indonesia
        Symbol::new(env, "MX"), // Mexico
        Symbol::new(env, "AR"), // Argentina
    ]
}

/// Default allowed basket categories.
fn default_allowed_categories(env: &Env) -> Vec<Symbol> {
    soroban_sdk::vec![
        env,
        Symbol::new(env, "Food"),
        Symbol::new(env, "Rent"),
        Symbol::new(env, "Transport"),
        Symbol::new(env, "Utilities"),
        Symbol::new(env, "Health"),
    ]
}

// ── Contract implementation ───────────────────────────────────────────────

#[contract]
pub struct PriceVault;

#[contractimpl]
impl PriceVault {
    // ── Lifecycle ─────────────────────────────────────────────────────────

    /// Initialize the contract, recording the admin and the schema version.
    ///
    /// # Errors
    /// * `AlreadyInitialized` — initialization has already happened.
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Schema) {
            return Err(Error::AlreadyInitialized);
        }

        admin.require_auth();

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::Schema, &SCHEMA_VERSION);
        env.storage()
            .instance()
            .set(&DataKey::SubmissionCounter, &0u64);

        env.storage().instance().set(
            &DataKey::AllowedCountries,
            &default_allowed_countries(&env),
        );
        env.storage().instance().set(
            &DataKey::AllowedCategories,
            &default_allowed_categories(&env),
        );

        Ok(())
    }

    // ── Submission ────────────────────────────────────────────────────────

    /// Submit a new price entry.
    ///
    /// # Parameters
    /// - `submitter`       — the contributor's Stellar address (must sign the tx)
    /// - `country_iso`     — ISO 3166-1 alpha-2 code, e.g. `"NG"`
    /// - `category`        — basket category, e.g. `"Food"`
    /// - `item_name`       — specific item within category, e.g. `"Bread"`
    /// - `price_usd_cents` — price in USD cents (non-zero, ≤ MAX)
    /// - `currency_local`  — local currency code, e.g. `"NGN"`
    /// - `price_local`     — price in local currency units (non-zero, ≤ MAX)
    ///
    /// # Validation (CT-004, CT-005)
    /// - `country_iso` must be in the allowed set
    /// - `category` must be in the allowed set
    /// - Both price values must be non-zero and within bounds
    ///
    /// # Storage (CT-003)
    /// The record is stored under a deterministic composite key:
    /// `(schema_version, country_iso, category, submitter, timestamp)`
    /// and also indexed by sequential ID via `DataKey::SubmissionById`.
    ///
    /// # Default status values
    /// Every new submission starts with:
    /// - `verification_status = VerificationStatus::Pending`
    /// - `reward_status       = RewardStatus::Unpaid`
    ///
    /// # Errors
    /// * `NotInitialized`   — the contract has not been initialized
    /// * `IncompatibleSchema` — stored schema differs from `SCHEMA_VERSION`
    /// * `InvalidCountry`   — the country code is not in the allow-list
    /// * `InvalidCategory`  — the category is not in the allow-list
    /// * `ZeroPrice`        — either price value is zero
    /// * `PriceTooLarge`    — either price value exceeds the maximum
    pub fn submit(
        env: Env,
        submitter: Address,
        country_iso: Symbol,
        category: Symbol,
        item_name: Symbol,
        price_usd_cents: u64,
        currency_local: Symbol,
        price_local: u64,
    ) -> Result<u64, Error> {
        let schema_version = Self::require_compatible_schema(&env)?;

        // CT-005: Reject zero prices
        if price_usd_cents == 0 {
            return Err(Error::ZeroPrice);
        }
        if price_local == 0 {
            return Err(Error::ZeroPrice);
        }

        // CT-005: Reject prices that are too large
        if price_usd_cents > MAX_PRICE_USD_CENTS {
            return Err(Error::PriceTooLarge);
        }
        if price_local > MAX_PRICE_LOCAL {
            return Err(Error::PriceTooLarge);
        }

        // CT-004: Validate country code
        let allowed_countries: Vec<Symbol> = env
            .storage()
            .instance()
            .get(&DataKey::AllowedCountries)
            .ok_or(Error::NotInitialized)?;

        if !allowed_countries.contains(&country_iso) {
            return Err(Error::InvalidCountry);
        }

        // CT-004: Validate category
        let allowed_categories: Vec<Symbol> = env
            .storage()
            .instance()
            .get(&DataKey::AllowedCategories)
            .ok_or(Error::NotInitialized)?;

        if !allowed_categories.contains(&category) {
            return Err(Error::InvalidCategory);
        }

        // Require authorization from the submitter
        submitter.require_auth();

        // Generate sequential submission ID
        let submission_id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::SubmissionCounter)
            .unwrap_or(0);

        // One source for the submission timestamp: the ledger clock, in Unix
        // seconds UTC. The record and the `PriceSubmitted` event below are
        // built from the same value, so they can never disagree.
        let timestamp = Self::ledger_timestamp(&env);

        // Build the submission record with default status values.
        let submission = Submission {
            id: submission_id,
            submitter: submitter.clone(),
            country_iso: country_iso.clone(),
            category: category.clone(),
            item_name: item_name.clone(),
            price_usd_cents,
            currency_local: currency_local.clone(),
            price_local,
            timestamp,
            schema_version,
            // All new submissions start as pending / unpaid.
            verification_status: VerificationStatus::Pending,
            reward_status: RewardStatus::Unpaid,
        };

        // CT-003: Store with deterministic composite key
        env.storage().persistent().set(
            &DataKey::Submission(
                schema_version,
                country_iso.clone(),
                category.clone(),
                submitter.clone(),
                timestamp,
            ),
            &submission,
        );

        // Secondary index: lookup by sequential ID
        env.storage()
            .persistent()
            .set(&DataKey::SubmissionById(submission_id), &submission);

        // Country pending index
        let country_key = DataKey::CountrySubmissions(country_iso.clone(), schema_version);
        let mut country_subs: Vec<u64> = env
            .storage()
            .persistent()
            .get(&country_key)
            .unwrap_or_else(|| Vec::new(&env));
        country_subs.push_back(submission_id);
        env.storage().persistent().set(&country_key, &country_subs);

        // Increment the ID counter
        env.storage()
            .instance()
            .set(&DataKey::SubmissionCounter, &(submission_id + 1));

        // Emit submission event
        PriceSubmitted {
            submission_id,
            country_iso,
            category,
            item_name,
            submitter,
            price_usd_cents,
            currency_local,
            price_local,
            timestamp,
            schema_version,
        }
        .publish(&env);

        Ok(submission_id)
    }

    // ── Status updates ────────────────────────────────────────────────────

    /// Update the verification status of a submission.
    ///
    /// Admin-only. In production this is called by the `SentinelPool` contract
    /// (or its authorized proxy) once a peer-verification quorum is reached.
    ///
    /// When transitioning to `Verified`, the submission ID is also appended to
    /// `DataKey::VerifiedSubmissions` so that `KovaraIndex` can aggregate
    /// confirmed data without scanning the full pending list.
    ///
    /// # Errors
    /// * `NotInitialized` / `IncompatibleSchema` — as above
    /// * `NotAdmin`  — caller is not the recorded administrator
    /// * `NotFound`  — the submission does not exist
    pub fn set_verification_status(
        env: Env,
        caller: Address,
        submission_id: u64,
        new_status: VerificationStatus,
    ) -> Result<(), Error> {
        let _schema_version = Self::require_compatible_schema(&env)?;
        Self::require_admin(&env, &caller)?;

        let mut submission: Submission = env
            .storage()
            .persistent()
            .get(&DataKey::SubmissionById(submission_id))
            .ok_or(Error::NotFound)?;

        submission.verification_status = new_status;

        // Update both storage copies so they remain consistent.
        env.storage()
            .persistent()
            .set(&DataKey::SubmissionById(submission_id), &submission);
        env.storage().persistent().set(
            &DataKey::Submission(
                submission.schema_version,
                submission.country_iso.clone(),
                submission.category.clone(),
                submission.submitter.clone(),
                submission.timestamp,
            ),
            &submission,
        );

        // Append to the verified index when newly confirmed.
        if new_status == VerificationStatus::Verified {
            let verified_key = DataKey::VerifiedSubmissions(
                submission.country_iso.clone(),
                submission.schema_version,
            );
            let mut verified_ids: Vec<u64> = env
                .storage()
                .persistent()
                .get(&verified_key)
                .unwrap_or_else(|| Vec::new(&env));
            verified_ids.push_back(submission_id);
            env.storage()
                .persistent()
                .set(&verified_key, &verified_ids);
        }

        VerificationStatusChanged {
            submission_id,
            country_iso: submission.country_iso,
            new_status,
        }
        .publish(&env);

        Ok(())
    }

    /// Update the reward status of a submission.
    ///
    /// Admin-only. In production this is called by the `FlowRewards` contract
    /// after a micro-reward is released to the submitter, or when a submission
    /// becomes ineligible due to rejection.
    ///
    /// # Errors
    /// * `NotInitialized` / `IncompatibleSchema` — as above
    /// * `NotAdmin`  — caller is not the recorded administrator
    /// * `NotFound`  — the submission does not exist
    pub fn set_reward_status(
        env: Env,
        caller: Address,
        submission_id: u64,
        new_status: RewardStatus,
    ) -> Result<(), Error> {
        let _schema_version = Self::require_compatible_schema(&env)?;
        Self::require_admin(&env, &caller)?;

        let mut submission: Submission = env
            .storage()
            .persistent()
            .get(&DataKey::SubmissionById(submission_id))
            .ok_or(Error::NotFound)?;

        submission.reward_status = new_status;

        // Update both storage copies.
        env.storage()
            .persistent()
            .set(&DataKey::SubmissionById(submission_id), &submission);
        env.storage().persistent().set(
            &DataKey::Submission(
                submission.schema_version,
                submission.country_iso.clone(),
                submission.category.clone(),
                submission.submitter.clone(),
                submission.timestamp,
            ),
            &submission,
        );

        RewardStatusChanged {
            submission_id,
            new_status,
        }
        .publish(&env);

        Ok(())
    }

    // ── Queries ───────────────────────────────────────────────────────────

    /// Read a single submission by ID.
    ///
    /// # Errors
    /// * `NotInitialized` / `IncompatibleSchema` — as above
    /// * `NotFound` — the submission does not exist
    pub fn get_submission(env: Env, submission_id: u64) -> Result<Submission, Error> {
        let _schema_version = Self::require_compatible_schema(&env)?;

        env.storage()
            .persistent()
            .get(&DataKey::SubmissionById(submission_id))
            .ok_or(Error::NotFound)
    }

    /// Read all pending (unverified) submissions for a country.
    ///
    /// Returns submissions in insertion order (ascending by submission ID).
    /// Note: this includes `Rejected` entries as well; callers should filter
    /// by `verification_status` if they only want `Pending` records.
    ///
    /// # Errors
    /// * `NotInitialized` / `IncompatibleSchema` — as above
    pub fn pending(env: Env, country_iso: Symbol) -> Vec<Submission> {
        let schema_version = match Self::require_compatible_schema(&env) {
            Ok(v) => v,
            Err(_) => return Vec::new(&env),
        };

        let country_key = DataKey::CountrySubmissions(country_iso, schema_version);
        let submission_ids: Vec<u64> = env
            .storage()
            .persistent()
            .get(&country_key)
            .unwrap_or_else(|| Vec::new(&env));

        let mut submissions = Vec::new(&env);
        for id in submission_ids.iter() {
            if let Some(submission) = env
                .storage()
                .persistent()
                .get::<DataKey, Submission>(&DataKey::SubmissionById(id))
            {
                submissions.push_back(submission);
            }
        }

        submissions
    }

    /// Read all verified submission IDs for a country.
    ///
    /// Used by `KovaraIndex` to aggregate confirmed data.
    pub fn verified_ids(env: Env, country_iso: Symbol) -> Vec<u64> {
        let schema_version = match Self::require_compatible_schema(&env) {
            Ok(v) => v,
            Err(_) => return Vec::new(&env),
        };

        env.storage()
            .persistent()
            .get(&DataKey::VerifiedSubmissions(country_iso, schema_version))
            .unwrap_or_else(|| Vec::new(&env))
    }

    /// Read every submission for a country whose record timestamp lies in the
    /// inclusive window `[from_timestamp, to_timestamp]`.
    ///
    /// This is the historical-record filter. The primary record is keyed by
    /// `(schema_version, country, category, submitter, timestamp)` and the
    /// per-country index is insertion-ordered, so a window is served by
    /// scanning the country's IDs once and returning the records whose stored
    /// `timestamp` falls inside the range.
    ///
    /// Timestamps are Unix seconds UTC — the same unit the [`PriceSubmitted`]
    /// event carries (see [`TIMESTAMP_UNIT`]).
    ///
    /// # Errors
    /// * `NotInitialized` / `IncompatibleSchema` — as above
    /// * `InvalidTimeWindow` — `from_timestamp` is after `to_timestamp`
    /// * `TimeWindowTooLarge` — the span exceeds [`MAX_SUBMISSION_WINDOW`]
    pub fn submissions_in_time_window(
        env: Env,
        country_iso: Symbol,
        from_timestamp: u64,
        to_timestamp: u64,
    ) -> Result<Vec<Submission>, Error> {
        let schema_version = Self::require_compatible_schema(&env)?;

        if from_timestamp > to_timestamp {
            return Err(Error::InvalidTimeWindow);
        }
        if to_timestamp - from_timestamp > MAX_SUBMISSION_WINDOW {
            return Err(Error::TimeWindowTooLarge);
        }

        let country_key = DataKey::CountrySubmissions(country_iso, schema_version);
        let submission_ids: Vec<u64> = env
            .storage()
            .persistent()
            .get(&country_key)
            .unwrap_or_else(|| Vec::new(&env));

        let mut submissions = Vec::new(&env);
        for id in submission_ids.iter() {
            if let Some(submission) = env
                .storage()
                .persistent()
                .get::<DataKey, Submission>(&DataKey::SubmissionById(id))
            {
                if submission.timestamp >= from_timestamp
                    && submission.timestamp <= to_timestamp
                {
                    submissions.push_back(submission);
                }
            }
        }

        Ok(submissions)
    }

    // ── Schema / admin introspection ──────────────────────────────────────

    /// The schema version this deployment was initialized at.
    pub fn deployed_schema_version(env: Env) -> Option<u32> {
        env.storage().instance().get(&DataKey::Schema)
    }

    /// The schema version this build of the contract understands.
    pub fn expected_schema_version(_env: Env) -> u32 {
        SCHEMA_VERSION
    }

    /// The unit every timestamp in this contract is expressed in.
    ///
    /// Exposed so a consumer does not have to read the source to know whether
    /// a stored timestamp is seconds, milliseconds, or a ledger sequence:
    /// records, events, and the bounds of `submissions_in_time_window` are all
    /// Unix seconds UTC.
    pub fn timestamp_unit(env: Env) -> Symbol {
        Symbol::new(&env, TIMESTAMP_UNIT)
    }

    /// Whether this deployment's data is compatible with this build.
    pub fn is_schema_compatible(env: Env) -> bool {
        Self::require_compatible_schema(&env).is_ok()
    }

    /// The administrator recorded at initialization.
    pub fn admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Admin)
    }

    /// The total number of submissions ever created.
    pub fn submission_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::SubmissionCounter)
            .unwrap_or(0)
    }

    // ── Internal guards ───────────────────────────────────────────────────

    /// The current ledger time, in Unix seconds UTC.
    ///
    /// Every timestamp this contract stores or emits is taken from here, which
    /// is what keeps a stored record and its event in the same unit.
    fn ledger_timestamp(env: &Env) -> u64 {
        env.ledger().timestamp()
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

    /// Verify that `caller` is the stored admin and require their auth.
    fn require_admin(env: &Env, caller: &Address) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;

        if *caller != admin {
            return Err(Error::NotAdmin);
        }

        caller.require_auth();
        Ok(())
    }
}
