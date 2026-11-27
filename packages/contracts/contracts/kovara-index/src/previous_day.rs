//! Tests for CT-047: KovaraIndex previous-day lookup.
//!
//! Verifies that `get_previous_day` returns the most recent prior record
//! within the bounded look-back window, and that it returns `NoPreviousDay`
//! when no record exists within that window.

use crate::{Error, KovaraIndex, KovaraIndexClient, MAX_LOOKBACK_DAYS, SCHEMA_VERSION};
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{symbol_short, vec, Address, Env, Symbol, Vec};

struct Fixture<'a> {
    env: Env,
    client: KovaraIndexClient<'a>,
    admin: Address,
    updater: Address,
}

fn deploy_initialized() -> Fixture<'static> {
    let env = Env::default();
    let contract_id = env.register(KovaraIndex, ());
    let client = KovaraIndexClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let updater = Address::generate(&env);

    env.mock_all_auths();

    client.initialize(&admin);
    client.set_sentinels(&admin, &vec![&env, updater.clone()], &1);

    Fixture {
        env,
        client,
        admin,
        updater,
    }
}

const NG: Symbol = symbol_short!("NG");
const KE: Symbol = symbol_short!("KE");
const BASKET: u32 = 3;
const PS: u64 = 1_700_000_000;
const PE: u64 = 1_700_086_400;

fn write(f: &Fixture, country: Symbol, date: u64, value: i128) {
    f.client.set_daily_index(
        &vec![&f.env, f.updater.clone()],
        &country,
        &date,
        &value,
        &BASKET,
        &PS,
        &PE,
        &vec![&f.env, symbol_short!("food")],
    );
}

/// When consecutive days exist, the previous day is returned immediately.
#[test]
fn returns_the_immediately_preceding_day() {
    let f = deploy_initialized();

    write(&f, NG, 1_000, 100);
    write(&f, NG, 1_001, 200);

    let prev = f.client.get_previous_day(&NG, &1_001);

    assert_eq!(prev.date, 1_000);
    assert_eq!(prev.value, 100);
}

/// When there is a gap, the lookup scans backward and finds the nearest
/// available record.
#[test]
fn returns_the_nearest_prior_day_across_a_gap() {
    let f = deploy_initialized();

    write(&f, NG, 1_000, 100);
    // 1_001 and 1_002 are absent.
    write(&f, NG, 1_003, 300);

    let prev = f.client.get_previous_day(&NG, &1_003);

    assert_eq!(prev.date, 1_000);
}

/// No prior record within the look-back window → `NoPreviousDay`.
#[test]
fn returns_no_previous_day_when_window_is_empty() {
    let f = deploy_initialized();

    // Write only at a date far from the query.
    write(&f, NG, 500, 50);

    // Query at 500 + MAX_LOOKBACK_DAYS + 10 so the record is outside the
    // look-back window.
    let query = 500 + MAX_LOOKBACK_DAYS + 10;

    assert_eq!(
        f.client.try_get_previous_day(&NG, &query),
        Err(Ok(Error::NoPreviousDay))
    );
}

/// When `date` is 0 there can be no previous day.
#[test]
fn returns_no_previous_day_for_date_zero() {
    let f = deploy_initialized();

    assert_eq!(
        f.client.try_get_previous_day(&NG, &0),
        Err(Ok(Error::NoPreviousDay))
    );
}

/// A record exactly at the edge of the look-back window is found.
#[test]
fn finds_record_at_the_exact_lookback_boundary() {
    let f = deploy_initialized();

    let base_date = 10_000u64;
    write(&f, NG, base_date, 42);

    // Query at base_date + MAX_LOOKBACK_DAYS: the record is exactly at the
    // floor of the scan.
    let query = base_date + MAX_LOOKBACK_DAYS;

    let prev = f.client.get_previous_day(&NG, &query);
    assert_eq!(prev.date, base_date);
}

/// A record one day beyond the look-back window is not found.
#[test]
fn does_not_find_record_just_outside_lookback_window() {
    let f = deploy_initialized();

    let base_date = 10_000u64;
    write(&f, NG, base_date, 42);

    // One day beyond the boundary.
    let query = base_date + MAX_LOOKBACK_DAYS + 1;

    assert_eq!(
        f.client.try_get_previous_day(&NG, &query),
        Err(Ok(Error::NoPreviousDay))
    );
}

/// Each country's history is independent.
#[test]
fn lookup_is_country_specific() {
    let f = deploy_initialized();

    write(&f, NG, 1_000, 100);
    // KE has no data.

    assert_eq!(
        f.client.try_get_previous_day(&KE, &1_001),
        Err(Ok(Error::NoPreviousDay))
    );

    // NG still works.
    let prev = f.client.get_previous_day(&NG, &1_001);
    assert_eq!(prev.date, 1_000);
}

/// When multiple records exist before a date, only the most recent is
/// returned (the scan stops at the first hit going backward).
#[test]
fn returns_the_most_recent_prior_record_not_the_earliest() {
    let f = deploy_initialized();

    write(&f, NG, 1_000, 10);
    write(&f, NG, 1_001, 20);
    write(&f, NG, 1_002, 30);

    let prev = f.client.get_previous_day(&NG, &1_003);

    assert_eq!(prev.date, 1_002);
    assert_eq!(prev.value, 30);
}

/// The schema guard applies: calling before initialization returns an error.
#[test]
fn returns_not_initialized_before_initialization() {
    let env = Env::default();
    let contract_id = env.register(KovaraIndex, ());
    let client = KovaraIndexClient::new(&env, &contract_id);
    env.mock_all_auths();

    assert_eq!(
        client.try_get_previous_day(&NG, &1_000),
        Err(Ok(Error::NotInitialized))
    );
}
