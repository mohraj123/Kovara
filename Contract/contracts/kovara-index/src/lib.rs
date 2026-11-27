#![no_std]
//! `KovaraIndex` — aggregates verified prices into the daily `KVI`
//! (Kōvara Value Index) per country.
//!
//! CT-001 scaffolding: wires the contract to the Soroban SDK and stores one
//! daily index value per country/date. The aggregation and rounding policies
//! for the daily index are owned by later contract issues.
//!
//! # Write-once daily values
//!
//! A `(country, date)` entry is immutable after its first successful write.
//! Both publication paths — [`KovaraIndex::set_daily_index`] and
//! [`KovaraIndex::set_daily_index_windowed`] — refuse to overwrite an occupied
//! key with [`Error::DuplicateWrite`], so a retried or replayed aggregation
//! transaction cannot silently replace a published index.
//!
//! The only way to change a published value is the explicit correction path:
//! [`KovaraIndex::set_correction_authority`] configures the single address
//! allowed to correct values, and [`KovaraIndex::correct_daily_index`] requires
//! that address to sign. With no authority configured, no correction is
//! possible — the history is immutable by default.
//!
//! # A stale observation is a wrong answer, not a warning
//!
//! `set_daily_index` takes a value and a date and stores it. It has no way to
//! tell whether the observation behind that value was still fresh when it was
//! written, so an expired price folded into a daily index is indistinguishable
//! from a correct one — there is no error anywhere, only a silently wrong
//! number that downstream consumers read.
//!
//! [`KovaraIndex::set_daily_index_windowed`] closes that. The caller supplies
//! the window the observation came from, and the contract applies the same
//! predicate `PriceVault` uses:
//!
//! ```text
//! valid_from <= query_ts < valid_until
//! ```
//!
//! Lower bound inclusive, upper bound exclusive, so consecutive non-overlapping
//! windows never both claim a ledger. The check runs **before** `require_auth`
//! and before any write, so a stale write costs the caller one failed
//! transaction and leaves the previous index value intact.
//!
//! The predicate itself is [`KovaraIndex::is_fresh`], a pure view, so a caller
//! can ask the question without submitting a transaction.

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, Env, Symbol};

/// Maximum allowed KVI value (fixed-point, 8 decimal places).
/// Represents 1 000 000.00000000 — one million units.
/// Values above this ceiling are rejected as out-of-range.
pub const KVI_MAX: i128 = 100_000_000_000_000; // 1 000 000 × 10^8

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    /// A zero date is reserved and never valid for a daily record.
    InvalidDate = 1,
    /// A daily index value must be strictly positive.
    NonPositiveValue = 23,
    /// A daily index value exceeds the documented fixed-point ceiling [`KVI_MAX`].
    IndexValueTooHigh = 22,
    /// The supplied window is empty or non-increasing: `valid_until <= valid_from`.
    /// Without a window there is nothing to compare `query_ts` against.
    InvalidWindow = 2,
    /// `query_ts` is at or after `valid_until` — the observation had already
    /// expired when the index was written.
    StaleSubmission = 3,
    /// `query_ts` is before `valid_from` — the observation was not yet valid.
    NotYetValid = 4,
    /// A daily value already exists for `(country, date)`. Daily values are
    /// write-once; use the authorized correction path to change one.
    DuplicateWrite = 5,
    /// The caller is not the configured correction authority.
    Unauthorized = 6,
    /// No correction authority has been configured, so no correction is
    /// possible. Configuration is deliberate, never inferred from the caller.
    CorrectionAuthorityNotConfigured = 7,
    /// A correction authority has already been configured; the role is
    /// one-shot and cannot be handed to another address by a retry.
    AuthorityAlreadyConfigured = 8,
    /// No daily value exists for `(country, date)` to correct.
    NotFound = 9,
    /// No admin has been configured, so updater management is unavailable.
    AdminNotConfigured = 20,
    /// An admin has already been configured; the role is one-shot.
    AdminAlreadyConfigured = 21,
}

/// One entry in the append-only revision log of a `(country, date)` value.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Revision {
    pub value: i128,
    pub updater: Address,
    pub ledger: u32,
    pub timestamp: u64,
    /// `false` for the first publication, `true` for a correction.
    pub correction: bool,
    /// The value that was replaced; `0` for a first publication.
    pub old_value: i128,
    /// Human-readable reason for a correction; empty for a first publication.
    pub reason: soroban_sdk::String,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    /// `(country, date)` → daily index value.
    DailyIndex(Symbol, u64),
    /// `(country, date)` → the window the written value came from.
    DailyWindow(Symbol, u64),
    /// The single address allowed to correct published daily values.
    CorrectionAuthority,
    /// The admin who manages the updater.
    Admin,
    /// The single address allowed to publish daily values, once configured.
    Updater,
    /// `(country, date)` → number of revisions recorded.
    RevisionCount(Symbol, u64),
    /// `(country, date, index)` → revision entry.
    Revision(Symbol, u64, u32),
}

#[contract]
pub struct KovaraIndex;

#[contractimpl]
impl KovaraIndex {
    /// Publish one daily index value for a country/date.
    ///
    /// Write-once: an existing `(country, date)` is refused with
    /// [`Error::DuplicateWrite`]. Use [`Self::correct_daily_index`] to change
    /// a published value.
    ///
    /// # Errors
    /// * [`Error::InvalidDate`] — `date == 0`.
    /// * [`Error::DuplicateWrite`] — this country/date already has a value.
    pub fn set_daily_index(
        env: Env,
        updater: Address,
        country: Symbol,
        date: u64,
        value: i128,
    ) -> Result<(), Error> {
        // 1. Pure checks, before auth and before any write.
        if date == 0 {
            return Err(Error::InvalidDate);
        }
        if value <= 0 {
            return Err(Error::NonPositiveValue);
        }
        if value > KVI_MAX {
            return Err(Error::IndexValueTooHigh);
        }
        let key = DataKey::DailyIndex(country, date);
        if env.storage().persistent().has(&key) {
            return Err(Error::DuplicateWrite);
        }

        // 2. Auth only after every check.
        Self::check_updater(&env, &updater)?;
        updater.require_auth();
        env.storage().persistent().set(&key, &value);
        Self::push_revision(
            &env,
            &key,
            value,
            0,
            &soroban_sdk::String::from_str(&env, ""),
            &updater,
            false,
        );
        Ok(())
    }

    /// Read a stored daily index value, if present.
    pub fn get_daily_index(env: Env, country: Symbol, date: u64) -> Option<i128> {
        env.storage()
            .persistent()
            .get(&DataKey::DailyIndex(country, date))
    }

    /// # Is `query_ts` inside `[valid_from, valid_until)`?
    ///
    /// The single definition of freshness used by this contract, and the same
    /// half-open convention `PriceVault` applies to a submission's validity
    /// window. Pure: no storage, no ledger, no events.
    ///
    /// An empty or inverted window is never fresh, so the answer is `false`
    /// rather than an error — a caller asking a yes/no question should not have
    /// to unwrap a `Result` to get it.
    pub fn is_fresh(valid_from: u64, valid_until: u64, query_ts: u64) -> bool {
        valid_until > valid_from && query_ts >= valid_from && query_ts < valid_until
    }

    /// The window a stored daily index value came from, if it was written
    /// through [`Self::set_daily_index_windowed`].
    ///
    /// `None` for a value written through [`Self::set_daily_index`], which
    /// carries no window at all. That distinction is the point: an index entry
    /// with no window cannot be re-checked for staleness later.
    pub fn get_daily_window(env: Env, country: Symbol, date: u64) -> Option<(u64, u64)> {
        env.storage()
            .persistent()
            .get(&DataKey::DailyWindow(country, date))
    }

    /// # Write a daily index value, refusing a stale observation
    ///
    /// The freshness-gated form of [`Self::set_daily_index`]. The value is
    /// accepted only if `query_ts` falls inside `[valid_from, valid_until)`,
    /// and the window is stored alongside it so the entry can be re-checked by
    /// a later reader.
    ///
    /// Validation runs before `require_auth` and before any write, so a refused
    /// call leaves the previous index value and window byte-for-byte unchanged.
    ///
    /// Write-once, just like [`Self::set_daily_index`]: an occupied
    /// `(country, date)` is refused with [`Error::DuplicateWrite`] before any
    /// write, so the existing value and window stay byte-for-byte unchanged.
    ///
    /// # Errors
    /// * [`Error::InvalidDate`] — `date == 0`.
    /// * [`Error::InvalidWindow`] — `valid_until <= valid_from`.
    /// * [`Error::NotYetValid`] — `query_ts < valid_from`.
    /// * [`Error::StaleSubmission`] — `query_ts >= valid_until`.
    /// * [`Error::DuplicateWrite`] — this country/date already has a value.
    pub fn set_daily_index_windowed(
        env: Env,
        updater: Address,
        country: Symbol,
        date: u64,
        value: i128,
        valid_from: u64,
        valid_until: u64,
        query_ts: u64,
    ) -> Result<(), Error> {
        // 1. Pure predicates over the arguments, before auth and before storage.
        if date == 0 {
            return Err(Error::InvalidDate);
        }
        if valid_until <= valid_from {
            return Err(Error::InvalidWindow);
        }
        if query_ts < valid_from {
            return Err(Error::NotYetValid);
        }
        if query_ts >= valid_until {
            return Err(Error::StaleSubmission);
        }
        if value <= 0 {
            return Err(Error::NonPositiveValue);
        }
        if value > KVI_MAX {
            return Err(Error::IndexValueTooHigh);
        }
        let key = DataKey::DailyIndex(country.clone(), date);
        if env.storage().persistent().has(&key) {
            return Err(Error::DuplicateWrite);
        }

        // 2. Auth only after every pure check.
        Self::check_updater(&env, &updater)?;
        updater.require_auth();

        // 3. Value and window land together, so an entry can never carry a
        //    value without the window that justifies it.
        env.storage().persistent().set(&key, &value);
        env.storage().persistent().set(
            &DataKey::DailyWindow(country, date),
            &(valid_from, valid_until),
        );
        Self::push_revision(
            &env,
            &key,
            value,
            0,
            &soroban_sdk::String::from_str(&env, ""),
            &updater,
            false,
        );

        Ok(())
    }

    /// Read a stored daily index value only if its window was fresh at
    /// `query_ts`.
    ///
    /// The read-side gate, for a caller that wants the same freshness
    /// guarantee the write side enforced. `None` covers three cases the caller
    /// can distinguish with [`Self::get_daily_window`] and [`Self::get_daily_index`]:
    /// no entry, an entry written without a window, and an entry whose window
    /// has expired.
    pub fn get_fresh_daily_index(
        env: Env,
        country: Symbol,
        date: u64,
        query_ts: u64,
    ) -> Option<i128> {
        let (valid_from, valid_until) = Self::get_daily_window(env.clone(), country.clone(), date)?;
        if !Self::is_fresh(valid_from, valid_until, query_ts) {
            return None;
        }
        Self::get_daily_index(env, country, date)
    }

    /// Configure the single address allowed to correct published daily values.
    ///
    /// One-shot: once set, the authority cannot be replaced, including by a
    /// retried transaction. `None` is never a fallback — with no authority
    /// configured, [`Self::correct_daily_index`] always fails, so a fresh
    /// contract has fully immutable history until an authority is explicitly
    /// chosen.
    ///
    /// # Errors
    /// * [`Error::AuthorityAlreadyConfigured`] — an authority already exists.
    pub fn set_correction_authority(env: Env, authority: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::CorrectionAuthority) {
            return Err(Error::AuthorityAlreadyConfigured);
        }
        authority.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::CorrectionAuthority, &authority);
        Ok(())
    }

    /// The configured correction authority, or `None` on a fresh contract.
    pub fn get_correction_authority(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::CorrectionAuthority)
    }

    /// Correct an already published daily value.
    ///
    /// This is the *only* path that may replace a `(country, date)` value. The
    /// caller must be the configured authority and must authorize the call;
    /// an ordinary `updater` signing a second publication is refused with
    /// [`Error::DuplicateWrite`].
    ///
    /// The validity window recorded by a windowed publication is left intact:
    /// a correction fixes the value, not the observation window it came from.
    /// A future correction-history issue can layer reason/old-value records on
    /// top without changing this authorization boundary.
    ///
    /// # Errors
    /// * [`Error::InvalidDate`] — `date == 0`.
    /// * [`Error::CorrectionAuthorityNotConfigured`] — no authority was set.
    /// * [`Error::Unauthorized`] — `authority` is not the configured one.
    /// * [`Error::NotFound`] — no published value exists for this country/date.
    pub fn correct_daily_index(
        env: Env,
        authority: Address,
        country: Symbol,
        date: u64,
        value: i128,
        reason: soroban_sdk::String,
    ) -> Result<(), Error> {
        // 1. Pure checks, before auth and before any write.
        if date == 0 {
            return Err(Error::InvalidDate);
        }
        let configured: Address = env
            .storage()
            .instance()
            .get(&DataKey::CorrectionAuthority)
            .ok_or(Error::CorrectionAuthorityNotConfigured)?;
        if configured != authority {
            return Err(Error::Unauthorized);
        }
        let key = DataKey::DailyIndex(country, date);
        if !env.storage().persistent().has(&key) {
            return Err(Error::NotFound);
        }

        // 2. Auth only after every check.
        authority.require_auth();
        let old_value: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        env.storage().persistent().set(&key, &value);
        Self::push_revision(&env, &key, value, old_value, &reason, &authority, true);
        Ok(())
    }
}
// ── Updater authorization, rotation, revisions, admin correction ────────────

impl KovaraIndex {
    /// With no updater configured, publication stays open (legacy behaviour);
    /// once configured, only that address may publish.
    fn check_updater(env: &Env, updater: &Address) -> Result<(), Error> {
        match env.storage().instance().get::<_, Address>(&DataKey::Updater) {
            Some(configured) if configured != *updater => Err(Error::Unauthorized),
            _ => Ok(()),
        }
    }

    fn require_admin(env: &Env, admin: &Address) -> Result<(), Error> {
        let configured: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::AdminNotConfigured)?;
        if configured != *admin {
            return Err(Error::Unauthorized);
        }
        admin.require_auth();
        Ok(())
    }

    fn push_revision(
        env: &Env,
        key: &DataKey,
        value: i128,
        old_value: i128,
        reason: &soroban_sdk::String,
        who: &Address,
        correction: bool,
    ) {
        if let DataKey::DailyIndex(country, date) = key {
            let count_key = DataKey::RevisionCount(country.clone(), *date);
            let count: u32 = env.storage().persistent().get(&count_key).unwrap_or(0);
            env.storage().persistent().set(
                &DataKey::Revision(country.clone(), *date, count),
                &Revision {
                    value,
                    updater: who.clone(),
                    ledger: env.ledger().sequence(),
                    timestamp: env.ledger().timestamp(),
                    correction,
                    old_value,
                    reason: reason.clone(),
                },
            );
            env.storage().persistent().set(&count_key, &(count + 1));
        }
    }
}

#[contractimpl]
impl KovaraIndex {
    /// Configure the admin. One-shot, like [`Self::set_correction_authority`].
    ///
    /// # Errors
    /// * [`Error::AdminAlreadyConfigured`] — an admin already exists.
    pub fn set_admin(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AdminAlreadyConfigured);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        Ok(())
    }

    /// The configured admin, if any.
    pub fn get_admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Admin)
    }

    /// Admin sets the updater allowed to publish daily values. Emits `upd_set`.
    ///
    /// # Errors
    /// * [`Error::AdminNotConfigured`] / [`Error::Unauthorized`].
    pub fn set_updater(env: Env, admin: Address, updater: Address) -> Result<(), Error> {
        Self::require_admin(&env, &admin)?;
        env.storage().instance().set(&DataKey::Updater, &updater);
        env.events()
            .publish((soroban_sdk::symbol_short!("upd_set"),), updater);
        Ok(())
    }

    /// The configured updater, or `None` while publication is still open.
    pub fn get_updater(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Updater)
    }

    /// Admin rotates the updater. The old updater immediately loses access.
    /// Emits `upd_rot` with `(old, new)`.
    ///
    /// # Errors
    /// * [`Error::AdminNotConfigured`] / [`Error::Unauthorized`].
    pub fn rotate_updater(env: Env, admin: Address, new_updater: Address) -> Result<(), Error> {
        Self::require_admin(&env, &admin)?;
        let old: Option<Address> = env.storage().instance().get(&DataKey::Updater);
        env.storage().instance().set(&DataKey::Updater, &new_updater);
        env.events()
            .publish((soroban_sdk::symbol_short!("upd_rot"),), (old, new_updater));
        Ok(())
    }

    /// Admin correction path: distinct from the updater (who can only publish)
    /// and from the one-shot correction authority. Records a correction revision.
    ///
    /// # Errors
    /// * [`Error::InvalidDate`], [`Error::AdminNotConfigured`],
    ///   [`Error::Unauthorized`], [`Error::NotFound`].
    pub fn admin_correct_daily_index(
        env: Env,
        admin: Address,
        country: Symbol,
        date: u64,
        value: i128,
    ) -> Result<(), Error> {
        if date == 0 {
            return Err(Error::InvalidDate);
        }
        let key = DataKey::DailyIndex(country, date);
        if !env.storage().persistent().has(&key) {
            return Err(Error::NotFound);
        }
        Self::require_admin(&env, &admin)?;
        env.storage().persistent().set(&key, &value);
        Self::push_revision(
            &env,
            &key,
            value,
            0,
            &soroban_sdk::String::from_str(&env, ""),
            &admin,
            true,
        );
        Ok(())
    }

    /// Number of revisions recorded for `(country, date)`.
    pub fn get_revision_count(env: Env, country: Symbol, date: u64) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::RevisionCount(country, date))
            .unwrap_or(0)
    }

    /// Revision `index` (0 = first publication); `None` when out of bounds.
    pub fn get_revision(env: Env, country: Symbol, date: u64, index: u32) -> Option<Revision> {
        env.storage()
            .persistent()
            .get(&DataKey::Revision(country, date, index))
    }
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        Env,
    };

    fn deploy(env: &Env) -> (KovaraIndexClient<'_>, Address) {
        let contract_id = env.register(KovaraIndex, ());
        (
            KovaraIndexClient::new(env, &contract_id),
            Address::generate(env),
        )
    }

    #[test]
    fn non_positive_values_are_rejected_before_persistence() {
        let env = Env::default();
        let (client, updater) = deploy(&env);
        let country = Symbol::new(&env, "NG");
        env.mock_all_auths();

        assert_eq!(
            client.try_set_daily_index(&updater, &country, &1, &0),
            Err(Ok(Error::NonPositiveValue))
        );
        assert_eq!(
            client.try_set_daily_index(&updater, &country, &1, &-5),
            Err(Ok(Error::NonPositiveValue))
        );
        assert_eq!(
            client.try_set_daily_index_windowed(&updater, &country, &1, &0, &1_000, &2_000, &1_500),
            Err(Ok(Error::NonPositiveValue))
        );
        assert_eq!(client.get_daily_index(&country, &1), None);
    }

    #[test]
    fn freshness_is_half_open() {
        let env = Env::default();
        let (client, _) = deploy(&env);

        // Lower bound inclusive.
        assert!(client.is_fresh(&1_000, &2_000, &1_000));
        // Interior.
        assert!(client.is_fresh(&1_000, &2_000, &1_500));
        assert!(client.is_fresh(&1_000, &2_000, &1_999));
        // Upper bound exclusive: 2_000 belongs to the next window.
        assert!(!client.is_fresh(&1_000, &2_000, &2_000));
        assert!(!client.is_fresh(&1_000, &2_000, &3_000));
        // Before the window.
        assert!(!client.is_fresh(&1_000, &2_000, &999));
        // An empty or inverted window is never fresh.
        assert!(!client.is_fresh(&1_000, &1_000, &1_000));
        assert!(!client.is_fresh(&2_000, &1_000, &1_500));
        // The largest representable window still holds.
        assert!(client.is_fresh(&0, &u64::MAX, &(u64::MAX - 1)));
        assert!(!client.is_fresh(&0, &u64::MAX, &u64::MAX));
    }

    #[test]
    fn a_windowed_write_is_accepted_inside_the_window_only() {
        let env = Env::default();
        let (client, updater) = deploy(&env);
        let country = Symbol::new(&env, "NG");
        env.mock_all_auths();

        // Exactly on the lower bound.
        client.set_daily_index_windowed(&updater, &country, &1, &1_500, &1_000, &2_000, &1_000);
        assert_eq!(client.get_daily_index(&country, &1), Some(1_500));

        // Exactly one before the upper bound, on a different date: each
        // `(country, date)` is write-once.
        client.set_daily_index_windowed(&updater, &country, &2, &1_600, &1_000, &2_000, &1_999);
        assert_eq!(client.get_daily_index(&country, &2), Some(1_600));

        // On the upper bound: expired.
        assert!(client
            .try_set_daily_index_windowed(&updater, &country, &3, &1_700, &1_000, &2_000, &2_000)
            .is_err());
        // Before the lower bound: not yet valid.
        assert!(client
            .try_set_daily_index_windowed(&updater, &country, &3, &1_700, &1_000, &2_000, &999)
            .is_err());

        // Both refusals left the previous values in place and wrote nothing.
        assert_eq!(client.get_daily_index(&country, &1), Some(1_500));
        assert_eq!(client.get_daily_index(&country, &2), Some(1_600));
        assert_eq!(client.get_daily_index(&country, &3), None);
    }

    #[test]
    fn a_windowed_write_validates_its_arguments() {
        let env = Env::default();
        let (client, updater) = deploy(&env);
        let country = Symbol::new(&env, "NG");
        env.mock_all_auths();

        // Zero date.
        assert!(client
            .try_set_daily_index_windowed(&updater, &country, &0, &100, &1_000, &2_000, &1_500)
            .is_err());
        // Empty window.
        assert!(client
            .try_set_daily_index_windowed(&updater, &country, &1, &100, &1_000, &1_000, &1_000)
            .is_err());
        // Inverted window.
        assert!(client
            .try_set_daily_index_windowed(&updater, &country, &1, &100, &2_000, &1_000, &1_500)
            .is_err());

        assert_eq!(client.get_daily_index(&country, &1), None);
        assert_eq!(client.get_daily_window(&country, &1), None);
    }

    #[test]
    fn a_stale_entry_drops_out_of_the_fresh_read_as_it_expires() {
        let env = Env::default();
        let (client, updater) = deploy(&env);
        let country = Symbol::new(&env, "NG");
        env.mock_all_auths();

        client.set_daily_index_windowed(&updater, &country, &1, &1_500, &1_000, &2_000, &1_500);

        // Inside the window the value is readable.
        assert_eq!(
            client.get_fresh_daily_index(&country, &1, &1_999),
            Some(1_500)
        );
        // The instant it expires, it is not — even though the raw record is
        // still there for audit.
        assert_eq!(client.get_fresh_daily_index(&country, &1, &2_000), None);
        assert_eq!(client.get_daily_index(&country, &1), Some(1_500));
        // And the window it was written under is readable for reconciliation.
        assert_eq!(client.get_daily_window(&country, &1), Some((1_000, 2_000)));
    }

    #[test]
    fn an_unwindowed_entry_is_never_fresh_and_says_so() {
        let env = Env::default();
        let (client, updater) = deploy(&env);
        let country = Symbol::new(&env, "NG");
        env.mock_all_auths();

        client.set_daily_index(&updater, &country, &1, &1_500);

        // The value is readable...
        assert_eq!(client.get_daily_index(&country, &1), Some(1_500));
        // ...but it carries no window, so freshness cannot be established.
        assert_eq!(client.get_daily_window(&country, &1), None);
        assert_eq!(client.get_fresh_daily_index(&country, &1, &1_500), None);
    }

    #[test]
    fn consecutive_windows_never_both_claim_a_date() {
        let env = Env::default();
        let (client, updater) = deploy(&env);
        let country = Symbol::new(&env, "NG");
        env.mock_all_auths();

        // Day 1 uses [1_000, 2_000), day 2 uses [2_000, 3_000).
        client.set_daily_index_windowed(&updater, &country, &1, &1_100, &1_000, &2_000, &1_100);
        client.set_daily_index_windowed(&updater, &country, &2, &1_200, &2_000, &3_000, &2_100);

        assert!(!client.is_fresh(&1_000, &2_000, &2_000));
        assert!(client.is_fresh(&2_000, &3_000, &2_000));

        // At 2_000 only day 2's entry is still fresh.
        assert_eq!(client.get_fresh_daily_index(&country, &1, &2_000), None);
        assert_eq!(
            client.get_fresh_daily_index(&country, &2, &2_000),
            Some(1_200)
        );

        // The ledger sequence is irrelevant to the window arithmetic: freshness
        // is decided by the caller-supplied observation timestamps.
        env.ledger().with_mut(|l| l.sequence_number = 99);
        assert_eq!(
            client.get_fresh_daily_index(&country, &2, &2_000),
            Some(1_200)
        );
    }
}
