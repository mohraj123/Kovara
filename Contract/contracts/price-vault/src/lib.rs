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
//! valid_from ──────────── valid_until
//!     │                      │
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
//! ## Rejected calls are silent
//!
//! Every mutating entry point publishes its event only after its write has
//! landed. A call that returns an error has written nothing and emitted
//! nothing, so an indexer never sees an event for a change that did not
//! happen.
//!
//! ## Error codes are ABI
//!
//! [`Error`] is `#[repr(u32)]` and its discriminants are part of the contract
//! ABI: deployed clients map integer codes back to meanings. They are
//! **append-only**. A new condition gets the next free number; an existing
//! number is never reused or renumbered, even if the condition it described is
//! later removed.

#![no_std]

pub mod tip;

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
/// Discriminants are append-only — see the ABI note in the module docs.
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

    // ── guards ───────────────────────────────────────────────────────────
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

    // ── access control ───────────────────────────────────────────────────
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
    /// Category is disabled by admin policy.
    CategoryDisabled = 27,
    /// Validity window exceeds the configured maximum.
    WindowTooLong = 28,
    /// A submission already exists for this key.
    DuplicateSubmission = 29,
    /// Submitted price exceeds the category-specific maximum (#1080).
    CategoryPriceExceeded = 40,
    /// History cursor version is not supported (#1083).
    UnsupportedCursorVersion = 41,
    /// Tip amount is zero (#1084).
    TipAmountZero = 42,
    /// Tip amount exceeds the configured maximum (#1084).
    TipAmountTooLarge = 43,

    // ── metadata corrections (#1078) ─────────────────────────────────────
    /// A metadata correction would leave the record exactly as it is.
    MetadataUnchanged = 44,
    /// The record is in a terminal state, so its metadata is frozen.
    RecordFinalized = 45,

    // ── status reasons (#1079) ───────────────────────────────────────────
    /// The status-change reason code is unknown, or does not fit the target
    /// status.
    InvalidStatusReason = 46,

    // ── authorization revocation (#1082) ─────────────────────────────────
    /// The submitter has no entry in the authorization policy.
    AuthorizationNotFound = 47,
    /// Revoking this entry would empty the policy, which means "unrestricted".
    LastAuthorization = 48,
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
/// their keys — untouched.
pub mod registry {
    use soroban_sdk::{Env, Symbol, Vec};

    /// Supported ISO 3166-1 alpha-2 country codes.
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
    #[inline]
    pub fn require_positive_u64(value: u64) -> Result<(), Error> {
        if value == 0 {
            return Err(Error::ZeroValue);
        }
        Ok(())
    }

    /// Reject an `i128` amount that is zero or negative.
    #[inline]
    pub fn require_positive_i128(amount: i128) -> Result<(), Error> {
        if amount <= 0 {
            return Err(Error::NonPositiveAmount);
        }
        Ok(())
    }

    /// Checked `u64` addition.
    #[inline]
    pub fn checked_add_u64(a: u64, b: u64) -> Result<u64, Error> {
        a.checked_add(b).ok_or(Error::ArithmeticOverflow)
    }

    /// Checked `i128` addition.
    #[inline]
    pub fn checked_add_i128(a: i128, b: i128) -> Result<i128, Error> {
        a.checked_add(b).ok_or(Error::ArithmeticOverflow)
    }

    /// Checked `i128` multiplication.
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
    /// returns immediately.
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
                    // The empty symbol is always the small-symbol encoding with
                    // an empty body, so comparing raw payloads needs no `Env`.
                    let empty = soroban_sdk::symbol_short!("").to_val().get_payload();
                    if payload.country_iso.to_val().get_payload() == empty
                        || payload.category.to_val().get_payload() == empty
                    {
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

// ── Status-change reason codes (#1079) ───────────────────────────────────────

/// Bounded reason codes attached to a moderation-driven status change.
///
/// Codes are `u32` on the wire so an audit consumer can store them without a
/// schema upgrade, and are validated against this fixed table before auth and
/// before storage. Like [`Error`] discriminants they are ABI: append-only,
/// never renumbered. `0` is reserved for "no reason given" and is only ever
/// produced by the legacy [`PriceVault::set_status`] entry point — a caller
/// cannot pass it explicitly.
pub mod status_reason {
    use super::SubmissionStatus;

    /// No reason supplied (legacy `set_status`). Never accepted as input.
    pub const UNSPECIFIED: u32 = 0;
    /// Verifier quorum approved the observation.
    pub const QUORUM_APPROVED: u32 = 1;
    /// Verifier quorum rejected the observation.
    pub const QUORUM_REJECTED: u32 = 2;
    /// The value is a statistical outlier for its country and category.
    pub const OUTLIER_VALUE: u32 = 3;
    /// The observation duplicates evidence already on record.
    pub const DUPLICATE_EVIDENCE: u32 = 4;
    /// The observation was stale when it was reviewed.
    pub const STALE_OBSERVATION: u32 = 5;
    /// The submitter breached the submission policy.
    pub const SUBMITTER_MISCONDUCT: u32 = 6;
    /// Governance decided the outcome directly.
    pub const GOVERNANCE_OVERRIDE: u32 = 7;

    /// Largest assigned reason code.
    pub const MAX: u32 = GOVERNANCE_OVERRIDE;

    /// Whether `reason` is a known code that can justify moving a record to
    /// `target`.
    ///
    /// An approval reason cannot justify a rejection and vice versa, so an
    /// audit trail can never read "rejected because quorum approved".
    /// `GOVERNANCE_OVERRIDE` fits either terminal state; nothing justifies a
    /// move to `Pending`, which is never a valid target anyway.
    pub fn allows(reason: u32, target: SubmissionStatus) -> bool {
        match (reason, target) {
            (QUORUM_APPROVED, SubmissionStatus::Verified) => true,
            (
                QUORUM_REJECTED
                | OUTLIER_VALUE
                | DUPLICATE_EVIDENCE
                | STALE_OBSERVATION
                | SUBMITTER_MISCONDUCT,
                SubmissionStatus::Rejected,
            ) => true,
            (GOVERNANCE_OVERRIDE, SubmissionStatus::Verified | SubmissionStatus::Rejected) => true,
            _ => false,
        }
    }
}

// ── Access control ───────────────────────────────────────────────────────────

/// The configured admin, if any.
fn load_admin(env: &Env) -> Option<Address> {
    env.storage().instance().get(&DataKey::Admin)
}

/// Reject a caller that is not the configured admin, then require its auth.
///
/// Checking the stored address *before* `require_auth` means an unauthorised
/// caller is refused on one cheap storage read instead of paying for an auth
/// prompt it could never satisfy. An unconfigured vault has no admin, so every
/// admin call is refused — there is no fallback to whoever signs.
fn require_admin(env: &Env, actor: &Address) -> Result<(), Error> {
    match load_admin(env) {
        Some(admin) if admin == *actor => {
            actor.require_auth();
            Ok(())
        }
        _ => Err(Error::Unauthorized),
    }
}

/// Whether `country` passes the configured country allowlist.
///
/// An empty allowlist imposes no restriction: the static [`registry`] has
/// already vetted the identifier.
fn country_allowed(env: &Env, country: &Symbol) -> bool {
    let list: Vec<Symbol> = env
        .storage()
        .instance()
        .get(&DataKey::CountryAllowlist)
        .unwrap_or_else(|| Vec::new(env));
    list.is_empty() || list.iter().any(|entry| &entry == country)
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
    list.is_empty() || list.iter().any(|entry| &entry == category)
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
    for entry in policy.iter() {
        if &entry.submitter == submitter {
            return entry.categories.is_empty()
                || entry.categories.iter().any(|c| &c == category);
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

    /// Whether `self -> next` is a permitted transition.
    ///
    /// Exactly one edge exists: `Pending -> {Verified, Rejected}`. Encoding
    /// this as a function means the table lives in one place, so `set_status`
    /// and any future consumer cannot drift apart.
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
    /// Category enabled/disabled policy.
    CategoryPolicy(Symbol),
    /// Submitter allowed/denied policy.
    SubmitterPolicy(Address),
    /// Allowed countries.
    CountryAllowlist,
    /// Allowed categories.
    CategoryAllowlist,
    /// Category max price override (#1080).
    CategoryMaxPrice(Symbol),
    /// Submitter authorizations.
    Authorizations,
}

// ── Domain types ─────────────────────────────────────────────────────────────

/// A single raw price submission with an attached validity window.
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

/// Current version of [`HistoryCursor`].
pub const HISTORY_CURSOR_VERSION: u32 = 1;

/// Versioned history cursor (#1083 / CT-012).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HistoryCursor {
    pub version: u32,
    pub offset: u32,
}

impl HistoryCursor {
    #[inline]
    pub fn new(offset: u32) -> Self {
        Self {
            version: HISTORY_CURSOR_VERSION,
            offset,
        }
    }

    /// The cursor's offset, or [`Error::UnsupportedCursorVersion`].
    pub fn validate(self) -> Result<u32, Error> {
        if self.version != HISTORY_CURSOR_VERSION {
            return Err(Error::UnsupportedCursorVersion);
        }
        Ok(self.offset)
    }
}

/// A bounded page of submissions.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HistoryPage {
    pub submissions: Vec<PriceSubmission>,
    pub next_cursor: HistoryCursor,
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
/// filters on. The body carries the rest of the metadata so an indexer can
/// build its record from the event alone. A refused submission emits nothing.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceSubmitted {
    #[topic]
    pub country_iso: Symbol,
    #[topic]
    pub category: Symbol,
    pub submitter: Address,
    pub value: i128,
    pub valid_from: u64,
    pub valid_until: u64,
    pub status: SubmissionStatus,
    pub schema_version: u32,
}

/// Emitted after a submission's status changes.
///
/// The record is addressed by `country_iso` (topic), `category` (topic) and
/// `timestamp`; `prior_status` and `new_status` give the transition; `actor`
/// is the address whose `require_auth` authorised it; `reason` is the
/// validated [`status_reason`] code (#1079), or
/// [`status_reason::UNSPECIFIED`] when the change came through the legacy
/// [`PriceVault::set_status`].
///
/// Published only after the record has been written. A refused transition
/// emits nothing.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StatusChanged {
    #[topic]
    pub country_iso: Symbol,
    #[topic]
    pub category: Symbol,
    pub timestamp: u64,
    pub actor: Address,
    pub prior_status: SubmissionStatus,
    pub new_status: SubmissionStatus,
    pub reason: u32,
}

/// Emitted after an admin corrects a submission's metadata (#1078).
///
/// The record is addressed by `country_iso` (topic), `category` (topic) and
/// `timestamp`. Both the prior and the corrected validity bound are carried, so
/// an indexer can update a cached record — and an auditor can see what was
/// overwritten — from the event alone.
///
/// Published only after the corrected record has been written. A refused
/// correction writes nothing and emits nothing.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MetadataCorrected {
    #[topic]
    pub country_iso: Symbol,
    #[topic]
    pub category: Symbol,
    pub timestamp: u64,
    pub actor: Address,
    pub prior_valid_until: u64,
    pub new_valid_until: u64,
}

/// Emitted when an admin revokes one submitter's authorization (#1082).
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuthorizationRevoked {
    #[topic]
    pub submitter: Address,
    pub admin: Address,
    /// Categories the revoked entry granted; empty meant "every category".
    pub categories: Vec<Symbol>,
}

/// Emitted when a country leaves the allowlist (#1081).
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CountryAllowlistRemoved {
    #[topic]
    pub country_iso: Symbol,
    pub admin: Address,
}

/// Emitted when a category leaves the allowlist (#1081).
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CategoryAllowlistRemoved {
    #[topic]
    pub category: Symbol,
    pub admin: Address,
}

/// Emitted when the configured maximum validity window changes.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ValidityWindowPolicyUpdated {
    #[topic]
    pub actor: Address,
    /// The new maximum, or `None` meaning unbounded.
    pub max_validity_window_secs: Option<u64>,
}

/// Emitted when a category is enabled or disabled.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CategoryPolicyUpdated {
    #[topic]
    pub actor: Address,
    #[topic]
    pub category: Symbol,
    pub enabled: bool,
}

/// Emitted when a submitter is allowed or denied.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SubmitterPolicyUpdated {
    #[topic]
    pub actor: Address,
    #[topic]
    pub submitter: Address,
    pub allowed: bool,
}

// ── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct PriceVault;

#[contractimpl]
impl PriceVault {
    // ── Mutating entry points ────────────────────────────────────────────

    /// # Record a raw price submission
    ///
    /// `valid_from` is the observation timestamp (and the storage key
    /// component). `validity_window_secs` is how long the submission stays
    /// fresh.
    ///
    /// Every step before auth is a pure predicate — see the module docs. If a
    /// record already exists for the same `(country_iso, category, valid_from)`
    /// triple the call is refused with [`Error::DuplicateSubmission`].
    ///
    /// # Errors
    /// * [`Error::InvalidCountry`] / [`Error::InvalidCategory`] — not a
    ///   registry identifier.
    /// * [`Error::CountryNotAllowed`] / [`Error::CategoryNotAllowed`] /
    ///   [`Error::SubmitterNotAllowed`] — refused by the allowlists or policy.
    /// * [`Error::CategoryPriceExceeded`] — above the category ceiling.
    /// * [`Error::ZeroNotAllowed`], [`Error::NegativeNotAllowed`],
    ///   [`Error::ValueAboveMaximum`], [`Error::EmptySymbol`],
    ///   [`Error::SchemaMismatch`] — payload schema failures.
    /// * [`Error::InvalidWindow`] — zero window, or `valid_from + window`
    ///   overflows `u64`.
    /// * [`Error::CategoryDisabled`] — the category is disabled by policy.
    /// * [`Error::WindowTooLong`] — the window exceeds the configured maximum.
    /// * [`Error::DuplicateSubmission`] — the key is occupied.
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
        if !registry::is_supported_country(&env, &country_iso) {
            return Err(Error::InvalidCountry);
        }
        if !registry::is_supported_category(&env, &category) {
            return Err(Error::InvalidCategory);
        }

        // Configurable narrowing of the static registry. An empty allowlist or
        // policy imposes no restriction.
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

        // #1080 category-specific ceiling.
        if value > Self::get_category_max_price(env.clone(), category.clone()) {
            return Err(Error::CategoryPriceExceeded);
        }

        // 3. Guards — defence in depth for the price itself.
        guards::require_positive_price(value)?;

        let valid_until = Self::resolve_window(valid_from, validity_window_secs)?;

        // 4. Admin policy. Absent entries mean "no restriction".
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

        // Per-(country, category) index so history queries need no scan.
        let idx_key = DataKey::SubmissionIndex(country_iso.clone(), category.clone());
        let mut index: Vec<u64> = env
            .storage()
            .persistent()
            .get(&idx_key)
            .unwrap_or_else(|| Vec::new(&env));
        index.push_back(valid_from);
        env.storage().persistent().set(&idx_key, &index);

        // Per-submitter index, written in the same transaction.
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
    /// Moves a `Pending` submission to `Verified` or `Rejected`. The emitted
    /// [`StatusChanged`] carries [`status_reason::UNSPECIFIED`]; moderation
    /// flows should prefer [`Self::set_status_with_reason`].
    ///
    /// # Errors
    /// * [`Error::NotFound`] — no submission for the given key.
    /// * [`Error::InvalidTransition`] — `new_status` is `Pending`, or the
    ///   current status is already terminal.
    pub fn set_status(
        env: Env,
        verifier: Address,
        country_iso: Symbol,
        category: Symbol,
        timestamp: u64,
        new_status: SubmissionStatus,
    ) -> Result<(), Error> {
        Self::apply_status(
            &env,
            verifier,
            country_iso,
            category,
            timestamp,
            new_status,
            status_reason::UNSPECIFIED,
        )
    }

    /// # Transition a submission's status, recording why (#1079)
    ///
    /// Identical to [`Self::set_status`] except that a [`status_reason`] code
    /// is validated and published in [`StatusChanged::reason`]. The code is
    /// checked first — before auth and before any storage read — so a bad
    /// code costs nothing and changes nothing. The terminal-state rules are
    /// unchanged: a valid reason never unlocks a refused transition.
    ///
    /// # Errors
    /// * [`Error::InvalidStatusReason`] — `reason` is unknown, is
    ///   [`status_reason::UNSPECIFIED`], or does not fit `new_status`.
    /// * [`Error::NotFound`] — no submission for the given key.
    /// * [`Error::InvalidTransition`] — `new_status` is `Pending`, or the
    ///   current status is already terminal.
    pub fn set_status_with_reason(
        env: Env,
        verifier: Address,
        country_iso: Symbol,
        category: Symbol,
        timestamp: u64,
        new_status: SubmissionStatus,
        reason: u32,
    ) -> Result<(), Error> {
        if new_status != SubmissionStatus::Pending && !status_reason::allows(reason, new_status) {
            return Err(Error::InvalidStatusReason);
        }
        // A `Pending` target falls through to the transition table, so it is
        // refused with the same `InvalidTransition` code as `set_status`.
        Self::apply_status(
            &env,
            verifier,
            country_iso,
            category,
            timestamp,
            new_status,
            reason,
        )
    }

    /// # Correct a submission's validity metadata (#1078)
    ///
    /// Admin-only. Replaces the window length of a `Pending` record, so
    /// `valid_until` becomes `valid_from + validity_window_secs`. The storage
    /// key, value, submitter and status are untouched.
    ///
    /// Terminal records are frozen: a `Verified` or `Rejected` record has
    /// already been judged on its metadata, and changing it afterwards would
    /// silently change what that judgement meant.
    ///
    /// On success a [`MetadataCorrected`] event is published after the write.
    /// Every refusal writes nothing and emits nothing.
    ///
    /// # Errors
    /// * [`Error::Unauthorized`] — `admin` is not the configured admin.
    /// * [`Error::InvalidWindow`] — zero window, or the bound overflows `u64`.
    /// * [`Error::WindowTooLong`] — above the configured maximum window.
    /// * [`Error::NotFound`] — no submission for the given key.
    /// * [`Error::RecordFinalized`] — the record is `Verified` or `Rejected`.
    /// * [`Error::MetadataUnchanged`] — the correction is a no-op.
    pub fn correct_metadata(
        env: Env,
        admin: Address,
        country_iso: Symbol,
        category: Symbol,
        timestamp: u64,
        validity_window_secs: u64,
    ) -> Result<(), Error> {
        require_admin(&env, &admin)?;

        let new_valid_until = Self::resolve_window(timestamp, validity_window_secs)?;
        if let Some(max) = Self::max_validity_window(env.clone()) {
            if validity_window_secs > max {
                return Err(Error::WindowTooLong);
            }
        }

        let key = DataKey::Price(country_iso.clone(), category.clone(), timestamp);
        let mut submission: PriceSubmission = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotFound)?;

        if submission.status.is_terminal() {
            return Err(Error::RecordFinalized);
        }
        if submission.valid_until == new_valid_until {
            return Err(Error::MetadataUnchanged);
        }

        let prior_valid_until = submission.valid_until;
        submission.valid_until = new_valid_until;
        env.storage().persistent().set(&key, &submission);

        MetadataCorrected {
            country_iso,
            category,
            timestamp,
            actor: admin,
            prior_valid_until,
            new_valid_until,
        }
        .publish(&env);

        Ok(())
    }

    // ── Read entry points ────────────────────────────────────────────────

    /// Read a stored submission by its exact composite key, fresh or not.
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
    pub fn get_valid(
        env: Env,
        country_iso: Symbol,
        category: Symbol,
        valid_from: u64,
        query_ts: u64,
    ) -> Option<PriceSubmission> {
        let submission = Self::get(env, country_iso, category, valid_from)?;
        if submission.is_valid_at(query_ts) {
            Some(submission)
        } else {
            None
        }
    }

    /// The exclusive expiry for a submission window.
    ///
    /// # Errors
    /// * [`Error::InvalidWindow`] — zero window, or the sum overflows `u64`.
    pub fn window_bounds(
        _env: Env,
        valid_from: u64,
        validity_window_secs: u64,
    ) -> Result<u64, Error> {
        Self::resolve_window(valid_from, validity_window_secs)
    }

    /// Whether the stored submission is fresh at `query_ts`. Missing → `false`.
    pub fn is_fresh(
        env: Env,
        country_iso: Symbol,
        category: Symbol,
        valid_from: u64,
        query_ts: u64,
    ) -> bool {
        Self::get(env, country_iso, category, valid_from)
            .map(|s| s.is_valid_at(query_ts))
            .unwrap_or(false)
    }

    /// Alias of [`Self::is_fresh`].
    pub fn is_valid_at(
        env: Env,
        country_iso: Symbol,
        category: Symbol,
        valid_from: u64,
        query_ts: u64,
    ) -> bool {
        Self::is_fresh(env, country_iso, category, valid_from, query_ts)
    }

    /// Every submission for `(country_iso, category)` fresh at `query_ts`.
    pub fn get_fresh_history(
        env: Env,
        country_iso: Symbol,
        category: Symbol,
        query_ts: u64,
    ) -> Vec<PriceSubmission> {
        let all = Self::get_history(env.clone(), country_iso, category);
        let mut fresh = Vec::new(&env);
        for submission in all.iter() {
            if submission.is_valid_at(query_ts) {
                fresh.push_back(submission);
            }
        }
        fresh
    }

    /// Just the lifecycle state of a submission, if present.
    pub fn get_status(
        env: Env,
        country_iso: Symbol,
        category: Symbol,
        timestamp: u64,
    ) -> Option<SubmissionStatus> {
        Self::get(env, country_iso, category, timestamp).map(|s| s.status)
    }

    /// All submissions for `(country_iso, category)`, in insertion order.
    pub fn get_history(env: Env, country_iso: Symbol, category: Symbol) -> Vec<PriceSubmission> {
        let timestamps = Self::load_index(&env, &country_iso, &category);
        Self::collect_submissions(&env, &country_iso, &category, &timestamps)
    }

    /// Submissions with `from_ts <= ts <= to_ts`, in insertion order.
    ///
    /// # Errors
    /// * [`Error::InvalidRange`] — `from_ts > to_ts`.
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
        let mut filtered = Vec::new(&env);
        for ts in Self::load_index(&env, &country_iso, &category).iter() {
            if ts >= from_ts && ts <= to_ts {
                filtered.push_back(ts);
            }
        }
        Ok(Self::collect_submissions(
            &env,
            &country_iso,
            &category,
            &filtered,
        ))
    }

    /// One bounded page of a country/category index.
    ///
    /// # Errors
    /// * [`Error::InvalidPageSize`] — `limit` is zero or too large.
    /// * [`Error::UnsupportedCursorVersion`] — unknown cursor version.
    pub fn get_country_history(
        env: Env,
        country_iso: Symbol,
        category: Symbol,
        cursor: HistoryCursor,
        limit: u32,
    ) -> Result<HistoryPage, Error> {
        if limit == 0 || limit > MAX_HISTORY_PAGE_SIZE {
            return Err(Error::InvalidPageSize);
        }
        let cursor = cursor.validate()?;
        let timestamps = Self::load_index(&env, &country_iso, &category);
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
            next_cursor: HistoryCursor::new(end),
            has_more: end < total,
        })
    }

    /// Alias for [`Self::get_country_history`].
    pub fn get_history_page(
        env: Env,
        country_iso: Symbol,
        category: Symbol,
        cursor: HistoryCursor,
        limit: u32,
    ) -> Result<HistoryPage, Error> {
        Self::get_country_history(env, country_iso, category, cursor, limit)
    }

    /// The most recently **inserted** submission, or `None`.
    pub fn get_latest(env: Env, country_iso: Symbol, category: Symbol) -> Option<PriceSubmission> {
        let latest_ts = Self::load_index(&env, &country_iso, &category).last()?;
        Self::get(env, country_iso, category, latest_ts)
    }

    /// # One bounded page of a submitter's records
    ///
    /// `cursor` is an offset into an append-only index, so pagination is
    /// stable while new submissions land. Entries whose record has gone are
    /// skipped rather than failing the page.
    ///
    /// # Errors
    /// * [`Error::InvalidPageSize`] — `limit` is zero or too large.
    /// * [`Error::UnsupportedCursorVersion`] — unknown cursor version.
    pub fn get_submitter_history(
        env: Env,
        submitter: Address,
        cursor: HistoryCursor,
        limit: u32,
    ) -> Result<HistoryPage, Error> {
        if limit == 0 || limit > MAX_HISTORY_PAGE_SIZE {
            return Err(Error::InvalidPageSize);
        }
        let cursor = cursor.validate()?;

        let entries: Vec<SubmitterEntry> = env
            .storage()
            .persistent()
            .get(&DataKey::SubmitterIndex(submitter))
            .unwrap_or_else(|| Vec::new(&env));

        let total = entries.len();
        let start = core::cmp::min(cursor, total);
        let end = core::cmp::min(start.saturating_add(limit), total);

        let mut submissions = Vec::new(&env);
        for i in start..end {
            if let Some(entry) = entries.get(i) {
                if let Some(submission) =
                    Self::get(env.clone(), entry.country_iso, entry.category, entry.timestamp)
                {
                    submissions.push_back(submission);
                }
            }
        }

        Ok(HistoryPage {
            submissions,
            next_cursor: HistoryCursor::new(end),
            has_more: end < total,
        })
    }

    /// Admin-authorised cleanup of stale submitter-index entries, one page.
    ///
    /// # Errors
    /// * [`Error::InvalidPageSize`] — `limit` is zero or too large.
    /// * [`Error::Unauthorized`] — `actor` is not the configured admin.
    pub fn cleanup_submitter_index(
        env: Env,
        actor: Address,
        submitter: Address,
        cursor: u32,
        limit: u32,
    ) -> Result<CleanupReport, Error> {
        if limit == 0 || limit > MAX_CLEANUP_PAGE_SIZE {
            return Err(Error::InvalidPageSize);
        }
        require_admin(&env, &actor)?;

        let key = DataKey::SubmitterIndex(submitter.clone());
        let entries: Vec<SubmitterEntry> = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| Vec::new(&env));
        let total = entries.len();
        let start = core::cmp::min(cursor, total);
        let end = core::cmp::min(start.saturating_add(limit), total);
        let mut kept = Vec::new(&env);
        let mut removed_count = 0u32;
        for i in 0..total {
            if let Some(entry) = entries.get(i) {
                let live = Self::get(
                    env.clone(),
                    entry.country_iso.clone(),
                    entry.category.clone(),
                    entry.timestamp,
                )
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
        // Entries before the cursor are never removed, so the next page starts
        // where this one ended minus what was dropped.
        let next_cursor = end.saturating_sub(removed_count);
        Ok(CleanupReport {
            removed_count,
            next_cursor,
            has_more: next_cursor < kept.len(),
        })
    }

    /// Read-only bounded consistency check for a country/category index page.
    ///
    /// # Errors
    /// * [`Error::InvalidPageSize`] — `limit` is zero or too large.
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
        let timestamps = Self::load_index(&env, &country_iso, &category);
        let total = timestamps.len();
        let start = core::cmp::min(cursor, total);
        let end = core::cmp::min(start.saturating_add(limit), total);
        let mut missing_count = 0u32;
        for i in start..end {
            if let Some(ts) = timestamps.get(i) {
                let key = DataKey::Price(country_iso.clone(), category.clone(), ts);
                if !env.storage().persistent().has(&key) {
                    missing_count = missing_count.saturating_add(1);
                }
            }
        }
        Ok(IndexConsistencyReport {
            checked_count: end.saturating_sub(start),
            missing_count,
            consistent: missing_count == 0,
            next_cursor: end,
            has_more: end < total,
        })
    }

    // ── Admin ────────────────────────────────────────────────────────────

    /// # Configure the access-control admin
    ///
    /// The first caller wins; every later call returns
    /// [`Error::AlreadyInitialized`]. An unconfigured contract is open rather
    /// than broken: every allowlist and policy starts empty.
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        Ok(())
    }

    /// Alias of [`Self::initialize`], kept for clients built against it.
    pub fn configure_admin(env: Env, admin: Address) -> Result<(), Error> {
        Self::initialize(env, admin)
    }

    /// The configured admin, or `None` when the contract is unconfigured.
    pub fn admin(env: Env) -> Option<Address> {
        load_admin(&env)
    }

    /// Hand the admin role to a new address. Both parties must sign.
    ///
    /// # Errors
    /// * [`Error::Unauthorized`] — `admin` is not the current admin.
    pub fn set_admin(env: Env, admin: Address, new_admin: Address) -> Result<(), Error> {
        require_admin(&env, &admin)?;
        new_admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        Ok(())
    }

    /// # Bound how long a submission may claim to be fresh
    ///
    /// `None` removes the bound.
    ///
    /// # Errors
    /// * [`Error::Unauthorized`] — `actor` is not the configured admin.
    pub fn set_max_validity_window(
        env: Env,
        actor: Address,
        max_validity_window_secs: Option<u64>,
    ) -> Result<(), Error> {
        require_admin(&env, &actor)?;
        match max_validity_window_secs {
            Some(max) => env
                .storage()
                .instance()
                .set(&DataKey::MaxValidityWindow, &max),
            None => env.storage().instance().remove(&DataKey::MaxValidityWindow),
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
        env.storage().instance().get(&DataKey::MaxValidityWindow)
    }

    /// # Enable or disable a category
    ///
    /// # Errors
    /// * [`Error::Unauthorized`] — `actor` is not the configured admin.
    pub fn set_category_enabled(
        env: Env,
        actor: Address,
        category: Symbol,
        enabled: bool,
    ) -> Result<(), Error> {
        require_admin(&env, &actor)?;
        env.storage()
            .instance()
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
            .instance()
            .get(&DataKey::CategoryPolicy(category))
            .unwrap_or(true)
    }

    /// # Allow or deny a submitter
    ///
    /// # Errors
    /// * [`Error::Unauthorized`] — `actor` is not the configured admin.
    pub fn set_submitter_allowed(
        env: Env,
        actor: Address,
        submitter: Address,
        allowed: bool,
    ) -> Result<(), Error> {
        require_admin(&env, &actor)?;
        env.storage()
            .instance()
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
            .instance()
            .get(&DataKey::SubmitterPolicy(submitter))
            .unwrap_or(true)
    }

    /// # Restrict which countries may receive submissions
    ///
    /// Narrows the static [`registry`]; it cannot widen it. An empty list
    /// clears the restriction. Each country that leaves the list publishes a
    /// [`CountryAllowlistRemoved`] event.
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
        for country in countries.iter() {
            if !registry::is_supported_country(&env, &country) {
                return Err(Error::InvalidCountry);
            }
        }
        let previous = Self::get_country_allowlist(env.clone());
        env.storage()
            .instance()
            .set(&DataKey::CountryAllowlist, &countries);
        for c in previous.iter() {
            if !countries.iter().any(|n| n == c) {
                CountryAllowlistRemoved {
                    country_iso: c,
                    admin: admin.clone(),
                }
                .publish(&env);
            }
        }
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
        for category in categories.iter() {
            if !registry::is_supported_category(&env, &category) {
                return Err(Error::InvalidCategory);
            }
        }
        let previous = Self::get_category_allowlist(env.clone());
        env.storage()
            .instance()
            .set(&DataKey::CategoryAllowlist, &categories);
        for c in previous.iter() {
            if !categories.iter().any(|n| n == c) {
                CategoryAllowlistRemoved {
                    category: c,
                    admin: admin.clone(),
                }
                .publish(&env);
            }
        }
        Ok(())
    }

    /// The configured category allowlist. Empty means unrestricted.
    pub fn get_category_allowlist(env: Env) -> Vec<Symbol> {
        env.storage()
            .instance()
            .get(&DataKey::CategoryAllowlist)
            .unwrap_or_else(|| Vec::new(&env))
    }

    /// #1080 — category-specific max price (`1..=MAX_PRICE`), or clear with
    /// `None`.
    ///
    /// # Errors
    /// * [`Error::Unauthorized`] — caller is not the admin.
    /// * [`Error::InvalidCategory`] — not a registry identifier.
    /// * [`Error::NonPositiveAmount`] / [`Error::ValueAboveMaximum`] — out of
    ///   range.
    pub fn set_category_max_price(
        env: Env,
        admin: Address,
        category: Symbol,
        max_price: Option<i128>,
    ) -> Result<(), Error> {
        require_admin(&env, &admin)?;
        if !registry::is_supported_category(&env, &category) {
            return Err(Error::InvalidCategory);
        }
        match max_price {
            Some(m) if m <= 0 => return Err(Error::NonPositiveAmount),
            Some(m) if m > MAX_PRICE => return Err(Error::ValueAboveMaximum),
            Some(m) => env
                .storage()
                .instance()
                .set(&DataKey::CategoryMaxPrice(category), &m),
            None => env
                .storage()
                .instance()
                .remove(&DataKey::CategoryMaxPrice(category)),
        }
        Ok(())
    }

    /// The effective price ceiling for `category`.
    pub fn get_category_max_price(env: Env, category: Symbol) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::CategoryMaxPrice(category))
            .unwrap_or(MAX_PRICE)
    }

    /// # Restrict which submitters may write which categories
    ///
    /// Replaces the whole policy. An empty policy imposes no restriction; an
    /// entry with an empty `categories` grants every category. To remove one
    /// submitter without resending the list, use
    /// [`Self::revoke_authorization`].
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
        for entry in policy.iter() {
            for category in entry.categories.iter() {
                if !registry::is_supported_category(&env, &category) {
                    return Err(Error::InvalidCategory);
                }
            }
        }
        env.storage()
            .instance()
            .set(&DataKey::Authorizations, &policy);
        Ok(())
    }

    /// # Revoke one submitter's authorization (#1082)
    ///
    /// Removes every policy entry for `submitter` and leaves all other grants
    /// exactly as they were, in their original order. Publishes
    /// [`AuthorizationRevoked`] after the write.
    ///
    /// Revoking the **last** remaining entry is refused: an empty policy means
    /// "unrestricted", so removing the only grant would silently open the
    /// vault to every address — the opposite of a revocation. To lift the
    /// policy deliberately, call [`Self::set_authorizations`] with an empty
    /// list.
    ///
    /// # Errors
    /// * [`Error::Unauthorized`] — caller is not the admin.
    /// * [`Error::AuthorizationNotFound`] — `submitter` has no entry.
    /// * [`Error::LastAuthorization`] — this is the only remaining entry.
    pub fn revoke_authorization(
        env: Env,
        admin: Address,
        submitter: Address,
    ) -> Result<(), Error> {
        require_admin(&env, &admin)?;

        let policy = Self::get_authorizations(env.clone());
        let mut kept = Vec::new(&env);
        let mut revoked: Option<Vec<Symbol>> = None;
        for entry in policy.iter() {
            if entry.submitter == submitter {
                // `submitter_allowed` honours the first entry, so that is the
                // grant the submitter actually held.
                if revoked.is_none() {
                    revoked = Some(entry.categories.clone());
                }
            } else {
                kept.push_back(entry);
            }
        }

        let categories = revoked.ok_or(Error::AuthorizationNotFound)?;
        if kept.is_empty() {
            return Err(Error::LastAuthorization);
        }

        env.storage()
            .instance()
            .set(&DataKey::Authorizations, &kept);

        AuthorizationRevoked {
            submitter,
            admin,
            categories,
        }
        .publish(&env);

        Ok(())
    }

    /// The configured submitter policy. Empty means unrestricted.
    pub fn get_authorizations(env: Env) -> Vec<Authorization> {
        env.storage()
            .instance()
            .get(&DataKey::Authorizations)
            .unwrap_or_else(|| Vec::new(&env))
    }

    /// Whether `submitter` may currently write `category` under the policy.
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

    // ── Registry views ───────────────────────────────────────────────────

    /// Whether `from -> to` is a permitted status transition.
    ///
    /// Derived from the same [`SubmissionStatus::can_transition_to`] the
    /// mutator uses, so the view can never disagree with the enforcement.
    pub fn can_transition(from: SubmissionStatus, to: SubmissionStatus) -> bool {
        from.can_transition_to(to)
    }

    /// Whether `reason` is accepted by [`Self::set_status_with_reason`] for a
    /// move to `to`.
    pub fn is_valid_status_reason(reason: u32, to: SubmissionStatus) -> bool {
        status_reason::allows(reason, to)
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

    // ── Pure helpers, callable off-chain ─────────────────────────────────

    /// Add two `i128` values, failing safely on overflow.
    pub fn safe_add(_env: Env, a: i128, b: i128) -> Result<i128, Error> {
        guards::checked_add_i128(a, b)
    }

    /// Multiply two `i128` values, failing safely on overflow.
    pub fn safe_mul(_env: Env, a: i128, b: i128) -> Result<i128, Error> {
        guards::checked_mul_i128(a, b)
    }

    /// Validate a submit payload without committing any state.
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
}

// ── Internal helpers (not contract entry points) ─────────────────────────────

impl PriceVault {
    /// `valid_from + validity_window_secs`, refusing rather than clamping.
    fn resolve_window(valid_from: u64, validity_window_secs: u64) -> Result<u64, Error> {
        if validity_window_secs == 0 {
            return Err(Error::InvalidWindow);
        }
        valid_from
            .checked_add(validity_window_secs)
            .ok_or(Error::InvalidWindow)
    }

    /// The shared body of `set_status` and `set_status_with_reason`.
    ///
    /// The record is left byte-for-byte unchanged, and nothing is emitted,
    /// when a transition is refused.
    fn apply_status(
        env: &Env,
        verifier: Address,
        country_iso: Symbol,
        category: Symbol,
        timestamp: u64,
        new_status: SubmissionStatus,
        reason: u32,
    ) -> Result<(), Error> {
        verifier.require_auth();

        let key = DataKey::Price(country_iso.clone(), category.clone(), timestamp);
        let mut submission: PriceSubmission = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotFound)?;

        if !submission.status.can_transition_to(new_status) {
            return Err(Error::InvalidTransition);
        }

        let prior_status = submission.status;
        submission.status = new_status;
        env.storage().persistent().set(&key, &submission);

        StatusChanged {
            country_iso,
            category,
            timestamp,
            actor: verifier,
            prior_status,
            new_status,
            reason,
        }
        .publish(env);

        Ok(())
    }

    fn load_index(env: &Env, country_iso: &Symbol, category: &Symbol) -> Vec<u64> {
        env.storage()
            .persistent()
            .get(&DataKey::SubmissionIndex(
                country_iso.clone(),
                category.clone(),
            ))
            .unwrap_or_else(|| Vec::new(env))
    }

    /// Load records for each timestamp, skipping any that are absent.
    fn collect_submissions(
        env: &Env,
        country_iso: &Symbol,
        category: &Symbol,
        timestamps: &Vec<u64>,
    ) -> Vec<PriceSubmission> {
        let mut result = Vec::new(env);
        for ts in timestamps.iter() {
            let key = DataKey::Price(country_iso.clone(), category.clone(), ts);
            if let Some(submission) = env
                .storage()
                .persistent()
                .get::<DataKey, PriceSubmission>(&key)
            {
                result.push_back(submission);
            }
        }
        result
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    extern crate std;

    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Events as _},
        vec, Env,
    };

    fn make_env() -> Env {
        Env::default()
    }

    fn deploy(env: &Env) -> PriceVaultClient<'_> {
        let contract_id = env.register(PriceVault, ());
        PriceVaultClient::new(env, &contract_id)
    }

    /// Deploy with an admin configured. Mocks all auths.
    fn deploy_with_admin(env: &Env) -> (PriceVaultClient<'_>, Address, Address) {
        env.mock_all_auths();
        let client = deploy(env);
        let admin = Address::generate(env);
        let submitter = Address::generate(env);
        client.initialize(&admin);
        (client, admin, submitter)
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
        client.submit(
            submitter,
            country,
            category,
            &value,
            &valid_from,
            &DEFAULT_VALIDITY_WINDOW_SECS,
        );
    }

    fn submit_err(
        client: &PriceVaultClient,
        submitter: &Address,
        country: &Symbol,
        category: &Symbol,
        value: i128,
        valid_from: u64,
        window: u64,
    ) -> Error {
        client
            .try_submit(submitter, country, category, &value, &valid_from, &window)
            .unwrap_err()
            .unwrap()
    }

    // ── guards ───────────────────────────────────────────────────────────

    #[test]
    fn guard_price_bounds() {
        assert_eq!(guards::require_positive_price(0), Err(Error::ZeroPrice));
        assert_eq!(guards::require_positive_price(-1), Err(Error::NegativePrice));
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

    // ── payload validate ─────────────────────────────────────────────────

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

    // ── registry ─────────────────────────────────────────────────────────

    #[test]
    fn registry_recognises_known_identifiers() {
        let env = make_env();
        assert!(registry::is_supported_country(&env, &sym(&env, "NG")));
        assert!(registry::is_supported_country(&env, &sym(&env, "US")));
        assert!(!registry::is_supported_country(&env, &sym(&env, "ZZ")));
        assert!(registry::is_supported_category(&env, &sym(&env, "Food")));
        assert!(!registry::is_supported_category(&env, &sym(&env, "Weapons")));
        assert_eq!(registry::countries(&env).len(), registry::COUNTRY_CODES.len() as u32);
        assert_eq!(registry::categories(&env).len(), registry::CATEGORIES.len() as u32);
    }

    // ── submit ───────────────────────────────────────────────────────────

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
        let s = Address::generate(&env);
        env.mock_all_auths();
        let w = DEFAULT_VALIDITY_WINDOW_SECS;

        assert_eq!(
            submit_err(&client, &s, &sym(&env, "ZZ"), &sym(&env, "Food"), 100, 1_000, w),
            Error::InvalidCountry
        );
        assert_eq!(
            submit_err(&client, &s, &sym(&env, "NG"), &sym(&env, "Weapons"), 100, 1_000, w),
            Error::InvalidCategory
        );
    }

    #[test]
    fn submit_rejects_bad_values_before_auth() {
        let env = make_env();
        let client = deploy(&env);
        let s = Address::generate(&env);
        let c = sym(&env, "NG");
        let k = sym(&env, "Food");
        let w = DEFAULT_VALIDITY_WINDOW_SECS;
        // No mock_all_auths: each refusal must happen before require_auth.

        assert_eq!(submit_err(&client, &s, &c, &k, 0, 1_000, w), Error::ZeroNotAllowed);
        assert_eq!(submit_err(&client, &s, &c, &k, -1, 1_000, w), Error::NegativeNotAllowed);
        assert_eq!(submit_err(&client, &s, &c, &k, 100, 0, w), Error::ZeroNotAllowed);
        assert_eq!(
            submit_err(&client, &s, &c, &k, MAX_PRICE + 1, 1_000, w),
            Error::ValueAboveMaximum
        );
    }

    #[test]
    fn submit_rejects_bad_windows() {
        let env = make_env();
        let client = deploy(&env);
        let s = Address::generate(&env);
        let c = sym(&env, "NG");
        let k = sym(&env, "Food");
        env.mock_all_auths();

        assert_eq!(submit_err(&client, &s, &c, &k, 100, 1_000, 0), Error::InvalidWindow);
        assert_eq!(submit_err(&client, &s, &c, &k, 100, u64::MAX, 1), Error::InvalidWindow);
    }

    #[test]
    fn resubmitting_the_same_key_is_refused() {
        let env = make_env();
        let client = deploy(&env);
        let s = Address::generate(&env);
        let c = sym(&env, "NG");
        let k = sym(&env, "Food");
        env.mock_all_auths();

        submit_ok(&client, &s, &c, &k, 100, 10);
        assert_eq!(
            submit_err(&client, &s, &c, &k, 999, 10, DEFAULT_VALIDITY_WINDOW_SECS),
            Error::DuplicateSubmission
        );

        let history = client.get_history(&c, &k);
        assert_eq!(history.len(), 1);
        assert_eq!(history.get(0).unwrap().value, 100);
    }

    #[test]
    fn a_duplicate_is_detected_per_key_component() {
        let env = make_env();
        let client = deploy(&env);
        let s = Address::generate(&env);
        let ng = sym(&env, "NG");
        let gh = sym(&env, "GH");
        let food = sym(&env, "Food");
        let rent = sym(&env, "Rent");
        env.mock_all_auths();

        submit_ok(&client, &s, &ng, &food, 100, 10);
        submit_ok(&client, &s, &ng, &food, 200, 11);
        submit_ok(&client, &s, &ng, &rent, 300, 10);
        submit_ok(&client, &s, &gh, &food, 400, 10);

        assert_eq!(client.get_history(&ng, &food).len(), 2);
        assert_eq!(client.get_history(&ng, &rent).len(), 1);
        assert_eq!(client.get_history(&gh, &food).len(), 1);
        assert_eq!(
            submit_err(&client, &s, &ng, &food, 100, 10, DEFAULT_VALIDITY_WINDOW_SECS),
            Error::DuplicateSubmission
        );
    }

    #[test]
    fn a_duplicate_is_detected_regardless_of_window_or_submitter() {
        let env = make_env();
        let client = deploy(&env);
        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        let c = sym(&env, "NG");
        let k = sym(&env, "Food");
        env.mock_all_auths();

        submit_ok(&client, &alice, &c, &k, 100, 10);
        for (submitter, window) in [(&alice, 1_u64), (&bob, DEFAULT_VALIDITY_WINDOW_SECS)] {
            assert_eq!(
                submit_err(&client, submitter, &c, &k, 777, 10, window),
                Error::DuplicateSubmission
            );
        }
        assert_eq!(client.get(&c, &k, &10).unwrap().value, 100);
        assert_eq!(client.get_history(&c, &k).len(), 1);
    }

    // ── validity window ──────────────────────────────────────────────────

    #[test]
    fn window_bounds_are_one_definition_of_the_window() {
        let env = make_env();
        let client = deploy(&env);

        assert_eq!(
            client.try_window_bounds(&1_000, &0).unwrap_err().unwrap(),
            Error::InvalidWindow
        );
        assert_eq!(
            client.try_window_bounds(&u64::MAX, &1).unwrap_err().unwrap(),
            Error::InvalidWindow
        );
        assert_eq!(client.window_bounds(&0, &u64::MAX), u64::MAX);
        assert_eq!(client.window_bounds(&1_000, &86_400), 87_400);
    }

    #[test]
    fn the_window_is_inclusive_at_the_start_and_exclusive_at_expiry() {
        let env = make_env();
        let client = deploy(&env);
        let s = Address::generate(&env);
        let c = sym(&env, "NG");
        let k = sym(&env, "Food");
        env.mock_all_auths();

        client.submit(&s, &c, &k, &100, &1_000_u64, &500_u64);
        assert!(client.is_fresh(&c, &k, &1_000, &1_000));
        assert!(client.is_fresh(&c, &k, &1_000, &1_499));
        assert!(!client.is_fresh(&c, &k, &1_000, &1_500));
        assert!(!client.is_fresh(&c, &k, &1_000, &999));
        assert!(client.is_valid_at(&c, &k, &1_000, &1_000));
    }

    #[test]
    fn consecutive_windows_do_not_overlap() {
        let env = make_env();
        let client = deploy(&env);
        let s = Address::generate(&env);
        let c = sym(&env, "NG");
        let k = sym(&env, "Food");
        env.mock_all_auths();

        client.submit(&s, &c, &k, &100, &1_000_u64, &1_000_u64);
        client.submit(&s, &c, &k, &200, &2_000_u64, &1_000_u64);
        assert!(!client.is_valid_at(&c, &k, &1_000, &2_000));
        assert!(client.is_valid_at(&c, &k, &2_000, &2_000));
    }

    #[test]
    fn get_valid_gates_on_freshness() {
        let env = make_env();
        let client = deploy(&env);
        let s = Address::generate(&env);
        let c = sym(&env, "KE");
        let k = sym(&env, "Rent");
        env.mock_all_auths();

        submit_ok(&client, &s, &c, &k, 500, 2_000);
        assert!(client.get_valid(&c, &k, &2_000, &2_000).is_some());
        assert!(client.get_valid(&c, &k, &2_000, &1_999).is_none());
        assert!(client.get_valid(&c, &k, &2_000, &100_000).is_none());
        assert!(client.get_valid(&c, &k, &9_999, &1).is_none());
        assert!(!client.is_valid_at(&c, &k, &9_999, &1));
    }

    #[test]
    fn fresh_history_drops_expired_and_not_yet_valid_records() {
        let env = make_env();
        let client = deploy(&env);
        let s = Address::generate(&env);
        let c = sym(&env, "NG");
        let k = sym(&env, "Food");
        env.mock_all_auths();

        for (ts, value) in [(1_000_u64, 100_i128), (2_000, 200), (3_000, 300)] {
            client.submit(&s, &c, &k, &value, &ts, &100_u64);
        }
        assert_eq!(client.get_history(&c, &k).len(), 3);

        let fresh = client.get_fresh_history(&c, &k, &1_050);
        assert_eq!(fresh.len(), 1);
        assert_eq!(fresh.get(0).unwrap().value, 100);

        let fresh = client.get_fresh_history(&c, &k, &2_050);
        assert_eq!(fresh.len(), 1);
        assert_eq!(fresh.get(0).unwrap().value, 200);

        assert_eq!(client.get_fresh_history(&c, &k, &1_100).len(), 0);
        assert_eq!(client.get_fresh_history(&c, &sym(&env, "Rent"), &1_050).len(), 0);
    }

    // ── status machine ───────────────────────────────────────────────────

    #[test]
    fn transition_table_allows_only_pending_to_a_terminal_state() {
        use SubmissionStatus::*;
        assert!(Pending.can_transition_to(Verified));
        assert!(Pending.can_transition_to(Rejected));
        assert!(!Pending.can_transition_to(Pending));
        assert!(!Verified.can_transition_to(Rejected));
        assert!(!Verified.can_transition_to(Pending));
        assert!(!Rejected.can_transition_to(Verified));
        assert!(!Rejected.can_transition_to(Pending));
        assert!(!Pending.is_terminal());
        assert!(Verified.is_terminal());
        assert!(Rejected.is_terminal());
    }

    #[test]
    fn status_discriminants_are_stable() {
        assert_eq!(SubmissionStatus::Pending as u32, 0);
        assert_eq!(SubmissionStatus::Verified as u32, 1);
        assert_eq!(SubmissionStatus::Rejected as u32, 2);
    }

    #[test]
    fn pending_transitions_to_verified_and_rejected() {
        for target in [SubmissionStatus::Verified, SubmissionStatus::Rejected] {
            let env = make_env();
            let client = deploy(&env);
            let s = Address::generate(&env);
            let v = Address::generate(&env);
            let c = sym(&env, "NG");
            let k = sym(&env, "Food");
            env.mock_all_auths();

            submit_ok(&client, &s, &c, &k, 1_000, 100);
            client.set_status(&v, &c, &k, &100, &target);
            assert_eq!(client.get_status(&c, &k, &100), Some(target));
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
                let s = Address::generate(&env);
                let v = Address::generate(&env);
                let c = sym(&env, "NG");
                let k = sym(&env, "Food");
                env.mock_all_auths();

                submit_ok(&client, &s, &c, &k, 1_000, 100);
                client.set_status(&v, &c, &k, &100, &terminal);
                assert_eq!(
                    client
                        .try_set_status(&v, &c, &k, &100, &next)
                        .unwrap_err()
                        .unwrap(),
                    Error::InvalidTransition,
                    "{terminal:?} -> {next:?} must be refused"
                );
                assert_eq!(client.get_status(&c, &k, &100), Some(terminal));
            }
        }
    }

    #[test]
    fn pending_is_not_a_valid_target() {
        let env = make_env();
        let client = deploy(&env);
        let s = Address::generate(&env);
        let v = Address::generate(&env);
        let c = sym(&env, "NG");
        let k = sym(&env, "Food");
        env.mock_all_auths();

        submit_ok(&client, &s, &c, &k, 1_000, 100);
        assert_eq!(
            client
                .try_set_status(&v, &c, &k, &100, &SubmissionStatus::Pending)
                .unwrap_err()
                .unwrap(),
            Error::InvalidTransition
        );
    }

    #[test]
    fn set_status_on_missing_record_is_not_found() {
        let env = make_env();
        let client = deploy(&env);
        let v = Address::generate(&env);
        env.mock_all_auths();

        assert_eq!(
            client
                .try_set_status(
                    &v,
                    &sym(&env, "NG"),
                    &sym(&env, "Food"),
                    &999,
                    &SubmissionStatus::Verified
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
        let s = Address::generate(&env);
        let v = Address::generate(&env);
        let c = sym(&env, "IN");
        let k = sym(&env, "Health");
        env.mock_all_auths();

        submit_ok(&client, &s, &c, &k, 300, 75);
        client.set_status(&v, &c, &k, &75, &SubmissionStatus::Rejected);

        let after = client.get(&c, &k, &75).unwrap();
        assert_eq!(after.status, SubmissionStatus::Rejected);
        assert_eq!(after.value, 300);
        assert_eq!(after.submitter, s);
    }

    #[test]
    fn the_public_transition_view_matches_the_enforced_table() {
        let env = make_env();
        let client = deploy(&env);
        let statuses = [
            SubmissionStatus::Pending,
            SubmissionStatus::Verified,
            SubmissionStatus::Rejected,
        ];
        for from in statuses {
            for to in statuses {
                assert_eq!(
                    client.can_transition(&from, &to),
                    from.can_transition_to(to),
                    "{from:?} -> {to:?}"
                );
            }
        }
    }

    // ── history ──────────────────────────────────────────────────────────

    #[test]
    fn history_is_empty_when_there_are_no_submissions() {
        let env = make_env();
        let client = deploy(&env);
        assert_eq!(client.get_history(&sym(&env, "NG"), &sym(&env, "Food")).len(), 0);
        assert!(client.get_latest(&sym(&env, "NG"), &sym(&env, "Food")).is_none());
    }

    #[test]
    fn history_returns_submissions_in_insertion_order_and_scoped() {
        let env = make_env();
        let client = deploy(&env);
        let s = Address::generate(&env);
        let ng = sym(&env, "NG");
        let ke = sym(&env, "KE");
        let food = sym(&env, "Food");
        env.mock_all_auths();

        submit_ok(&client, &s, &ng, &food, 100, 10);
        submit_ok(&client, &s, &ng, &food, 200, 20);
        submit_ok(&client, &s, &ke, &food, 999, 15);
        submit_ok(&client, &s, &ng, &food, 300, 30);

        let h = client.get_history(&ng, &food);
        assert_eq!(h.len(), 3);
        assert_eq!(h.get(0).unwrap().value, 100);
        assert_eq!(h.get(1).unwrap().value, 200);
        assert_eq!(h.get(2).unwrap().value, 300);
        assert_eq!(client.get_history(&ke, &food).len(), 1);
    }

    #[test]
    fn history_range_filters_inclusively() {
        let env = make_env();
        let client = deploy(&env);
        let s = Address::generate(&env);
        let c = sym(&env, "NG");
        let k = sym(&env, "Food");
        env.mock_all_auths();

        for ts in [10_u64, 20, 30, 40, 50] {
            submit_ok(&client, &s, &c, &k, ts as i128 * 10, ts);
        }
        let range = client.get_history_range(&c, &k, &20, &40);
        assert_eq!(range.len(), 3);
        assert_eq!(range.get(0).unwrap().timestamp, 20);
        assert_eq!(range.get(2).unwrap().timestamp, 40);
        assert_eq!(client.get_history_range(&c, &k, &10, &10).len(), 1);
        assert_eq!(client.get_history_range(&c, &k, &60, &70).len(), 0);
        assert_eq!(
            client
                .try_get_history_range(&c, &k, &100, &50)
                .unwrap_err()
                .unwrap(),
            Error::InvalidRange
        );
    }

    #[test]
    fn latest_is_the_most_recently_inserted_record() {
        let env = make_env();
        let client = deploy(&env);
        let s = Address::generate(&env);
        let c = sym(&env, "NG");
        let k = sym(&env, "Food");
        env.mock_all_auths();

        submit_ok(&client, &s, &c, &k, 100, 10);
        submit_ok(&client, &s, &c, &k, 200, 30);
        submit_ok(&client, &s, &c, &k, 150, 20);
        let latest = client.get_latest(&c, &k).unwrap();
        assert_eq!(latest.timestamp, 20);
        assert_eq!(latest.value, 150);
    }

    fn seed_submitter(env: &Env, client: &PriceVaultClient, submitter: &Address, from: u32, count: u32) {
        let countries = ["NG", "KE", "BR"];
        for i in from..from + count {
            client.submit(
                submitter,
                &Symbol::new(env, countries[(i % 3) as usize]),
                &Symbol::new(env, "Food"),
                &((i as i128) + 1),
                &((i as u64) * 10 + 10),
                &DEFAULT_VALIDITY_WINDOW_SECS,
            );
        }
    }

    #[test]
    fn submitter_history_pages_through_every_record_exactly_once() {
        let env = make_env();
        let client = deploy(&env);
        let s = Address::generate(&env);
        let other = Address::generate(&env);
        env.mock_all_auths();

        seed_submitter(&env, &client, &s, 0, 7);
        seed_submitter(&env, &client, &other, 100, 2);

        let mut seen: Vec<u64> = Vec::new(&env);
        let mut cursor = HistoryCursor::new(0);
        loop {
            let page = client.get_submitter_history(&s, &cursor, &3);
            assert!(page.submissions.len() <= 3);
            for record in page.submissions.iter() {
                seen.push_back(record.timestamp);
            }
            if !page.has_more {
                assert_eq!(page.next_cursor.offset, 7);
                break;
            }
            cursor = page.next_cursor.clone();
        }
        let mut expected: Vec<u64> = Vec::new(&env);
        for i in 0..7u64 {
            expected.push_back(i * 10 + 10);
        }
        assert_eq!(seen, expected);
    }

    #[test]
    fn submitter_history_rejects_an_out_of_range_page_size() {
        let env = make_env();
        let client = deploy(&env);
        let s = Address::generate(&env);
        for limit in [0, MAX_HISTORY_PAGE_SIZE + 1] {
            assert_eq!(
                client
                    .try_get_submitter_history(&s, &HistoryCursor::new(0), &limit)
                    .unwrap_err()
                    .unwrap(),
                Error::InvalidPageSize
            );
        }
    }

    #[test]
    fn submitter_history_is_empty_for_an_unknown_submitter() {
        let env = make_env();
        let client = deploy(&env);
        let page = client.get_submitter_history(&Address::generate(&env), &HistoryCursor::new(0), &10);
        assert_eq!(page.submissions.len(), 0);
        assert!(!page.has_more);
        assert_eq!(page.next_cursor.offset, 0);
    }

    // ── admin & policy ───────────────────────────────────────────────────

    #[test]
    fn initialize_is_once_only_and_records_the_admin() {
        let env = make_env();
        let client = deploy(&env);
        let admin = Address::generate(&env);
        let other = Address::generate(&env);
        env.mock_all_auths();

        assert_eq!(client.admin(), None);
        client.initialize(&admin);
        assert_eq!(client.admin(), Some(admin.clone()));
        assert_eq!(
            client.try_initialize(&other).unwrap_err().unwrap(),
            Error::AlreadyInitialized
        );
        assert_eq!(
            client.try_configure_admin(&other).unwrap_err().unwrap(),
            Error::AlreadyInitialized
        );
        assert_eq!(client.admin(), Some(admin));
    }

    #[test]
    fn admin_can_be_handed_over() {
        let env = make_env();
        let (client, admin, _) = deploy_with_admin(&env);
        let successor = Address::generate(&env);
        client.set_admin(&admin, &successor);
        assert_eq!(client.admin(), Some(successor));
    }

    #[test]
    fn an_unconfigured_vault_refuses_admin_calls_but_accepts_submissions() {
        let env = make_env();
        let client = deploy(&env);
        let anyone = Address::generate(&env);
        env.mock_all_auths();

        assert_eq!(client.admin(), None);
        assert_eq!(client.max_validity_window(), None);
        assert_eq!(
            client
                .try_set_category_enabled(&anyone, &sym(&env, "Food"), &false)
                .unwrap_err()
                .unwrap(),
            Error::Unauthorized
        );
        submit_ok(&client, &anyone, &sym(&env, "NG"), &sym(&env, "Food"), 100, 10);
        assert!(client.is_country_allowed(&sym(&env, "KE")));
        assert!(client.is_category_allowed(&sym(&env, "Rent")));
        assert!(client.is_submitter_authorized(&anyone, &sym(&env, "Food")));
    }

    #[test]
    fn a_non_admin_cannot_change_configuration() {
        let env = make_env();
        let (client, _admin, subject) = deploy_with_admin(&env);
        let x = Address::generate(&env);
        let food = sym(&env, "Food");

        let errs = [
            client.try_set_country_allowlist(&x, &vec![&env, sym(&env, "NG")]).unwrap_err().unwrap(),
            client.try_set_category_allowlist(&x, &vec![&env, food.clone()]).unwrap_err().unwrap(),
            client.try_set_authorizations(&x, &vec![&env]).unwrap_err().unwrap(),
            client.try_set_category_enabled(&x, &food, &false).unwrap_err().unwrap(),
            client.try_set_submitter_allowed(&x, &subject, &false).unwrap_err().unwrap(),
            client.try_set_max_validity_window(&x, &Some(100)).unwrap_err().unwrap(),
        ];
        for e in errs {
            assert_eq!(e, Error::Unauthorized);
        }
        assert!(client.is_category_enabled(&food));
        assert!(client.is_submitter_allowed(&subject));
        assert_eq!(client.max_validity_window(), None);
    }

    #[test]
    fn allowlists_cannot_widen_the_registry() {
        let env = make_env();
        let (client, admin, _) = deploy_with_admin(&env);

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
    fn allowlists_narrow_submissions_and_empty_clears_them() {
        let env = make_env();
        let (client, admin, s) = deploy_with_admin(&env);
        let food = sym(&env, "Food");
        let rent = sym(&env, "Rent");
        let w = DEFAULT_VALIDITY_WINDOW_SECS;

        client.set_country_allowlist(&admin, &vec![&env, sym(&env, "NG")]);
        client.set_category_allowlist(&admin, &vec![&env, food.clone()]);
        submit_ok(&client, &s, &sym(&env, "NG"), &food, 100, 10);
        assert_eq!(
            submit_err(&client, &s, &sym(&env, "KE"), &food, 100, 10, w),
            Error::CountryNotAllowed
        );
        assert_eq!(
            submit_err(&client, &s, &sym(&env, "NG"), &rent, 100, 10, w),
            Error::CategoryNotAllowed
        );

        client.set_country_allowlist(&admin, &vec![&env]);
        client.set_category_allowlist(&admin, &vec![&env]);
        submit_ok(&client, &s, &sym(&env, "KE"), &rent, 100, 10);
    }

    #[test]
    fn a_submitter_may_be_confined_to_specific_categories() {
        let env = make_env();
        let (client, admin, baker) = deploy_with_admin(&env);
        let stranger = Address::generate(&env);
        let ng = sym(&env, "NG");
        let w = DEFAULT_VALIDITY_WINDOW_SECS;

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
        submit_ok(&client, &baker, &ng, &sym(&env, "Food"), 100, 10);
        assert_eq!(
            submit_err(&client, &baker, &ng, &sym(&env, "Utilities"), 100, 10, w),
            Error::SubmitterNotAllowed
        );
        assert_eq!(
            submit_err(&client, &stranger, &ng, &sym(&env, "Food"), 100, 11, w),
            Error::SubmitterNotAllowed
        );
        assert!(client.is_submitter_authorized(&baker, &sym(&env, "Rent")));
        assert!(!client.is_submitter_authorized(&baker, &sym(&env, "Utilities")));
    }

    #[test]
    fn disabled_category_denied_submitter_and_window_cap_are_enforced() {
        let env = make_env();
        let (client, admin, bob) = deploy_with_admin(&env);
        let alice = Address::generate(&env);
        let ng = sym(&env, "NG");
        let food = sym(&env, "Food");
        let rent = sym(&env, "Rent");
        let w = DEFAULT_VALIDITY_WINDOW_SECS;

        client.set_category_enabled(&admin, &food, &false);
        client.set_submitter_allowed(&admin, &alice, &false);
        client.set_max_validity_window(&admin, &Some(3_600));

        assert_eq!(submit_err(&client, &bob, &ng, &food, 100, 1_000, 3_600), Error::CategoryDisabled);
        assert_eq!(submit_err(&client, &alice, &ng, &rent, 100, 1_000, 3_600), Error::SubmitterNotAllowed);
        assert_eq!(submit_err(&client, &bob, &ng, &rent, 100, 1_000, 3_601), Error::WindowTooLong);
        client.submit(&bob, &ng, &rent, &100, &1_000_u64, &3_600_u64);

        client.set_category_enabled(&admin, &food, &true);
        client.set_max_validity_window(&admin, &None);
        client.submit(&bob, &ng, &food, &100, &1_000_u64, &w);
    }

    #[test]
    fn every_policy_change_publishes_an_event() {
        let env = make_env();
        let (client, admin, subject) = deploy_with_admin(&env);
        let category = sym(&env, "Food");

        let mut count = 0;
        client.set_max_validity_window(&admin, &Some(3_600));
        count += env.events().all().events().len();
        client.set_max_validity_window(&admin, &None);
        count += env.events().all().events().len();
        client.set_category_enabled(&admin, &category, &false);
        count += env.events().all().events().len();
        client.set_submitter_allowed(&admin, &subject, &false);
        count += env.events().all().events().len();
        assert_eq!(count, 4);
    }

    // ── pure helpers & constants ─────────────────────────────────────────

    #[test]
    fn safe_arithmetic_entry_points() {
        let env = make_env();
        let client = deploy(&env);
        assert_eq!(client.safe_add(&10, &20), 30);
        assert_eq!(client.safe_mul(&6, &7), 42);
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
        client.validate_submit_payload(&sym(&env, "KE"), &sym(&env, "Rent"), &500, &50);
        assert_eq!(
            client
                .try_validate_submit_payload(&sym(&env, "KE"), &sym(&env, "Rent"), &-1, &50)
                .unwrap_err()
                .unwrap(),
            Error::NegativeNotAllowed
        );
        assert!(client.get(&sym(&env, "KE"), &sym(&env, "Rent"), &50).is_none());
    }

    #[test]
    fn documented_constants_hold() {
        assert_eq!(DEFAULT_VALIDITY_WINDOW_SECS, 86_400);
        assert_eq!(SCHEMA_VERSION, 1);
        assert_eq!(registry::VERSION, 1);
    }
}
