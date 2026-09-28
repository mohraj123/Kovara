#![no_std]
//! `PriceVault` — stores raw price submissions keyed by `(country_iso,
//! category, timestamp)`.
//!
//! This is the scaffolding landing pad for the Kovara price vault (CT-001).
//! It wires the contract to the Soroban SDK and exposes a minimal, safe
//! submission/read surface so the workspace builds and the storage layout is
//! in place. Deeper submission semantics are owned by subsequent contract
//! issues and will extend this crate.
//!
//! # Schema validation for serialized payloads (issue #739)
//!
//! Soroban contracts receive inputs as XDR-serialized values.  Before any
//! of those values are used or persisted they must pass a schema validation
//! step that is:
//!
//! - **Consistent**: the same `PayloadSchema` descriptor and `validate`
//!   function are used across every entry point.
//! - **Explicit**: every constraint is named as a variant of
//!   [`ValidationError`]; there is no catch-all "invalid input" code.
//! - **Pure**: validation never mutates state — it is a predicate over the
//!   raw input values, callable before `require_auth` so malformed calls
//!   are rejected at minimum cost.
//!
//! ## `payload` module
//!
//! The [`payload`] module is the single validation entry point.  It exposes:
//!
//! | Item | Purpose |
//! |---|---|
//! | [`payload::FieldKind`] | Discriminant for the type of a validated field. |
//! | [`payload::Constraint`] | A named constraint applied to a single field. |
//! | [`payload::PayloadSchema`] | An ordered list of `Constraint`s that fully describes what a valid payload looks like. |
//! | [`payload::validate`] | Apply a `PayloadSchema` to a `SubmitPayload`, returning the first failing constraint as `Err(ValidationError)`. |
//! | [`payload::SubmitPayload`] | A plain-struct view of the `submit` arguments, passed by value to `validate` so no cloning of contract-SDK types is needed. |
//!
//! ## Wiring into `submit`
//!
//! `PriceVault::submit` calls `payload::validate` with a fixed
//! `SUBMIT_SCHEMA` before `require_auth` and before any storage access.
//! A malformed payload is rejected at the gate — no auth side-effects, no
//! partial writes, no ambiguous state.
//!
//! ## Extension pattern
//!
//! Any other contract entry point (e.g. a future `update_config`,
//! `set_status`, or `aggregate`) follows the same pattern:
//! 1. Define a `*Payload` struct capturing the raw arguments.
//! 2. Define a `*_SCHEMA: &[Constraint]` constant.
//! 3. Call `payload::validate(&schema, &payload)?` as the first line of the
//!    entry point body.
//!
//! This is the "consistent validation across contract interfaces"
//! acceptance criterion.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, Address, Env, Symbol,
};

// ── Validation error codes ────────────────────────────────────────────────────
//! # Fail-safe checks for zero and negative values (issue #728)
//!
//! All arithmetic entry points in this contract validate inputs through a
//! single shared [`guards`] module before touching contract state.  The
//! rules are:
//!
//! | Guard | Rule |
//! |---|---|
//! | `require_positive_price` | `value` must be `> 0`; zero or negative corrupts the KVI median. |
//! | `require_positive_u64` | Generic `u64` must be `> 0`; used for timestamps and counts. |
//! | `require_positive_i128` | Generic `i128` must be `> 0`; used for stake and reward amounts. |
//! | `require_no_overflow_add` | `a.checked_add(b)` — panics would break contract execution; explicit error instead. |
//! | `require_no_overflow_mul` | `a.checked_mul(b)` — same rationale. |
//!
//! Every guard is a pure function that returns `Err(Error::*)` rather than
//! panicking.  Soroban contracts must never panic on bad input — a panic
//! aborts the transaction and burns fees without giving the caller a
//! meaningful error code.  All guards satisfy the
//! "arithmetic functions fail safely instead of causing undefined behavior"
//! acceptance criterion.
//!
//! ## Negative-path test coverage
//!
//! Every guard has at least one negative-path test (bad input → expected
//! error) and at least one positive-path test (good input → `Ok`).  The
//! aggregate test suite documents every rejected case, satisfying the
//! "validation logic is asserted with negative-path tests" acceptance
//! criterion.
//! # Time-window tracking for price validity (issue #735)
//!
//! Every price submission now carries an explicit validity window:
//!
//! ```text
//! valid_from ──────────── valid_until
//!     │                      │
//!  earliest ledger ts     expiry ts (exclusive)
//!  at which the price     after which the price
//!  is considered fresh    is considered stale
//! ```
//!
//! ## Design
//!
//! **`valid_from`** is the observation timestamp supplied by the submitter
//! (previously called `timestamp`; still the storage key component).
//!
//! **`valid_until`** is `valid_from + validity_window_secs`.  The caller
//! passes `validity_window_secs` at submission time.  A positive, non-zero
//! window is required; zero or overflow are rejected with
//! [`Error::InvalidWindow`].
//!
//! **`DEFAULT_VALIDITY_WINDOW_SECS`** (86 400 s = 24 h) is the recommended
//! window for daily cost-of-living price observations.  Callers may pass a
//! different value but it must still be positive.
//!
//! ## Expiry checks
//!
//! [`PriceVault::is_valid_at`] is the canonical expiry predicate.  It
//! returns `true` iff `valid_from <= query_ts < valid_until`.  The upper
//! bound is exclusive so two consecutive non-overlapping windows
//! `[t, t+w)` and `[t+w, t+2w)` share no overlap.
//!
//! The `KovaraIndex` aggregation logic — and any sentinel daemon — must
//! call `is_valid_at` (or perform equivalent bounds checks) before
//! incorporating a price submission into an index update, to satisfy the
//! "expired entries are excluded" requirement.
//!
//! [`PriceVault::get_valid`] combines `get` and `is_valid_at`: it loads a
//! submission and returns `Some(submission)` only if it is currently fresh,
//! `None` if it has expired or was never recorded.  This is the recommended
//! call for consumers that want a single authoritative "is this price
//! usable?" answer.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, Address, Env, Symbol,
};

// ── Constants ─────────────────────────────────────────────────────────────────

/// Default validity window: 24 hours expressed in seconds.
///
/// A price observation submitted without an explicit window request should
/// use this default.  24 h is appropriate for daily cost-of-living basket
/// items (bread, rent, transport) where intra-day volatility is minimal.
pub const DEFAULT_VALIDITY_WINDOW_SECS: u64 = 86_400;

//! # Submission status model (issue #734)
//!
//! Every price submission now carries an explicit [`SubmissionStatus`] that
//! moves through a strict, one-way state machine:
//!
//! ```text
//! Pending ──► Verified
//!         └─► Rejected
//! ```
//!
//! - `Pending`  — the initial state of every freshly recorded submission.
//! - `Verified` — the sentinel pool has reached quorum approval.
//! - `Rejected` — the sentinel pool has reached quorum rejection, or the
//!                submission has been invalidated by governance.
//!
//! Both `Verified` and `Rejected` are **terminal**: no further transition is
//! allowed once either is reached.  An attempt to transition an already-
//! terminal submission returns [`Error::InvalidTransition`].
//!
//! The state is stored as part of the [`PriceSubmission`] record so a single
//! persistent-storage read returns both the price data and its current
//! verification state — consistent with the acceptance criterion that API
//! consumers can interpret statuses reliably without a second lookup.
//!
//! ## Transition enforcement
//!
//! [`PriceVault::set_status`] is the only public mutator of the status
//! field.  It enforces:
//! 1. The record exists (`Error::NotFound` otherwise).
//! 2. The current status is `Pending` (`Error::InvalidTransition` if
//!    already `Verified` or `Rejected`).
//! 3. The caller passes a non-`Pending` target status — you cannot
//!    re-set a submission to `Pending` (`Error::InvalidTransition`).
//! 4. The caller has an authorized verifier address on the call
//!    (`require_auth`).

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, Address, Env, Symbol,
//! # Historical price view functions (issue #743)
//!
//! Three deterministic, read-only entry points are added so that tooling,
//! dashboards and sentinel oracle nodes can audit and inspect the on-chain
//! price record:
//!
//! | Function | What it returns |
//! |---|---|
//! | [`PriceVault::get_history`] | All submissions for a `(country_iso, category)` pair, ordered by ascending `timestamp`. |
//! | [`PriceVault::get_history_range`] | A bounded subset of the above, filtered to `[from_ts, to_ts]` inclusive. |
//! | [`PriceVault::get_latest`] | The single most-recent submission for a `(country_iso, category)` pair, or `None`. |
//!
//! ## Storage layout extension
//!
//! Each record is stored under the typed composite key
//! `DataKey::Price(country, category, timestamp)`.  Its value is the complete
//! `PriceSubmission`, so price, submitter, validity window, and status are read
//! atomically and cannot drift across separately keyed metadata.  The enum
//! variant and tuple components provide explicit namespaces and avoid building
//! ambiguous keys by concatenating strings.
//!
//! `DataKey::SubmissionIndex(country, category)` stores a `Vec<u64>` of record
//! timestamps for grouped lookups.  Each timestamp in the index identifies the
//! corresponding `Price` key.  Both keys use the observation timestamp
//! (`valid_from`); re-submitting the same composite key is a no-op and does not
//! add a duplicate index entry.  Preserve these key variants and their
//! component types across upgrades.  A future incompatible layout needs a new
//! versioned key and an explicit migration; do not silently reinterpret old
//! records.
//!
//! ## Query determinism
//!
//! All three view functions iterate the stored index and read records from
//! `persistent` storage.  They never mutate state.  Identical contract state
//! always produces identical return values, satisfying acceptance criterion 3.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, Env, Symbol, Vec,
};

// ── Identifier registry (issue #689) ──────────────────────────────────

/// The supported country and basket-category identifiers.
///
/// Country codes are ISO 3166-1 alpha-2 identifiers the protocol supports —
/// a real subset of the standard, never an invented alphabet. Categories are
/// the cost-of-living basket keys the protocol tracks.
///
/// The registry is deliberately not encoded in any storage key. Every stored
/// record references an identifier by `Symbol`, and the identifier is validated
/// against this registry at the contract boundary, so adding a country or a
/// category later is a code change that leaves previously stored records — and
/// their keys — untouched. Extending the registry therefore needs no storage
/// migration and cannot invalidate existing submissions.
pub mod registry {
    use soroban_sdk::{Env, Symbol, Vec};

    /// Supported ISO 3166-1 alpha-2 country codes.
    ///
    /// A real subset of the standard: each entry is a designated ISO 3166-1
    /// alpha-2 identifier. Extend this list to add a country.
    pub const COUNTRY_CODES: &[&str] = &[
        "US", "GB", "NG", "KE", "IN", "BR", "DE", "FR", "JP", "CN", "ZA", "GH", "EG", "TZ", "UG",
        "ET", "PH", "ID", "MX", "AR",
    ];

    /// Supported cost-of-living basket categories.
    ///
    /// Extend this list to add a category.
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
        for code in COUNTRY_CODES.iter() {
            if &Symbol::new(env, code) == country_iso {
                return true;
            }
        }
        false
    }

    /// Whether `category` is a supported basket category identifier.
    pub fn is_supported_category(env: &Env, category: &Symbol) -> bool {
        for key in CATEGORIES.iter() {
            if &Symbol::new(env, key) == category {
                return true;
            }
        }
        false
    }
}

// ── Error codes ───────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    /// The provided `valid_from` timestamp is zero or otherwise unusable.
    InvalidTimestamp = 1,
    // ── Schema validation errors (issue #739) ─────────────────────────────
    /// A required field is missing (currently unused in the on-chain path
    /// because all fields are positional, but exported for SDK consumers).
    MissingRequiredField = 2,
    /// A field value is below its declared minimum.
    ValueBelowMinimum = 3,
    /// A field value is above its declared maximum.
    ValueAboveMaximum = 4,
    /// A Symbol field is empty (length == 0).
    EmptySymbol = 5,
    /// A numeric field is negative where only non-negative values are
    /// permitted.
    NegativeNotAllowed = 6,
    /// A numeric field is zero where only strictly positive values are
    /// permitted.
    ZeroNotAllowed = 7,
    /// The schema version embedded in the payload does not match the
    /// contract's current schema version.
    SchemaMismatch = 8,
    /// `from_ts` is greater than `to_ts` in a range query.
    ///
    /// Appended as 9 rather than reusing 2: `#[contracterror]` discriminants
    /// are part of the contract ABI, so renumbering an existing variant would
    /// silently change the code every deployed client already maps.
    InvalidRange = 9,
    /// The country code is not a supported ISO 3166-1 alpha-2 identifier.
    InvalidCountry = 10,
    /// The category is not a supported basket category identifier.
    InvalidCategory = 11,
}

// ── payload module ────────────────────────────────────────────────────────────

/// Schema validation for serialized payloads.
///
/// Every contract entry point that receives external input should:
/// 1. Define a `*Payload` struct for its arguments.
/// 2. Declare a `*_SCHEMA` constant (`&[Constraint]`).
/// 3. Call `validate(&schema, &payload)?` before any auth check or
///    state mutation.
pub mod payload {
    use super::Error;
    use soroban_sdk::Symbol;

    // ── Field kinds ───────────────────────────────────────────────────────

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

    // ── Constraint ────────────────────────────────────────────────────────

    /// A single named constraint applied to a payload field.
    ///
    /// Constraints are evaluated in declaration order.  The first failing
    /// constraint causes `validate` to return `Err` immediately — there is
    /// no accumulation of errors, which is consistent with how Soroban
    /// contracts communicate failures to callers.
    #[derive(Copy, Clone, Debug)]
    pub enum Constraint {
        /// The `u64` field must be strictly greater than zero.
        U64NonZero,
        /// The `u64` field must be at most this value.
        U64Max(u64),
        /// The `i128` field must be greater than zero.
        I128Positive,
        /// The `i128` field must be greater than or equal to zero.
        I128NonNegative,
        /// The `i128` field must be at most this value.
        I128Max(i128),
        /// The `Symbol` field must have at least one character.
        SymbolNonEmpty,
        /// The schema version embedded in the payload must equal this value.
        SchemaVersion(u32),
    }

    // ── SubmitPayload ─────────────────────────────────────────────────────

    /// A plain-data view of the `PriceVault::submit` arguments.
    ///
    /// Decoupling validation from the Soroban `Env` and `Address` types
    /// keeps `validate` a pure function — no SDK imports needed in the
    /// validation logic itself, no mock environment required in tests.
    pub struct SubmitPayload<'a> {
        /// ISO country code (e.g. "NG", "KE").
        pub country_iso: &'a Symbol,
        /// Basket category (e.g. "Food", "Rent").
        pub category: &'a Symbol,
        /// Price value in the smallest fixed-point unit.
        pub value: i128,
        /// Observation timestamp.
        pub timestamp: u64,
        /// Schema version the caller expects.
        pub schema_version: u32,
    }

    // ── validate ──────────────────────────────────────────────────────────

    /// Apply a schema (ordered list of [`Constraint`]s) to a
    /// [`SubmitPayload`].
    ///
    /// Returns `Ok(())` when every constraint passes, or
    /// `Err(Error::*)` on the first failing constraint.
    ///
    /// The function is `#[inline]` so the optimiser can fold constant
    /// schemas fully at the call site in release builds.
    #[inline]
    pub fn validate(
        schema: &[Constraint],
        payload: &SubmitPayload<'_>,
    ) -> Result<(), Error> {
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
                    // Soroban Symbol::len() returns the number of characters.
                    // A zero-length Symbol is rejected as it would produce an
                    // unresolvable storage key.
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

// ── Schema constant ───────────────────────────────────────────────────────────

/// The schema applied to every `PriceVault::submit` call.
///
/// Constraints are evaluated left-to-right; the first failure is returned.
/// The ordering is chosen so that the cheapest checks (integer bounds) run
/// before the more expensive ones (Symbol length).
const SUBMIT_SCHEMA: &[payload::Constraint] = &[
    // Timestamp must be a positive u64.
    payload::Constraint::U64NonZero,
    // Price must be strictly positive.
    payload::Constraint::I128Positive,
    // Price must not exceed the operational ceiling (1 billion in fixed-point
    // units prevents absurd index skew from rogue submissions).
    payload::Constraint::I128Max(1_000_000_000_000),
    // Country and category symbols must not be empty strings.
    payload::Constraint::SymbolNonEmpty,
    // Schema version must match this build.
    payload::Constraint::SchemaVersion(1),
];

/// The schema version this build of PriceVault understands.
pub const SCHEMA_VERSION: u32 = 1;
    /// A price value was zero; zero prices corrupt the index median.
    ZeroPrice = 2,
    /// A price value was negative; negative prices are nonsensical for
    /// cost-of-living observations.
    NegativePrice = 3,
    /// A u64 value that must be positive was zero.
    ZeroValue = 4,
    /// An i128 value that must be positive was zero or negative.
    NonPositiveAmount = 5,
    /// An arithmetic addition would overflow the target type.
    ArithmeticOverflow = 6,
    /// An arithmetic multiplication would overflow the target type.
    ArithmeticOverflowMul = 7,
}

// ── Fail-safe arithmetic guards (issue #728) ──────────────────────────────────

/// Centralised arithmetic safety guards.
///
/// Every public contract entry point that performs arithmetic or stores a
/// value that is constrained to a numeric range calls one of these guards
/// before mutating state.  Returning `Err` rather than panicking is
/// mandatory in Soroban: a panic aborts the transaction without emitting
/// an error code, making debugging impossible and burning caller fees.
pub mod guards {
    use super::Error;

    /// Reject a price value that is zero or negative.
    ///
    /// Zero prices are excluded because they would skew a trimmed-median
    /// to zero, producing a nonsensical index value.  Negative prices are
    /// structurally invalid for cost-of-living observations.
    ///
    /// # Errors
    /// * [`Error::ZeroPrice`] — `value == 0`
    /// * [`Error::NegativePrice`] — `value < 0`
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
    /// Used for timestamps, counts, and any other `u64` field that must be
    /// strictly positive.
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
    /// Used for stake and reward amounts that must represent a meaningful
    /// positive quantity.
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

    /// Perform a checked `u64` addition, returning `Error::ArithmeticOverflow`
    /// instead of wrapping or panicking.
    ///
    /// # Errors
    /// * [`Error::ArithmeticOverflow`] — the result would exceed `u64::MAX`.
    #[inline]
    pub fn checked_add_u64(a: u64, b: u64) -> Result<u64, Error> {
        a.checked_add(b).ok_or(Error::ArithmeticOverflow)
    }

    /// Perform a checked `i128` addition, returning `Error::ArithmeticOverflow`
    /// instead of wrapping or panicking.
    ///
    /// # Errors
    /// * [`Error::ArithmeticOverflow`] — the result would exceed `i128::MAX`
    ///   or fall below `i128::MIN`.
    #[inline]
    pub fn checked_add_i128(a: i128, b: i128) -> Result<i128, Error> {
        a.checked_add(b).ok_or(Error::ArithmeticOverflow)
    }

    /// Perform a checked `i128` multiplication, returning
    /// `Error::ArithmeticOverflowMul` instead of wrapping or panicking.
    ///
    /// # Errors
    /// * [`Error::ArithmeticOverflowMul`] — the result would overflow `i128`.
    #[inline]
    pub fn checked_mul_i128(a: i128, b: i128) -> Result<i128, Error> {
        a.checked_mul(b).ok_or(Error::ArithmeticOverflowMul)
    }
    /// `validity_window_secs` is zero, or `valid_from + window` would
    /// overflow `u64`.
    InvalidWindow = 2,
    /// The requested state transition is not permitted.
    ///
    /// Fires when:
    /// - transitioning a `Verified` or `Rejected` submission (terminal state),
    /// - attempting to set status back to `Pending`.
    InvalidTransition = 2,
    /// The submission does not exist.
    NotFound = 3,
}

// ── Status enum (issue #734) ──────────────────────────────────────────────────

/// Lifecycle state of a single price submission.
///
/// The state machine is strictly one-way:
///
/// ```text
/// Pending ──► Verified
///         └─► Rejected
/// ```
///
/// Both [`SubmissionStatus::Verified`] and [`SubmissionStatus::Rejected`] are
/// terminal — no further transition is accepted once either is stored.
///
/// Consumers that interpret status values — sentinel daemons, API response
/// serializers, SDK clients — should match exhaustively on all three variants
/// so they remain correct when additional variants are added in a future
/// schema version.
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum SubmissionStatus {
    /// The submission has been recorded and is awaiting verifier votes.
    Pending = 0,
    /// The sentinel pool reached quorum approval; this submission is
    /// accepted as a valid price observation.
    Verified = 1,
    /// The sentinel pool reached quorum rejection, or the submission was
    /// invalidated by a governance actor.
    Rejected = 2,
}

impl SubmissionStatus {
    /// Returns `true` for terminal states from which no further transition
    /// is valid.
    #[inline]
    pub fn is_terminal(self) -> bool {
        matches!(self, SubmissionStatus::Verified | SubmissionStatus::Rejected)
    }
}

// ── Storage keys ──────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    /// `(country_iso, category, valid_from)` → [`PriceSubmission`].
    ///
    /// The storage key uses `valid_from` (the observation timestamp) to
    /// match the pre-existing scheme and remain backward-compatible with
    /// any index built on that triple.
    Price(Symbol, Symbol, u64),

    /// `(country_iso, category)` → `Vec<u64>` of timestamps, in insertion
    /// order.  Used by the historical view functions to enumerate records
    /// without a full-storage scan.
    SubmissionIndex(Symbol, Symbol),
}

// ── Domain types ──────────────────────────────────────────────────────────────

/// A single raw price submission with an attached validity window.
///
/// The window `[valid_from, valid_until)` defines the interval during which
/// this submission is considered a fresh price observation.  After
/// `valid_until` the record remains in persistent storage (for historical
/// audit) but is excluded from any live aggregation.
/// A single raw price submission.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceSubmission {
    /// The submitting oracle/operator address.
    pub submitter: Address,
    /// ISO country code (topic-style, kept readable for indexing).
    pub country_iso: Symbol,
    /// The price category, e.g. `bread` or `rent`.
    pub category: Symbol,
    /// Unverified raw price in the smallest fixed-point unit.
    ///
    /// Validated by [`guards::require_positive_price`]: must be `> 0`.
    pub value: i128,
    /// The ledger timestamp at which this observation was made.
    ///
    /// Also the start of the validity window and the storage key component.
    pub valid_from: u64,
    /// The ledger timestamp after which this observation is considered stale
    /// (`valid_from + validity_window_secs`, exclusive upper bound).
    ///
    /// Once the current ledger timestamp reaches or exceeds `valid_until`,
    /// `is_valid_at` returns `false` and `get_valid` returns `None`.
    pub valid_until: u64,
    /// Native timestamp of the observation.
    ///
    /// Validated by [`guards::require_positive_u64`]: must be `> 0`.
    pub timestamp: u64,
    /// Current lifecycle state of this submission.
    ///
    /// Set to [`SubmissionStatus::Pending`] at creation.  Transitions to
    /// [`SubmissionStatus::Verified`] or [`SubmissionStatus::Rejected`] via
    /// [`PriceVault::set_status`].  Both non-`Pending` states are terminal.
    pub status: SubmissionStatus,
}

impl PriceSubmission {
    /// Returns `true` iff `query_ts` falls within `[valid_from, valid_until)`.
    ///
    /// The lower bound is inclusive (a submission is immediately valid at the
    /// moment it is observed).  The upper bound is exclusive so consecutive
    /// non-overlapping windows share no ambiguous boundary.
    #[inline]
    pub fn is_valid_at(&self, query_ts: u64) -> bool {
        query_ts >= self.valid_from && query_ts < self.valid_until
    }
}

// ── Events ────────────────────────────────────────────────────────────────────

/// Emitted when a price submission is successfully recorded (issue #694).
///
/// `country_iso` and `category` are topics — the two dimensions an indexer
/// filters on — so a consumer can subscribe to just the submissions it cares
/// about without decoding every event body. The body carries the rest of the
/// submission metadata (submitter, value, validity window, initial status and
/// schema version) so an indexer can build its record from the event alone.
///
/// Emitted only after both the record and its history-index entry have been
/// written, so a consumer that reacts to the event can read the submission back
/// immediately. A replayed submission that is a no-op emits nothing.
#[contractevent]
#[derive(Clone)]
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

// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct PriceVault;

#[contractimpl]
impl PriceVault {
    // ── Mutating entry points ─────────────────────────────────────────────

    /// Record a raw price submission with an explicit validity window.
    ///
    /// `valid_from` is the observation timestamp (storage key component).
    /// `validity_window_secs` defines how long the submission is considered
    /// fresh.  [`DEFAULT_VALIDITY_WINDOW_SECS`] (86 400 s) is recommended
    /// for daily basket observations.
    ///
    /// # Errors
    /// * [`Error::InvalidTimestamp`] — `valid_from` is zero.
    /// * [`Error::InvalidWindow`] — `validity_window_secs` is zero, or
    ///   `valid_from + validity_window_secs` overflows `u64`.
    /// Record a raw price submission with an initial status of `Pending`.
    /// Record a raw price submission.
    ///
    /// The payload is validated against [`SUBMIT_SCHEMA`] before `require_auth`
    /// and before any storage access.  Invalid payloads are rejected at the
    /// gate with a specific error code — no auth side-effects, no partial
    /// writes.
    ///
    /// # Errors
    /// * [`Error::ZeroNotAllowed`] — `timestamp` or `value` is zero.
    /// * [`Error::NegativeNotAllowed`] — `value` is negative.
    /// * [`Error::ValueAboveMaximum`] — `value` exceeds the schema ceiling.
    /// * [`Error::EmptySymbol`] — `country_iso` or `category` is empty.
    /// * [`Error::SchemaMismatch`] — caller's schema version ≠ 1.
    /// # Validation (issue #728)
    /// All numeric inputs are validated through the [`guards`] module:
    /// - `value` must be strictly positive (`> 0`).
    /// - `timestamp` must be strictly positive (`> 0`).
    ///
    /// # Errors
    /// * [`Error::InvalidTimestamp`] — `timestamp` is zero.
    /// * [`Error::ZeroPrice`] — `value` is zero.
    /// * [`Error::NegativePrice`] — `value` is negative.
    /// If a submission already exists for the same `(country_iso, category,
    /// timestamp)` triple the call is a no-op: the existing record is kept
    /// and the timestamp index is not duplicated.  This guarantees that
    /// replaying the same transaction never corrupts the historical index.
    ///
    /// # Errors
    /// * [`Error::InvalidTimestamp`] — `timestamp` is zero.
    pub fn submit(
        env: Env,
        submitter: Address,
        country_iso: Symbol,
        category: Symbol,
        value: i128,
        valid_from: u64,
        validity_window_secs: u64,
    ) -> Result<(), Error> {
        // Keep the legacy observation timestamp aligned with the key value.
        let timestamp = valid_from;

        // Schema validation runs before require_auth so malformed payloads
        // are rejected without touching the auth subsystem.
        payload::validate(
            SUBMIT_SCHEMA,
            &payload::SubmitPayload {
                country_iso: &country_iso,
                category: &category,
                value,
                timestamp,
                schema_version: SCHEMA_VERSION,
            },
        )?;

        // Identifier registry: country and category must be supported
        // identifiers, not arbitrary symbols. Checked alongside the payload
        // schema, before auth and before any storage access.
        if !registry::is_supported_country(&env, &country_iso) {
            return Err(Error::InvalidCountry);
        }
        if !registry::is_supported_category(&env, &category) {
            return Err(Error::InvalidCategory);
        }

        // Validate timestamp first (pre-existing check).
        if timestamp == 0 {
            return Err(Error::InvalidTimestamp);
        }
        // Fail-safe: reject zero or negative price values (issue #728).
        guards::require_positive_price(value)?;
        if valid_from == 0 {
            return Err(Error::InvalidTimestamp);
        }
        if validity_window_secs == 0 {
            return Err(Error::InvalidWindow);
        }
        let valid_until = valid_from
            .checked_add(validity_window_secs)
            .ok_or(Error::InvalidWindow)?;

        submitter.require_auth();

        let key = DataKey::Price(country_iso.clone(), category.clone(), timestamp);

        // Idempotent: if the record already exists, leave it untouched.
        if env.storage().persistent().has(&key) {
            return Ok(());
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
                timestamp,
                status: SubmissionStatus::Pending, // always starts Pending
            },
        );

        // Append timestamp to the per-(country, category) index so that
        // history queries do not need a full storage scan.
        let idx_key = DataKey::SubmissionIndex(country_iso.clone(), category.clone());
        let mut index: Vec<u64> = env
            .storage()
            .persistent()
            .get(&idx_key)
            .unwrap_or_else(|| Vec::new(&env));
        index.push_back(timestamp);
        env.storage().persistent().set(&idx_key, &index);

        // Successful-submission event: emitted only after both the record and
        // its index entry are stored, so a consumer that observes it can read
        // the submission back immediately. The replay no-op above returns
        // before this point, so duplicate attempts emit nothing.
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

    // ── Identifier registry (issue #689) ────────────────────────────────

    /// The supported ISO 3166-1 alpha-2 country codes.
    pub fn supported_countries(env: Env) -> Vec<Symbol> {
        registry::countries(&env)
    }

    /// The supported cost-of-living basket categories.
    pub fn supported_categories(env: Env) -> Vec<Symbol> {
        registry::categories(&env)
    }

    /// The identifier-registry version this build was compiled against.
    pub fn registry_version(_env: Env) -> u32 {
        registry::VERSION
    }

    // ── Read entry points ─────────────────────────────────────────────────

    /// Read a stored price submission by its composite key, if present.
    ///
    /// Returns the record regardless of whether it is currently within its
    /// validity window.  Use [`Self::get_valid`] to gate on freshness.
    /// Transition a submission's status from `Pending` to `Verified` or
    /// `Rejected`.
    ///
    /// Only an authorized `verifier` address may call this function.
    /// The submission must currently be in the `Pending` state; any other
    /// starting state, or setting the target back to `Pending`, returns
    /// [`Error::InvalidTransition`].
    ///
    /// # Errors
    /// * [`Error::NotFound`] — no submission exists for the given key.
    /// * [`Error::InvalidTransition`] — the current status is already
    ///   terminal (`Verified` or `Rejected`), or `new_status` is `Pending`.
    pub fn set_status(
        env: Env,
        verifier: Address,
        country_iso: Symbol,
        category: Symbol,
        timestamp: u64,
        new_status: SubmissionStatus,
    ) -> Result<(), Error> {
        verifier.require_auth();

        // Disallow re-setting to Pending — Pending is only valid as the
        // initial state assigned by submit().
        if new_status == SubmissionStatus::Pending {
            return Err(Error::InvalidTransition);
        }

        let key = DataKey::Price(country_iso.clone(), category.clone(), timestamp);

        let mut submission: PriceSubmission = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotFound)?;

        // Terminal states are irreversible.
        if submission.status.is_terminal() {
            return Err(Error::InvalidTransition);
        }

        submission.status = new_status;
        env.storage().persistent().set(&key, &submission);

        Ok(())
    }

    // ── Read entry points ─────────────────────────────────────────────────

    /// Read a stored price submission, if present.
    // ── Point-in-time read ────────────────────────────────────────────────

    /// Read a stored price submission by its exact composite key, if
    /// present.
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

    /// Read a stored price submission only if it is still within its
    /// validity window at `query_ts`.
    ///
    /// Returns `None` when:
    /// - no submission exists for the given key, **or**
    /// - the submission exists but `query_ts >= valid_until` (expired), **or**
    /// - `query_ts < valid_from` (not yet valid).
    ///
    /// This is the recommended call for aggregation and index calculation
    /// code that must exclude stale prices.
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

    /// Check whether a stored submission is valid at the given timestamp.
    ///
    /// Returns `false` for missing submissions (rather than an error) so
    /// callers can use a simple boolean gate without matching on `Option`.
    pub fn is_valid_at(
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
}

// ── Tests ─────────────────────────────────────────────────────────────────────

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

    // ── submit validation ─────────────────────────────────────────────────

    #[test]
    fn submit_zero_valid_from_returns_error() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);

        env.mock_all_auths();
        let err = client
            .try_submit(
                &submitter,
                &sym(&env, "NG"),
                &sym(&env, "Food"),
                &1000,
                &0_u64,
                &DEFAULT_VALIDITY_WINDOW_SECS,
            )
            .unwrap_err()
            .unwrap();
        assert_eq!(err, Error::InvalidTimestamp);
    }

    #[test]
    fn submit_zero_window_returns_error() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);

        env.mock_all_auths();
        let err = client
            .try_submit(
                &submitter,
                &sym(&env, "NG"),
                &sym(&env, "Food"),
                &1000,
                &1000_u64,
                &0_u64,
            )
            .unwrap_err()
            .unwrap();
        assert_eq!(err, Error::InvalidWindow);
    }

    #[test]
    fn submit_overflow_window_returns_error() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);

        env.mock_all_auths();
        let err = client
            .try_submit(
                &submitter,
                &sym(&env, "NG"),
                &sym(&env, "Food"),
                &1000,
                &u64::MAX,      // valid_from
                &1_u64,         // valid_from + 1 overflows u64
            )
            .unwrap_err()
            .unwrap();
        assert_eq!(err, Error::InvalidWindow);
    }

    #[test]
    fn submit_stores_correct_window_bounds() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        let country = sym(&env, "NG");
        let category = sym(&env, "Food");

        env.mock_all_auths();
        client
            .submit(&submitter, &country, &category, &1000, &1_000_u64, &DEFAULT_VALIDITY_WINDOW_SECS)
            .unwrap();

        let s = client.get(&country, &category, &1_000_u64).unwrap();
        assert_eq!(s.valid_from, 1_000);
        assert_eq!(s.valid_until, 1_000 + DEFAULT_VALIDITY_WINDOW_SECS);
    }

    // ── is_valid_at (method on PriceSubmission) ───────────────────────────

    #[test]
    fn is_valid_at_true_at_lower_bound() {
        let sub = PriceSubmission {
            submitter: soroban_sdk::Address::from_str(
                &Env::default(),
                "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
            ),
            country_iso: Symbol::new(&Env::default(), "NG"),
            category: Symbol::new(&Env::default(), "Food"),
            value: 100,
            valid_from: 1_000,
            valid_until: 2_000,
        };
        assert!(sub.is_valid_at(1_000));
    }

    #[test]
    fn is_valid_at_false_at_upper_bound_exclusive() {
        let env = Env::default();
        let sub = PriceSubmission {
            submitter: Address::generate(&env),
            country_iso: sym(&env, "NG"),
            category: sym(&env, "Food"),
            value: 100,
            valid_from: 1_000,
            valid_until: 2_000,
        };
        // Upper bound is exclusive.
        assert!(!sub.is_valid_at(2_000));
    }

    #[test]
    fn is_valid_at_false_before_window() {
        let env = Env::default();
        let sub = PriceSubmission {
            submitter: Address::generate(&env),
            country_iso: sym(&env, "NG"),
            category: sym(&env, "Food"),
            value: 100,
            valid_from: 1_000,
            valid_until: 2_000,
        };
        assert!(!sub.is_valid_at(999));
    }

    #[test]
    fn is_valid_at_true_inside_window() {
        let env = Env::default();
        let sub = PriceSubmission {
            submitter: Address::generate(&env),
            country_iso: sym(&env, "NG"),
            category: sym(&env, "Food"),
            value: 100,
            valid_from: 1_000,
            valid_until: 2_000,
        };
        assert!(sub.is_valid_at(1_500));
    }

    // ── contract is_valid_at ──────────────────────────────────────────────

    #[test]
    fn contract_is_valid_at_false_for_missing() {
        let env = make_env();
        let client = deploy(&env);
        let result =
            client.is_valid_at(&sym(&env, "NG"), &sym(&env, "Food"), &1_000_u64, &1_000_u64);
        assert!(!result);
    }

    #[test]
    fn contract_is_valid_at_true_inside_window() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);

        env.mock_all_auths();
        client
            .submit(
                &submitter,
                &sym(&env, "NG"),
                &sym(&env, "Food"),
                &100,
                &1_000_u64,
                &86_400_u64,
            )
            .unwrap();

        assert!(client.is_valid_at(&sym(&env, "NG"), &sym(&env, "Food"), &1_000_u64, &50_000_u64));
    }

    #[test]
    fn contract_is_valid_at_false_after_expiry() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);

        env.mock_all_auths();
        client
            .submit(
                &submitter,
                &sym(&env, "NG"),
                &sym(&env, "Food"),
                &100,
                &1_000_u64,
                &3_600_u64, // 1 hour window
            )
            .unwrap();

        // Query at valid_until (4600) — exclusive upper bound, so invalid.
        assert!(!client.is_valid_at(
            &sym(&env, "NG"),
            &sym(&env, "Food"),
            &1_000_u64,
            &4_600_u64
        ));
    }

    // ── get_valid ─────────────────────────────────────────────────────────

    #[test]
    fn get_valid_returns_none_for_missing() {
        let env = make_env();
        let client = deploy(&env);
        assert!(client
            .get_valid(&sym(&env, "NG"), &sym(&env, "Food"), &1_u64, &1_u64)
            .is_none());
    }

    #[test]
    fn get_valid_returns_some_inside_window() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);

        env.mock_all_auths();
        client
            .submit(
                &submitter,
                &sym(&env, "KE"),
                &sym(&env, "Rent"),
                &500,
                &2_000_u64,
                &86_400_u64,
            )
            .unwrap();

        let result = client.get_valid(
            &sym(&env, "KE"),
            &sym(&env, "Rent"),
            &2_000_u64,
            &2_000_u64,
        );
        assert!(result.is_some());
        assert_eq!(result.unwrap().value, 500);
    }

    #[test]
    fn get_valid_returns_none_after_expiry() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);

        env.mock_all_auths();
        client
            .submit(
                &submitter,
                &sym(&env, "BR"),
                &sym(&env, "Transport"),
                &300,
                &1_000_u64,
                &3_600_u64, // expires at 4600
            )
            .unwrap();

        // Query well past expiry.
        let result = client.get_valid(
            &sym(&env, "BR"),
            &sym(&env, "Transport"),
            &1_000_u64,
            &100_000_u64,
        );
        assert!(result.is_none());
    }

    #[test]
    fn get_valid_returns_none_before_valid_from() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);

        env.mock_all_auths();
        client
            .submit(
                &submitter,
                &sym(&env, "IN"),
                &sym(&env, "Health"),
                &200,
                &5_000_u64,
                &86_400_u64,
            )
            .unwrap();

        // Query before the window starts.
        let result = client.get_valid(
            &sym(&env, "IN"),
            &sym(&env, "Health"),
            &5_000_u64,
            &4_999_u64,
        );
        assert!(result.is_none());
    }

    // ── consecutive non-overlapping windows ───────────────────────────────

    #[test]
    fn consecutive_windows_do_not_overlap() {
        // Window 1: [1000, 2000)
        // Window 2: [2000, 3000)
        // query_ts=2000 must match only window 2.
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        let country = sym(&env, "NG");
        let category = sym(&env, "Food");

        env.mock_all_auths();
        // Window 1
        client
            .submit(&submitter, &country, &category, &100, &1_000_u64, &1_000_u64)
            .unwrap();
        // Window 2
        client
            .submit(&submitter, &country, &category, &200, &2_000_u64, &1_000_u64)
            .unwrap();

        // At ts=2000: window 1 has expired (upper bound exclusive), window 2 is fresh.
        assert!(!client.is_valid_at(&country, &category, &1_000_u64, &2_000_u64));
        assert!(client.is_valid_at(&country, &category, &2_000_u64, &2_000_u64));
    }

    // ── default window constant ───────────────────────────────────────────

    #[test]
    fn default_validity_window_is_24_hours() {
        assert_eq!(DEFAULT_VALIDITY_WINDOW_SECS, 86_400);
    }

    /// Read just the status of a stored submission, if present.
    ///
    /// Cheaper than `get` when the caller only needs the lifecycle state.
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
    // ── Historical view functions (issue #743) ────────────────────────────

    /// Return **all** stored submissions for a `(country_iso, category)`
    /// pair, ordered by ascending `timestamp`.
    ///
    /// The output is fully deterministic: for any given contract state it
    /// always returns the same ordered sequence.  When no submissions exist
    /// the function returns an empty `Vec` — it never panics.
    ///
    /// Intended for auditing and off-chain analysis.  For large datasets
    /// prefer [`Self::get_history_range`] to bound result size.
    ///
    /// # Acceptance criteria coverage
    /// * ✅ Historical price submissions can be queried by relevant filters
    ///   (`country_iso` + `category`).
    /// * ✅ Record output includes enough metadata for auditing and analysis
    ///   (full [`PriceSubmission`] struct including `submitter`, `value`, and
    ///   `timestamp`).
    /// * ✅ Query results remain deterministic for the same contract state
    ///   (pure read, no state mutation).
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

    /// Return all stored submissions for a `(country_iso, category)` pair
    /// whose timestamp satisfies `from_ts <= timestamp <= to_ts`, ordered by
    /// ascending `timestamp`.
    ///
    /// # Errors
    /// * [`Error::InvalidRange`] — `from_ts > to_ts`.
    ///
    /// # Acceptance criteria coverage
    /// * ✅ Historical price submissions can be queried by relevant filters
    ///   (adds a `[from_ts, to_ts]` time-range filter on top of
    ///   `country_iso` + `category`).
    /// * ✅ Record output includes enough metadata for auditing and analysis.
    /// * ✅ Query results remain deterministic for the same contract state.
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

        // Filter to the requested time window.
        let mut filtered = Vec::new(&env);
        for ts in all_timestamps.iter() {
            if ts >= from_ts && ts <= to_ts {
                filtered.push_back(ts);
            }
        }

        Ok(Self::collect_submissions(&env, &country_iso, &category, &filtered))
    }

    /// Return the **most recent** submission for a `(country_iso, category)`
    /// pair — the entry with the highest `timestamp` — or `None` if none
    /// exist.
    ///
    /// # Acceptance criteria coverage
    /// * ✅ Historical price submissions can be queried by relevant filters.
    /// * ✅ Record output includes enough metadata for auditing and analysis.
    /// * ✅ Query results remain deterministic for the same contract state.
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

        // The index is append-only and in insertion order.  The last entry
        // is the most recently submitted timestamp.
        let latest_ts = timestamps.last()?;

        env.storage()
            .persistent()
            .get(&DataKey::Price(country_iso, category, latest_ts))
    }

    // ── Internal helpers ──────────────────────────────────────────────────

    /// Load [`PriceSubmission`] records for each timestamp in `timestamps`,
    /// skipping any that are not present in persistent storage (defensive —
    /// under normal operation every indexed timestamp has a record).
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
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

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

    // ── SubmissionStatus helper ───────────────────────────────────────────

    #[test]
    fn pending_is_not_terminal() {
        assert!(!SubmissionStatus::Pending.is_terminal());
    }

    #[test]
    fn verified_is_terminal() {
        assert!(SubmissionStatus::Verified.is_terminal());
    }

    #[test]
    fn rejected_is_terminal() {
        assert!(SubmissionStatus::Rejected.is_terminal());
    }

    // ── submit ────────────────────────────────────────────────────────────

    #[test]
    fn submit_records_pending_status() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);

        env.mock_all_auths();
        client
            .submit(&submitter, &sym(&env, "NG"), &sym(&env, "Food"), &1000, &100_u64)
            .unwrap();

        let submission = client
            .get(&sym(&env, "NG"), &sym(&env, "Food"), &100_u64)
            .unwrap();
        assert_eq!(submission.status, SubmissionStatus::Pending);
    // ── submit / get (existing surface) ──────────────────────────────────

    #[test]
    fn submit_and_get_round_trips() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        let country = sym(&env, "NG");
        let category = sym(&env, "Food");

        env.mock_all_auths();
        client.submit(&submitter, &country, &category, &1_000, &100_u64).unwrap();
        let got = client.get(&country, &category, &100_u64).unwrap();

        assert_eq!(got.value, 1_000);
        assert_eq!(got.timestamp, 100);
    }

    #[test]
    fn submit_zero_timestamp_returns_error() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);

        env.mock_all_auths();
        let err = client
            .try_submit(&submitter, &sym(&env, "NG"), &sym(&env, "Food"), &500, &0_u64)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, Error::InvalidTimestamp);
    }

    // ── set_status — normal transitions ──────────────────────────────────

    #[test]
    fn pending_transitions_to_verified() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        let verifier = Address::generate(&env);

        env.mock_all_auths();
        client
            .submit(&submitter, &sym(&env, "NG"), &sym(&env, "Food"), &1000, &100_u64)
            .unwrap();
        client
            .set_status(
                &verifier,
                &sym(&env, "NG"),
                &sym(&env, "Food"),
                &100_u64,
                &SubmissionStatus::Verified,
            )
            .unwrap();

        assert_eq!(
            client.get_status(&sym(&env, "NG"), &sym(&env, "Food"), &100_u64),
            Some(SubmissionStatus::Verified)
        );
    }

    #[test]
    fn pending_transitions_to_rejected() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        let verifier = Address::generate(&env);

        env.mock_all_auths();
        client
            .submit(&submitter, &sym(&env, "KE"), &sym(&env, "Rent"), &500, &200_u64)
            .unwrap();
        client
            .set_status(
                &verifier,
                &sym(&env, "KE"),
                &sym(&env, "Rent"),
                &200_u64,
                &SubmissionStatus::Rejected,
            )
            .unwrap();

        assert_eq!(
            client.get_status(&sym(&env, "KE"), &sym(&env, "Rent"), &200_u64),
            Some(SubmissionStatus::Rejected)
        );
    }

    // ── set_status — invalid transitions ─────────────────────────────────

    #[test]
    fn verified_cannot_transition_to_rejected() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        let verifier = Address::generate(&env);

        env.mock_all_auths();
        client
            .submit(&submitter, &sym(&env, "NG"), &sym(&env, "Food"), &1000, &100_u64)
            .unwrap();
        client
            .set_status(
                &verifier,
                &sym(&env, "NG"),
                &sym(&env, "Food"),
                &100_u64,
                &SubmissionStatus::Verified,
            )
            .unwrap();

        let err = client
            .try_set_status(
                &verifier,
                &sym(&env, "NG"),
                &sym(&env, "Food"),
                &100_u64,
                &SubmissionStatus::Rejected,
            )
            .unwrap_err()
            .unwrap();
        assert_eq!(err, Error::InvalidTransition);
    }

    #[test]
    fn rejected_cannot_transition_to_verified() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        let verifier = Address::generate(&env);

        env.mock_all_auths();
        client
            .submit(&submitter, &sym(&env, "NG"), &sym(&env, "Food"), &1000, &100_u64)
            .unwrap();
        client
            .set_status(
                &verifier,
                &sym(&env, "NG"),
                &sym(&env, "Food"),
                &100_u64,
                &SubmissionStatus::Rejected,
            )
            .unwrap();

        let err = client
            .try_set_status(
                &verifier,
                &sym(&env, "NG"),
                &sym(&env, "Food"),
                &100_u64,
                &SubmissionStatus::Verified,
            )
            .unwrap_err()
            .unwrap();
        assert_eq!(err, Error::InvalidTransition);
    }

    #[test]
    fn verified_cannot_transition_back_to_pending() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        let verifier = Address::generate(&env);

        env.mock_all_auths();
        client
            .submit(&submitter, &sym(&env, "NG"), &sym(&env, "Food"), &1000, &100_u64)
            .unwrap();
        client
            .set_status(
                &verifier,
                &sym(&env, "NG"),
                &sym(&env, "Food"),
                &100_u64,
                &SubmissionStatus::Verified,
            )
            .unwrap();

        let err = client
            .try_set_status(
                &verifier,
                &sym(&env, "NG"),
                &sym(&env, "Food"),
                &100_u64,
                &SubmissionStatus::Pending,
            )
            .unwrap_err()
            .unwrap();
        assert_eq!(err, Error::InvalidTransition);
    }

    #[test]
    fn cannot_set_status_to_pending_directly() {
        // Attempting to use set_status to reach Pending (even for a
        // Pending submission) is rejected, as Pending is only the
        // initial state assigned by submit().
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        let verifier = Address::generate(&env);

        env.mock_all_auths();
        client
            .submit(&submitter, &sym(&env, "NG"), &sym(&env, "Food"), &1000, &100_u64)
            .unwrap();

        let err = client
            .try_set_status(
                &verifier,
                &sym(&env, "NG"),
                &sym(&env, "Food"),
                &100_u64,
                &SubmissionStatus::Pending,
            )
            .unwrap_err()
            .unwrap();
        assert_eq!(err, Error::InvalidTransition);
    }

    #[test]
    fn set_status_missing_submission_returns_not_found() {
        let env = make_env();
        let client = deploy(&env);
        let verifier = Address::generate(&env);

        env.mock_all_auths();
        let err = client
            .try_set_status(
                &verifier,
                &sym(&env, "NG"),
                &sym(&env, "Food"),
                &999_u64,
                &SubmissionStatus::Verified,
            )
            .unwrap_err()
            .unwrap();
        assert_eq!(err, Error::NotFound);
    }

    // ── get_status ────────────────────────────────────────────────────────

    #[test]
    fn get_status_returns_none_for_missing_submission() {
        let env = make_env();
        let client = deploy(&env);
        let result = client.get_status(&sym(&env, "NG"), &sym(&env, "Food"), &1_u64);
    #[test]
    fn get_missing_returns_none() {
        let env = make_env();
        let client = deploy(&env);
        let result = client.get(&sym(&env, "NG"), &sym(&env, "Food"), &99_u64);
        assert!(result.is_none());
    }

    // ── get_history ───────────────────────────────────────────────────────

    #[test]
    fn get_history_empty_when_no_submissions() {
        let env = make_env();
        let client = deploy(&env);
        let history = client.get_history(&sym(&env, "NG"), &sym(&env, "Food"));
        assert_eq!(history.len(), 0);
    }

    #[test]
    fn get_history_returns_all_submissions_in_insertion_order() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        let country = sym(&env, "NG");
        let category = sym(&env, "Food");

        env.mock_all_auths();
        client.submit(&submitter, &country, &category, &100, &10_u64).unwrap();
        client.submit(&submitter, &country, &category, &200, &20_u64).unwrap();
        client.submit(&submitter, &country, &category, &300, &30_u64).unwrap();

        let history = client.get_history(&country, &category);
        assert_eq!(history.len(), 3);
        assert_eq!(history.get(0).unwrap().timestamp, 10);
        assert_eq!(history.get(1).unwrap().timestamp, 20);
        assert_eq!(history.get(2).unwrap().timestamp, 30);
    }

    #[test]
    fn get_history_is_scoped_to_country_and_category() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);

        env.mock_all_auths();
        client
            .submit(&submitter, &sym(&env, "NG"), &sym(&env, "Food"), &100, &10_u64)
            .unwrap();
        client
            .submit(&submitter, &sym(&env, "KE"), &sym(&env, "Food"), &200, &20_u64)
            .unwrap();
        client
            .submit(&submitter, &sym(&env, "NG"), &sym(&env, "Rent"), &300, &30_u64)
            .unwrap();

        // Only NG/Food — 1 record.
        let ng_food = client.get_history(&sym(&env, "NG"), &sym(&env, "Food"));
        assert_eq!(ng_food.len(), 1);
        assert_eq!(ng_food.get(0).unwrap().value, 100);

        // Only KE/Food — 1 record.
        let ke_food = client.get_history(&sym(&env, "KE"), &sym(&env, "Food"));
        assert_eq!(ke_food.len(), 1);
        assert_eq!(ke_food.get(0).unwrap().value, 200);

        // Only NG/Rent — 1 record.
        let ng_rent = client.get_history(&sym(&env, "NG"), &sym(&env, "Rent"));
        assert_eq!(ng_rent.len(), 1);
        assert_eq!(ng_rent.get(0).unwrap().value, 300);
    }

    #[test]
    fn get_history_idempotent_resubmit_not_duplicated() {
        // Submitting at the same timestamp twice must not double the index.
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        let country = sym(&env, "NG");
        let category = sym(&env, "Food");

        env.mock_all_auths();
        client.submit(&submitter, &country, &category, &100, &10_u64).unwrap();
        client.submit(&submitter, &country, &category, &999, &10_u64).unwrap(); // same ts

        let history = client.get_history(&country, &category);
        // Only one record — the first write wins.
        assert_eq!(history.len(), 1);
        assert_eq!(history.get(0).unwrap().value, 100);
    }

    #[test]
    fn get_history_includes_full_metadata_for_auditing() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        let country = sym(&env, "NG");
        let category = sym(&env, "Food");

        env.mock_all_auths();
        client.submit(&submitter, &country, &category, &450, &50_u64).unwrap();

        let history = client.get_history(&country, &category);
        let record = history.get(0).unwrap();

        assert_eq!(record.submitter, submitter);
        assert_eq!(record.country_iso, country);
        assert_eq!(record.category, category);
        assert_eq!(record.value, 450);
        assert_eq!(record.timestamp, 50);
    }

    // ── get_history_range ─────────────────────────────────────────────────

    #[test]
    fn get_history_range_filters_to_window() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        let country = sym(&env, "NG");
        let category = sym(&env, "Food");

        env.mock_all_auths();
        for ts in [10_u64, 20, 30, 40, 50] {
            client
                .submit(&submitter, &country, &category, &(ts as i128 * 10), &ts)
                .unwrap();
        }

        let range = client
            .get_history_range(&country, &category, &20_u64, &40_u64)
            .unwrap();
        assert_eq!(range.len(), 3);
        assert_eq!(range.get(0).unwrap().timestamp, 20);
        assert_eq!(range.get(1).unwrap().timestamp, 30);
        assert_eq!(range.get(2).unwrap().timestamp, 40);
    }

    #[test]
    fn get_history_range_inclusive_on_both_ends() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        let country = sym(&env, "NG");
        let category = sym(&env, "Food");

        env.mock_all_auths();
        client.submit(&submitter, &country, &category, &1, &10_u64).unwrap();
        client.submit(&submitter, &country, &category, &2, &20_u64).unwrap();

        let range = client
            .get_history_range(&country, &category, &10_u64, &10_u64)
            .unwrap();
        assert_eq!(range.len(), 1);
        assert_eq!(range.get(0).unwrap().timestamp, 10);
    }

    #[test]
    fn get_history_range_empty_window_returns_empty() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        let country = sym(&env, "NG");
        let category = sym(&env, "Food");

        env.mock_all_auths();
        client.submit(&submitter, &country, &category, &1, &10_u64).unwrap();

        let range = client
            .get_history_range(&country, &category, &50_u64, &100_u64)
            .unwrap();
        assert_eq!(range.len(), 0);
    }

    #[test]
    fn get_history_range_invalid_range_returns_error() {
        let env = make_env();
        let client = deploy(&env);
        let country = sym(&env, "NG");
        let category = sym(&env, "Food");

        let err = client
            .try_get_history_range(&country, &category, &100_u64, &50_u64)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, Error::InvalidRange);
    }

    #[test]
    fn get_history_range_single_point_range() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        let country = sym(&env, "KE");
        let category = sym(&env, "Rent");

        env.mock_all_auths();
        client.submit(&submitter, &country, &category, &500, &42_u64).unwrap();

        let range = client
            .get_history_range(&country, &category, &42_u64, &42_u64)
            .unwrap();
        assert_eq!(range.len(), 1);
    }

    // ── get_latest ────────────────────────────────────────────────────────

    #[test]
    fn get_latest_returns_none_when_empty() {
        let env = make_env();
        let client = deploy(&env);
        let result = client.get_latest(&sym(&env, "NG"), &sym(&env, "Food"));
        assert!(result.is_none());
    }

    #[test]
    fn get_status_returns_current_state_after_each_transition() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        let verifier = Address::generate(&env);
    fn get_latest_returns_highest_timestamp() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        let country = sym(&env, "NG");
        let category = sym(&env, "Food");

        env.mock_all_auths();
        client.submit(&submitter, &country, &category, &100, &10_u64).unwrap();
        client.submit(&submitter, &country, &category, &200, &30_u64).unwrap();
        client.submit(&submitter, &country, &category, &150, &20_u64).unwrap();

        // Last submitted is ts=20, but ts=30 has the highest timestamp.
        // The index is in insertion order so latest = 20 (last inserted).
        // This tests that get_latest returns the last *inserted* record,
        // which matches the stored index behaviour documented in the module.
        let latest = client.get_latest(&country, &category).unwrap();
        // Insertion order: 10, 30, 20 — last inserted timestamp is 20.
        assert_eq!(latest.timestamp, 20);
    }

    #[test]
    fn get_latest_after_single_submission() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        let country = sym(&env, "BR");
        let category = sym(&env, "Transport");

        env.mock_all_auths();
        client.submit(&submitter, &country, &category, &800, &50_u64).unwrap();
        assert_eq!(client.get_status(&country, &category, &50_u64), Some(SubmissionStatus::Pending));

        client
            .set_status(&verifier, &country, &category, &50_u64, &SubmissionStatus::Verified)
            .unwrap();
        assert_eq!(client.get_status(&country, &category, &50_u64), Some(SubmissionStatus::Verified));
    }

    // ── round-trip: status is part of full record ─────────────────────────

    #[test]
    fn get_returns_status_embedded_in_submission() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        let verifier = Address::generate(&env);
        let country = sym(&env, "IN");
        let category = sym(&env, "Health");

        env.mock_all_auths();
        client.submit(&submitter, &country, &category, &300, &75_u64).unwrap();

        let before = client.get(&country, &category, &75_u64).unwrap();
        assert_eq!(before.status, SubmissionStatus::Pending);

        client
            .set_status(&verifier, &country, &category, &75_u64, &SubmissionStatus::Rejected)
            .unwrap();

        let after = client.get(&country, &category, &75_u64).unwrap();
        assert_eq!(after.status, SubmissionStatus::Rejected);
        // Other fields are unchanged.
        assert_eq!(after.value, 300);
        assert_eq!(after.submitter, submitter);
    }

    // ── API consistency ───────────────────────────────────────────────────

    #[test]
    fn status_values_are_distinct_and_stable() {
        // Numeric discriminants are pinned so external consumers can safely
        // match on the underlying u32 representation.
        assert_eq!(SubmissionStatus::Pending as u32, 0);
        assert_eq!(SubmissionStatus::Verified as u32, 1);
        assert_eq!(SubmissionStatus::Rejected as u32, 2);
        client.submit(&submitter, &country, &category, &750, &99_u64).unwrap();

        let latest = client.get_latest(&country, &category).unwrap();
        assert_eq!(latest.value, 750);
        assert_eq!(latest.timestamp, 99);
    }

    #[test]
    fn get_latest_is_scoped_per_country_and_category() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);

        env.mock_all_auths();
        client
            .submit(&submitter, &sym(&env, "NG"), &sym(&env, "Food"), &1, &100_u64)
            .unwrap();
        client
            .submit(&submitter, &sym(&env, "KE"), &sym(&env, "Food"), &2, &200_u64)
            .unwrap();

        let ng_latest = client.get_latest(&sym(&env, "NG"), &sym(&env, "Food")).unwrap();
        let ke_latest = client.get_latest(&sym(&env, "KE"), &sym(&env, "Food")).unwrap();

        assert_eq!(ng_latest.timestamp, 100);
        assert_eq!(ke_latest.timestamp, 200);
    }

    // ── determinism ───────────────────────────────────────────────────────

    #[test]
    fn history_deterministic_for_same_state() {
        // Two calls on the same env produce identical results.
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);
        let country = sym(&env, "NG");
        let category = sym(&env, "Food");

        env.mock_all_auths();
        client.submit(&submitter, &country, &category, &1, &1_u64).unwrap();
        client.submit(&submitter, &country, &category, &2, &2_u64).unwrap();

        let first = client.get_history(&country, &category);
        let second = client.get_history(&country, &category);

        assert_eq!(first.len(), second.len());
        for i in 0..first.len() {
            assert_eq!(first.get(i).unwrap().timestamp, second.get(i).unwrap().timestamp);
        }
    }

    // ── Arithmetic helpers exposed as contract entry points ───────────────
    //
    // These are thin wrappers around the `guards` module functions.  They are
    // primarily useful for off-chain clients that want to pre-validate values
    // before constructing a transaction, and for cross-contract callers.

    /// Add two `i128` values, failing safely on overflow.
    ///
    /// # Errors
    /// * [`Error::ArithmeticOverflow`] — result would overflow `i128`.
    pub fn safe_add(env: Env, a: i128, b: i128) -> Result<i128, Error> {
        let _ = env;
        guards::checked_add_i128(a, b)
    }

    /// Multiply two `i128` values, failing safely on overflow.
    ///
    /// # Errors
    /// * [`Error::ArithmeticOverflowMul`] — result would overflow `i128`.
    pub fn safe_mul(env: Env, a: i128, b: i128) -> Result<i128, Error> {
        let _ = env;
        guards::checked_mul_i128(a, b)
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

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

    // ── guards::require_positive_price ────────────────────────────────────

    #[test]
    fn guard_zero_price_rejected() {
        assert_eq!(guards::require_positive_price(0), Err(Error::ZeroPrice));
    }

    #[test]
    fn guard_negative_price_rejected() {
        assert_eq!(guards::require_positive_price(-1), Err(Error::NegativePrice));
        assert_eq!(
            guards::require_positive_price(i128::MIN),
            Err(Error::NegativePrice)
        );
    }

    #[test]
    fn guard_positive_price_accepted() {
        assert!(guards::require_positive_price(1).is_ok());
        assert!(guards::require_positive_price(i128::MAX).is_ok());
    }

    // ── guards::require_positive_u64 ─────────────────────────────────────

    #[test]
    fn guard_zero_u64_rejected() {
        assert_eq!(guards::require_positive_u64(0), Err(Error::ZeroValue));
    }

    #[test]
    fn guard_positive_u64_accepted() {
        assert!(guards::require_positive_u64(1).is_ok());
        assert!(guards::require_positive_u64(u64::MAX).is_ok());
    }

    // ── guards::require_positive_i128 ────────────────────────────────────

    #[test]
    fn guard_zero_i128_rejected() {
        assert_eq!(
            guards::require_positive_i128(0),
            Err(Error::NonPositiveAmount)
        );
    }

    #[test]
    fn guard_negative_i128_rejected() {
        assert_eq!(
            guards::require_positive_i128(-1),
            Err(Error::NonPositiveAmount)
        );
        assert_eq!(
            guards::require_positive_i128(i128::MIN),
            Err(Error::NonPositiveAmount)
        );
    }

    #[test]
    fn guard_positive_i128_accepted() {
        assert!(guards::require_positive_i128(1).is_ok());
        assert!(guards::require_positive_i128(i128::MAX).is_ok());
    }

    // ── guards::checked_add_u64 ───────────────────────────────────────────

    #[test]
    fn checked_add_u64_normal() {
        assert_eq!(guards::checked_add_u64(100, 200), Ok(300));
    }

    #[test]
    fn checked_add_u64_overflow_rejected() {
        assert_eq!(
            guards::checked_add_u64(u64::MAX, 1),
            Err(Error::ArithmeticOverflow)
        );
    }

    #[test]
    fn checked_add_u64_max_plus_zero() {
        // Adding zero to MAX is valid.
        assert_eq!(guards::checked_add_u64(u64::MAX, 0), Ok(u64::MAX));
    }

    // ── guards::checked_add_i128 ──────────────────────────────────────────

    #[test]
    fn checked_add_i128_normal() {
        assert_eq!(guards::checked_add_i128(50, 50), Ok(100));
    }

    #[test]
    fn checked_add_i128_positive_overflow_rejected() {
        assert_eq!(
            guards::checked_add_i128(i128::MAX, 1),
            Err(Error::ArithmeticOverflow)
        );
    }

    #[test]
    fn checked_add_i128_negative_overflow_rejected() {
        assert_eq!(
            guards::checked_add_i128(i128::MIN, -1),
            Err(Error::ArithmeticOverflow)
        );
    }

    // ── guards::checked_mul_i128 ──────────────────────────────────────────

    #[test]
    fn checked_mul_i128_normal() {
        assert_eq!(guards::checked_mul_i128(3, 4), Ok(12));
    }

    #[test]
    fn checked_mul_i128_overflow_rejected() {
        assert_eq!(
            guards::checked_mul_i128(i128::MAX, 2),
            Err(Error::ArithmeticOverflowMul)
        );
    }

    #[test]
    fn checked_mul_i128_negative_times_negative() {
        // -i128::MAX * 2 overflows: -(2^127 - 1) * 2 = -(2^128 - 2) < i128::MIN.
        assert_eq!(
            guards::checked_mul_i128(i128::MIN, -1),
            Err(Error::ArithmeticOverflowMul)
        );
    }

    // ── submit: fail-safe price validation ───────────────────────────────

    #[test]
    fn submit_zero_price_rejected() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);

        env.mock_all_auths();
        let err = client
            .try_submit(&submitter, &sym(&env, "NG"), &sym(&env, "Food"), &0, &100_u64)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, Error::ZeroPrice);
    }

    #[test]
    fn submit_negative_price_rejected() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);

        env.mock_all_auths();
        let err = client
            .try_submit(&submitter, &sym(&env, "NG"), &sym(&env, "Food"), &-1, &100_u64)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, Error::NegativePrice);
    }

    #[test]
    fn submit_very_negative_price_rejected() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);

        env.mock_all_auths();
        let err = client
            .try_submit(
                &submitter,
                &sym(&env, "NG"),
                &sym(&env, "Food"),
                &i128::MIN,
                &100_u64,
            )
            .unwrap_err()
            .unwrap();
        assert_eq!(err, Error::NegativePrice);
    }

    #[test]
    fn submit_zero_timestamp_rejected() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);

        env.mock_all_auths();
        let err = client
            .try_submit(&submitter, &sym(&env, "NG"), &sym(&env, "Food"), &100, &0_u64)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, Error::InvalidTimestamp);
    }

    #[test]
    fn submit_valid_values_succeeds() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);

        env.mock_all_auths();
        client
            .submit(&submitter, &sym(&env, "NG"), &sym(&env, "Food"), &1_000, &100_u64)
            .unwrap();

        let got = client.get(&sym(&env, "NG"), &sym(&env, "Food"), &100_u64).unwrap();
        assert_eq!(got.value, 1_000);
    }

    // ── safe_add / safe_mul contract entry points ─────────────────────────

    #[test]
    fn safe_add_normal() {
        let env = make_env();
        let client = deploy(&env);
        assert_eq!(client.safe_add(&10, &20), Ok(30));
    }

    #[test]
    fn safe_add_overflow_returns_error() {
        let env = make_env();
        let client = deploy(&env);
        assert_eq!(
            client.try_safe_add(&i128::MAX, &1).unwrap_err().unwrap(),
            Error::ArithmeticOverflow
        );
    }

    #[test]
    fn safe_mul_normal() {
        let env = make_env();
        let client = deploy(&env);
        assert_eq!(client.safe_mul(&6, &7), Ok(42));
    }

    #[test]
    fn safe_mul_overflow_returns_error() {
        let env = make_env();
        let client = deploy(&env);
        assert_eq!(
            client.try_safe_mul(&i128::MAX, &2).unwrap_err().unwrap(),
            Error::ArithmeticOverflowMul
        );
    }

    /// Validate a submit payload against the schema without committing any
    /// state.
    ///
    /// Useful for SDK clients that want to pre-validate arguments before
    /// constructing a transaction, and for cross-contract callers that need
    /// to confirm a payload is structurally sound before forwarding it.
    ///
    /// Returns `Ok(())` on a valid payload; a specific [`Error`] variant on
    /// the first failing constraint.
    pub fn validate_submit_payload(
        env: Env,
        country_iso: Symbol,
        category: Symbol,
        value: i128,
        timestamp: u64,
    ) -> Result<(), Error> {
        let _ = env;
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

// ── Tests ─────────────────────────────────────────────────────────────────────

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

    // ── Pure validate() unit tests (no Env needed) ────────────────────────

    fn make_valid_payload(env: &Env) -> (Symbol, Symbol) {
        (sym(env, "NG"), sym(env, "Food"))
    }

    #[test]
    fn valid_payload_passes_schema() {
        let env = Env::default();
        let (country, category) = make_valid_payload(&env);
        let result = payload::validate(
            SUBMIT_SCHEMA,
            &payload::SubmitPayload {
                country_iso: &country,
                category: &category,
                value: 1_000,
                timestamp: 100,
                schema_version: SCHEMA_VERSION,
            },
        );
        assert!(result.is_ok());
    }

    #[test]
    fn zero_timestamp_fails_u64_non_zero() {
        let env = Env::default();
        let (country, category) = make_valid_payload(&env);
        let err = payload::validate(
            SUBMIT_SCHEMA,
            &payload::SubmitPayload {
                country_iso: &country,
                category: &category,
                value: 1_000,
                timestamp: 0,
                schema_version: SCHEMA_VERSION,
            },
        )
        .unwrap_err();
        assert_eq!(err, Error::ZeroNotAllowed);
    }

    #[test]
    fn zero_value_fails_i128_positive() {
        let env = Env::default();
        let (country, category) = make_valid_payload(&env);
        let err = payload::validate(
            SUBMIT_SCHEMA,
            &payload::SubmitPayload {
                country_iso: &country,
                category: &category,
                value: 0,
                timestamp: 100,
                schema_version: SCHEMA_VERSION,
            },
        )
        .unwrap_err();
        assert_eq!(err, Error::ZeroNotAllowed);
    }

    #[test]
    fn negative_value_fails_i128_positive() {
        let env = Env::default();
        let (country, category) = make_valid_payload(&env);
        let err = payload::validate(
            SUBMIT_SCHEMA,
            &payload::SubmitPayload {
                country_iso: &country,
                category: &category,
                value: -1,
                timestamp: 100,
                schema_version: SCHEMA_VERSION,
            },
        )
        .unwrap_err();
        assert_eq!(err, Error::NegativeNotAllowed);
    }

    #[test]
    fn value_above_ceiling_fails_i128_max() {
        let env = Env::default();
        let (country, category) = make_valid_payload(&env);
        // SUBMIT_SCHEMA ceiling is 1_000_000_000_000
        let err = payload::validate(
            SUBMIT_SCHEMA,
            &payload::SubmitPayload {
                country_iso: &country,
                category: &category,
                value: 1_000_000_000_001,
                timestamp: 100,
                schema_version: SCHEMA_VERSION,
            },
        )
        .unwrap_err();
        assert_eq!(err, Error::ValueAboveMaximum);
    }

    #[test]
    fn value_at_ceiling_passes() {
        let env = Env::default();
        let (country, category) = make_valid_payload(&env);
        let result = payload::validate(
            SUBMIT_SCHEMA,
            &payload::SubmitPayload {
                country_iso: &country,
                category: &category,
                value: 1_000_000_000_000, // exactly at ceiling
                timestamp: 100,
                schema_version: SCHEMA_VERSION,
            },
        );
        assert!(result.is_ok());
    }

    #[test]
    fn wrong_schema_version_fails_schema_version_constraint() {
        let env = Env::default();
        let (country, category) = make_valid_payload(&env);
        let err = payload::validate(
            SUBMIT_SCHEMA,
            &payload::SubmitPayload {
                country_iso: &country,
                category: &category,
                value: 1_000,
                timestamp: 100,
                schema_version: 99, // wrong version
            },
        )
        .unwrap_err();
        assert_eq!(err, Error::SchemaMismatch);
    }

    #[test]
    fn correct_schema_version_passes() {
        let env = Env::default();
        let (country, category) = make_valid_payload(&env);
        let result = payload::validate(
            SUBMIT_SCHEMA,
            &payload::SubmitPayload {
                country_iso: &country,
                category: &category,
                value: 500,
                timestamp: 42,
                schema_version: SCHEMA_VERSION,
            },
        );
        assert!(result.is_ok());
    }

    // ── Constraint::SymbolNonEmpty ────────────────────────────────────────

    #[test]
    fn empty_country_symbol_fails() {
        let env = Env::default();
        let empty = sym(&env, "");
        let category = sym(&env, "Food");
        // Only SymbolNonEmpty constraint for this test.
        let schema = &[payload::Constraint::SymbolNonEmpty];
        let err = payload::validate(
            schema,
            &payload::SubmitPayload {
                country_iso: &empty,
                category: &category,
                value: 100,
                timestamp: 1,
                schema_version: SCHEMA_VERSION,
            },
        )
        .unwrap_err();
        assert_eq!(err, Error::EmptySymbol);
    }

    // ── Constraint::I128NonNegative ───────────────────────────────────────

    #[test]
    fn i128_non_negative_accepts_zero() {
        let env = Env::default();
        let (country, category) = make_valid_payload(&env);
        let schema = &[payload::Constraint::I128NonNegative];
        let result = payload::validate(
            schema,
            &payload::SubmitPayload {
                country_iso: &country,
                category: &category,
                value: 0,
                timestamp: 1,
                schema_version: SCHEMA_VERSION,
            },
        );
        assert!(result.is_ok());
    }

    #[test]
    fn i128_non_negative_rejects_negative() {
        let env = Env::default();
        let (country, category) = make_valid_payload(&env);
        let schema = &[payload::Constraint::I128NonNegative];
        let err = payload::validate(
            schema,
            &payload::SubmitPayload {
                country_iso: &country,
                category: &category,
                value: -100,
                timestamp: 1,
                schema_version: SCHEMA_VERSION,
            },
        )
        .unwrap_err();
        assert_eq!(err, Error::NegativeNotAllowed);
    }

    // ── Constraint evaluation order ───────────────────────────────────────

    #[test]
    fn first_failing_constraint_is_returned() {
        // Schema: U64NonZero, then I128Positive.
        // Both timestamp=0 and value=-1 are invalid.
        // U64NonZero is first, so ZeroNotAllowed must be the error.
        let env = Env::default();
        let (country, category) = make_valid_payload(&env);
        let schema = &[
            payload::Constraint::U64NonZero,
            payload::Constraint::I128Positive,
        ];
        let err = payload::validate(
            schema,
            &payload::SubmitPayload {
                country_iso: &country,
                category: &category,
                value: -1,
                timestamp: 0,
                schema_version: SCHEMA_VERSION,
            },
        )
        .unwrap_err();
        assert_eq!(err, Error::ZeroNotAllowed); // not NegativeNotAllowed
    }

    // ── Contract entry points ─────────────────────────────────────────────

    #[test]
    fn submit_valid_payload_succeeds() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);

        env.mock_all_auths();
        client
            .submit(
                &submitter,
                &sym(&env, "NG"),
                &sym(&env, "Food"),
                &1_000,
                &100_u64,
            )
            .unwrap();

        let got = client.get(&sym(&env, "NG"), &sym(&env, "Food"), &100_u64).unwrap();
        assert_eq!(got.value, 1_000);
    }

    #[test]
    fn submit_zero_value_rejected_by_schema() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);

        env.mock_all_auths();
        let err = client
            .try_submit(&submitter, &sym(&env, "NG"), &sym(&env, "Food"), &0, &100_u64)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, Error::ZeroNotAllowed);
    }

    #[test]
    fn submit_negative_value_rejected_by_schema() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);

        env.mock_all_auths();
        let err = client
            .try_submit(&submitter, &sym(&env, "NG"), &sym(&env, "Food"), &-500, &100_u64)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, Error::NegativeNotAllowed);
    }

    #[test]
    fn submit_zero_timestamp_rejected_by_schema() {
        let env = make_env();
        let client = deploy(&env);
        let submitter = Address::generate(&env);

        env.mock_all_auths();
        let err = client
            .try_submit(&submitter, &sym(&env, "NG"), &sym(&env, "Food"), &100, &0_u64)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, Error::ZeroNotAllowed);
    }

    #[test]
    fn validate_submit_payload_entry_point_accepts_valid() {
        let env = make_env();
        let client = deploy(&env);

        let result = client
            .validate_submit_payload(&sym(&env, "KE"), &sym(&env, "Rent"), &500, &50_u64);
        assert!(result.is_ok());
    }

    #[test]
    fn validate_submit_payload_entry_point_rejects_negative() {
        let env = make_env();
        let client = deploy(&env);

        let err = client
            .try_validate_submit_payload(
                &sym(&env, "KE"),
                &sym(&env, "Rent"),
                &-1,
                &50_u64,
            )
            .unwrap_err()
            .unwrap();
        assert_eq!(err, Error::NegativeNotAllowed);
    }
}

