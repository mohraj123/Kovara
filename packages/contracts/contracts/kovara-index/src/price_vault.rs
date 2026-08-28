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
//! # Storage layout
//!
//! Submissions are keyed by `(schema_version, country_iso, category,
//! submitter_address, timestamp)` — a composite key that is:
//! - **Deterministic**: identical inputs always produce the same key (CT-003)
//! - **Collision-resistant**: distinct observations cannot overwrite each other (CT-003)
//! - **Schema-versioned**: records under different schemas never collide
//!
//! # Validation
//!
//! - Country codes must be valid ISO 3166-1 alpha-2 (CT-004)
//! - Categories must be one of the defined basket categories (CT-004)
//! - Price values must be positive and non-zero (CT-005)

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
}

/// Storage keys for the contract.
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
    /// submitter, timestamp) — this is the deterministic key from CT-003.
    Submission(u32, Symbol, Symbol, Address, u64),

    /// Instance: counter for submission IDs.
    SubmissionCounter,

    /// Persistent: maps submission ID to its composite key for lookup.
    SubmissionById(u64),

    /// Persistent: all submission IDs for a given country (for pending query).
    CountrySubmissions(Symbol, u32),

    /// Instance: allowed country codes.
    AllowedCountries,

    /// Instance: allowed categories.
    AllowedCategories,
}

/// A price submission record.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Submission {
    /// Unique submission ID (sequential).
    pub id: u64,

    /// The submitter's address.
    pub submitter: Address,

    /// ISO 3166-1 alpha-2 country code (e.g., "US", "NG", "KE").
    pub country_iso: Symbol,

    /// Basket category (e.g., "Food", "Rent", "Transport", "Utilities", "Healthcare").
    pub category: Symbol,

    /// Price in USD cents (integer, CT-005 rejects zero).
    pub price_usd_cents: u64,

    /// Local currency code (e.g., "USD", "NGN", "KES").
    pub currency_local: Symbol,

    /// Price in local currency units (integer, CT-005 rejects zero).
    pub price_local: u64,

    /// Unix timestamp of the submission.
    pub timestamp: u64,

    /// The schema version in force when the record was written.
    pub schema_version: u32,
}

/// Emitted when a price is submitted (CT-002).
///
/// `country_iso` and `category` are topics so an indexer can filter by
/// country or category without decoding the full event body.
#[contractevent]
#[derive(Clone)]
pub struct PriceSubmitted {
    #[topic]
    pub submission_id: u64,

    #[topic]
    pub country_iso: Symbol,

    #[topic]
    pub category: Symbol,

    pub submitter: Address,
    pub price_usd_cents: u64,
    pub currency_local: Symbol,
    pub price_local: u64,
    pub timestamp: u64,
    pub schema_version: u32,
}

/// Emitted when a submission is queried.
#[contractevent]
#[derive(Clone)]
pub struct SubmissionQueried {
    #[topic]
    pub submission_id: u64,

    pub requester: Address,
}

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

#[contract]
pub struct PriceVault;

#[contractimpl]
impl PriceVault {
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
        env.storage().instance().set(&DataKey::SubmissionCounter, &0u64);

        // Store default allowed countries and categories
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

    /// Submit a new price entry.
    ///
    /// # Validation (CT-004, CT-005)
    /// - `country_iso` must be a valid ISO 3166-1 alpha-2 code
    /// - `category` must be one of the defined basket categories
    /// - `price_usd_cents` must be non-zero and within bounds
    /// - `price_local` must be non-zero and within bounds
    ///
    /// # Storage (CT-003)
    /// The submission is stored with a deterministic composite key:
    /// `(schema_version, country_iso, category, submitter, timestamp)`
    ///
    /// # Errors
    /// * `NotInitialized` — the contract has not been initialized
    /// * `IncompatibleSchema` — stored schema differs from SCHEMA_VERSION
    /// * `InvalidCountry` — the country code is not allowed
    /// * `InvalidCategory` — the category is not allowed
    /// * `ZeroPrice` — either price value is zero
    /// * `PriceTooLarge` — either price value exceeds the maximum
    pub fn submit(
        env: Env,
        submitter: Address,
        country_iso: Symbol,
        category: Symbol,
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

        let timestamp = env.ledger().timestamp();

        // Create the submission record
        let submission = Submission {
            id: submission_id,
            submitter: submitter.clone(),
            country_iso: country_iso.clone(),
            category: category.clone(),
            price_usd_cents,
            currency_local: currency_local.clone(),
            price_local,
            timestamp,
            schema_version,
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

        // Store the submission ID → key mapping for lookup by ID
        env.storage()
            .persistent()
            .set(&DataKey::SubmissionById(submission_id), &submission);

        // Index by country for pending query
        let country_key = DataKey::CountrySubmissions(country_iso.clone(), schema_version);
        let mut country_subs: Vec<u64> = env
            .storage()
            .persistent()
            .get(&country_key)
            .unwrap_or_else(|| Vec::new(&env));
        country_subs.push_back(submission_id);
        env.storage().persistent().set(&country_key, &country_subs);

        // Increment the counter
        env.storage().instance().set(
            &DataKey::SubmissionCounter,
            &(submission_id + 1),
        );

        // Emit event
        PriceSubmitted {
            submission_id,
            country_iso,
            category,
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
    /// Returns submissions in insertion order (by submission ID).
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

    /// The schema version this deployment was initialized at.
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

    /// The total number of submissions ever created.
    pub fn submission_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::SubmissionCounter)
            .unwrap_or(0)
    }

    // ── Internal guards ──────────────────────────────────────────────────

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
