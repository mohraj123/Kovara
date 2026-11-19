#![no_std]

//! `PriceVault` — stores raw price submissions keyed by `(country_iso,
//! category, valid_from)`.
//!
//! A submission is a single cost-of-living observation (bread, rent, transport,
//! …) made in a given country at a given moment. Each observation carries an
//! explicit **validity window** and moves through a strict **verification
//! state machine** before it can be aggregated into the Kovara index.
//!
//! ```text
//!                         ┌──────────────► Verified   (terminal)
//!  submit() ──► Pending ──┤
//!                         └──────────────► Rejected   (terminal)
//! ```
//!
//! # Design invariants
//!
//! ## Validation happens before auth, and before storage
//!
//! Every rejection path in [`PriceVault::submit`] is a **pure** predicate over
//! the caller's arguments. The order is fixed:
//!
//! 1. [`registry`] — the country and category must be known identifiers.
//! 2. [`payload`] — the arguments must satisfy [`SUBMIT_SCHEMA`].
//! 3. [`guards`] — arithmetic is checked, never assumed.
//!
//! Only then does the contract call `require_auth` and touch storage. A
//! malformed call therefore costs the caller nothing beyond the validation it
//! already had to pay for, and can never leave a partial write behind.
//!
//! ## Validity windows
//!
//! ```text
//! valid_from â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ valid_until
//!     â”‚                      â”‚
//!  earliest ledger ts     expiry ts (exclusive)
//! ```
//!
//! The lower bound is inclusive, the upper bound exclusive, so consecutive
//! non-overlapping windows `[t, t+w)` and `[t+w, t+2w)` never both claim a
//! query timestamp. [`PriceVault::is_valid_at`] is the canonical predicate;
//! [`PriceVault::get_valid`] combines it with the read.
//!
//! ## Terminal states are terminal
//!
//! `Verified` and `Rejected` are absorbing. There is no path back to `Pending`
//! and no path between them — see [`SubmissionStatus::can_transition_to`]. An
//! attempt to leave a terminal state fails with [`Error::InvalidTransition`]
//! and leaves the record byte-for-byte unchanged.
//!
//! ## Error codes are ABI
//!
//! [`Error`] is `#[repr(u32)]` and its discriminants are part of the contract
//! ABI: deployed clients map integer codes back to meanings. They are therefore
//! allocated **contiguously from 1** and are **append-only**. A new condition
//! gets the next free number; an existing number is never reused or renumbered,
//! even if the condition it described is later removed.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, Env, Symbol, Vec,
};

// ── Constants ────────────────────────────────────────────────────────────────

/// Default validity window: 24 hours expressed in seconds.
///
/// A price observation submitted without an explicit window should use this.
/// 24 h suits daily cost-of-living basket items (bread, rent, transport) where
/// intra-day volatility is minimal.
pub const DEFAULT_VALIDITY_WINDOW_SECS: u64 = 86_400;

/// The schema version this build of `PriceVault` understands.
pub const SCHEMA_VERSION: u32 = 1;

/// Largest price value accepted by [`SUBMIT_SCHEMA`] (fixed-point units).
///
/// The ceiling bounds how far one rogue submission can skew an index median.
pub const MAX_PRICE: i128 = 1_000_000_000_000;

/// Maximum entries returned by a bounded country or submitter history page.
pub const MAX_HISTORY_PAGE_SIZE: u32 = 50;
/// Maximum submitter-index entries processed by one cleanup call.
pub const MAX_CLEANUP_PAGE_SIZE: u32 = 50;
/// Maximum submitter-index entries inspected by one consistency call.
pub const MAX_CONSISTENCY_PAGE_SIZE: u32 = 50;

// ── Errors ───────────────────────────────────────────────────────────────────

/// Errors returned by `PriceVault`.
///
/// Discriminants are contiguous from 1 and append-only — see the ABI note in
/// the module docs.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    /// `valid_from` is zero.
    InvalidTimestamp = 1,
    /// `validity_window_secs` is zero, or `valid_from + window` overflows.
    InvalidWindow = 2,
    /// `from_ts > to_ts` in a range query.
    InvalidRange = 3,
    /// The country is not a supported ISO 3166-1 alpha-2 identifier.
    InvalidCountry = 4,
    /// The category is not a supported basket category identifier.
    InvalidCategory = 5,
    /// The requested status transition is not permitted.
    InvalidTransition = 6,
    /// No submission exists for the given key.
    NotFound = 7,

    // ── payload schema ───────────────────────────────────────────────────
    /// A required field is missing.
    MissingRequiredField = 8,
    /// A field value is below its declared minimum.
    ValueBelowMinimum = 9,
    /// A field value is above its declared maximum.
    ValueAboveMaximum = 10,
    /// A `Symbol` field is empty.
    EmptySymbol = 11,
    /// A numeric field is negative where non-negative is required.
    NegativeNotAllowed = 12,
    /// A numeric field is zero where strictly positive is required.
    ZeroNotAllowed = 13,
    /// The payload's schema version is not the one this build understands.
    SchemaMismatch = 14,

    // ── guards ──────────────────────────────────────────────────────────
    /// A price value was zero.
    ZeroPrice = 15,
    /// A price value was negative.
    NegativePrice = 16,
    /// A `u64` that must be positive was zero.
    ZeroValue = 17,
    /// An `i128` amount that must be positive was zero or negative.
    NonPositiveAmount = 18,
    /// An addition would overflow the target type.
    ArithmeticOverflow = 19,
    /// A multiplication would overflow the target type.
    ArithmeticOverflowMul = 20,

    // ── access control ────────────────────────────────────────────────
    /// The caller is not the contract admin.
    Unauthorized = 21,
    /// The country is not in the configured allowlist.
    CountryNotAllowed = 22,
    /// The category is not in the configured allowlist.
    CategoryNotAllowed = 23,
    /// The submitter may not write this category.
    SubmitterNotAllowed = 24,
    /// `initialize` was called more than once.
    AlreadyInitialized = 25,
    /// A bounded page size was zero or above its API-specific limit.
    InvalidPageSize = 26,
}

/// Which categories one submitter is allowed to write.
///
/// An **empty** `categories` list means "every category the registry accepts",
/// which is what lets a deployment start open and be narrowed later without a
/// storage migration.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Authorization {
    /// The submitter this policy applies to.
    pub submitter: Address,
    /// Categories this submitter may write; empty means all of them.
    pub categories: Vec<Symbol>,
}

// ── Identifier registry ──────────────────────────────────────────────────────

/// The set of country and basket-category identifiers the protocol understands.
///
/// The registry is deliberately **not** encoded in any storage key. Every stored
/// record references an identifier by `Symbol`, and the identifier is checked
/// against this registry at the contract boundary, so adding a country or a
/// category later is a code change that leaves previously stored records — and
/// their keys — untouched. Extending it therefore needs no storage migration
/// and cannot invalidate existing submissions.
pub mod registry {
    use soroban_sdk::{Env, Symbol, Vec};

    /// Supported ISO 3166-1 alpha-2 country codes.
    ///
    /// A real subset of the standard: every entry is a designated ISO 3166-1
    /// alpha-2 identifier.
    pub const COUNTRY_CODES: &[&str] = &[
        "US", "GB", "NG", "KE", "IN", "BR", "DE", "FR", "JP", "CN", "ZA", "GH", "EG", "TZ", "UG",
        "ET", "PH", "ID", "MX", "AR",
    ];

    /// Supported cost-of-living basket categories.
    pub const CATEGORIES: &[&str] = &["Food", "Rent", "Transport", "Utilities", "Health"];

    /// Version of the identifier registry.
    ///
    /// Bump this when an identifier is added or removed so clients and indexers
    /// can tell which registry a deployment was built against.
    pub const VERSION: u32 = 1;

    /// Every supported country code, as `Symbol`s.
    pub fn countries(env: &Env) -> Vec<Symbol> {
        let mut codes = Vec::new(env);
        for code in COUNTRY_CODES.iter() {
            codes.push_back(Symbol::new(env, code));
        }
        codes
    }

    /// Every supported basket category, as `Symbol`s.
    pub fn categories(env: &Env) -> Vec<Symbol> {
        let mut keys = Vec::new(env);
        for key in CATEGORIES.iter() {
            keys.push_back(Symbol::new(env, key));
        }
        keys
    }

    /// Whether `country_iso` is a supported ISO 3166-1 alpha-2 identifier.
    pub fn is_supported_country(env: &Env, country_iso: &Symbol) -> bool {
        COUNTRY_CODES
            .iter()
            .any(|code| &Symbol::new(env, code) == country_iso)
    }

    /// Whether `category` is a supported basket category identifier.
    pub fn is_supported_category(env: &Env, category: &Symbol) -> bool {
        CATEGORIES
            .iter()
            .any(|key| &Symbol::new(env, key) == category)
    }
}

// ── Fail-safe arithmetic guards ──────────────────────────────────────────────

/// Centralised arithmetic safety guards.
///
/// Every guard is a pure function returning `Err` rather than panicking. A
/// panic in a Soroban contract aborts the transaction without emitting an error
/// code, burning caller fees and leaving no diagnosable trace — so overflow and
/// bad input are always values, never faults.
pub mod guards {
    use super::Error;

    /// Reject a price value that is zero or negative.
    ///
    /// # Errors
    /// * [`Error::NegativePrice`] — `value < 0`
    /// * [`Error::ZeroPrice`] — `value == 0`
    #[inline]
    pub fn require_positive_price(value: i128) -> Result<(), Error> {
        if value < 0 {
            return Err(Error::NegativePrice);
        }
        if value == 0 {
            return Err(Error::ZeroPrice);
        }
        Ok(())
    }

    /// Reject a `u64` value that is zero.
    ///
    /// # Errors
    /// * [`Error::ZeroValue`] — `value == 0`
    #[inline]
    pub fn require_positive_u64(value: u64) -> Result<(), Error> {
        if value == 0 {
            return Err(Error::ZeroValue);
        }
        Ok(())
    }

    /// Reject an `i128` amount that is zero or negative.
    ///
    /// # Errors
    /// * [`Error::NonPositiveAmount`] — `amount <= 0`
    #[inline]
    pub fn require_positive_i128(amount: i128) -> Result<(), Error> {
        if amount <= 0 {
            return Err(Error::NonPositiveAmount);
        }
        Ok(())
    }

    /// Checked `u64` addition.
    ///
    /// # Errors
    /// * [`Error::ArithmeticOverflow`] — the result would exceed `u64::MAX`.
    #[inline]
    pub fn checked_add_u64(a: u64, b: u64) -> Result<u64, Error> {
        a.checked_add(b).ok_or(Error::ArithmeticOverflow)
    }

    /// Checked `i128` addition.
    ///
    /// # Errors
    /// * [`Error::ArithmeticOverflow`] — the result would overflow `i128`.
    #[inline]
    pub fn checked_add_i128(a: i128, b: i128) -> Result<i128, Error> {
        a.checked_add(b).ok_or(Error::ArithmeticOverflow)
    }

    /// Checked `i128` multiplication.
    ///
    /// # Errors
    /// * [`Error::ArithmeticOverflowMul`] — the result would overflow `i128`.
    #[inline]
    pub fn checked_mul_i128(a: i128, b: i128) -> Result<i128, Error> {
        a.checked_mul(b).ok_or(Error::ArithmeticOverflowMul)
    }
}

// ── Payload schema validation ────────────────────────────────────────────────

/// Schema validation for external payloads.
///
/// Every entry point that receives external input should:
/// 1. define a `*Payload` struct for its arguments,
/// 2. declare a `*_SCHEMA` constant (`&[Constraint]`),
/// 3. call `validate(&schema, &payload)?` **before** any auth check or state
///    mutation.
pub mod payload {
    use super::Error;
    use soroban_sdk::Symbol;

    /// Discriminant for the type of a validated field.
    #[derive(Copy, Clone, Debug, Eq, PartialEq)]
    pub enum FieldKind {
        /// A 64-bit unsigned integer (timestamps, counts).
        U64,
        /// A 128-bit signed integer (prices, amounts).
        I128,
        /// A Soroban `Symbol` (country codes, category labels).
        Symbol,
    }

    /// A single named constraint applied to a payload field.
    ///
    /// Constraints are evaluated in declaration order and the first failure
    /// returns immediately — there is no error accumulation, which is how
    /// Soroban contracts communicate a single failure to a caller.
    #[derive(Copy, Clone, Debug)]
    pub enum Constraint {
        /// The `u64` field must be strictly greater than zero.
        U64NonZero,
        /// The `u64` field must be at most this value.
        U64Max(u64),
        /// The `i128` field must be strictly positive.
        I128Positive,
        /// The `i128` field must be zero or positive.
        I128NonNegative,
        /// The `i128` field must be at most this value.
        I128Max(i128),
        /// The `Symbol` fields must each have at least one character.
        SymbolNonEmpty,
        /// The payload's schema version must equal this value.
        SchemaVersion(u32),
    }

    /// A plain-data view of the `submit` arguments.
    ///
    /// Decoupling validation from `Env` and `Address` keeps [`validate`] a pure
    /// function: no SDK imports in the validation logic, no mock environment
    /// needed to test it.
    pub struct SubmitPayload<'a> {
        /// ISO country code (e.g. `"NG"`).
        pub country_iso: &'a Symbol,
        /// Basket category (e.g. `"Food"`).
        pub category: &'a Symbol,
        /// Price value in the smallest fixed-point unit.
        pub value: i128,
        /// Observation timestamp.
        pub timestamp: u64,
        /// Schema version the caller expects.
        pub schema_version: u32,
    }

    /// Apply `schema` to `payload`, returning the first failing constraint.
    ///
    /// `#[inline]` so the optimiser can fold constant schemas at the call site
    /// in release builds.
    #[inline]
    pub fn validate(schema: &[Constraint], payload: &SubmitPayload<'_>) -> Result<(), Error> {
        for constraint in schema {
            match constraint {
                Constraint::U64NonZero => {
                    if payload.timestamp == 0 {
                        return Err(Error::ZeroNotAllowed);
                    }
                }
                Constraint::U64Max(max) => {
                    if payload.timestamp > *max {
                        return Err(Error::ValueAboveMaximum);
                    }
                }
                Constraint::I128Positive => {
                    if payload.value < 0 {
                        return Err(Error::NegativeNotAllowed);
                    }
                    if payload.value == 0 {
                        return Err(Error::ZeroNotAllowed);
                    }
                }
                Constraint::I128NonNegative => {
                    if payload.value < 0 {
                        return Err(Error::NegativeNotAllowed);
                    }
                }
                Constraint::I128Max(max) => {
                    if payload.value > *max {
                        return Err(Error::ValueAboveMaximum);
                    }
                }
                Constraint::SymbolNonEmpty => {
                    // A zero-length Symbol would produce an unresolvable key.
                    if payload.country_iso.len() == 0 || payload.category.len() == 0 {
                        return Err(Error::EmptySymbol);
                    }
                }
                Constraint::SchemaVersion(expected) => {
                    if payload.schema_version != *expected {
                        return Err(Error::SchemaMismatch);
                    }
                }
            }
        }
        Ok(())
    }
}

/// The schema applied to every `PriceVault::submit` call.
///
/// Ordered cheapest-first: integer bounds run before `Symbol` length checks.
pub const SUBMIT_SCHEMA: &[payload::Constraint] = &[
    payload::Constraint::U64NonZero,
    payload::Constraint::I128Positive,
    payload::Constraint::I128Max(MAX_PRICE),
    payload::Constraint::SymbolNonEmpty,
    payload::Constraint::SchemaVersion(SCHEMA_VERSION),
];

// -- Access control -----------------------------------------------------------

/// Load the admin, or [`Error::NotFound`] when the contract is unconfigured.
fn load_admin(env: &Env) -> Result<Address, Error> {
    env.storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(Error::NotFound)
}

/// Reject a caller that is not the configured admin.
///
/// Checking the stored address *before* `require_auth` means an unauthorised
/// caller is refused on one cheap storage read instead of paying for an auth
/// prompt it could never satisfy.
fn require_admin(env: &Env, admin: &Address) -> Result<(), Error> {
    if *admin != load_admin(env)? {
        return Err(Error::Unauthorized);
    }
    admin.require_auth();
    Ok(())
}

/// Whether `country` passes the configured country allowlist.
///
/// An empty allowlist imposes no restriction: the static [`registry`] has
/// already vetted the identifier, and "empty means no extra restriction" is
/// what lets a deployment start open and be narrowed in a later governance
/// action without a migration.
fn country_allowed(env: &Env, country: &Symbol) -> bool {
    let list: Vec<Symbol> = env
        .storage()
        .instance()
        .get(&DataKey::CountryAllowlist)
        .unwrap_or_else(|| Vec::new(env));
    if list.is_empty() {
        return true;
    }
    for entry in list.iter() {
        if &entry == country {
            return true;
        }
    }
    false
}

/// Whether `category` passes the configured category allowlist.
///
/// Empty means unrestricted; see [`country_allowed`].
fn category_allowed(env: &Env, category: &Symbol) -> bool {
    let list: Vec<Symbol> = env
        .storage()
        .instance()
        .get(&DataKey::CategoryAllowlist)
        .unwrap_or_else(|| Vec::new(env));
    if list.is_empty() {
        return true;
    }
    for entry in list.iter() {
        if &entry == category {
            return true;
        }
    }
    false
}

/// Whether `submitter` may write `category` under the configured policy.
///
/// Empty policy means unrestricted. Otherwise the submitter needs an entry, and
/// that entry's `categories` must be empty (all categories) or contain
/// `category`. An entry that does not cover the category is a refusal, not a
/// fall-through to the next entry — otherwise a submitter with a narrow grant
/// could be widened by a later duplicate entry for the same address.
fn submitter_allowed(env: &Env, submitter: &Address, category: &Symbol) -> bool {
    let policy: Vec<Authorization> = env
        .storage()
        .instance()
        .get(&DataKey::Authorizations)
        .unwrap_or_else(|| Vec::new(env));
    if policy.is_empty() {
        return true;
    }
    for i in 0..policy.len() {
        let entry = policy.get(i).unwrap();
        if &entry.submitter == submitter {
            if entry.categories.is_empty() {
                return true;
            }
            for j in 0..entry.categories.len() {
                if &entry.categories.get(j).unwrap() == category {
                    return true;
                }
            }
            return false;
        }
    }
    false
}

// ── Submission status ────────────────────────────────────────────────────────

/// Lifecycle state of a single price submission.
///
/// ```text
/// Pending ──► Verified   (terminal)
///         └─► Rejected   (terminal)
/// ```
///
/// Consumers matching on status should match exhaustively on all three
/// variants so they stay correct when more are added in a future schema
/// version.
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum SubmissionStatus {
    /// Recorded, awaiting verifier votes.
    Pending = 0,
    /// Quorum approval; accepted as a valid price observation.
    Verified = 1,
    /// Quorum rejection, or invalidated by governance.
    Rejected = 2,
}

impl SubmissionStatus {
    /// Whether this state absorbs: no transition leaves it.
    #[inline]
    pub fn is_terminal(self) -> bool {
        matches!(self, SubmissionStatus::Verified | SubmissionStatus::Rejected)
    }

    /// # The transition table
    ///
    /// Whether `self -> next` is a permitted transition.
    ///
    /// Exactly one edge exists: `Pending -> {Verified, Rejected}`. `Pending`
    /// is never a *target* (it is only ever the initial state assigned by
    /// `submit`), and terminal states have no outgoing edges. Encoding this as
    /// a function rather than as inline `if`s means the table lives in one
    /// place, so `set_status` and any future consumer cannot drift apart.
    #[inline]
    pub fn can_transition_to(self, next: SubmissionStatus) -> bool {
        matches!(
            (self, next),
            (SubmissionStatus::Pending, SubmissionStatus::Verified)
                | (SubmissionStatus::Pending, SubmissionStatus::Rejected)
        )
    }
}

// ── Storage keys ─────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    /// `(country_iso, category, valid_from)` → `PriceSubmission`.
    Price(Symbol, Symbol, u64),
    /// `(country_iso, category)` → `Vec<u64>` timestamps.
    SubmissionIndex(Symbol, Symbol),
    /// Admin address used for configuration.
    Admin,
    /// `submitter` → `Vec<SubmitterEntry>`.
    SubmitterIndex(Address),
    /// Longest allowed validity window.
    MaxValidityWindow,
    /// Category policy.
    CategoryPolicy(Symbol),
    /// Submitter policy.
    SubmitterPolicy(Address),
    /// Allowed countries.
    CountryAllowlist,
    /// Allowed categories.
    CategoryAllowlist,
    /// Submitter authorizations.
    Authorizations,
}

// ── Domain types ─────────────────────────────────────────────────────────────

/// A single raw price submission with an attached validity window.
///
/// The window `[valid_from, valid_until)` bounds the interval during which the
/// record is a fresh observation. After `valid_until` the record stays in
/// storage for historical audit but is excluded from live aggregation.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceSubmission {
    /// The submitting oracle/operator address.
    pub submitter: Address,
    /// ISO country code, kept readable for indexing.
    pub country_iso: Symbol,
    /// The price category, e.g. `Food` or `Rent`.
    pub category: Symbol,
    /// Raw price in the smallest fixed-point unit. Must be `> 0`.
    pub value: i128,
    /// Start of the validity window; also the storage key component.
    pub valid_from: u64,
    /// Exclusive expiry timestamp (`valid_from + validity_window_secs`).
    pub valid_until: u64,
    /// Observation timestamp. Mirrors `valid_from`.
    pub timestamp: u64,
    /// Current lifecycle state. `Pending` at creation.
    pub status: SubmissionStatus,
}

impl PriceSubmission {
    /// Whether `query_ts` falls within `[valid_from, valid_until)`.
    ///
    /// Lower bound inclusive, upper bound exclusive, so consecutive
    /// non-overlapping windows never both claim a timestamp.
    #[inline]
    pub fn is_valid_at(&self, query_ts: u64) -> bool {
        query_ts >= self.valid_from && query_ts < self.valid_until
    }
}

/// One entry in a submitter's append-only index.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SubmitterEntry {
    pub country_iso: Symbol,
    pub category: Symbol,
    pub timestamp: u64,
}

/// A bounded page of submissions.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HistoryPage {
    pub submissions: Vec<PriceSubmission>,
    pub next_cursor: u32,
    pub has_more: bool,
}

/// Result of a bounded submitter-index cleanup page.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CleanupReport {
    pub removed_count: u32,
    pub next_cursor: u32,
    pub has_more: bool,
}

/// Result of a bounded index-consistency page.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IndexConsistencyReport {
    pub checked_count: u32,
    pub missing_count: u32,
    pub consistent: bool,
    pub next_cursor: u32,
    pub has_more: bool,
}

// ── Events ───────────────────────────────────────────────────────────────────

/// Emitted after a price submission is recorded.
///
/// `country_iso` and `category` are **topics** — the two dimensions an indexer
/// filters on — so a consumer can subscribe to just the submissions it cares
/// about without decoding every body. The body carries the rest of the
/// metadata so an indexer can build its record from the event alone.
///
/// Emitted only after both the record and its index entry are written, so a
/// consumer reacting to the event can read the submission back immediately. A
/// replayed submission is a no-op and emits nothing.
#[contractevent]
#[derive(Clone)]
pub struct PriceSubmitted {
    /// Topic — the country this observation belongs to.
    #[topic]
    pub country_iso: Symbol,
    /// Topic — the basket category.
    #[topic]
    pub category: Symbol,
    /// The submitting oracle/operator.
    pub submitter: Address,
    /// Raw price value.
    pub value: i128,
    /// Start of the validity window.
    pub valid_from: u64,
    /// Exclusive expiry timestamp.
    pub valid_until: u64,
    /// Status at creation, always `Pending`.
    pub status: SubmissionStatus,
    /// Schema version the record was written under.
    pub schema_version: u32,
}

// ── Contract ─────────────────────────────────────────────────────────────────
/// Emitted after a submission's status changes.
///
/// # What an indexer needs
///
/// A consumer that tracks verification state has to know *which* record moved,
/// *from where* it moved, and *who* was authorised to move it. All three are in
/// this event: the record is addressed by `country_iso` (topic), `category`
/// (topic) and `timestamp`; `prior_status` and `new_status` give the
/// transition; `actor` is the address whose `require_auth` authorised it.
///
/// Without `prior_status` an indexer can only report the new state and cannot
/// distinguish a `Verified` record from one that was already `Verified`. Without
/// `actor` it cannot attribute the change to a verifier at all â€” which is the
/// part an audit actually needs.
///
/// Published only after the record has been written, so a consumer reacting to
/// the event can read the new status back immediately. A refused transition
/// emits nothing.
#[contractevent]
#[derive(Clone)]
pub struct StatusChanged {
    /// Topic â€” the country this record belongs to.
    #[topic]
    pub country_iso: Symbol,
    /// Topic â€” the basket category.
    #[topic]
    pub category: Symbol,
    /// Observation timestamp: the third component of the record's key.
    pub timestamp: u64,
    /// The address whose authorisation allowed the transition.
    pub actor: Address,
    /// Status the record held before this change.
    pub prior_status: SubmissionStatus,
    /// Status the record holds after this change.
    pub new_status: SubmissionStatus,
}

// â”€â”€ Contract â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/// Emitted when the configured maximum validity window changes.
#[contractevent]
#[derive(Clone)]
pub struct ValidityWindowPolicyUpdated {
    #[topic]
    pub actor: Address,
    /// The new maximum, or `None` meaning unbounded.
    pub max_validity_window_secs: Option<u64>,
}

/// Emitted when a category is enabled or disabled.
#[contractevent]
#[derive(Clone)]
pub struct CategoryPolicyUpdated {
    #[topic]
    pub actor: Address,
    /// Topic - the category the policy entry is for.
    #[topic]
    pub category: Symbol,
    /// Whether submissions in this category are accepted after this change.
    pub enabled: bool,
}

/// Emitted when a submitter is allowed or denied.
#[contractevent]
#[derive(Clone)]
pub struct SubmitterPolicyUpdated {
    #[topic]
    pub actor: Address,
    /// Topic - the submitter the policy entry is for.
    #[topic]
    pub submitter: Address,
    /// Whether this submitter may submit after this change.
    pub allowed: bool,
}

#[contract]
pub struct PriceVault;

#[contractimpl]
impl PriceVault {
    // ── Mutating entry points ───────────────────────────────────────────
    // â”€â”€ Mutating entry points â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    /// # Record a raw price submission
    ///
    /// `valid_from` is the observation timestamp (and the storage key
    /// component). `validity_window_secs` is how long the submission stays
    /// fresh; [`DEFAULT_VALIDITY_WINDOW_SECS`] (86 400 s) suits daily basket
    /// observations.
    ///
    /// Validation order is fixed and every step before auth is a pure
    /// predicate — see the module docs. If a record already exists for the same
    /// predicate â€” see the module docs. If a record already exists for the same
    /// `(country_iso, category, valid_from)` triple the call is **refused** with
    /// [`Error::DuplicateSubmission`]: the key is occupied, the original is kept,
    /// and the index is not duplicated. The failure is explicit because a silent
    /// success is indistinguishable, to a caller and to an indexer alike, from a
    /// genuine first write.
    ///
    /// # Errors
    /// * [`Error::InvalidCountry`] — country is not a registry identifier.
    /// * [`Error::InvalidCategory`] — category is not a registry identifier.
    /// * [`Error::ZeroNotAllowed`] — `valid_from` or `value` is zero.
    /// * [`Error::NegativeNotAllowed`] — `value` is negative.
    /// * [`Error::ValueAboveMaximum`] — `value` exceeds [`MAX_PRICE`].
    /// * [`Error::EmptySymbol`] — country or category is empty.
    /// * [`Error::SchemaMismatch`] — caller expects another schema version.
    /// * [`Error::InvalidWindow`] — zero window, or `valid_from + window`
    /// * [`Error::InvalidCountry`] â€” country is not a registry identifier.
    /// * [`Error::InvalidCategory`] â€” category is not a registry identifier.
    /// * [`Error::ZeroNotAllowed`] â€” `valid_from` or `value` is zero.
    /// * [`Error::NegativeNotAllowed`] â€” `value` is negative.
    /// * [`Error::ValueAboveMaximum`] â€” `value` exceeds [`MAX_PRICE`].
    /// * [`Error::EmptySymbol`] â€” country or category is empty.
    /// * [`Error::SchemaMismatch`] â€” caller expects another schema version.
    /// * [`Error::InvalidWindow`] â€” zero window, or `valid_from + window`
    ///   overflows `u64`.
    /// * [`Error::CategoryDisabled`] - the category is disabled by policy.
    /// * [`Error::SubmitterNotAllowed`] - the submitter is denied by policy.
    /// * [`Error::WindowTooLong`] - the window exceeds the configured maximum.
    /// * [`Error::DuplicateSubmission`] - the key is occupied.
    pub fn submit(
        env: Env,
        submitter: Address,
        country_iso: Symbol,
        category: Symbol,
        value: i128,
        valid_from: u64,
        validity_window_secs: u64,
    ) -> Result<(), Error> {
        // 1. Identifier registry — pure, before auth and before storage.
        // 1. Identifier registry â€” pure, before auth and before storage.
        if !registry::is_supported_country(&env, &country_iso) {
            return Err(Error::InvalidCountry);
        }
        if !registry::is_supported_category(&env, &category) {
            return Err(Error::InvalidCategory);
        }

        // Configurable narrowing of the static registry. An empty allowlist or
        // policy imposes no restriction, so a deployment that never calls
        // initialize behaves exactly as before.
        if !country_allowed(&env, &country_iso) {
            return Err(Error::CountryNotAllowed);
        }
        if !category_allowed(&env, &category) {
            return Err(Error::CategoryNotAllowed);
        }
        if !submitter_allowed(&env, &submitter, &category) {
            return Err(Error::SubmitterNotAllowed);
        }

        // 2. Payload schema — pure, before auth and before storage.
        // 2. Payload schema â€” pure, before auth and before storage.
        payload::validate(
            SUBMIT_SCHEMA,
            &payload::SubmitPayload {
                country_iso: &country_iso,
                category: &category,
                value,
                timestamp: valid_from,
                schema_version: SCHEMA_VERSION,
            },
        )?;

        // 3. Guards — defence in depth for the price itself.
        // 3. Guards â€” defence in depth for the price itself.
        guards::require_positive_price(value)?;

        // Validity window. Zero or overflowing windows are rejected rather
        // than clamped: a clamped window would silently disagree with the
        // submitter's intent about how fresh the observation is.
        let valid_until = Self::resolve_window(valid_from, validity_window_secs)?;

        // 4. Admin policy - pure lookups, still before auth and storage. Absent
        //    entries mean "no restriction", so an unconfigured vault behaves
        //    exactly as it did before the policy existed.
        if !Self::is_category_enabled(env.clone(), category.clone()) {
            return Err(Error::CategoryDisabled);
        }
        if !Self::is_submitter_allowed(env.clone(), submitter.clone()) {
            return Err(Error::SubmitterNotAllowed);
        }
        if let Some(max) = Self::max_validity_window(env.clone()) {
            if validity_window_secs > max {
                return Err(Error::WindowTooLong);
            }
        }

        // Auth comes after every pure check.
        submitter.require_auth();

        let key = DataKey::Price(country_iso.clone(), category.clone(), valid_from);

        // The key is occupied. Refuse rather than silently succeeding: a caller
        // cannot tell "written" from "ignored", and neither can an indexer.
        if env.storage().persistent().has(&key) {
            return Err(Error::DuplicateSubmission);
        }

        env.storage().persistent().set(
            &key,
            &PriceSubmission {
                submitter: submitter.clone(),
                country_iso: country_iso.clone(),
                category: category.clone(),
                value,
                valid_from,
                valid_until,
                timestamp: valid_from,
                status: SubmissionStatus::Pending,
            },
        );

        // Append to the per-(country, category) index so history queries need
        // no full-storage scan.
        let idx_key = DataKey::SubmissionIndex(country_iso.clone(), category.clone());
        let mut index: Vec<u64> = env
            .storage()
            .persistent()
            .get(&idx_key)
            .unwrap_or_else(|| Vec::new(&env));
        index.push_back(valid_from);
        env.storage().persistent().set(&idx_key, &index);

        // Append to the per-submitter index so a submitter's own history is
        // reachable without scanning every (country, category) pair. Written in
        // the same transaction as the record and the group index, so the three
        // views cannot disagree about which records exist.
        let sub_key = DataKey::SubmitterIndex(submitter.clone());
        let mut sub_index: Vec<SubmitterEntry> = env
            .storage()
            .persistent()
            .get(&sub_key)
            .unwrap_or_else(|| Vec::new(&env));
        sub_index.push_back(SubmitterEntry {
            country_iso: country_iso.clone(),
            category: category.clone(),
            timestamp: valid_from,
        });
        env.storage().persistent().set(&sub_key, &sub_index);

        PriceSubmitted {
            country_iso,
            category,
            submitter,
            value,
            valid_from,
            valid_until,
            status: SubmissionStatus::Pending,
            schema_version: SCHEMA_VERSION,
        }
        .publish(&env);

        Ok(())
    }

    /// # Transition a submission's status
    ///
    /// Moves a `Pending` submission to `Verified` or `Rejected`. The transition
    /// table is [`SubmissionStatus::can_transition_to`]: `Pending` is never a
    /// target, and `Verified`/`Rejected` are absorbing.
    ///
    /// The record is left byte-for-byte unchanged when a transition is refused.
    ///
    /// # Errors
    /// * [`Error::NotFound`] — no submission for the given key.
    /// * [`Error::InvalidTransition`] — `new_status` is `Pending`, or the
    /// * [`Error::NotFound`] â€” no submission for the given key.
    /// * [`Error::InvalidTransition`] â€” `new_status` is `Pending`, or the
    ///   current status is already terminal.
    pub fn set_status(
        env: Env,
        verifier: Address,
        country_iso: Symbol,
        category: Symbol,
        timestamp: u64,
        new_status: SubmissionStatus,
    ) -> Result<(), Error> {
        verifier.require_auth();

        let key = DataKey::Price(country_iso.clone(), category.clone(), timestamp);
        let mut submission: PriceSubmission = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotFound)?;

        // One table, consulted here and nowhere else.
        if !submission.status.can_transition_to(new_status) {
            return Err(Error::InvalidTransition);
        }

        let prior_status = submission.status;
        submission.status = new_status;
        env.storage().persistent().set(&key, &submission);

        // Published after the write, so a consumer reacting to the event can
        // read the new status back. A refused transition returns above and
        // emits nothing.
        StatusChanged {
            country_iso,
            category,
            timestamp,
            actor: verifier,
            prior_status,
            new_status,
        }
        .publish(&env);

        Ok(())
    }

    // ── Read entry points ───────────────────────────────────────────────

    /// Read a stored submission by its exact composite key.
    ///
    /// Returns the record regardless of whether it is currently fresh — use
    // â”€â”€ Read entry points â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    /// Read a stored submission by its exact composite key.
    ///
    /// Returns the record regardless of whether it is currently fresh â€” use
    /// [`Self::get_valid`] to gate on the validity window.
    pub fn get(
        env: Env,
        country_iso: Symbol,
        category: Symbol,
        valid_from: u64,
    ) -> Option<PriceSubmission> {
        env.storage()
            .persistent()
            .get(&DataKey::Price(country_iso, category, valid_from))
    }

    /// Read a submission only if it is fresh at `query_ts`.
    ///
    /// Returns `None` when the record is missing, expired
    /// (`query_ts >= valid_until`), or not yet valid (`query_ts < valid_from`).
    /// This is the recommended call for aggregation and index code, which must
    /// exclude stale prices.
    pub fn get_valid(
        env: Env,
        country_iso: Symbol,
        category: Symbol,
        valid_from: u64,
        query_ts: u64,
    ) -> Option<PriceSubmission> {
        let submission: PriceSubmission = env
            .storage()
            .persistent()
            .get(&DataKey::Price(country_iso, category, valid_from))?;
        if submission.is_valid_at(query_ts) {
            Some(submission)
        } else {
            None
        }
    }

    /// The exclusive expiry ledger for a submission window.
    ///
    /// One definition of the window, reachable off-chain and usable by
    /// cross-contract callers before a transaction is built.
    ///
    /// # Errors
    /// * [`Error::InvalidWindow`] - `validity_window_secs` is zero, or
    ///   `valid_from + validity_window_secs` overflows `u64`.
    pub fn window_bounds(
        _env: Env,
        valid_from: u64,
        validity_window_secs: u64,
    ) -> Result<u64, Error> {
        Self::resolve_window(valid_from, validity_window_secs)
    }

    /// `valid_from + validity_window_secs`, refusing rather than clamping.
    ///
    /// A zero window is refused rather than treated as instantaneous: the
    /// record would be born already stale, and the submitter's stated intent
    /// about freshness would be silently discarded. An overflowing sum is
    /// refused rather than wrapped or saturated, because both would produce a
    /// window nobody asked for.
    fn resolve_window(valid_from: u64, validity_window_secs: u64) -> Result<u64, Error> {
        if validity_window_secs == 0 {
            return Err(Error::InvalidWindow);
        }

        valid_from
            .checked_add(validity_window_secs)
            .ok_or(Error::InvalidWindow)
    }

    /// # Is the stored submission fresh at `query_ts`?
    ///
    /// The canonical freshness predicate: `valid_from <= query_ts < valid_until`.
    /// Lower bound inclusive, upper bound exclusive, so consecutive
    /// non-overlapping windows never both claim a ledger.
    ///
    /// A missing record is `false`, not an error - callers use this as a plain
    /// boolean gate and should not have to match on `Option` first.
    pub fn is_fresh(
        env: Env,
        country_iso: Symbol,
        category: Symbol,
        valid_from: u64,
        query_ts: u64,
    ) -> bool {
        let submission: Option<PriceSubmission> = env
            .storage()
            .persistent()
            .get(&DataKey::Price(country_iso, category, valid_from));
        match submission {
            Some(s) => s.is_valid_at(query_ts),
            None => false,
        }
    }

    /// Every submission for `(country_iso, category)` that is fresh at
    /// `query_ts`, in insertion order.
    ///
    /// The read aggregation code should call. [`Self::get_history`] returns
    /// everything, expired records included, which is what an audit wants and
    /// exactly what an index must not consume: a stale observation silently
    /// folded into a median is a wrong index value with no error anywhere.
    ///
    /// Expired entries are skipped rather than failing the read; a caller can
    /// always reconcile against [`Self::get_history`].
    pub fn get_fresh_history(
        env: Env,
        country_iso: Symbol,
        category: Symbol,
        query_ts: u64,
    ) -> Vec<PriceSubmission> {
        let all = Self::get_history(env.clone(), country_iso.clone(), category.clone());

        let mut fresh = Vec::new(&env);
        for submission in all.iter() {
            if submission.is_valid_at(query_ts) {
                fresh.push_back(submission);
            }
        }
        fresh
    }

    /// Whether a stored submission is fresh at `query_ts`.
    ///
    /// Returns `false` (not an error) for missing records so callers can use a
    /// plain boolean gate without matching on `Option`.
    pub fn is_valid_at(
        env: Env,
        country_iso: Symbol,
        category: Symbol,
        valid_from: u64,
        query_ts: u64,
    ) -> bool {
        Self::is_fresh(env, country_iso, category, valid_from, query_ts)
    }

    /// Read just the lifecycle state of a submission, if present.
    ///
    /// Cheaper than [`Self::get`] when the caller only needs the status.
    pub fn get_status(
        env: Env,
        country_iso: Symbol,
        category: Symbol,
        timestamp: u64,
    ) -> Option<SubmissionStatus> {
        let submission: Option<PriceSubmission> = env
            .storage()
            .persistent()
            .get(&DataKey::Price(country_iso, category, timestamp));
        submission.map(|s| s.status)
    }

    /// All submissions for `(country_iso, category)`, in insertion order.
    ///
    /// Deterministic: identical contract state always produces an identical
    /// sequence. Returns an empty `Vec` when there are none — never panics.
    /// sequence. Returns an empty `Vec` when there are none â€” never panics.
    /// For bounded reads prefer [`Self::get_history_range`].
    pub fn get_history(
        env: Env,
        country_iso: Symbol,
        category: Symbol,
    ) -> Vec<PriceSubmission> {
        let idx_key = DataKey::SubmissionIndex(country_iso.clone(), category.clone());
        let timestamps: Vec<u64> = env
            .storage()
            .persistent()
            .get(&idx_key)
            .unwrap_or_else(|| Vec::new(&env));

        Self::collect_submissions(&env, &country_iso, &category, &timestamps)
    }

    /// Submissions whose timestamp satisfies `from_ts <= ts <= to_ts`, in
    /// insertion order. Both bounds are inclusive.
    ///
    /// # Errors
    /// * [`Error::InvalidRange`] — `from_ts > to_ts`.
    /// * [`Error::InvalidRange`] â€” `from_ts > to_ts`.
    pub fn get_history_range(
        env: Env,
        country_iso: Symbol,
        category: Symbol,
        from_ts: u64,
        to_ts: u64,
    ) -> Result<Vec<PriceSubmission>, Error> {
        if from_ts > to_ts {
            return Err(Error::InvalidRange);
        }

        let idx_key = DataKey::SubmissionIndex(country_iso.clone(), category.clone());
        let all_timestamps: Vec<u64> = env
            .storage()
            .persistent()
            .get(&idx_key)
            .unwrap_or_else(|| Vec::new(&env));

        let mut filtered = Vec::new(&env);
        for ts in all_timestamps.iter() {
            if ts >= from_ts && ts <= to_ts {
                filtered.push_back(ts);
            }
        }

        Ok(Self::collect_submissions(&env, &country_iso, &category, &filtered))
    }

    /// One bounded page of a country/category index.
    pub fn get_country_history(
        env: Env,
        country_iso: Symbol,
        category: Symbol,
        cursor: u32,
        limit: u32,
    ) -> Result<HistoryPage, Error> {
        if limit == 0 || limit > MAX_HISTORY_PAGE_SIZE {
            return Err(Error::InvalidPageSize);
        }
        let timestamps: Vec<u64> = env.storage().persistent()
            .get(&DataKey::SubmissionIndex(country_iso.clone(), category.clone()))
            .unwrap_or_else(|| Vec::new(&env));
        let total = timestamps.len();
        let start = core::cmp::min(cursor, total);
        let end = core::cmp::min(start.saturating_add(limit), total);
        let mut page = Vec::new(&env);
        for i in start..end {
            if let Some(ts) = timestamps.get(i) {
                page.push_back(ts);
            }
        }
        Ok(HistoryPage {
            submissions: Self::collect_submissions(&env, &country_iso, &category, &page),
            next_cursor: end,
            has_more: end < total,
        })
    }

    /// Alias for bounded country/category history pagination.
    pub fn get_history_page(
        env: Env,
        country_iso: Symbol,
        category: Symbol,
        cursor: u32,
        limit: u32,
    ) -> Result<HistoryPage, Error> {
        Self::get_country_history(env, country_iso, category, cursor, limit)
    }

    /// The most recently **inserted** submission for `(country_iso, category)`,
    /// or `None` when there is none.
    pub fn get_latest(
        env: Env,
        country_iso: Symbol,
        category: Symbol,
    ) -> Option<PriceSubmission> {
        let idx_key = DataKey::SubmissionIndex(country_iso.clone(), category.clone());
        let timestamps: Vec<u64> = env
            .storage()
            .persistent()
            .get(&idx_key)
            .unwrap_or_else(|| Vec::new(&env));

        // The index is append-only and in insertion order, so the last entry is
        // the most recently inserted timestamp.
        let latest_ts = timestamps.last()?;
        env.storage()
            .persistent()
            .get(&DataKey::Price(country_iso, category, latest_ts))
    }

    // -- Access control entry points -----------------------------------------

    /// # Configure the access-control admin
    ///
    /// Idempotent-by-refusal: the first caller wins and every later call
    /// returns [`Error::AlreadyInitialized`]. Without this a freshly deployed
    /// contract would have no owner and nobody could ever narrow the
    /// allowlists.
    ///
    /// A submission already accepts every registry identifier, so an
    /// unconfigured contract is open rather than broken.
    ///
    /// # Errors
    /// * [`Error::AlreadyInitialized`] — an admin is already set.
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
    /// # One bounded page of a submitter's records
    ///
    /// Returns at most [`MAX_HISTORY_PAGE_SIZE`] records starting at `cursor`
    /// in [`DataKey::SubmitterIndex`].
    ///
    /// `cursor` is an **offset into an append-only index**, which is what makes
    /// pagination stable: new submissions are appended, so an offset already
    /// handed to a caller keeps pointing at the same position. A caller paging
    /// through history therefore never sees a record twice and never skips one
    /// just because another submission landed mid-pagination.
    ///
    /// An index entry whose record has since been removed is skipped rather
    /// than failing the whole page.
    ///
    /// # Errors
    /// * [`Error::InvalidPageSize`] â€” `limit` is zero or above
    ///   [`MAX_HISTORY_PAGE_SIZE`].
    pub fn get_submitter_history(
        env: Env,
        submitter: Address,
        cursor: u32,
        limit: u32,
    ) -> Result<HistoryPage, Error> {
        if limit == 0 || limit > MAX_HISTORY_PAGE_SIZE {
            return Err(Error::InvalidPageSize);
        }

        let sub_key = DataKey::SubmitterIndex(submitter);
        let entries: Vec<SubmitterEntry> = env
            .storage()
            .persistent()
            .get(&sub_key)
            .unwrap_or_else(|| Vec::new(&env));

        let total = entries.len();
        // A cursor past the end yields an empty final page rather than an
        // error, so a caller that races a concurrent submission still
        // terminates.
        let start = if cursor > total { total } else { cursor };
        let end = core::cmp::min(start.saturating_add(limit), total);

        let mut submissions = Vec::new(&env);
        for i in start..end {
            let entry = entries.get(i).unwrap();
            let key = DataKey::Price(
                entry.country_iso.clone(),
                entry.category.clone(),
                entry.timestamp,
            );
            if let Some(submission) = env.storage().persistent().get::<DataKey, PriceSubmission>(&key)
            {
                submissions.push_back(submission);
            }
        }

        Ok(HistoryPage {
            submissions,
            next_cursor: end,
            has_more: end < total,
        })
    }

    /// Admin-authorized cleanup of stale submitter-index entries, limited to one page.
    pub fn cleanup_submitter_index(
        env: Env,
        actor: Address,
        submitter: Address,
        cursor: u32,
        limit: u32,
    ) -> Result<CleanupReport, Error> {
        actor.require_auth();
        if limit == 0 || limit > MAX_CLEANUP_PAGE_SIZE {
            return Err(Error::InvalidPageSize);
        }
        let admin = env.storage().instance().get::<DataKey, Address>(&DataKey::Admin)
            .or_else(|| env.storage().persistent().get::<DataKey, Address>(&DataKey::Admin));
        if admin != Some(actor.clone()) {
            return Err(Error::Unauthorized);
        }
        let key = DataKey::SubmitterIndex(submitter.clone());
        let entries: Vec<SubmitterEntry> = env.storage().persistent()
            .get(&key).unwrap_or_else(|| Vec::new(&env));
        let total = entries.len();
        let start = core::cmp::min(cursor, total);
        let end = core::cmp::min(start.saturating_add(limit), total);
        let mut kept = Vec::new(&env);
        let mut removed_count = 0u32;
        for i in 0..total {
            if let Some(entry) = entries.get(i) {
                let live = env.storage().persistent()
                    .get::<DataKey, PriceSubmission>(&DataKey::Price(
                        entry.country_iso.clone(), entry.category.clone(), entry.timestamp,
                    ))
                    .map(|record| record.submitter == submitter)
                    .unwrap_or(false);
                if i >= start && i < end && !live {
                    removed_count = removed_count.saturating_add(1);
                } else {
                    kept.push_back(entry);
                }
            }
        }
        env.storage().persistent().set(&key, &kept);
        Ok(CleanupReport { removed_count, next_cursor: end, has_more: end < total })
    }

    /// Read-only bounded consistency check for a country/category index page.
    pub fn check_index_consistency(
        env: Env,
        country_iso: Symbol,
        category: Symbol,
        cursor: u32,
        limit: u32,
    ) -> Result<IndexConsistencyReport, Error> {
        if limit == 0 || limit > MAX_CONSISTENCY_PAGE_SIZE {
            return Err(Error::InvalidPageSize);
        }
        let timestamps: Vec<u64> = env.storage().persistent()
            .get(&DataKey::SubmissionIndex(country_iso.clone(), category.clone()))
            .unwrap_or_else(|| Vec::new(&env));
        let total = timestamps.len();
        let start = core::cmp::min(cursor, total);
        let end = core::cmp::min(start.saturating_add(limit), total);
        let mut missing_count = 0u32;
        for i in start..end {
            if let Some(ts) = timestamps.get(i) {
                if env.storage().persistent().get::<DataKey, PriceSubmission>(
                    &DataKey::Price(country_iso.clone(), category.clone(), ts)
                ).is_none() {
                    missing_count = missing_count.saturating_add(1);
                }
            }
        }
        let checked_count = end.saturating_sub(start);
        Ok(IndexConsistencyReport {
            checked_count,
            missing_count,
            consistent: missing_count == 0,
            next_cursor: end,
            has_more: end < total,
        })
    }

    // â”€â”€ Registry views â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    /// The supported ISO 3166-1 alpha-2 country codes.
    // Admin configuration ---------------------------------------------------
    //
    // Every setter below is admin-only and emits an event, so a change to what
    // the vault accepts is visible in the ledger rather than only in storage.
    // The three policies are independent and opt-in: an address, a category or
    // a window with no entry carries no restriction, so a deployment that
    // configures nothing behaves exactly as it did before these setters
    // existed.

    /// Configure the admin address.
    ///
    /// One-shot: a second call is refused so the authority cannot be handed to
    /// a new address without a visible, deliberate act.
    ///
    /// # Errors
    /// * [`Error::AdminNotConfigured`] - an admin is already configured.
    pub fn configure_admin(env: Env, admin: Address) -> Result<(), Error> {
        admin.require_auth();

        if env.storage().persistent().has(&DataKey::Admin) {
            return Err(Error::AdminNotConfigured);
        }

        env.storage().persistent().set(&DataKey::Admin, &admin);
        Ok(())
    }

    /// The configured admin, or `None`.
    pub fn admin(env: Env) -> Option<Address> {
        env.storage().persistent().get(&DataKey::Admin)
    }

    /// Fail unless `actor` is the configured admin.
    ///
    /// The lookup has no fallback to the caller: an unconfigured vault cannot be
    /// reconfigured by whoever signs the transaction.
    fn require_admin(env: &Env, actor: &Address) -> Result<(), Error> {
        let stored: Option<Address> = env.storage().persistent().get(&DataKey::Admin);
        match stored {
            Some(admin) if admin == *actor => Ok(()),
            _ => Err(Error::Unauthorized),
        }
    }

    /// # Bound how long a submission may claim to be fresh
    ///
    /// `max_validity_window_secs = None` removes the bound. `submit` refuses a
    /// longer window with [`Error::WindowTooLong`]; without a bound, a single
    /// submission can stay "fresh" for years and quietly dominate every index
    /// that reads it.
    ///
    /// # Errors
    /// * [`Error::Unauthorized`] - `actor` is not the configured admin.
    pub fn set_max_validity_window(
        env: Env,
        actor: Address,
        max_validity_window_secs: Option<u64>,
    ) -> Result<(), Error> {
        actor.require_auth();
        Self::require_admin(&env, &actor)?;

        match max_validity_window_secs {
            Some(max) => {
                env.storage()
                    .persistent()
                    .set(&DataKey::MaxValidityWindow, &max);
            }
            None => {
                env.storage().persistent().remove(&DataKey::MaxValidityWindow);
            }
        }

        ValidityWindowPolicyUpdated {
            actor,
            max_validity_window_secs,
        }
        .publish(&env);

        Ok(())
    }

    /// The configured maximum validity window, or `None` when unbounded.
    pub fn max_validity_window(env: Env) -> Option<u64> {
        env.storage().persistent().get(&DataKey::MaxValidityWindow)
    }

    /// # Enable or disable a category
    ///
    /// # Errors
    /// * [`Error::Unauthorized`] - `actor` is not the configured admin.
    pub fn set_category_enabled(
        env: Env,
        actor: Address,
        category: Symbol,
        enabled: bool,
    ) -> Result<(), Error> {
        actor.require_auth();
        Self::require_admin(&env, &actor)?;

        env.storage()
            .persistent()
            .set(&DataKey::CategoryPolicy(category.clone()), &enabled);

        CategoryPolicyUpdated {
            actor,
            category,
            enabled,
        }
        .publish(&env);

        Ok(())
    }

    /// Whether submissions in `category` are accepted. No entry means enabled.
    pub fn is_category_enabled(env: Env, category: Symbol) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::CategoryPolicy(category))
            .unwrap_or(true)
    }

    /// # Allow or deny a submitter
    ///
    /// # Errors
    /// * [`Error::Unauthorized`] - `actor` is not the configured admin.
    pub fn set_submitter_allowed(
        env: Env,
        actor: Address,
        submitter: Address,
        allowed: bool,
    ) -> Result<(), Error> {
        actor.require_auth();
        Self::require_admin(&env, &actor)?;

        env.storage()
            .persistent()
            .set(&DataKey::SubmitterPolicy(submitter.clone()), &allowed);

        SubmitterPolicyUpdated {
            actor,
            submitter,
            allowed,
        }
        .publish(&env);

        Ok(())
    }

    /// Whether `submitter` may submit. No entry means allowed.
    pub fn is_submitter_allowed(env: Env, submitter: Address) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::SubmitterPolicy(submitter))
            .unwrap_or(true)
    }

    pub fn supported_countries(env: Env) -> Vec<Symbol> {
        registry::countries(&env)
    }

    /// The supported cost-of-living basket categories.
    pub fn supported_categories(env: Env) -> Vec<Symbol> {
        registry::categories(&env)
    }

    /// The registry version this build was compiled against.
    pub fn registry_version(_env: Env) -> u32 {
        registry::VERSION
    }

    // â”€â”€ Pure helpers, callable off-chain â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    /// Add two `i128` values, failing safely on overflow.
    ///
    /// # Errors
    /// * [`Error::ArithmeticOverflow`] â€” result would overflow `i128`.
    pub fn safe_add(_env: Env, a: i128, b: i128) -> Result<i128, Error> {
        guards::checked_add_i128(a, b)
    }

    /// Multiply two `i128` values, failing safely on overflow.
    ///
    /// # Errors
    /// * [`Error::ArithmeticOverflowMul`] â€” result would overflow `i128`.
    pub fn safe_mul(_env: Env, a: i128, b: i128) -> Result<i128, Error> {
        guards::checked_mul_i128(a, b)
    }

    /// Validate a submit payload without committing any state.
    ///
    /// Lets SDK clients and cross-contract callers confirm a payload is
    /// structurally sound before building or forwarding a transaction.
    pub fn validate_submit_payload(
        _env: Env,
        country_iso: Symbol,
        category: Symbol,
        value: i128,
        timestamp: u64,
    ) -> Result<(), Error> {
        payload::validate(
            SUBMIT_SCHEMA,
            &payload::SubmitPayload {
                country_iso: &country_iso,
                category: &category,
                value,
                timestamp,
                schema_version: SCHEMA_VERSION,
            },
        )
    }

    // â”€â”€ Internal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    /// Load records for each timestamp in `timestamps`, skipping any that are
    /// absent (defensive â€” under normal operation every indexed timestamp has
    /// a record).
    fn collect_submissions(
        env: &Env,
        country_iso: &Symbol,
        category: &Symbol,
        timestamps: &Vec<u64>,
    ) -> Vec<PriceSubmission> {
        let mut result = Vec::new(env);
        for ts in timestamps.iter() {
            let key = DataKey::Price(country_iso.clone(), category.clone(), ts);
            if let Some(submission) = env.storage().persistent().get::<DataKey, PriceSubmission>(&key)
            {
                result.push_back(submission);
            }
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        Ok(())
    }
}

// â”€â”€ Tests â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    /// The configured admin, or `None` when the contract is unconfigured.
    pub fn admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Admin)
    }
#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Events as _},
        Env,
    };

    /// Hand the admin role to a new address.
    ///
    /// # Errors
    /// * [`Error::Unauthorized`] — caller is not the current admin.
    pub fn set_admin(env: Env, admin: Address, new_admin: Address) -> Result<(), Error> {
        require_admin(&env, &admin)?;
        new_admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        Ok(())
    }

    /// # Restrict which countries may receive submissions
    ///
    /// Narrows the static [`registry`]; it cannot widen it, because every
    /// entry is validated against the registry first. An empty list clears the
    /// restriction and returns the contract to registry-only behaviour.
    ///
    /// # Errors
    /// * [`Error::Unauthorized`] — caller is not the admin.
    /// * [`Error::InvalidCountry`] — an entry is not a registry identifier.
    pub fn set_country_allowlist(
        env: Env,
        admin: Address,
        countries: Vec<Symbol>,
    ) -> Result<(), Error> {
        require_admin(&env, &admin)?;
        for i in 0..countries.len() {
            if !registry::is_supported_country(&env, &countries.get(i).unwrap()) {
                return Err(Error::InvalidCountry);
            }
        }
        env.storage().instance().set(&DataKey::CountryAllowlist, &countries);
        Ok(())
    }

    /// The configured country allowlist. Empty means unrestricted.
    pub fn get_country_allowlist(env: Env) -> Vec<Symbol> {
        env.storage()
            .instance()
            .get(&DataKey::CountryAllowlist)
            .unwrap_or_else(|| Vec::new(&env))
    }

    /// # Restrict which categories may receive submissions
    ///
    /// As with the country allowlist, an empty list clears the restriction.
    /// Enforced in `submit` before `require_auth` and before any storage
    /// access, so an unknown category costs the caller a single read.
    ///
    /// # Errors
    /// * [`Error::Unauthorized`] — caller is not the admin.
    /// * [`Error::InvalidCategory`] — an entry is not a registry identifier.
    pub fn set_category_allowlist(
        env: Env,
        admin: Address,
        categories: Vec<Symbol>,
    ) -> Result<(), Error> {
        require_admin(&env, &admin)?;
        for i in 0..categories.len() {
            if !registry::is_supported_category(&env, &categories.get(i).unwrap()) {
                return Err(Error::InvalidCategory);
            }
        }
        env.storage().instance().set(&DataKey::CategoryAllowlist, &categories);
        Ok(())
    }

    /// The configured category allowlist. Empty means unrestricted.
    pub fn get_category_allowlist(env: Env) -> Vec<Symbol> {
        env.storage()
            .instance()
            .get(&DataKey::CategoryAllowlist)
            .unwrap_or_else(|| Vec::new(&env))
    }

    /// # Restrict which submitters may write which categories
    ///
    /// Replaces the whole policy. An empty policy imposes no restriction; an
    /// entry with an empty `categories` grants every category. Every category
    /// named in the policy is validated against the registry, so the policy
    /// cannot grant a category that would be rejected anyway.
    ///
    /// # Errors
    /// * [`Error::Unauthorized`] — caller is not the admin.
    /// * [`Error::InvalidCategory`] — a named category is not a registry
    ///   identifier.
    pub fn set_authorizations(
        env: Env,
        admin: Address,
        policy: Vec<Authorization>,
    ) -> Result<(), Error> {
        require_admin(&env, &admin)?;
        for i in 0..policy.len() {
            let entry = policy.get(i).unwrap();
            for j in 0..entry.categories.len() {
                if !registry::is_supported_category(&env, &entry.categories.get(j).unwrap()) {
                    return Err(Error::InvalidCategory);
                }
            }
        }
        env.storage().instance().set(&DataKey::Authorizations, &policy);
        Ok(())
    }

    /// The configured submitter policy. Empty means unrestricted.
    pub fn get_authorizations(env: Env) -> Vec<Authorization> {
        env.storage()
            .instance()
            .get(&DataKey::Authorizations)
            .unwrap_or_else(|| Vec::new(&env))
    }

    /// Whether `submitter` may currently write `category`.
    ///
    /// Exposed so a client can check before building a transaction, rather
    /// than discovering the refusal by submitting.
    pub fn is_submitter_authorized(env: Env, submitter: Address, category: Symbol) -> bool {
        submitter_allowed(&env, &submitter, &category)
    }

    /// Whether `country` currently passes the allowlist.
    pub fn is_country_allowed(env: Env, country: Symbol) -> bool {
        country_allowed(&env, &country)
    }

    /// Whether `category` currently passes the allowlist.
    pub fn is_category_allowed(env: Env, category: Symbol) -> bool {
        category_allowed(&env, &category)
    }

    // ── Registry views ──────────────────────────────────────────────────

    /// Whether `from -> to` is a permitted status transition.
    ///
    /// Publishes the transition table that `set_status` enforces, so a sentinel
    /// daemon can ask "would this transition be accepted?" without submitting a
    /// transaction that is going to be rejected. The answer is derived from the
    /// same [`SubmissionStatus::can_transition_to`] the mutator uses, so the
    /// view can never disagree with the enforcement.
    ///
    /// Returns `false` — never an error — for an unknown or terminal pair, so a
    /// caller can use it as a plain boolean gate.
    pub fn can_transition(from: SubmissionStatus, to: SubmissionStatus) -> bool {
        from.can_transition_to(to)
    }

    /// The supported ISO 3166-1 alpha-2 country codes.
    pub fn supported_countries(env: Env) -> Vec<Symbol> {
        registry::countries(&env)
    }

    /// The supported cost-of-living basket categories.
    pub fn supported_categories(env: Env) -> Vec<Symbol> {
        registry::categories(&env)
    }

    /// The registry version this build was compiled against.
    pub fn registry_version(_env: Env) -> u32 {
        registry::VERSION
    }

    // ── Pure helpers, callable off-chain ────────────────────────────────

    /// Add two `i128` values, failing safely on overflow.
    ///
    /// # Errors
    /// * [`Error::ArithmeticOverflow`] — result would overflow `i128`.
    pub fn safe_add(_env: Env, a: i128, b: i128) -> Result<i128, Error> {
        guards::checked_add_i128(a, b)
    }

    /// Multiply two `i128` values, failing safely on overflow.
    ///
    /// # Errors
    /// * [`Error::ArithmeticOverflowMul`] — result would overflow `i128`.
    pub fn safe_mul(_env: Env, a: i128, b: i128) -> Result<i128, Error> {
        guards::checked_mul_i128(a, b)
    }

    /// Validate a submit payload without committing any state.
    ///
    /// Lets SDK clients and cross-contract callers confirm a payload is
    /// structurally sound before building or forwarding a transaction.
    pub fn validate_submit_payload(
        _env: Env,
        country_iso: Symbol,
        category: Symbol,
        value: i128,
        timestamp: u64,
    ) -> Result<(), Error> {
        payload::validate(
            SUBMIT_SCHEMA,
            &payload::SubmitPayload {
                country_iso: &country_iso,
                category: &category,
                value,
                timestamp,
                schema_version: SCHEMA_VERSION,
            },
        )
    }

    // ── Internal ────────────────────────────────────────────────────────

    /// Load records for each timestamp in `timestamps`, skipping any that are
    /// absent (defensive — under normal operation every indexed timestamp has
    /// a record).
    fn collect_submissions(
        env: &Env,
        country_iso: &Symbol,
        category: &Symbol,
        timestamps: &Vec<u64>,
    ) -> Vec<PriceSubmission> {
        let mut result = Vec::new(env);
        for ts in timestamps.iter() {
            let key = DataKey::Price(country_iso.clone(), category.clone(), ts);
            if let Some(submission) = env.storage().persistent().get::<DataKey, PriceSubmission>(&key)
            {
                result.push_back(submission);
            }
        }
        result
    /// Submit with the default validity window.
    fn submit_ok(
        client: &PriceVaultClient,
        submitter: &Address,
        country: &Symbol,
        category: &Symbol,
        value: i128,
        valid_from: u64,
    ) {
        client
            .submit(
                submitter,
                country,
                category,
                &value,
                &valid_from,
                &DEFAULT_VALIDITY_WINDOW_SECS,
            )
            .unwrap();
    }

    // â”€â”€ guards â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    #[test]
    fn guard_price_bounds() {
        assert_eq!(guards::require_positive_price(0), Err(Error::ZeroPrice));
        assert_eq!(
            guards::require_positive_price(-1),
            Err(Error::NegativePrice)
        );
        assert_eq!(
            guards::require_positive_price(i128::MIN),
            Err(Error::NegativePrice)
        );
        assert!(guards::require_positive_price(1).is_ok());
        assert!(guards::require_positive_price(i128::MAX).is_ok());
    }

    #[test]
    fn guard_u64_and_i128_bounds() {
        assert_eq!(guards::require_positive_u64(0), Err(Error::ZeroValue));
        assert!(guards::require_positive_u64(1).is_ok());

        assert_eq!(
            guards::require_positive_i128(0),
            Err(Error::NonPositiveAmount)
        );
        assert_eq!(
            guards::require_positive_i128(-1),
            Err(Error::NonPositiveAmount)
        );
        assert!(guards::require_positive_i128(1).is_ok());
    }

    #[test]
    fn guard_checked_arithmetic() {
        assert_eq!(guards::checked_add_u64(100, 200), Ok(300));
        assert_eq!(guards::checked_add_u64(u64::MAX, 0), Ok(u64::MAX));
        assert_eq!(
            guards::checked_add_u64(u64::MAX, 1),
            Err(Error::ArithmeticOverflow)
        );

        assert_eq!(guards::checked_add_i128(50, 50), Ok(100));
        assert_eq!(
            guards::checked_add_i128(i128::MAX, 1),
            Err(Error::ArithmeticOverflow)
        );
        assert_eq!(
            guards::checked_add_i128(i128::MIN, -1),
            Err(Error::ArithmeticOverflow)
        );

        assert_eq!(guards::checked_mul_i128(3, 4), Ok(12));
        assert_eq!(
            guards::checked_mul_i128(i128::MAX, 2),
            Err(Error::ArithmeticOverflowMul)
        );
        assert_eq!(
            guards::checked_mul_i128(i128::MIN, -1),
            Err(Error::ArithmeticOverflowMul)
        );
    }

    // â”€â”€ payload validate â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    fn payload<'a>(
        country: &'a Symbol,
        category: &'a Symbol,
        value: i128,
        timestamp: u64,
    ) -> payload::SubmitPayload<'a> {
        payload::SubmitPayload {
            country_iso: country,
            category,
            value,
            timestamp,
            schema_version: SCHEMA_VERSION,
        }
    }

    #[test]
    fn validate_rejects_bad_values() {
        let env = make_env();
        let ng = sym(&env, "NG");
        let food = sym(&env, "Food");
        let empty = sym(&env, "");

        assert_eq!(
            payload::validate(SUBMIT_SCHEMA, &payload(&ng, &food, 0, 1)),
            Err(Error::ZeroNotAllowed)
        );
        assert_eq!(
            payload::validate(SUBMIT_SCHEMA, &payload(&ng, &food, -1, 1)),
            Err(Error::NegativeNotAllowed)
        );
        assert_eq!(
            payload::validate(SUBMIT_SCHEMA, &payload(&ng, &food, 100, 0)),
            Err(Error::ZeroNotAllowed)
        );
        assert_eq!(
            payload::validate(SUBMIT_SCHEMA, &payload(&ng, &food, MAX_PRICE + 1, 1)),
            Err(Error::ValueAboveMaximum)
        );
        assert_eq!(
            payload::validate(SUBMIT_SCHEMA, &payload(&empty, &food, 100, 1)),
            Err(Error::EmptySymbol)
        );
        assert!(payload::validate(SUBMIT_SCHEMA, &payload(&ng, &food, 100, 1)).is_ok());
        assert!(payload::validate(SUBMIT_SCHEMA, &payload(&ng, &food, MAX_PRICE, 1)).is_ok());
    }

    // â”€â”€ registry â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    #[test]
    fn registry_recognises_known_identifiers() {
        let env = make_env();
        assert!(registry::is_supported_country(&env, &sym(&env, "NG")));
        assert!(registry::is_supported_country(&env, &sym(&env, "US")));
        assert!(!registry::is_supported_country(&env, &sym(&env, "ZZ")));
        assert!(registry::is_supported_category(&env, &sym(&env, "Food")));
        assert!(!registry::is_supported_category(&env, &sym(&env, "Weapons")));
        assert_eq!(registry::countries(&env).len(), registry::COUNTRY_CODES.len());
        assert_eq!(registry::categories(&env).len(), registry::CATEGORIES.len());
    }

    // â”€â”€ submit â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    #[test]
    fn submit_stores_window_bounds_and_pending_status() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        let country = sym(&env, "NG");
        let category = sym(&env, "Food");

        env.mock_all_auths();
        submit_ok(&client, &submitter, &country, &category, 1_000, 1_000);

        let s = client.get(&country, &category, &1_000).unwrap();
        assert_eq!(s.valid_from, 1_000);
        assert_eq!(s.valid_until, 1_000 + DEFAULT_VALIDITY_WINDOW_SECS);
        assert_eq!(s.timestamp, 1_000);
        assert_eq!(s.value, 1_000);
        assert_eq!(s.submitter, submitter);
        assert_eq!(s.status, SubmissionStatus::Pending);
    }

    #[test]
    fn submit_rejects_unknown_identifiers() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        env.mock_all_auths();

        assert_eq!(
            client
                .try_submit(
                    &submitter,
                    &sym(&env, "ZZ"),
                    &sym(&env, "Food"),
                    &100,
                    &1_000_u64,
                    &DEFAULT_VALIDITY_WINDOW_SECS,
                )
                .unwrap_err()
                .unwrap(),
            Error::InvalidCountry
        );
        assert_eq!(
            client
                .try_submit(
                    &submitter,
                    &sym(&env, "NG"),
                    &sym(&env, "Weapons"),
                    &100,
                    &1_000_u64,
                    &DEFAULT_VALIDITY_WINDOW_SECS,
                )
                .unwrap_err()
                .unwrap(),
            Error::InvalidCategory
        );
    }

    #[test]
    fn submit_rejects_bad_values_before_auth() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        let country = sym(&env, "NG");
        let category = sym(&env, "Food");
        env.mock_all_auths();

        // Zero price.
        assert_eq!(
            client
                .try_submit(
                    &submitter,
                    &country,
                    &category,
                    &0,
                    &1_000_u64,
                    &DEFAULT_VALIDITY_WINDOW_SECS,
                )
                .unwrap_err()
                .unwrap(),
            Error::ZeroNotAllowed
        );
        // Negative price.
        assert_eq!(
            client
                .try_submit(
                    &submitter,
                    &country,
                    &category,
                    &-1,
                    &1_000_u64,
                    &DEFAULT_VALIDITY_WINDOW_SECS,
                )
                .unwrap_err()
                .unwrap(),
            Error::NegativeNotAllowed
        );
        // Zero timestamp.
        assert_eq!(
            client
                .try_submit(
                    &submitter,
                    &country,
                    &category,
                    &100,
                    &0_u64,
                    &DEFAULT_VALIDITY_WINDOW_SECS,
                )
                .unwrap_err()
                .unwrap(),
            Error::ZeroNotAllowed
        );
        // Above the schema ceiling.
        assert_eq!(
            client
                .try_submit(
                    &submitter,
                    &country,
                    &category,
                    &(MAX_PRICE + 1),
                    &1_000_u64,
                    &DEFAULT_VALIDITY_WINDOW_SECS,
                )
                .unwrap_err()
                .unwrap(),
            Error::ValueAboveMaximum
        );
    }

    #[test]
    fn submit_rejects_bad_windows() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        let country = sym(&env, "NG");
        let category = sym(&env, "Food");
        env.mock_all_auths();

        // Zero window.
        assert_eq!(
            client
                .try_submit(&submitter, &country, &category, &100, &1_000_u64, &0_u64)
                .unwrap_err()
                .unwrap(),
            Error::InvalidWindow
        );
        // valid_from + window overflows u64.
        assert_eq!(
            client
                .try_submit(&submitter, &country, &category, &100, &u64::MAX, &1_u64)
                .unwrap_err()
                .unwrap(),
            Error::InvalidWindow
        );
    }

    #[test]
    fn resubmitting_the_same_key_is_refused() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        let country = sym(&env, "NG");
        let category = sym(&env, "Food");
        env.mock_all_auths();

        submit_ok(&client, &submitter, &country, &category, 100, 10);

        // Same key, different value: refused rather than silently ignored, so a
        // caller cannot mistake "kept the first write" for "wrote mine".
        assert_eq!(
            client
                .try_submit(
                    &submitter,
                    &country,
                    &category,
                    &999,
                    &10_u64,
                    &DEFAULT_VALIDITY_WINDOW_SECS,
                )
                .unwrap_err()
                .unwrap(),
            Error::DuplicateSubmission
        );

        // The original is intact and the index was not duplicated.
        let history = client.get_history(&country, &category);
        assert_eq!(history.len(), 1);
        assert_eq!(history.get(0).unwrap().value, 100);
        assert_eq!(client.get(&country, &category, &10).unwrap().value, 100);
    }

    #[test]
    fn a_duplicate_is_detected_per_key_component() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        let ng = sym(&env, "NG");
        let food = sym(&env, "Food");
        let rent = sym(&env, "Rent");
        let gh = sym(&env, "GH");
        env.mock_all_auths();

        submit_ok(&client, &submitter, &ng, &food, 100, 10);

        // Every component differs, so every one of these is a distinct record.
        submit_ok(&client, &submitter, &ng, &food, 200, 11);
        submit_ok(&client, &submitter, &ng, &rent, 300, 10);
        submit_ok(&client, &submitter, &gh, &food, 400, 10);

        assert_eq!(client.get_history(&ng, &food).len(), 2);
        assert_eq!(client.get_history(&ng, &rent).len(), 1);
        assert_eq!(client.get_history(&gh, &food).len(), 1);

        // Only the exact triple collides.
        assert_eq!(
            client
                .try_submit(
                    &submitter,
                    &ng,
                    &food,
                    &100,
                    &10_u64,
                    &DEFAULT_VALIDITY_WINDOW_SECS,
                )
                .unwrap_err()
                .unwrap(),
            Error::DuplicateSubmission
        );
    }

    #[test]
    fn a_duplicate_is_detected_regardless_of_window_or_submitter() {
        let env = make_env();
        let client = deploy(&env);
        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        let country = sym(&env, "NG");
        let category = sym(&env, "Food");
        env.mock_all_auths();

        submit_ok(&client, &alice, &country, &category, 100, 10);

        // The key is the record's identity; neither the window nor the submitter
        // is part of it, so neither can be varied to smuggle in a second value
        // for the same observation instant.
        for (submitter, window) in [(&alice, 1_u64), (&bob, DEFAULT_VALIDITY_WINDOW_SECS)] {
            assert_eq!(
                client
                    .try_submit(&submitter, &country, &category, &777, &10_u64, &window)
                    .unwrap_err()
                    .unwrap(),
                Error::DuplicateSubmission
            );
        }

        assert_eq!(client.get(&country, &category, &10).unwrap().value, 100);
        assert_eq!(client.get_history(&country, &category).len(), 1);
    }

    // -- submission window validation -------------------------------------

    #[test]
    fn window_bounds_are_one_definition_of_the_window() {
        let env = make_env();
        let client = deploy(&env);

        // Zero window: refused, not treated as instantaneous.
        assert_eq!(client.window_bounds(&1_000, &0), Err(Error::InvalidWindow));
        // Overflow: refused, not wrapped or saturated.
        assert_eq!(
            client.window_bounds(&u64::MAX, &1),
            Err(Error::InvalidWindow)
        );
        assert_eq!(
            client.window_bounds(&u64::MAX, &u64::MAX),
            Err(Error::InvalidWindow)
        );
        // A window that lands exactly on u64::MAX is representable.
        assert_eq!(client.window_bounds(&0, &u64::MAX), Ok(u64::MAX));
        assert_eq!(client.window_bounds(&1_000, &86_400), Ok(87_400));
    }

    #[test]
    fn the_window_is_inclusive_at_the_start_and_exclusive_at_expiry() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        let country = sym(&env, "NG");
        let category = sym(&env, "Food");
        env.mock_all_auths();

        client
            .submit(&submitter, &country, &category, &100, &1_000_u64, &500_u64)
            .unwrap();
        let valid_until = client.window_bounds(&1_000, &500).unwrap();
        assert_eq!(valid_until, 1_500);

        // Fresh at the lower bound.
        assert!(client.is_fresh(&country, &category, &1_000, &1_000));
        // Fresh one tick before expiry.
        assert!(client.is_fresh(&country, &category, &1_000, &1_499));
        // Stale exactly at expiry: the upper bound is exclusive.
        assert!(!client.is_fresh(&country, &category, &1_000, &1_500));
        // Not yet valid before the lower bound.
        assert!(!client.is_fresh(&country, &category, &1_000, &999));
    }

    // -- freshness for aggregation ----------------------------------------

    #[test]
    fn fresh_history_drops_expiry_and_not_yet_valid_records() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        let country = sym(&env, "NG");
        let category = sym(&env, "Food");
        env.mock_all_auths();

        // Three records with 100s windows: [1_000, 1_100), [2_000, 2_100),
        // [3_000, 3_100).
        for (ts, value) in [(1_000_u64, 100_i128), (2_000, 200), (3_000, 300)] {
            client
                .submit(&submitter, &country, &category, &value, &ts, &100_u64)
                .unwrap();
        }

        // Everything is stored, expired or not.
        assert_eq!(client.get_history(&country, &category).len(), 3);

        // At 1_050 only the first is fresh.
        let fresh = client.get_fresh_history(&country, &category, &1_050);
        assert_eq!(fresh.len(), 1);
        assert_eq!(fresh.get(0).unwrap().value, 100);

        // At 2_050 the second has joined and the first has gone.
        let fresh = client.get_fresh_history(&country, &category, &2_050);
        assert_eq!(fresh.len(), 1);
        assert_eq!(fresh.get(0).unwrap().value, 200);

        // At 1_100 exactly, the first is expired: the upper bound is exclusive.
        let fresh = client.get_fresh_history(&country, &category, &1_100);
        assert_eq!(fresh.len(), 0);
        assert_eq!(client.get_history(&country, &category).len(), 3);

        // An empty group is empty, never an error.
        assert_eq!(
            client
                .get_fresh_history(&country, &sym(&env, "Rent"), &1_050)
                .len(),
            0
        );
    }

    #[test]
    fn a_missing_record_is_never_fresh() {
        let env = make_env();
        let client = deploy(&env);
        let country = sym(&env, "NG");
        let category = sym(&env, "Food");

        assert!(!client.is_fresh(&country, &category, &1_000, &1_000));
        assert_eq!(
            client.get_fresh_history(&country, &category, &1_000).len(),
            0
        );
    }

    // -- admin configuration ----------------------------------------------

    #[test]
    fn an_unconfigured_vault_has_no_admin_and_no_restrictions() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        let country = sym(&env, "NG");
        let category = sym(&env, "Food");
        env.mock_all_auths();

        assert_eq!(client.admin(), None);
        assert_eq!(client.max_validity_window(), None);
        // Absent entries mean "no restriction", so submitting still works.
        assert!(client.is_category_enabled(&category));
        assert!(client.is_submitter_allowed(&submitter));
        submit_ok(&client, &submitter, &country, &category, 100, 10);
    }

    #[test]
    fn the_admin_can_be_configured_once() {
        let env = make_env();
        let client = deploy(&env);
        let admin = Address::generate(&env);
        let other = Address::generate(&env);
        env.mock_all_auths();

        client.configure_admin(&admin);
        assert_eq!(client.admin(), Some(admin.clone()));

        // Handing the authority to a new address is a deliberate act, not a
        // side effect of a retried transaction.
        assert_eq!(
            client.try_configure_admin(&other).unwrap_err().unwrap(),
            Error::AdminNotConfigured
        );
        assert_eq!(client.admin(), Some(admin.clone()));
    }

    #[test]
    fn policy_setters_are_admin_only() {
        let env = make_env();
        let client = deploy(&env);
        let admin = Address::generate(&env);
        let stranger = Address::generate(&env);
        let category = sym(&env, "Food");
        let subject = Address::generate(&env);
        env.mock_all_auths();

        client.configure_admin(&admin);

        assert_eq!(
            client
                .try_set_category_enabled(&stranger, &category, &false)
                .unwrap_err()
                .unwrap(),
            Error::Unauthorized
        );
        assert_eq!(
            client
                .try_set_submitter_allowed(&stranger, &subject, &false)
                .unwrap_err()
                .unwrap(),
            Error::Unauthorized
        );
        assert_eq!(
            client
                .try_set_max_validity_window(&stranger, &Some(100))
                .unwrap_err()
                .unwrap(),
            Error::Unauthorized
        );

        // Nothing was written by the refused calls.
        assert!(client.is_category_enabled(&category));
        assert!(client.is_submitter_allowed(&subject));
        assert_eq!(client.max_validity_window(), None);
    }

    #[test]
    fn a_disabled_category_or_denied_submitter_is_refused_by_submit() {
        let env = make_env();
        let client = deploy(&env);
        let admin = Address::generate(&env);
        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        let ng = sym(&env, "NG");
        let food = sym(&env, "Food");
        let rent = sym(&env, "Rent");
        env.mock_all_auths();

        client.configure_admin(&admin);
        client.set_category_enabled(&admin, &food, &false);
        client.set_submitter_allowed(&admin, &alice, &false);

        assert!(!client.is_category_enabled(&food));
        assert!(client.is_category_enabled(&rent));
        assert!(!client.is_submitter_allowed(&alice));
        assert!(client.is_submitter_allowed(&bob));

        assert_eq!(
            client
                .try_submit(
                    &bob,
                    &ng,
                    &food,
                    &100,
                    &1_000_u64,
                    &DEFAULT_VALIDITY_WINDOW_SECS,
                )
                .unwrap_err()
                .unwrap(),
            Error::CategoryDisabled
        );
        assert_eq!(
            client
                .try_submit(
                    &alice,
                    &ng,
                    &rent,
                    &100,
                    &1_000_u64,
                    &DEFAULT_VALIDITY_WINDOW_SECS,
                )
                .unwrap_err()
                .unwrap(),
            Error::SubmitterNotAllowed
        );

        // The unrestricted combination still works, so a policy entry does not
        // disable more than it names.
        client
            .submit(
                &bob,
                &ng,
                &rent,
                &100,
                &1_000_u64,
                &DEFAULT_VALIDITY_WINDOW_SECS,
            )
            .unwrap();

        // Re-enabling restores the category.
        client.set_category_enabled(&admin, &food, &true);
        client
            .submit(
                &bob,
                &ng,
                &food,
                &100,
                &1_000_u64,
                &DEFAULT_VALIDITY_WINDOW_SECS,
            )
            .unwrap();
    }

    #[test]
    fn a_maximum_validity_window_bounds_what_submit_accepts() {
        let env = make_env();
        let client = deploy(&env);
        let admin = Address::generate(&env);
        let submitter = Address::generate(&env);
        let country = sym(&env, "NG");
        let category = sym(&env, "Food");
        env.mock_all_auths();

        client.configure_admin(&admin);
        client.set_max_validity_window(&admin, &Some(3_600));

        assert_eq!(client.max_validity_window(), Some(3_600));

        assert_eq!(
            client
                .try_submit(&submitter, &country, &category, &100, &1_000_u64, &3_601_u64)
                .unwrap_err()
                .unwrap(),
            Error::WindowTooLong
        );
        // Exactly the bound is accepted.
        client
            .submit(&submitter, &country, &category, &100, &1_000_u64, &3_600_u64)
            .unwrap();

        // Removing the bound restores acceptance.
        client.set_max_validity_window(&admin, &None);
        assert_eq!(client.max_validity_window(), None);
        client
            .submit(&submitter, &country, &category, &200, &2_000_u64, &86_400_u64)
            .unwrap();
    }

    #[test]
    fn every_policy_change_publishes_an_event() {
        let env = make_env();
        let client = deploy(&env);
        let admin = Address::generate(&env);
        let category = sym(&env, "Food");
        let subject = Address::generate(&env);
        env.mock_all_auths();

        client.configure_admin(&admin);

        let before = env.events().all().events().len();

        client.set_max_validity_window(&admin, &Some(3_600));
        client.set_max_validity_window(&admin, &None);
        client.set_category_enabled(&admin, &category, &false);
        client.set_category_enabled(&admin, &category, &true);
        client.set_submitter_allowed(&admin, &subject, &false);
        client.set_submitter_allowed(&admin, &subject, &true);

        // One event per change, including the "remove the bound" direction.
        assert_eq!(env.events().all().events().len(), before + 6);
    }

    // â”€â”€ validity window â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    #[test]
    fn validity_window_bounds_are_half_open() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        let country = sym(&env, "NG");
        let category = sym(&env, "Food");
        env.mock_all_auths();

        submit_ok(&client, &submitter, &country, &category, 100, 1_000);

        // Lower bound inclusive.
        assert!(client.is_valid_at(&country, &category, &1_000, &1_000));
        // Interior.
        assert!(client.is_valid_at(
            &country,
            &category,
            &1_000,
            &1_000 + DEFAULT_VALIDITY_WINDOW_SECS - 1
        ));
        // Upper bound exclusive.
        assert!(!client.is_valid_at(
            &country,
            &category,
            &1_000,
            &1_000 + DEFAULT_VALIDITY_WINDOW_SECS
        ));
        // Before the window.
        assert!(!client.is_valid_at(&country, &category, &1_000, &999));
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env};

    fn make_env() -> Env {
        Env::default()
    }

    fn deploy(env: &Env) -> PriceVaultClient {
        let contract_id = env.register(PriceVault, ());
        PriceVaultClient::new(env, &contract_id)
    }

    fn sym(env: &Env, s: &str) -> Symbol {
        Symbol::new(env, s)
    }

    /// Submit with the default validity window.
    fn submit_ok(
        client: &PriceVaultClient,
        submitter: &Address,
        country: &Symbol,
        category: &Symbol,
        value: i128,
        valid_from: u64,
    ) {
        client
            .submit(
                submitter,
                country,
                category,
                &value,
                &valid_from,
                &DEFAULT_VALIDITY_WINDOW_SECS,
            )
            .unwrap();
    }

    // ── guards ──────────────────────────────────────────────────────────

    #[test]
    fn guard_price_bounds() {
        assert_eq!(guards::require_positive_price(0), Err(Error::ZeroPrice));
        assert_eq!(
            guards::require_positive_price(-1),
            Err(Error::NegativePrice)
        );
        assert_eq!(
            guards::require_positive_price(i128::MIN),
            Err(Error::NegativePrice)
        );
        assert!(guards::require_positive_price(1).is_ok());
        assert!(guards::require_positive_price(i128::MAX).is_ok());
    }

    #[test]
    fn guard_u64_and_i128_bounds() {
        assert_eq!(guards::require_positive_u64(0), Err(Error::ZeroValue));
        assert!(guards::require_positive_u64(1).is_ok());
    #[test]
    fn consecutive_windows_do_not_overlap() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        let country = sym(&env, "NG");
        let category = sym(&env, "Food");
        env.mock_all_auths();

        // Window 1 = [1_000, 2_000), window 2 = [2_000, 3_000).
        client
            .submit(&submitter, &country, &category, &100, &1_000_u64, &1_000_u64)
            .unwrap();
        client
            .submit(&submitter, &country, &category, &200, &2_000_u64, &1_000_u64)
            .unwrap();

        // At 2_000 only window 2 is fresh.
        assert!(!client.is_valid_at(&country, &category, &1_000, &2_000));
        assert!(client.is_valid_at(&country, &category, &2_000, &2_000));
    }

    #[test]
    fn get_valid_gates_on_freshness() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        let country = sym(&env, "KE");
        let category = sym(&env, "Rent");
        env.mock_all_auths();

        submit_ok(&client, &submitter, &country, &category, 500, 2_000);

        assert!(client
            .get_valid(&country, &category, &2_000, &2_000)
            .is_some());
        assert!(client
            .get_valid(&country, &category, &2_000, &1_999)
            .is_none());
        assert!(client
            .get_valid(&country, &category, &2_000, &100_000)
            .is_none());
        // Missing record.
        assert!(client.get_valid(&country, &category, &9_999, &1).is_none());
    }

    #[test]
    fn is_valid_at_is_false_for_missing_records() {
        let env = make_env();
        let client = deploy(&env);
        assert!(!client.is_valid_at(&sym(&env, "NG"), &sym(&env, "Food"), &1, &1));
    }

    // â”€â”€ status machine â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    #[test]
    fn transition_table_allows_only_pending_to_a_terminal_state() {
        // Pending may reach either terminal state.
        assert!(SubmissionStatus::Pending.can_transition_to(SubmissionStatus::Verified));
        assert!(SubmissionStatus::Pending.can_transition_to(SubmissionStatus::Rejected));
        // Pending is never a target.
        assert!(!SubmissionStatus::Pending.can_transition_to(SubmissionStatus::Pending));
        // Terminal states are absorbing.
        assert!(!SubmissionStatus::Verified.can_transition_to(SubmissionStatus::Rejected));
        assert!(!SubmissionStatus::Verified.can_transition_to(SubmissionStatus::Pending));
        assert!(!SubmissionStatus::Rejected.can_transition_to(SubmissionStatus::Verified));
        assert!(!SubmissionStatus::Rejected.can_transition_to(SubmissionStatus::Pending));

        assert!(!SubmissionStatus::Pending.is_terminal());
        assert!(SubmissionStatus::Verified.is_terminal());
        assert!(SubmissionStatus::Rejected.is_terminal());
    }

    #[test]
    fn status_discriminants_are_stable() {
        // Pinned so external consumers can match on the u32 representation.
        assert_eq!(SubmissionStatus::Pending as u32, 0);
        assert_eq!(SubmissionStatus::Verified as u32, 1);
        assert_eq!(SubmissionStatus::Rejected as u32, 2);
    }

    #[test]
    fn pending_transitions_to_verified_and_rejected() {
        for target in [SubmissionStatus::Verified, SubmissionStatus::Rejected] {
            let env = make_env();
            let client = deploy(&env);
            let submitter = Address::generate(&env);
            let verifier = Address::generate(&env);
            let country = sym(&env, "NG");
            let category = sym(&env, "Food");
            env.mock_all_auths();

            submit_ok(&client, &submitter, &country, &category, 1_000, 100);
            client
                .set_status(&verifier, &country, &category, &100, &target)
                .unwrap();
            assert_eq!(client.get_status(&country, &category, &100), Some(target));
        }
    }

    #[test]
    fn terminal_states_reject_further_transitions() {
        for terminal in [SubmissionStatus::Verified, SubmissionStatus::Rejected] {
            for next in [
                SubmissionStatus::Verified,
                SubmissionStatus::Rejected,
                SubmissionStatus::Pending,
            ] {
                let env = make_env();
                let client = deploy(&env);
                let submitter = Address::generate(&env);
                let verifier = Address::generate(&env);
                let country = sym(&env, "NG");
                let category = sym(&env, "Food");
                env.mock_all_auths();

                submit_ok(&client, &submitter, &country, &category, 1_000, 100);
                client
                    .set_status(&verifier, &country, &category, &100, &terminal)
                    .unwrap();

                assert_eq!(
                    client
                        .try_set_status(&verifier, &country, &category, &100, &next)
                        .unwrap_err()
                        .unwrap(),
                    Error::InvalidTransition,
                    "{terminal:?} -> {next:?} must be refused"
                );
                // The record is unchanged.
                assert_eq!(
                    client.get_status(&country, &category, &100),
                    Some(terminal)
                );
            }
        }
    }

    #[test]
    fn pending_is_not_a_valid_target() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        let verifier = Address::generate(&env);
        let country = sym(&env, "NG");
        let category = sym(&env, "Food");
        env.mock_all_auths();

        submit_ok(&client, &submitter, &country, &category, 1_000, 100);
        assert_eq!(
            client
                .try_set_status(
                    &verifier,
                    &country,
                    &category,
                    &100,
                    &SubmissionStatus::Pending,
                )
                .unwrap_err()
                .unwrap(),
            Error::InvalidTransition
        );
    }

    #[test]
    fn set_status_on_missing_record_is_not_found() {
        let env = make_env();
        let client = deploy(&env);
        let verifier = Address::generate(&env);
        env.mock_all_auths();

        assert_eq!(
            client
                .try_set_status(
                    &verifier,
                    &sym(&env, "NG"),
                    &sym(&env, "Food"),
                    &999,
                    &SubmissionStatus::Verified,
                )
                .unwrap_err()
                .unwrap(),
            Error::NotFound
        );
    }

    #[test]
    fn status_round_trips_inside_the_record() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        let verifier = Address::generate(&env);
        let country = sym(&env, "IN");
        let category = sym(&env, "Health");
        env.mock_all_auths();

        submit_ok(&client, &submitter, &country, &category, 300, 75);
        assert_eq!(
            client.get(&country, &category, &75).unwrap().status,
            SubmissionStatus::Pending
        );

        client
            .set_status(
                &verifier,
                &country,
                &category,
                &75,
                &SubmissionStatus::Rejected,
            )
            .unwrap();

        let after = client.get(&country, &category, &75).unwrap();
        assert_eq!(after.status, SubmissionStatus::Rejected);
        // Other fields are untouched by a status change.
        assert_eq!(after.value, 300);
        assert_eq!(after.submitter, submitter);
    }

    // â”€â”€ history â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    #[test]
    fn history_is_empty_when_there_are_no_submissions() {
        let env = make_env();
        let client = deploy(&env);
        assert_eq!(client.get_history(&sym(&env, "NG"), &sym(&env, "Food")).len(), 0);
        assert!(client.get_latest(&sym(&env, "NG"), &sym(&env, "Food")).is_none());
    }

    #[test]
    fn history_returns_submissions_in_insertion_order() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        let country = sym(&env, "NG");
        let category = sym(&env, "Food");
        env.mock_all_auths();

        submit_ok(&client, &submitter, &country, &category, 100, 10);
        submit_ok(&client, &submitter, &country, &category, 200, 20);
        submit_ok(&client, &submitter, &country, &category, 300, 30);

        assert_eq!(
            guards::require_positive_i128(0),
            Err(Error::NonPositiveAmount)
        );
        assert_eq!(
            guards::require_positive_i128(-1),
            Err(Error::NonPositiveAmount)
        );
        assert!(guards::require_positive_i128(1).is_ok());
    }

    #[test]
    fn guard_checked_arithmetic() {
        assert_eq!(guards::checked_add_u64(100, 200), Ok(300));
        assert_eq!(guards::checked_add_u64(u64::MAX, 0), Ok(u64::MAX));
        assert_eq!(
            guards::checked_add_u64(u64::MAX, 1),
            Err(Error::ArithmeticOverflow)
        );

        assert_eq!(guards::checked_add_i128(50, 50), Ok(100));
        assert_eq!(
            guards::checked_add_i128(i128::MAX, 1),
            Err(Error::ArithmeticOverflow)
        );
        assert_eq!(
            guards::checked_add_i128(i128::MIN, -1),
            Err(Error::ArithmeticOverflow)
        );

        assert_eq!(guards::checked_mul_i128(3, 4), Ok(12));
        assert_eq!(
            guards::checked_mul_i128(i128::MAX, 2),
            Err(Error::ArithmeticOverflowMul)
        );
        assert_eq!(
            guards::checked_mul_i128(i128::MIN, -1),
            Err(Error::ArithmeticOverflowMul)
        );
    }

    // ── payload validate ────────────────────────────────────────────────

    fn payload<'a>(
        country: &'a Symbol,
        category: &'a Symbol,
        value: i128,
        timestamp: u64,
    ) -> payload::SubmitPayload<'a> {
        payload::SubmitPayload {
            country_iso: country,
            category,
            value,
            timestamp,
            schema_version: SCHEMA_VERSION,
        }
    }

    #[test]
    fn validate_rejects_bad_values() {
        let env = make_env();
        let ng = sym(&env, "NG");
        let food = sym(&env, "Food");
        let empty = sym(&env, "");

        assert_eq!(
            payload::validate(SUBMIT_SCHEMA, &payload(&ng, &food, 0, 1)),
            Err(Error::ZeroNotAllowed)
        );
        assert_eq!(
            payload::validate(SUBMIT_SCHEMA, &payload(&ng, &food, -1, 1)),
            Err(Error::NegativeNotAllowed)
        );
        assert_eq!(
            payload::validate(SUBMIT_SCHEMA, &payload(&ng, &food, 100, 0)),
            Err(Error::ZeroNotAllowed)
        );
        assert_eq!(
            payload::validate(SUBMIT_SCHEMA, &payload(&ng, &food, MAX_PRICE + 1, 1)),
            Err(Error::ValueAboveMaximum)
        );
        assert_eq!(
            payload::validate(SUBMIT_SCHEMA, &payload(&empty, &food, 100, 1)),
            Err(Error::EmptySymbol)
        );
        assert!(payload::validate(SUBMIT_SCHEMA, &payload(&ng, &food, 100, 1)).is_ok());
        assert!(payload::validate(SUBMIT_SCHEMA, &payload(&ng, &food, MAX_PRICE, 1)).is_ok());
    }

    // ── registry ────────────────────────────────────────────────────────

    #[test]
    fn registry_recognises_known_identifiers() {
        let env = make_env();
        assert!(registry::is_supported_country(&env, &sym(&env, "NG")));
        assert!(registry::is_supported_country(&env, &sym(&env, "US")));
        assert!(!registry::is_supported_country(&env, &sym(&env, "ZZ")));
        assert!(registry::is_supported_category(&env, &sym(&env, "Food")));
        assert!(!registry::is_supported_category(&env, &sym(&env, "Weapons")));
        assert_eq!(registry::countries(&env).len(), registry::COUNTRY_CODES.len());
        assert_eq!(registry::categories(&env).len(), registry::CATEGORIES.len());
    fn history_is_scoped_per_country_and_category() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        env.mock_all_auths();

        submit_ok(&client, &submitter, &sym(&env, "NG"), &sym(&env, "Food"), 100, 10);
        submit_ok(&client, &submitter, &sym(&env, "KE"), &sym(&env, "Food"), 200, 20);
        submit_ok(&client, &submitter, &sym(&env, "NG"), &sym(&env, "Rent"), 300, 30);

        let ng_food = client.get_history(&sym(&env, "NG"), &sym(&env, "Food"));
        assert_eq!(ng_food.len(), 1);
        assert_eq!(ng_food.get(0).unwrap().value, 100);

        let ke_food = client.get_history(&sym(&env, "KE"), &sym(&env, "Food"));
        assert_eq!(ke_food.len(), 1);
        assert_eq!(ke_food.get(0).unwrap().value, 200);

        let ng_rent = client.get_history(&sym(&env, "NG"), &sym(&env, "Rent"));
        assert_eq!(ng_rent.len(), 1);
        assert_eq!(ng_rent.get(0).unwrap().value, 300);
    }

    #[test]
    fn history_carries_full_audit_metadata() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        let country = sym(&env, "NG");
        let category = sym(&env, "Food");
        env.mock_all_auths();

        submit_ok(&client, &submitter, &country, &category, 450, 50);

        let record = client.get_history(&country, &category).get(0).unwrap();
        assert_eq!(record.submitter, submitter);
        assert_eq!(record.country_iso, country);
        assert_eq!(record.category, category);
        assert_eq!(record.value, 450);
        assert_eq!(record.timestamp, 50);
        assert_eq!(record.valid_from, 50);
        assert_eq!(record.valid_until, 50 + DEFAULT_VALIDITY_WINDOW_SECS);
        assert_eq!(record.status, SubmissionStatus::Pending);
    }

    #[test]
    fn history_range_filters_inclusively() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        let country = sym(&env, "NG");
        let category = sym(&env, "Food");
        env.mock_all_auths();

        for ts in [10_u64, 20, 30, 40, 50] {
            submit_ok(&client, &submitter, &country, &category, ts as i128 * 10, ts);
        }

        let range = client.get_history_range(&country, &category, &20, &40).unwrap();
        assert_eq!(range.len(), 3);
        assert_eq!(range.get(0).unwrap().timestamp, 20);
        assert_eq!(range.get(1).unwrap().timestamp, 30);
        assert_eq!(range.get(2).unwrap().timestamp, 40);

        // Both bounds inclusive.
        let single = client.get_history_range(&country, &category, &10, &10).unwrap();
        assert_eq!(single.len(), 1);
        assert_eq!(single.get(0).unwrap().timestamp, 10);

        // A window with nothing in it.
        let empty = client.get_history_range(&country, &category, &60, &70).unwrap();
        assert_eq!(empty.len(), 0);
    }

    // ── submit ──────────────────────────────────────────────────────────

    #[test]
    fn submit_stores_window_bounds_and_pending_status() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        let country = sym(&env, "NG");
        let category = sym(&env, "Food");

        env.mock_all_auths();
        submit_ok(&client, &submitter, &country, &category, 1_000, 1_000);

        let s = client.get(&country, &category, &1_000).unwrap();
        assert_eq!(s.valid_from, 1_000);
        assert_eq!(s.valid_until, 1_000 + DEFAULT_VALIDITY_WINDOW_SECS);
        assert_eq!(s.timestamp, 1_000);
        assert_eq!(s.value, 1_000);
        assert_eq!(s.submitter, submitter);
        assert_eq!(s.status, SubmissionStatus::Pending);
    }

    #[test]
    fn submit_rejects_unknown_identifiers() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        env.mock_all_auths();

        assert_eq!(
            client
                .try_submit(
                    &submitter,
                    &sym(&env, "ZZ"),
                    &sym(&env, "Food"),
                    &100,
                    &1_000_u64,
                    &DEFAULT_VALIDITY_WINDOW_SECS,
                )
                .unwrap_err()
                .unwrap(),
            Error::InvalidCountry
        );
        assert_eq!(
            client
                .try_submit(
                    &submitter,
                    &sym(&env, "NG"),
                    &sym(&env, "Weapons"),
                    &100,
                    &1_000_u64,
                    &DEFAULT_VALIDITY_WINDOW_SECS,
                )
                .unwrap_err()
                .unwrap(),
            Error::InvalidCategory
        );
    }

    #[test]
    fn submit_rejects_bad_values_before_auth() {
    fn history_range_rejects_an_inverted_range() {
        let env = make_env();
        let client = deploy(&env);
        assert_eq!(
            client
                .try_get_history_range(&sym(&env, "NG"), &sym(&env, "Food"), &100, &50)
                .unwrap_err()
                .unwrap(),
            Error::InvalidRange
        );
    }

    #[test]
    fn latest_is_the_most_recently_inserted_record() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        let country = sym(&env, "NG");
        let category = sym(&env, "Food");
        env.mock_all_auths();

        // Inserted out of timestamp order; the index is insertion-ordered, so
        // "latest" is the last inserted, not the highest timestamp.
        submit_ok(&client, &submitter, &country, &category, 100, 10);
        submit_ok(&client, &submitter, &country, &category, 200, 30);
        submit_ok(&client, &submitter, &country, &category, 150, 20);

        let latest = client.get_latest(&country, &category).unwrap();
        assert_eq!(latest.timestamp, 20);
        assert_eq!(latest.value, 150);
    }

    #[test]
    fn history_is_deterministic_for_the_same_state() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        let country = sym(&env, "NG");
        let category = sym(&env, "Food");
        env.mock_all_auths();

        // Zero price.
        assert_eq!(
            client
                .try_submit(
                    &submitter,
                    &country,
                    &category,
                    &0,
                    &1_000_u64,
                    &DEFAULT_VALIDITY_WINDOW_SECS,
                )
                .unwrap_err()
                .unwrap(),
            Error::ZeroNotAllowed
        );
        // Negative price.
        assert_eq!(
            client
                .try_submit(
                    &submitter,
                    &country,
                    &category,
                    &-1,
                    &1_000_u64,
                    &DEFAULT_VALIDITY_WINDOW_SECS,
                )
                .unwrap_err()
                .unwrap(),
            Error::NegativeNotAllowed
        );
        // Zero timestamp.
        assert_eq!(
            client
                .try_submit(
                    &submitter,
                    &country,
                    &category,
                    &100,
                    &0_u64,
                    &DEFAULT_VALIDITY_WINDOW_SECS,
                )
                .unwrap_err()
                .unwrap(),
            Error::ZeroNotAllowed
        );
        // Above the schema ceiling.
        assert_eq!(
            client
                .try_submit(
                    &submitter,
                    &country,
                    &category,
                    &(MAX_PRICE + 1),
                    &1_000_u64,
                    &DEFAULT_VALIDITY_WINDOW_SECS,
                )
                .unwrap_err()
                .unwrap(),
            Error::ValueAboveMaximum
        );
    }

    #[test]
    fn submit_rejects_bad_windows() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        let country = sym(&env, "NG");
        let category = sym(&env, "Food");
        env.mock_all_auths();

        // Zero window.
        assert_eq!(
            client
                .try_submit(&submitter, &country, &category, &100, &1_000_u64, &0_u64)
                .unwrap_err()
                .unwrap(),
            Error::InvalidWindow
        );
        // valid_from + window overflows u64.
        assert_eq!(
            client
                .try_submit(&submitter, &country, &category, &100, &u64::MAX, &1_u64)
                .unwrap_err()
                .unwrap(),
            Error::InvalidWindow
        );
    }

    #[test]
    fn resubmitting_the_same_key_is_a_no_op() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        let country = sym(&env, "NG");
        let category = sym(&env, "Food");
        env.mock_all_auths();

        submit_ok(&client, &submitter, &country, &category, 100, 10);
        submit_ok(&client, &submitter, &country, &category, 999, 10);

        let history = client.get_history(&country, &category);
        assert_eq!(history.len(), 1);
        assert_eq!(history.get(0).unwrap().value, 100);
    }

    // ── validity window ─────────────────────────────────────────────────

    #[test]
    fn validity_window_bounds_are_half_open() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        let country = sym(&env, "NG");
        let category = sym(&env, "Food");
        env.mock_all_auths();

        submit_ok(&client, &submitter, &country, &category, 100, 1_000);

        // Lower bound inclusive.
        assert!(client.is_valid_at(&country, &category, &1_000, &1_000));
        // Interior.
        assert!(client.is_valid_at(
            &country,
            &category,
            &1_000,
            &1_000 + DEFAULT_VALIDITY_WINDOW_SECS - 1
        ));
        // Upper bound exclusive.
        assert!(!client.is_valid_at(
            &country,
            &category,
            &1_000,
            &1_000 + DEFAULT_VALIDITY_WINDOW_SECS
        ));
        // Before the window.
        assert!(!client.is_valid_at(&country, &category, &1_000, &999));
    }

    #[test]
    fn consecutive_windows_do_not_overlap() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        let country = sym(&env, "NG");
        let category = sym(&env, "Food");
        env.mock_all_auths();

        // Window 1 = [1_000, 2_000), window 2 = [2_000, 3_000).
        client
            .submit(&submitter, &country, &category, &100, &1_000_u64, &1_000_u64)
            .unwrap();
        client
            .submit(&submitter, &country, &category, &200, &2_000_u64, &1_000_u64)
            .unwrap();

        // At 2_000 only window 2 is fresh.
        assert!(!client.is_valid_at(&country, &category, &1_000, &2_000));
        assert!(client.is_valid_at(&country, &category, &2_000, &2_000));
    }

    #[test]
    fn get_valid_gates_on_freshness() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        let country = sym(&env, "KE");
        let category = sym(&env, "Rent");
        env.mock_all_auths();

        submit_ok(&client, &submitter, &country, &category, 500, 2_000);

        assert!(client
            .get_valid(&country, &category, &2_000, &2_000)
            .is_some());
        assert!(client
            .get_valid(&country, &category, &2_000, &1_999)
            .is_none());
        assert!(client
            .get_valid(&country, &category, &2_000, &100_000)
            .is_none());
        // Missing record.
        assert!(client.get_valid(&country, &category, &9_999, &1).is_none());
    }

    #[test]
    fn is_valid_at_is_false_for_missing_records() {
        let env = make_env();
        let client = deploy(&env);
        assert!(!client.is_valid_at(&sym(&env, "NG"), &sym(&env, "Food"), &1, &1));
    }

    // ── status machine ──────────────────────────────────────────────────

    #[test]
    fn transition_table_allows_only_pending_to_a_terminal_state() {
        // Pending may reach either terminal state.
        assert!(SubmissionStatus::Pending.can_transition_to(SubmissionStatus::Verified));
        assert!(SubmissionStatus::Pending.can_transition_to(SubmissionStatus::Rejected));
        // Pending is never a target.
        assert!(!SubmissionStatus::Pending.can_transition_to(SubmissionStatus::Pending));
        // Terminal states are absorbing.
        assert!(!SubmissionStatus::Verified.can_transition_to(SubmissionStatus::Rejected));
        assert!(!SubmissionStatus::Verified.can_transition_to(SubmissionStatus::Pending));
        assert!(!SubmissionStatus::Rejected.can_transition_to(SubmissionStatus::Verified));
        assert!(!SubmissionStatus::Rejected.can_transition_to(SubmissionStatus::Pending));

        assert!(!SubmissionStatus::Pending.is_terminal());
        assert!(SubmissionStatus::Verified.is_terminal());
        assert!(SubmissionStatus::Rejected.is_terminal());
    }

    #[test]
    fn status_discriminants_are_stable() {
        // Pinned so external consumers can match on the u32 representation.
        assert_eq!(SubmissionStatus::Pending as u32, 0);
        assert_eq!(SubmissionStatus::Verified as u32, 1);
        assert_eq!(SubmissionStatus::Rejected as u32, 2);
    }

    #[test]
    fn pending_transitions_to_verified_and_rejected() {
        for target in [SubmissionStatus::Verified, SubmissionStatus::Rejected] {
            let env = make_env();
            let client = deploy(&env);
            let submitter = Address::generate(&env);
            let verifier = Address::generate(&env);
            let country = sym(&env, "NG");
            let category = sym(&env, "Food");
            env.mock_all_auths();

            submit_ok(&client, &submitter, &country, &category, 1_000, 100);
            client
                .set_status(&verifier, &country, &category, &100, &target)
                .unwrap();
            assert_eq!(client.get_status(&country, &category, &100), Some(target));
        }
    }

    #[test]
    fn terminal_states_reject_further_transitions() {
        for terminal in [SubmissionStatus::Verified, SubmissionStatus::Rejected] {
            for next in [
                SubmissionStatus::Verified,
                SubmissionStatus::Rejected,
                SubmissionStatus::Pending,
            ] {
                let env = make_env();
                let client = deploy(&env);
                let submitter = Address::generate(&env);
                let verifier = Address::generate(&env);
                let country = sym(&env, "NG");
                let category = sym(&env, "Food");
                env.mock_all_auths();

                submit_ok(&client, &submitter, &country, &category, 1_000, 100);
                client
                    .set_status(&verifier, &country, &category, &100, &terminal)
                    .unwrap();

                assert_eq!(
                    client
                        .try_set_status(&verifier, &country, &category, &100, &next)
                        .unwrap_err()
                        .unwrap(),
                    Error::InvalidTransition,
                    "{terminal:?} -> {next:?} must be refused"
                );
                // The record is unchanged.
                assert_eq!(
                    client.get_status(&country, &category, &100),
                    Some(terminal)
                );
            }
        }
    }

    #[test]
    fn pending_is_not_a_valid_target() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        let verifier = Address::generate(&env);
        let country = sym(&env, "NG");
        let category = sym(&env, "Food");
        env.mock_all_auths();

        submit_ok(&client, &submitter, &country, &category, 1_000, 100);
        assert_eq!(
            client
                .try_set_status(
                    &verifier,
                    &country,
                    &category,
                    &100,
                    &SubmissionStatus::Pending,
                )
                .unwrap_err()
                .unwrap(),
            Error::InvalidTransition
        );
    }

    #[test]
    fn set_status_on_missing_record_is_not_found() {
        let env = make_env();
        let client = deploy(&env);
        let verifier = Address::generate(&env);
        env.mock_all_auths();

        assert_eq!(
            client
                .try_set_status(
                    &verifier,
                    &sym(&env, "NG"),
                    &sym(&env, "Food"),
                    &999,
                    &SubmissionStatus::Verified,
                )
                .unwrap_err()
                .unwrap(),
            Error::NotFound
        );
    }

    #[test]
    fn status_round_trips_inside_the_record() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        let verifier = Address::generate(&env);
        let country = sym(&env, "IN");
        let category = sym(&env, "Health");
        env.mock_all_auths();

        submit_ok(&client, &submitter, &country, &category, 300, 75);
        assert_eq!(
            client.get(&country, &category, &75).unwrap().status,
            SubmissionStatus::Pending
        );

        client
            .set_status(
                &verifier,
                &country,
                &category,
                &75,
                &SubmissionStatus::Rejected,
            )
            .unwrap();

        let after = client.get(&country, &category, &75).unwrap();
        assert_eq!(after.status, SubmissionStatus::Rejected);
        // Other fields are untouched by a status change.
        assert_eq!(after.value, 300);
        assert_eq!(after.submitter, submitter);
    }

    // ── history ─────────────────────────────────────────────────────────

    #[test]
    fn history_is_empty_when_there_are_no_submissions() {
        let env = make_env();
        let client = deploy(&env);
        assert_eq!(client.get_history(&sym(&env, "NG"), &sym(&env, "Food")).len(), 0);
        assert!(client.get_latest(&sym(&env, "NG"), &sym(&env, "Food")).is_none());
    }

    #[test]
    fn history_returns_submissions_in_insertion_order() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        let country = sym(&env, "NG");
        let category = sym(&env, "Food");
        env.mock_all_auths();

        submit_ok(&client, &submitter, &country, &category, 100, 10);
        submit_ok(&client, &submitter, &country, &category, 200, 20);
        submit_ok(&client, &submitter, &country, &category, 300, 30);

        let history = client.get_history(&country, &category);
        assert_eq!(history.len(), 3);
        assert_eq!(history.get(0).unwrap().timestamp, 10);
        assert_eq!(history.get(1).unwrap().timestamp, 20);
        assert_eq!(history.get(2).unwrap().timestamp, 30);
    }

    #[test]
    fn history_is_scoped_per_country_and_category() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        env.mock_all_auths();

        submit_ok(&client, &submitter, &sym(&env, "NG"), &sym(&env, "Food"), 100, 10);
        submit_ok(&client, &submitter, &sym(&env, "KE"), &sym(&env, "Food"), 200, 20);
        submit_ok(&client, &submitter, &sym(&env, "NG"), &sym(&env, "Rent"), 300, 30);

        let ng_food = client.get_history(&sym(&env, "NG"), &sym(&env, "Food"));
        assert_eq!(ng_food.len(), 1);
        assert_eq!(ng_food.get(0).unwrap().value, 100);

        let ke_food = client.get_history(&sym(&env, "KE"), &sym(&env, "Food"));
        assert_eq!(ke_food.len(), 1);
        assert_eq!(ke_food.get(0).unwrap().value, 200);

        let ng_rent = client.get_history(&sym(&env, "NG"), &sym(&env, "Rent"));
        assert_eq!(ng_rent.len(), 1);
        assert_eq!(ng_rent.get(0).unwrap().value, 300);
    }

    #[test]
    fn history_carries_full_audit_metadata() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        let country = sym(&env, "NG");
        let category = sym(&env, "Food");
        env.mock_all_auths();

        submit_ok(&client, &submitter, &country, &category, 450, 50);

        let record = client.get_history(&country, &category).get(0).unwrap();
        assert_eq!(record.submitter, submitter);
        assert_eq!(record.country_iso, country);
        assert_eq!(record.category, category);
        assert_eq!(record.value, 450);
        assert_eq!(record.timestamp, 50);
        assert_eq!(record.valid_from, 50);
        assert_eq!(record.valid_until, 50 + DEFAULT_VALIDITY_WINDOW_SECS);
        assert_eq!(record.status, SubmissionStatus::Pending);
    }

    #[test]
    fn history_range_filters_inclusively() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        let country = sym(&env, "NG");
        let category = sym(&env, "Food");
        env.mock_all_auths();

        for ts in [10_u64, 20, 30, 40, 50] {
            submit_ok(&client, &submitter, &country, &category, ts as i128 * 10, ts);
        }

        let range = client.get_history_range(&country, &category, &20, &40).unwrap();
        assert_eq!(range.len(), 3);
        assert_eq!(range.get(0).unwrap().timestamp, 20);
        assert_eq!(range.get(1).unwrap().timestamp, 30);
        assert_eq!(range.get(2).unwrap().timestamp, 40);

        // Both bounds inclusive.
        let single = client.get_history_range(&country, &category, &10, &10).unwrap();
        assert_eq!(single.len(), 1);
        assert_eq!(single.get(0).unwrap().timestamp, 10);

        // A window with nothing in it.
        let empty = client.get_history_range(&country, &category, &60, &70).unwrap();
        assert_eq!(empty.len(), 0);
    }

    #[test]
    fn history_range_rejects_an_inverted_range() {
        let env = make_env();
        let client = deploy(&env);
        assert_eq!(
            client
                .try_get_history_range(&sym(&env, "NG"), &sym(&env, "Food"), &100, &50)
                .unwrap_err()
                .unwrap(),
            Error::InvalidRange
        );
    }

    #[test]
    fn latest_is_the_most_recently_inserted_record() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        let country = sym(&env, "NG");
        let category = sym(&env, "Food");
        env.mock_all_auths();

        // Inserted out of timestamp order; the index is insertion-ordered, so
        // "latest" is the last inserted, not the highest timestamp.
        submit_ok(&client, &submitter, &country, &category, 100, 10);
        submit_ok(&client, &submitter, &country, &category, 200, 30);
        submit_ok(&client, &submitter, &country, &category, 150, 20);

        let latest = client.get_latest(&country, &category).unwrap();
        assert_eq!(latest.timestamp, 20);
        assert_eq!(latest.value, 150);
    }

    #[test]
    fn history_is_deterministic_for_the_same_state() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        let country = sym(&env, "NG");
        let category = sym(&env, "Food");
        env.mock_all_auths();

        submit_ok(&client, &submitter, &country, &category, 1, 1);
        submit_ok(&client, &submitter, &country, &category, 2, 2);

        let first = client.get_history(&country, &category);
        let second = client.get_history(&country, &category);
        assert_eq!(first.len(), second.len());
        for i in 0..first.len() {
            assert_eq!(
                first.get(i).unwrap().timestamp,
                second.get(i).unwrap().timestamp
            );
        }
    }

    // ── pure helpers ────────────────────────────────────────────────────

    // -- Access control (CT-53, CT-54, CT-55) ---------------------------

    /// Deploy with an admin configured.
    fn deploy_with_admin(env: &Env) -> (PriceVaultClient, Address, Address) {
        let client = deploy(env);
        let admin = Address::generate(env);
        let submitter = Address::generate(env);
        client.initialize(&admin);
        (client, admin, submitter)
    }

    #[test]
    fn initialize_is_once_only_and_records_the_admin() {
        let env = make_env();
        let client = deploy(&env);
        let admin = Address::generate(&env);
        env.mock_all_auths();

        assert_eq!(client.admin(), None);
        client.initialize(&admin);
        assert_eq!(client.admin(), Some(admin.clone()));
        assert_eq!(
            client.try_initialize(&admin).unwrap_err().unwrap(),
            Error::AlreadyInitialized
        );
    }

    #[test]
    fn admin_can_be_handed_over() {
        let env = make_env();
        let (client, admin, _submitter) = deploy_with_admin(&env);
        let successor = Address::generate(&env);
        env.mock_all_auths();

        client.set_admin(&admin, &successor);
        assert_eq!(client.admin(), Some(successor));
    }

    #[test]
    fn a_non_admin_cannot_change_configuration() {
        let env = make_env();
        let (client, _admin, _submitter) = deploy_with_admin(&env);
        let interloper = Address::generate(&env);
        env.mock_all_auths();

        assert_eq!(
            client
                .try_set_country_allowlist(&interloper, &vec![&env, sym(&env, "NG")])
                .unwrap_err()
                .unwrap(),
            Error::Unauthorized
        );
        assert_eq!(
            client
                .try_set_category_allowlist(&interloper, &vec![&env, sym(&env, "Food")])
                .unwrap_err()
                .unwrap(),
            Error::Unauthorized
        );
        assert_eq!(
            client
                .try_set_authorizations(&interloper, &vec![&env])
                .unwrap_err()
                .unwrap(),
            Error::Unauthorized
        );
    }

    #[test]
    fn allowlists_cannot_widen_the_registry() {
        let env = make_env();
        let (client, admin, _submitter) = deploy_with_admin(&env);
        env.mock_all_auths();

        // "ZZ" is not a registry country and "Weapons" is not a registry
        // category, so neither can be allowlisted even though the allowlist is
        // nominally the wider set.
        assert_eq!(
            client
                .try_set_country_allowlist(&admin, &vec![&env, sym(&env, "ZZ")])
                .unwrap_err()
                .unwrap(),
            Error::InvalidCountry
        );
        assert_eq!(
            client
                .try_set_category_allowlist(&admin, &vec![&env, sym(&env, "Weapons")])
                .unwrap_err()
                .unwrap(),
            Error::InvalidCategory
        );
        assert_eq!(
            client
                .try_set_authorizations(
                    &admin,
                    &vec![
                        &env,
                        Authorization {
                            submitter: Address::generate(&env),
                            categories: vec![&env, sym(&env, "Weapons")],
                        },
                    ],
                )
                .unwrap_err()
                .unwrap(),
            Error::InvalidCategory
        );
    }

    #[test]
    fn country_allowlist_narrows_submissions() {
        let env = make_env();
        let (client, admin, submitter) = deploy_with_admin(&env);
        let food = sym(&env, "Food");
        env.mock_all_auths();

        client.set_country_allowlist(&admin, &vec![&env, sym(&env, "NG")]);
        assert_eq!(client.get_country_allowlist().len(), 1);

        // In the allowlist: accepted.
        submit_ok(&client, &submitter, &sym(&env, "NG"), &food, 100, 10);
        // Not in the allowlist: refused before auth and before storage.
        assert_eq!(
            client
                .try_submit(
                    &submitter,
                    &sym(&env, "KE"),
                    &food,
                    &100,
                    &10_u64,
                    &DEFAULT_VALIDITY_WINDOW_SECS,
                )
                .unwrap_err()
                .unwrap(),
            Error::CountryNotAllowed
        );
        assert!(client.get(&sym(&env, "KE"), &food, &10).is_none());
    }

    #[test]
    fn category_allowlist_narrows_submissions() {
        let env = make_env();
        let (client, admin, submitter) = deploy_with_admin(&env);
        env.mock_all_auths();

        client.set_category_allowlist(&admin, &vec![&env, sym(&env, "Food")]);
        assert_eq!(client.get_category_allowlist().len(), 1);

        submit_ok(&client, &submitter, &sym(&env, "NG"), &sym(&env, "Food"), 100, 10);
        assert_eq!(
            client
                .try_submit(
                    &submitter,
                    &sym(&env, "NG"),
                    &sym(&env, "Rent"),
                    &100,
                    &10_u64,
                    &DEFAULT_VALIDITY_WINDOW_SECS,
                )
                .unwrap_err()
                .unwrap(),
            Error::CategoryNotAllowed
        );
        assert!(client.get(&sym(&env, "NG"), &sym(&env, "Rent"), &10).is_none());
    }

    #[test]
    fn an_empty_allowlist_imposes_no_restriction() {
        let env = make_env();
        let (client, admin, submitter) = deploy_with_admin(&env);
        env.mock_all_auths();

        client.set_country_allowlist(&admin, &vec![&env, sym(&env, "NG")]);
        client.set_category_allowlist(&admin, &vec![&env, sym(&env, "Food")]);

        // Clearing both restores registry-only behaviour.
        client.set_country_allowlist(&admin, &vec![&env]);
        client.set_category_allowlist(&admin, &vec![&env]);

        submit_ok(&client, &submitter, &sym(&env, "KE"), &sym(&env, "Rent"), 100, 10);
        assert!(client.get(&sym(&env, "KE"), &sym(&env, "Rent"), &10).is_some());
    }

    #[test]
    fn a_submitter_may_be_confined_to_specific_categories() {
        let env = make_env();
        let (client, admin, baker) = deploy_with_admin(&env);
        let stranger = Address::generate(&env);
        env.mock_all_auths();

        // The baker may write Food and Rent only.
        client.set_authorizations(
            &admin,
            &vec![
                &env,
                Authorization {
                    submitter: baker.clone(),
                    categories: vec![&env, sym(&env, "Food"), sym(&env, "Rent")],
                },
            ],
        );
        assert_eq!(client.get_authorizations().len(), 1);

        submit_ok(&client, &baker, &sym(&env, "NG"), &sym(&env, "Food"), 100, 10);
        // Allowed category, refused category.
        assert_eq!(
            client
                .try_submit(
                    &baker,
                    &sym(&env, "NG"),
                    &sym(&env, "Utilities"),
                    &100,
                    &10_u64,
                    &DEFAULT_VALIDITY_WINDOW_SECS,
                )
                .unwrap_err()
                .unwrap(),
            Error::SubmitterNotAllowed
        );
        // A submitter with no entry at all is refused under a non-empty policy.
        assert_eq!(
            client
                .try_submit(
                    &stranger,
                    &sym(&env, "NG"),
                    &sym(&env, "Food"),
                    &100,
                    &10_u64,
                    &DEFAULT_VALIDITY_WINDOW_SECS,
                )
                .unwrap_err()
                .unwrap(),
            Error::SubmitterNotAllowed
        );
        assert!(client.is_submitter_authorized(&baker, &sym(&env, "Rent")));
        assert!(!client.is_submitter_authorized(&baker, &sym(&env, "Utilities")));
    }

    #[test]
    fn an_authorization_with_no_categories_grants_every_category() {
        let env = make_env();
        let (client, admin, submitter) = deploy_with_admin(&env);
        env.mock_all_auths();

        client.set_authorizations(
            &admin,
            &vec![
                &env,
                Authorization {
                    submitter: submitter.clone(),
                    categories: Vec::new(&env),
                },
            ],
        );

        submit_ok(&client, &submitter, &sym(&env, "NG"), &sym(&env, "Health"), 100, 10);
        assert!(client.is_submitter_authorized(&submitter, &sym(&env, "Health")));
    }

    #[test]
    fn an_unconfigured_contract_accepts_any_registry_submission() {
        // No initialize: the allowlists are empty and impose nothing, so
        // pre-existing behaviour is unchanged.
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        env.mock_all_auths();

        assert_eq!(client.admin(), None);
        submit_ok(&client, &submitter, &sym(&env, "NG"), &sym(&env, "Food"), 100, 10);
        assert!(client.get(&sym(&env, "NG"), &sym(&env, "Food"), &10).is_some());
        assert!(client.is_country_allowed(&sym(&env, "KE")));
        assert!(client.is_category_allowed(&sym(&env, "Rent")));
        assert!(client.is_submitter_authorized(&submitter, &sym(&env, "Food")));
    }

    // -- Transition table view (CT-56) -----------------------------------

    #[test]
    fn the_public_transition_view_matches_the_enforced_table() {
        let env = make_env();
        let client = deploy(&env);
        let statuses = [
            SubmissionStatus::Pending,
            SubmissionStatus::Verified,
            SubmissionStatus::Rejected,
        ];

        for from in statuses.iter() {
            for to in statuses.iter() {
                // The view and the mutator's table must never disagree.
                assert_eq!(
                    client.can_transition(from, to),
                    from.can_transition_to(to),
                    "{from:?} -> {to:?}"
                );
            }
        }

        assert!(client.can_transition(&SubmissionStatus::Pending, &SubmissionStatus::Verified));
        assert!(client.can_transition(&SubmissionStatus::Pending, &SubmissionStatus::Rejected));
        assert!(!client.can_transition(&SubmissionStatus::Pending, &SubmissionStatus::Pending));
        assert!(!client.can_transition(&SubmissionStatus::Verified, &SubmissionStatus::Pending));
        assert!(!client.can_transition(&SubmissionStatus::Verified, &SubmissionStatus::Rejected));
        assert!(!client.can_transition(&SubmissionStatus::Rejected, &SubmissionStatus::Verified));
    }

    #[test]
    fn the_transition_view_predicts_what_set_status_will_do() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        let verifier = Address::generate(&env);
        let country = sym(&env, "NG");
        let category = sym(&env, "Food");
        env.mock_all_auths();

        submit_ok(&client, &submitter, &country, &category, 1_000, 100);

        // Pending -> Verified is advertised as allowed, and is allowed.
        assert!(client.can_transition(&SubmissionStatus::Pending, &SubmissionStatus::Verified));
        client
            .set_status(&verifier, &country, &category, &100, &SubmissionStatus::Verified)
            .unwrap();

        // Every transition out of the terminal state is advertised refused,
        // and is refused with the stable InvalidTransition code.
        for next in [
            SubmissionStatus::Pending,
            SubmissionStatus::Verified,
            SubmissionStatus::Rejected,
        ] {
            assert!(!client.can_transition(&SubmissionStatus::Verified, &next));
            assert_eq!(
                client
                    .try_set_status(&verifier, &country, &category, &100, &next)
                    .unwrap_err()
                    .unwrap(),
                Error::InvalidTransition
            );
        }
    }

    #[test]
    fn safe_arithmetic_entry_points() {
        let env = make_env();
        let client = deploy(&env);
        assert_eq!(client.safe_add(&10, &20), Ok(30));
        assert_eq!(client.safe_mul(&6, &7), Ok(42));
        assert_eq!(
            client.try_safe_add(&i128::MAX, &1).unwrap_err().unwrap(),
            Error::ArithmeticOverflow
        );
        assert_eq!(
            client.try_safe_mul(&i128::MAX, &2).unwrap_err().unwrap(),
            Error::ArithmeticOverflowMul
        );
    }

    #[test]
    fn validate_submit_payload_commits_no_state() {
        let env = make_env();
        let client = deploy(&env);

        assert!(client
            .validate_submit_payload(&sym(&env, "KE"), &sym(&env, "Rent"), &500, &50)
            .is_ok());
        assert_eq!(
            client
                .try_validate_submit_payload(&sym(&env, "KE"), &sym(&env, "Rent"), &-1, &50)
                .unwrap_err()
                .unwrap(),
            Error::NegativeNotAllowed
        );
        // Nothing was written.
        assert!(client.get(&sym(&env, "KE"), &sym(&env, "Rent"), &50).is_none());
    }

    // ── constants ───────────────────────────────────────────────────────

    #[test]
    fn documented_constants_hold() {
        assert_eq!(DEFAULT_VALIDITY_WINDOW_SECS, 86_400);
        assert_eq!(SCHEMA_VERSION, 1);
        assert_eq!(registry::VERSION, 1);
    }
        submit_ok(&client, &submitter, &country, &category, 1, 1);
        submit_ok(&client, &submitter, &country, &category, 2, 2);

        let first = client.get_history(&country, &category);
        let second = client.get_history(&country, &category);
        assert_eq!(first.len(), second.len());
        for i in 0..first.len() {
            assert_eq!(
                first.get(i).unwrap().timestamp,
                second.get(i).unwrap().timestamp
            );
        }
    }

    // â”€â”€ bounded submitter history (#885) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    /// Submit `count` records for one submitter, spreading them over countries
    /// so the submitter index is genuinely cross-group.
    fn seed_submitter(env: &Env, client: &PriceVaultClient, submitter: &Address, count: u32) {
        let countries = ["NG", "KE", "BR"];
        for i in 0..count {
            client
                .submit(
                    submitter,
                    &Symbol::new(env, countries[(i % 3) as usize]),
                    &Symbol::new(env, "Food"),
                    &((i as i128) + 1),
                    &((i as u64) * 10 + 10),
                    &DEFAULT_VALIDITY_WINDOW_SECS,
                )
                .unwrap();
        }
    }

    #[test]
    fn submitter_history_pages_through_every_record_exactly_once() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        let other = Address::generate(&env);
        env.mock_all_auths();

        seed_submitter(&env, &client, &submitter, 7);
        // A second submitter must not appear in the first one's history.
        seed_submitter(&env, &client, &other, 2);

        let mut seen: Vec<u64> = Vec::new();
        let mut cursor: u32 = 0;
        loop {
            let page = client.get_submitter_history(&submitter, &cursor, &3).unwrap();
            for record in page.submissions.iter() {
                seen.push_back(record.timestamp);
            }
            assert!(page.submissions.len() <= 3);
            if !page.has_more {
                // An exhausted cursor terminates the walk.
                assert_eq!(page.next_cursor, 7);
                break;
            }
            cursor = page.next_cursor;
        }

        assert_eq!(seen.len(), 7);
        // Append-only ordering, and no duplicates from the paging.
        let mut expected: Vec<u64> = Vec::new();
        for i in 0..7u64 {
            expected.push_back(i * 10 + 10);
        }
        assert_eq!(seen, expected);
    }

    #[test]
    fn submitter_history_rejects_an_out_of_range_page_size() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        env.mock_all_auths();

        assert_eq!(
            client
                .try_get_submitter_history(&submitter, &0, &0)
                .unwrap_err()
                .unwrap(),
            Error::InvalidPageSize
        );
        assert_eq!(
            client
                .try_get_submitter_history(&submitter, &0, &(MAX_HISTORY_PAGE_SIZE + 1))
                .unwrap_err()
                .unwrap(),
            Error::InvalidPageSize
        );
    }

    #[test]
    fn submitter_history_cursor_is_stable_when_new_records_land() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        env.mock_all_auths();

        seed_submitter(&env, &client, &submitter, 4);

        // Read the first page, then let more records land mid-pagination.
        let first = client.get_submitter_history(&submitter, &0, &2).unwrap();
        assert_eq!(first.submissions.len(), 2);
        assert!(first.has_more);

        seed_submitter(&env, &client, &submitter, 2);

        // Resuming from the cursor we were handed still reads forward, and the
        // records we already saw are not repeated.
        let second = client
            .get_submitter_history(&submitter, &first.next_cursor, &10)
            .unwrap();
        assert_eq!(second.submissions.len(), 4);
        for record in second.submissions.iter() {
            assert!(record.timestamp > 30);
        }
    }

    #[test]
    fn submitter_history_is_empty_for_an_unknown_submitter() {
        let env = make_env();
        let client = deploy(&env);
        let page = client
            .get_submitter_history(&Address::generate(&env), &0, &10)
            .unwrap();
        assert_eq!(page.submissions.len(), 0);
        assert!(!page.has_more);
        assert_eq!(page.next_cursor, 0);
    }

    // â”€â”€ pure helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    #[test]
    fn safe_arithmetic_entry_points() {
        let env = make_env();
        let client = deploy(&env);
        assert_eq!(client.safe_add(&10, &20), Ok(30));
        assert_eq!(client.safe_mul(&6, &7), Ok(42));
        assert_eq!(
            client.try_safe_add(&i128::MAX, &1).unwrap_err().unwrap(),
            Error::ArithmeticOverflow
        );
        assert_eq!(
            client.try_safe_mul(&i128::MAX, &2).unwrap_err().unwrap(),
            Error::ArithmeticOverflowMul
        );
    }

    #[test]
    fn validate_submit_payload_commits_no_state() {
        let env = make_env();
        let client = deploy(&env);

        assert!(client
            .validate_submit_payload(&sym(&env, "KE"), &sym(&env, "Rent"), &500, &50)
            .is_ok());
        assert_eq!(
            client
                .try_validate_submit_payload(&sym(&env, "KE"), &sym(&env, "Rent"), &-1, &50)
                .unwrap_err()
                .unwrap(),
            Error::NegativeNotAllowed
        );
        // Nothing was written.
        assert!(client.get(&sym(&env, "KE"), &sym(&env, "Rent"), &50).is_none());
    }

    // â”€â”€ constants â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    #[test]
    fn documented_constants_hold() {
        assert_eq!(DEFAULT_VALIDITY_WINDOW_SECS, 86_400);
        assert_eq!(SCHEMA_VERSION, 1);
        assert_eq!(registry::VERSION, 1);
    }
}