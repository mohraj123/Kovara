//! Tests for CT-042: KovaraIndex category-level aggregation inputs.
//!
//! Verifies that categories are stored and retrieved correctly, that the list
//! is bounded by `MAX_CATEGORIES`, and that an empty list is rejected.

use crate::{Error, KovaraIndex, KovaraIndexClient, MAX_CATEGORIES};
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
const DATE: u64 = 20_140;
const VALUE: i128 = 1_234_567;
const BASKET: u32 = 7;
const PS: u64 = 1_700_000_000;
const PE: u64 = 1_700_086_400;

fn write_with_cats(f: &Fixture, categories: Vec<Symbol>) -> Result<Result<(), Error>, soroban_sdk::Error> {
    f.client.try_set_daily_index(
        &vec![&f.env, f.updater.clone()],
        &NG,
        &DATE,
        &VALUE,
        &BASKET,
        &PS,
        &PE,
        &categories,
    )
}

/// Categories are stored and round-trip correctly.
#[test]
fn categories_are_stored_and_retrieved() {
    let f = deploy_initialized();
    let cats = vec![
        &f.env,
        symbol_short!("food"),
        symbol_short!("fuel"),
        symbol_short!("housing"),
    ];

    write_with_cats(&f, cats.clone()).unwrap().unwrap();

    let record = f.client.get_daily_index(&NG, &DATE).unwrap();

    assert_eq!(record.categories, cats);
}

/// A single-element category list is accepted.
#[test]
fn single_category_is_accepted() {
    let f = deploy_initialized();
    let cats = vec![&f.env, symbol_short!("food")];

    assert_eq!(write_with_cats(&f, cats), Ok(Ok(())));
}

/// An empty category list is rejected.
#[test]
fn empty_category_list_is_rejected() {
    let f = deploy_initialized();

    assert_eq!(
        write_with_cats(&f, Vec::new(&f.env)),
        Err(Ok(Error::EmptyCategoryList))
    );
}

/// A list exceeding `MAX_CATEGORIES` is rejected.
#[test]
fn category_list_exceeding_max_is_rejected() {
    let f = deploy_initialized();

    let mut cats = Vec::new(&f.env);
    // Build MAX_CATEGORIES + 1 categories using symbol_short! for a few
    // known names and then reuse them to exceed the limit.
    let names = [
        symbol_short!("food"),
        symbol_short!("fuel"),
        symbol_short!("housing"),
        symbol_short!("health"),
        symbol_short!("edu"),
        symbol_short!("trans"),
        symbol_short!("util"),
        symbol_short!("cloth"),
    ];

    for i in 0..=(MAX_CATEGORIES as usize) {
        cats.push_back(names[i % names.len()].clone());
    }

    assert_eq!(
        write_with_cats(&f, cats),
        Err(Ok(Error::CategoryListTooLong))
    );
}

/// A list of exactly `MAX_CATEGORIES` entries is accepted.
#[test]
fn category_list_at_max_is_accepted() {
    let f = deploy_initialized();

    let mut cats = Vec::new(&f.env);
    let names = [
        symbol_short!("food"),
        symbol_short!("fuel"),
        symbol_short!("housing"),
        symbol_short!("health"),
        symbol_short!("edu"),
        symbol_short!("trans"),
        symbol_short!("util"),
        symbol_short!("cloth"),
    ];

    for i in 0..MAX_CATEGORIES as usize {
        cats.push_back(names[i % names.len()].clone());
    }

    assert_eq!(write_with_cats(&f, cats), Ok(Ok(())));
}

/// Categories are stored independently per country and date.
#[test]
fn categories_are_per_country_and_date() {
    let f = deploy_initialized();

    let cats_ng = vec![&f.env, symbol_short!("food"), symbol_short!("fuel")];
    let cats_ke = vec![&f.env, symbol_short!("housing"), symbol_short!("health")];

    // Write for NG at DATE.
    f.client
        .set_daily_index(
            &vec![&f.env, f.updater.clone()],
            &NG,
            &DATE,
            &VALUE,
            &BASKET,
            &PS,
            &PE,
            &cats_ng.clone(),
        );

    // Write for KE at DATE.
    f.client
        .set_daily_index(
            &vec![&f.env, f.updater.clone()],
            &symbol_short!("KE"),
            &DATE,
            &VALUE,
            &BASKET,
            &PS,
            &PE,
            &cats_ke.clone(),
        );

    let ng_record = f.client.get_daily_index(&NG, &DATE).unwrap();
    let ke_record = f.client.get_daily_index(&symbol_short!("KE"), &DATE).unwrap();

    assert_eq!(ng_record.categories, cats_ng);
    assert_eq!(ke_record.categories, cats_ke);
}

/// Categories are included in the emitted event.
#[test]
fn categories_appear_in_the_emitted_event() {
    use crate::DailyIndexUpdated;
    use soroban_sdk::testutils::Events;
    use soroban_sdk::IntoVal;

    let env = Env::default();
    let contract_id = env.register(KovaraIndex, ());
    let client = KovaraIndexClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let updater = Address::generate(&env);

    env.mock_all_auths();
    client.initialize(&admin);
    client.set_sentinels(&admin, &vec![&env, updater.clone()], &1);

    let cats = vec![&env, symbol_short!("food"), symbol_short!("fuel")];

    client
        .set_daily_index(
            &vec![&env, updater.clone()],
            &NG,
            &DATE,
            &VALUE,
            &BASKET,
            &PS,
            &PE,
            &cats.clone(),
        );

    // Retrieve emitted events and check the data section contains the
    // categories.
    let all_events = env.events().all();
    assert_eq!(all_events.events().len(), 1);

    // The categories field lives in the event data, not topics. Verify by
    // reconstructing the event and comparing the encoded data.
    let expected = DailyIndexUpdated {
        country: NG,
        date: DATE,
        value: VALUE,
        basket_version: BASKET,
        source_period_start: PS,
        source_period_end: PE,
        updater: updater.clone(),
        schema_version: crate::SCHEMA_VERSION,
        categories: cats,
    };

    let (_, _, event_data) = all_events.events().get(0).unwrap();
    let expected_data = expected.data(&env);
    let expected_data_val: soroban_sdk::Val = expected_data.into_val(&env);

    assert_eq!(event_data, expected_data_val);
}
