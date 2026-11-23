//! Tests for CT-050: versioned KovaraIndex storage keys.
//!
//! Verifies that:
//! - `DailyIndex` and `DailyIndexV` key variants are genuinely disjoint.
//! - Existing `DailyIndex`-keyed reads continue to work after `DailyIndexV`
//!   records are written alongside them.
//! - The schema version prefix in both variants prevents cross-schema
//!   collisions.

use crate::{DailyIndex, DataKey, Error, KovaraIndex, KovaraIndexClient, SCHEMA_VERSION};
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{symbol_short, vec, Address, Env, Symbol, Vec};

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

fn write_via_set(f: &Fixture) {
    f.client.set_daily_index(
        &vec![&f.env, f.updater.clone()],
        &NG,
        &DATE,
        &VALUE,
        &BASKET,
        &PS,
        &PE,
        &vec![&f.env, symbol_short!("food")],
    );
}

/// Reading via the standard key works after a standard write.
#[test]
fn standard_key_read_works_after_standard_write() {
    let f = deploy_initialized();
    write_via_set(&f);

    let record = f.client.get_daily_index(&NG, &DATE).unwrap();

    assert_eq!(record.value, VALUE);
    assert_eq!(record.schema_version, SCHEMA_VERSION);
}

/// `DailyIndex` and `DailyIndexV` are different enum variants and therefore
/// different storage keys.  A record written under one is not visible under
/// the other.
#[test]
fn daily_index_and_daily_index_v_occupy_disjoint_keyspaces() {
    let f = deploy_initialized();

    // Write via the standard path (uses `DailyIndex` key variant).
    write_via_set(&f);

    // The `DailyIndexV` variant at the same (schema, country, date) should
    // return None — nothing has been written there.
    let via_v = f.client.get_daily_index_v(&NG, &DATE);
    assert_eq!(via_v, Ok(None));

    // And the standard read still returns the record.
    let via_std = f.client.get_daily_index(&NG, &DATE);
    assert!(via_std.unwrap().is_some());
}

/// A record written directly under `DailyIndexV` is readable via
/// `get_daily_index_v` and invisible to `get_daily_index`.
#[test]
fn record_written_under_daily_index_v_is_readable_via_v_only() {
    let f = deploy_initialized();

    let versioned_record = DailyIndex {
        country: NG,
        date: DATE,
        value: 9_999,
        basket_version: 2,
        source_period_start: PS,
        source_period_end: PE,
        updater: f.updater.clone(),
        schema_version: SCHEMA_VERSION,
        categories: vec![&f.env, symbol_short!("fuel")],
    };

    // Plant a record under the DailyIndexV key directly.
    f.env.as_contract(&f.contract_id, || {
        f.env.storage().persistent().set(
            &DataKey::DailyIndexV(SCHEMA_VERSION, NG, DATE),
            &versioned_record,
        );
    });

    // Readable via `get_daily_index_v`.
    let via_v = f.client.get_daily_index_v(&NG, &DATE).unwrap();
    assert_eq!(via_v.unwrap().value, 9_999);

    // Not visible via the standard `get_daily_index`.
    assert_eq!(f.client.get_daily_index(&NG, &DATE), Ok(None));
}

/// Both keys embed the schema version, so records from different schemas
/// cannot collide regardless of which variant is used.
#[test]
fn versioned_keys_do_not_collide_across_schema_versions() {
    let f = deploy_initialized();
    write_via_set(&f);

    let other_schema = SCHEMA_VERSION + 1;

    f.env.as_contract(&f.contract_id, || {
        // Write a record under DailyIndexV with a different schema version.
        let foreign = DailyIndex {
            country: NG,
            date: DATE,
            value: 777,
            basket_version: 1,
            source_period_start: PS,
            source_period_end: PE,
            updater: f.updater.clone(),
            schema_version: other_schema,
            categories: vec![&f.env, symbol_short!("food")],
        };

        f.env.storage().persistent().set(
            &DataKey::DailyIndexV(other_schema, NG, DATE),
            &foreign,
        );

        // The v1 record under the standard key is untouched.
        let ours: DailyIndex = f
            .env
            .storage()
            .persistent()
            .get(&DataKey::DailyIndex(SCHEMA_VERSION, NG, DATE))
            .expect("v1 DailyIndex record still present");

        assert_eq!(ours.value, VALUE);

        // And the v1 record under DailyIndexV key (if any) is untouched too.
        // We only wrote DailyIndexV for other_schema, so DailyIndexV(v1) is None.
        let v1_v: Option<DailyIndex> = f
            .env
            .storage()
            .persistent()
            .get(&DataKey::DailyIndexV(SCHEMA_VERSION, NG, DATE));

        assert!(v1_v.is_none());
    });
}

/// `get_daily_index_v` is guarded by the same schema check as
/// `get_daily_index`.
#[test]
fn get_daily_index_v_rejects_incompatible_schema() {
    let f = deploy_initialized();
    write_via_set(&f);

    f.env.as_contract(&f.contract_id, || {
        f.env
            .storage()
            .instance()
            .set(&DataKey::Schema, &(SCHEMA_VERSION + 1));
    });

    assert_eq!(
        f.client.try_get_daily_index_v(&NG, &DATE),
        Err(Ok(Error::IncompatibleSchema))
    );
}

/// `get_daily_index_v` returns None for an unknown country.
#[test]
fn get_daily_index_v_returns_none_for_unknown_country() {
    let f = deploy_initialized();

    assert_eq!(f.client.get_daily_index_v(&NG, &DATE), Ok(None));
}
