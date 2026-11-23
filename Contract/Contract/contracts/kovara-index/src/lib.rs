#![no_std]

//! `KovaraIndex` — aggregates verified prices into the daily `KVI`
//! (Kōvara Value Index) per country.

use soroban_sdk::{
    contract,
    contracterror,
    contractimpl,
    contracttype,
    Address,
    Env,
    Symbol,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    /// A zero date is reserved and never valid for a daily record.
    InvalidDate = 1,

    /// The supplied window is empty or non-increasing:
    /// `valid_until <= valid_from`.
    InvalidWindow = 2,

    /// `query_ts` is at or after `valid_until`.
    StaleSubmission = 3,

    /// `query_ts` is before `valid_from`.
    NotYetValid = 4,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    /// `(country, date)` → daily index value.
    DailyIndex(Symbol, u64),

    /// `(country, date)` → the window the written value came from.
    DailyWindow(Symbol, u64),
}

/// Describes why an index event was emitted.
///
/// `Published` means there was no previous value for the country/date.
///
/// `Corrected` means an existing value was replaced by a new value.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum IndexEventKind {
    Published,
    Corrected,
}

/// Event data emitted whenever a daily index is written.
///
/// Indexers can use `kind` to distinguish an initial publication from
/// a correction without having to query contract storage first.
///
/// For `Published`, `previous` is `None`.
///
/// For `Corrected`, `previous` contains the value that was replaced.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IndexEvent {
    pub kind: IndexEventKind,
    pub previous: Option<i128>,
    pub value: i128,
}

#[contract]
pub struct KovaraIndex;

#[contractimpl]
impl KovaraIndex {
    /// Emit the canonical index update event.
    ///
    /// The event topics are:
    ///
    /// `(index, country, date)`
    ///
    /// The event data contains:
    ///
    /// - `Published` + `None` when this is the first value.
    /// - `Corrected` + `Some(previous)` when an existing value is replaced.
    /// - `value` is always the newly stored value.
    fn emit_index_event(
        env: &Env,
        country: Symbol,
        date: u64,
        previous: Option<i128>,
        value: i128,
    ) {
        let kind = if previous.is_some() {
            IndexEventKind::Corrected
        } else {
            IndexEventKind::Published
        };

        let event = IndexEvent {
            kind,
            previous,
            value,
        };

        env.events().publish(
            (
                Symbol::new(env, "index"),
                country,
                date,
            ),
            event,
        );
    }

    /// Write one daily index value for a country/date.
    ///
    /// Emits an `index` event that explicitly distinguishes the first
    /// publication from a correction.
    pub fn set_daily_index(
        env: Env,
        updater: Address,
        country: Symbol,
        date: u64,
        value: i128,
    ) -> Result<(), Error> {
        if date == 0 {
            return Err(Error::InvalidDate);
        }

        updater.require_auth();

        let key = DataKey::DailyIndex(country.clone(), date);

        // Read the existing value before replacing it. This is what allows
        // the emitted event to distinguish publication from correction.
        let previous: Option<i128> =
            env.storage().persistent().get(&key);

        env.storage()
            .persistent()
            .set(&key, &value);

        Self::emit_index_event(
            &env,
            country,
            date,
            previous,
            value,
        );

        Ok(())
    }

    /// Read a stored daily index value, if present.
    pub fn get_daily_index(
        env: Env,
        country: Symbol,
        date: u64,
    ) -> Option<i128> {
        env.storage()
            .persistent()
            .get(&DataKey::DailyIndex(country, date))
    }

    /// # Is `query_ts` inside `[valid_from, valid_until)`?
    pub fn is_fresh(
        valid_from: u64,
        valid_until: u64,
        query_ts: u64,
    ) -> bool {
        valid_until > valid_from
            && query_ts >= valid_from
            && query_ts < valid_until
    }

    /// The window a stored daily index value came from.
    pub fn get_daily_window(
        env: Env,
        country: Symbol,
        date: u64,
    ) -> Option<(u64, u64)> {
        env.storage()
            .persistent()
            .get(&DataKey::DailyWindow(country, date))
    }

    /// Write a daily index value, refusing a stale observation.
    ///
    /// Emits the same publication/correction event as `set_daily_index`.
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
        // Validate before authentication and before storage writes.
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

        updater.require_auth();

        let key = DataKey::DailyIndex(country.clone(), date);

        // Capture the old value before replacing it so the event can
        // identify this operation as either a publication or correction.
        let previous: Option<i128> =
            env.storage().persistent().get(&key);

        // Value and window are written together.
        env.storage()
            .persistent()
            .set(&key, &value);

        env.storage()
            .persistent()
            .set(
                &DataKey::DailyWindow(country.clone(), date),
                &(valid_from, valid_until),
            );

        Self::emit_index_event(
            &env,
            country,
            date,
            previous,
            value,
        );

        Ok(())
    }

    /// Read a stored daily index value only if its window was fresh at
    /// `query_ts`.
    pub fn get_fresh_daily_index(
        env: Env,
        country: Symbol,
        date: u64,
        query_ts: u64,
    ) -> Option<i128> {
        let (valid_from, valid_until) =
            Self::get_daily_window(
                env.clone(),
                country.clone(),
                date,
            )?;

        if !Self::is_fresh(
            valid_from,
            valid_until,
            query_ts,
        ) {
            return None;
        }

        Self::get_daily_index(
            env,
            country,
            date,
        )
    }
}

// ── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    use soroban_sdk::{
        testutils::{Address as _, Events, Ledger, Register as _},
        Env,
    };

    fn deploy(env: &Env) -> (KovaraIndexClient, Address) {
        let contract_id = env.register(KovaraIndex, ());

        (
            KovaraIndexClient::new(env, &contract_id),
            Address::generate(env),
        )
    }

    #[test]
    fn freshness_is_half_open() {
        let env = Env::default();
        let (client, _) = deploy(&env);

        assert!(client.is_fresh(
            &1_000,
            &2_000,
            &1_000
        ));

        assert!(client.is_fresh(
            &1_000,
            &2_000,
            &1_500
        ));

        assert!(client.is_fresh(
            &1_000,
            &2_000,
            &1_999
        ));

        // Upper bound is exclusive.
        assert!(!client.is_fresh(
            &1_000,
            &2_000,
            &2_000
        ));

        assert!(!client.is_fresh(
            &1_000,
            &2_000,
            &999
        ));

        assert!(!client.is_fresh(
            &1_000,
            &1_000,
            &1_000
        ));

        assert!(!client.is_fresh(
            &2_000,
            &1_000,
            &1_500
        ));
    }

    #[test]
    fn first_publication_emits_published_event() {
        let env = Env::default();
        let (client, updater) = deploy(&env);

        let country = Symbol::new(&env, "NG");

        env.mock_all_auths();

        client.set_daily_index(
            &updater,
            &country,
            &1,
            &1_500,
        );

        assert_eq!(
            client.get_daily_index(
                &country,
                &1
            ),
            Some(1_500)
        );

        let events = env.events().all();

        assert_eq!(events.len(), 1);

        let (_, data) = &events[0];

        let event: IndexEvent =
            data.clone().into_val(&env);

        assert_eq!(
            event,
            IndexEvent {
                kind: IndexEventKind::Published,
                previous: None,
                value: 1_500,
            }
        );
    }

    #[test]
    fn correction_emits_corrected_event_with_previous_value() {
        let env = Env::default();
        let (client, updater) = deploy(&env);

        let country = Symbol::new(&env, "NG");

        env.mock_all_auths();

        // First publication.
        client.set_daily_index(
            &updater,
            &country,
            &1,
            &1_500,
        );

        // Correction.
        client.set_daily_index(
            &updater,
            &country,
            &1,
            &1_600,
        );

        assert_eq!(
            client.get_daily_index(
                &country,
                &1
            ),
            Some(1_600)
        );

        let events = env.events().all();

        assert_eq!(events.len(), 2);

        let (_, first_data) = &events[0];
        let (_, second_data) = &events[1];

        let first: IndexEvent =
            first_data.clone().into_val(&env);

        let second: IndexEvent =
            second_data.clone().into_val(&env);

        assert_eq!(
            first.kind,
            IndexEventKind::Published
        );

        assert_eq!(
            first.previous,
            None
        );

        assert_eq!(
            first.value,
            1_500
        );

        assert_eq!(
            second,
            IndexEvent {
                kind: IndexEventKind::Corrected,
                previous: Some(1_500),
                value: 1_600,
            }
        );
    }

    #[test]
    fn windowed_first_publication_emits_published_event() {
        let env = Env::default();
        let (client, updater) = deploy(&env);

        let country = Symbol::new(&env, "NG");

        env.mock_all_auths();

        client.set_daily_index_windowed(
            &updater,
            &country,
            &1,
            &1_500,
            &1_000,
            &2_000,
            &1_500,
        );

        assert_eq!(
            client.get_daily_index(
                &country,
                &1
            ),
            Some(1_500)
        );

        assert_eq!(
            client.get_daily_window(
                &country,
                &1
            ),
            Some((1_000, 2_000))
        );

        let events = env.events().all();

        assert_eq!(events.len(), 1);

        let (_, data) = &events[0];

        let event: IndexEvent =
            data.clone().into_val(&env);

        assert_eq!(
            event,
            IndexEvent {
                kind: IndexEventKind::Published,
                previous: None,
                value: 1_500,
            }
        );
    }

    #[test]
    fn windowed_correction_emits_corrected_event() {
        let env = Env::default();
        let (client, updater) = deploy(&env);

        let country = Symbol::new(&env, "NG");

        env.mock_all_auths();

        client.set_daily_index_windowed(
            &updater,
            &country,
            &1,
            &1_500,
            &1_000,
            &2_000,
            &1_500,
        );

        client.set_daily_index_windowed(
            &updater,
            &country,
            &1,
            &1_600,
            &1_000,
            &2_000,
            &1_600,
        );

        assert_eq!(
            client.get_daily_index(
                &country,
                &1
            ),
            Some(1_600)
        );

        let events = env.events().all();

        assert_eq!(events.len(), 2);

        let (_, data) = &events[1];

        let event: IndexEvent =
            data.clone().into_val(&env);

        assert_eq!(
            event,
            IndexEvent {
                kind: IndexEventKind::Corrected,
                previous: Some(1_500),
                value: 1_600,
            }
        );
    }

    #[test]
    fn rejected_windowed_write_emits_no_event() {
        let env = Env::default();
        let (client, updater) = deploy(&env);

        let country = Symbol::new(&env, "NG");

        env.mock_all_auths();

        client.set_daily_index_windowed(
            &updater,
            &country,
            &1,
            &1_500,
            &1_000,
            &2_000,
            &1_500,
        );

        let before = env.events().all().len();

        assert!(
            client
                .try_set_daily_index_windowed(
                    &updater,
                    &country,
                    &1,
                    &1_700,
                    &1_000,
                    &2_000,
                    &2_000,
                )
                .is_err()
        );

        assert_eq!(
            env.events().all().len(),
            before
        );

        assert_eq!(
            client.get_daily_index(
                &country,
                &1
            ),
            Some(1_500)
        );
    }

    #[test]
    fn different_dates_are_independent_publications() {
        let env = Env::default();
        let (client, updater) = deploy(&env);

        let country = Symbol::new(&env, "NG");

        env.mock_all_auths();

        client.set_daily_index(
            &updater,
            &country,
            &1,
            &1_500,
        );

        client.set_daily_index(
            &updater,
            &country,
            &2,
            &1_600,
        );

        let events = env.events().all();

        assert_eq!(events.len(), 2);

        let (_, first_data) = &events[0];
        let (_, second_data) = &events[1];

        let first: IndexEvent =
            first_data.clone().into_val(&env);

        let second: IndexEvent =
            second_data.clone().into_val(&env);

        assert_eq!(
            first.kind,
            IndexEventKind::Published
        );

        assert_eq!(
            second.kind,
            IndexEventKind::Published
        );

        assert_eq!(first.previous, None);
        assert_eq!(second.previous, None);

        assert_eq!(first.value, 1_500);
        assert_eq!(second.value, 1_600);
    }

    #[test]
    fn unwindowed_entry_has_no_window() {
        let env = Env::default();
        let (client, updater) = deploy(&env);

        let country = Symbol::new(&env, "NG");

        env.mock_all_auths();

        client.set_daily_index(
            &updater,
            &country,
            &1,
            &1_500,
        );

        assert_eq!(
            client.get_daily_index(
                &country,
                &1
            ),
            Some(1_500)
        );

        assert_eq!(
            client.get_daily_window(
                &country,
                &1
            ),
            None
        );

        assert_eq!(
            client.get_fresh_daily_index(
                &country,
                &1,
                &1_500
            ),
            None
        );
    }

    #[test]
    fn stale_entry_drops_out_of_fresh_read() {
        let env = Env::default();
        let (client, updater) = deploy(&env);

        let country = Symbol::new(&env, "NG");

        env.mock_all_auths();

        client.set_daily_index_windowed(
            &updater,
            &country,
            &1,
            &1_500,
            &1_000,
            &2_000,
            &1_500,
        );

        assert_eq!(
            client.get_fresh_daily_index(
                &country,
                &1,
                &1_999
            ),
            Some(1_500)
        );

        assert_eq!(
            client.get_fresh_daily_index(
                &country,
                &1,
                &2_000
            ),
            None
        );

        assert_eq!(
            client.get_daily_index(
                &country,
                &1
            ),
            Some(1_500)
        );

        assert_eq!(
            client.get_daily_window(
                &country,
                &1
            ),
            Some((1_000, 2_000))
        );
    }
}
