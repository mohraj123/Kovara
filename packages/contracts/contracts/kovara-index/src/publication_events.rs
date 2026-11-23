//! Tests for CT-048: Emit KovaraIndex publication events.
//!
//! Verifies that every accepted `set_daily_index` call emits a
//! `DailyIndexUpdated` event containing country, date, value, and the
//! validity window (source_period_start / source_period_end), and that
//! rejected calls emit nothing.

use crate::{DailyIndexUpdated, Error, KovaraIndex, KovaraIndexClient, SCHEMA_VERSION};
use soroban_sdk::testutils::{Address as _, Events};
use soroban_sdk::{symbol_short, vec, Address, Env, IntoVal, Symbol, Vec};

struct Fixture<'a> {
    env: Env,
    client: KovaraIndexClient<'a>,
    contract_id: Address,
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
        contract_id,
        admin,
        updater,
    }
}

const NG: Symbol = symbol_short!("NG");
const DATE: u64 = 20_140;
const VALUE: i128 = 1_234_567;
const BASKET: u32 = 7;
const PS: u64 = 1_700_000_000;
const PE: u64 = 1_700_086_400;

fn cats(f: &Fixture) -> soroban_sdk::Vec<Symbol> {
    vec![&f.env, symbol_short!("food"), symbol_short!("fuel")]
}

fn write(f: &Fixture) {
    f.client.set_daily_index(
        &vec![&f.env, f.updater.clone()],
        &NG,
        &DATE,
        &VALUE,
        &BASKET,
        &PS,
        &PE,
        &cats(f),
    );
}

fn expected_event(
    f: &Fixture,
    event: &DailyIndexUpdated,
) -> soroban_sdk::Vec<(
    Address,
    soroban_sdk::Vec<soroban_sdk::Val>,
    soroban_sdk::Val,
)> {
    vec![
        &f.env,
        (
            f.contract_id.clone(),
            event.topics(&f.env),
            event.data(&f.env),
        ),
    ]
}

/// Every successful write emits exactly one `DailyIndexUpdated` event.
#[test]
fn a_successful_write_emits_exactly_one_event() {
    let f = deploy_initialized();
    write(&f);

    assert_eq!(f.env.events().all().events().len(), 1);
}

/// The event carries all required fields: country, date, value, basket,
/// source period, updater, schema version, and categories.
#[test]
fn the_event_carries_all_required_fields() {
    let f = deploy_initialized();
    write(&f);

    let expected = DailyIndexUpdated {
        country: NG,
        date: DATE,
        value: VALUE,
        basket_version: BASKET,
        source_period_start: PS,
        source_period_end: PE,
        updater: f.updater.clone(),
        schema_version: SCHEMA_VERSION,
        categories: cats(&f),
    };

    assert_eq!(f.env.events().all(), expected_event(&f, &expected));
}

/// `country` and `date` are topics so an indexer can subscribe to one
/// country without decoding every event body.
#[test]
fn country_and_date_are_topics() {
    let f = deploy_initialized();
    write(&f);

    let event = DailyIndexUpdated {
        country: NG,
        date: DATE,
        value: VALUE,
        basket_version: BASKET,
        source_period_start: PS,
        source_period_end: PE,
        updater: f.updater.clone(),
        schema_version: SCHEMA_VERSION,
        categories: cats(&f),
    };

    let topics = event.topics(&f.env);

    let country_topic: soroban_sdk::Val = NG.into_val(&f.env);
    let date_topic: soroban_sdk::Val = DATE.into_val(&f.env);
    let value_val: soroban_sdk::Val = VALUE.into_val(&f.env);

    assert!(
        topics.contains(country_topic),
        "country should be a topic: {topics:?}"
    );
    assert!(
        topics.contains(date_topic),
        "date should be a topic: {topics:?}"
    );

    // Value belongs in the data body, not as a topic.
    assert!(!topics.contains(value_val));
}

/// The event fields match what was actually stored.
#[test]
fn the_event_matches_the_stored_record() {
    let f = deploy_initialized();
    write(&f);

    let emitted = f.env.events().all();
    let stored = f.client.get_daily_index(&NG, &DATE).unwrap();

    let from_storage = DailyIndexUpdated {
        country: stored.country.clone(),
        date: stored.date,
        value: stored.value,
        basket_version: stored.basket_version,
        source_period_start: stored.source_period_start,
        source_period_end: stored.source_period_end,
        updater: stored.updater.clone(),
        schema_version: stored.schema_version,
        categories: stored.categories.clone(),
    };

    assert_eq!(emitted, expected_event(&f, &from_storage));
}

/// A write rejected due to an invalid basket version emits no event.
#[test]
fn rejected_write_emits_no_event() {
    let f = deploy_initialized();

    let _ = f.client.try_set_daily_index(
        &vec![&f.env, f.updater.clone()],
        &NG,
        &DATE,
        &VALUE,
        &0u32, // invalid basket
        &PS,
        &PE,
        &cats(&f),
    );

    assert_eq!(f.env.events().all().events().len(), 0);
}

/// A write rejected due to an invalid source period emits no event.
#[test]
fn rejected_write_with_bad_period_emits_no_event() {
    let f = deploy_initialized();

    let _ = f.client.try_set_daily_index(
        &vec![&f.env, f.updater.clone()],
        &NG,
        &DATE,
        &VALUE,
        &BASKET,
        &PE, // end before start
        &PS,
        &cats(&f),
    );

    assert_eq!(f.env.events().all().events().len(), 0);
}

/// Two writes for different countries each emit their own event.
#[test]
fn two_writes_to_different_countries_each_emit_one_event() {
    let f = deploy_initialized();

    write(&f);

    f.client.set_daily_index(
        &vec![&f.env, f.updater.clone()],
        &symbol_short!("KE"),
        &DATE,
        &VALUE,
        &BASKET,
        &PS,
        &PE,
        &cats(&f),
    );

    // Events reset each invocation — only the latest is visible.
    assert_eq!(f.env.events().all().events().len(), 1);
}
