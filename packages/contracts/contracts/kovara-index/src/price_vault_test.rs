//! Tests for PriceVault contract (CT-002, CT-003, CT-004, CT-005).

use crate::price_vault::{Error, PriceVault, PriceVaultClient};
use soroban_sdk::testutils::Address as _;
use soroban_sdk::testutils::Events;
use soroban_sdk::testutils::Ledger as _;
use soroban_sdk::{symbol_short, Address, Env, Symbol};

struct Fixture<'a> {
    env: Env,
    client: PriceVaultClient<'a>,
    admin: Address,
    submitter: Address,
}

fn deploy() -> Fixture<'static> {
    let env = Env::default();
    let contract_id = env.register(PriceVault, ());
    let client = PriceVaultClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let submitter = Address::generate(&env);

    env.mock_all_auths();

    Fixture {
        env,
        client,
        admin,
        submitter,
    }
}

fn deploy_initialized() -> Fixture<'static> {
    let f = deploy();
    f.client.initialize(&f.admin);
    f
}

const US: Symbol = symbol_short!("US");
const NG: Symbol = symbol_short!("NG");
const KE: Symbol = symbol_short!("KE");
const ZZ: Symbol = symbol_short!("ZZ");
const FOOD: Symbol = symbol_short!("Food");
const RENT: Symbol = symbol_short!("Rent");
const TRANSPORT: Symbol = symbol_short!("Transport");
const UTILITIES: Symbol = symbol_short!("Utilities");
const HEALTH: Symbol = symbol_short!("Health");
const INVALID_CAT: Symbol = symbol_short!("Invalid");
const USD: Symbol = symbol_short!("USD");
const NGN: Symbol = symbol_short!("NGN");

// ═══════════════════════════════════════════════════════════════════════════
// CT-002 — Implement PriceVault
// ═══════════════════════════════════════════════════════════════════════════

/// Basic submission and retrieval round-trip.
#[test]
fn a_submission_can_be_submitted_and_retrieved() {
    let f = deploy_initialized();

    let id = f.client.submit(&f.submitter, &US, &FOOD, &100, &USD, &100);

    let submission = f.client.try_get_submission(&id).unwrap().unwrap();

    assert_eq!(submission.id, 0);
    assert_eq!(submission.submitter, f.submitter);
    assert_eq!(submission.country_iso, US);
    assert_eq!(submission.category, FOOD);
    assert_eq!(submission.price_usd_cents, 100);
    assert_eq!(submission.currency_local, USD);
    assert_eq!(submission.price_local, 100);
}

/// Sequential submissions get incrementing IDs.
#[test]
fn submissions_get_sequential_ids() {
    let f = deploy_initialized();

    let id1 = f.client.submit(&f.submitter, &US, &FOOD, &100, &USD, &100);
    let id2 = f.client.submit(&f.submitter, &US, &RENT, &200, &USD, &200);
    let id3 = f.client.submit(&f.submitter, &NG, &FOOD, &300, &NGN, &50000);

    assert_eq!(id1, 0);
    assert_eq!(id2, 1);
    assert_eq!(id3, 2);
}

/// Submission count increments with each submission.
#[test]
fn submission_count_increments() {
    let f = deploy_initialized();

    assert_eq!(f.client.submission_count(), 0);

    f.client.submit(&f.submitter, &US, &FOOD, &100, &USD, &100);
    assert_eq!(f.client.submission_count(), 1);

    f.client.submit(&f.submitter, &US, &RENT, &200, &USD, &200);
    assert_eq!(f.client.submission_count(), 2);
}

/// A rejected submission does not increment the counter.
#[test]
fn a_rejected_submission_does_not_increment_counter() {
    let f = deploy_initialized();

    assert_eq!(
        f.client.try_submit(&f.submitter, &ZZ, &FOOD, &100, &USD, &100),
        Err(Ok(Error::InvalidCountry))
    );
    assert_eq!(f.client.submission_count(), 0);
}

/// The event carries every required field.
#[test]
fn the_event_carries_every_required_field() {
    let f = deploy_initialized();

    f.client.submit(&f.submitter, &US, &FOOD, &100, &USD, &100);

    let events = f.env.events().all();
    assert_eq!(events.events().len(), 1);
}

/// Getting a non-existent submission returns NotFound.
#[test]
fn getting_a_nonexistent_submission_returns_not_found() {
    let f = deploy_initialized();

    assert_eq!(
        f.client.try_get_submission(&999),
        Err(Ok(Error::NotFound))
    );
}

/// Pending submissions are returned for a country.
#[test]
fn pending_submissions_are_returned_for_a_country() {
    let f = deploy_initialized();

    f.client.submit(&f.submitter, &US, &FOOD, &100, &USD, &100);
    f.client.submit(&f.submitter, &US, &RENT, &200, &USD, &200);
    f.client.submit(&f.submitter, &NG, &FOOD, &300, &NGN, &50000);

    let us_pending = f.client.pending(&US);
    assert_eq!(us_pending.len(), 2);

    let ng_pending = f.client.pending(&NG);
    assert_eq!(ng_pending.len(), 1);

    let ke_pending = f.client.pending(&KE);
    assert_eq!(ke_pending.len(), 0);
}

// ═══════════════════════════════════════════════════════════════════════════
// CT-003 — Key price submissions deterministically
// ═══════════════════════════════════════════════════════════════════════════

/// Different timestamps produce different submissions even for same
/// country/category/submitter.
#[test]
fn different_timestamps_produce_different_submissions() {
    let f = deploy_initialized();

    let id1 = f.client.submit(&f.submitter, &US, &FOOD, &100, &USD, &100);

    // Advance the ledger timestamp
    f.env.ledger().set_timestamp(1000);

    let id2 = f.client.submit(&f.submitter, &US, &FOOD, &100, &USD, &100);

    assert_ne!(id1, id2);

    let sub1 = f.client.try_get_submission(&id1).unwrap().unwrap();
    let sub2 = f.client.try_get_submission(&id2).unwrap().unwrap();

    // Same values but different timestamps
    assert_eq!(sub1.country_iso, sub2.country_iso);
    assert_eq!(sub1.category, sub2.category);
    assert_eq!(sub1.price_usd_cents, sub2.price_usd_cents);
    assert_ne!(sub1.timestamp, sub2.timestamp);
}

/// Different submitters produce different submissions for same country/category.
#[test]
fn different_submitters_produce_different_submissions() {
    let f = deploy_initialized();

    let submitter2 = Address::generate(&f.env);

    let id1 = f.client.submit(&f.submitter, &US, &FOOD, &100, &USD, &100);
    let id2 = f.client.submit(&submitter2, &US, &FOOD, &100, &USD, &100);

    assert_ne!(id1, id2);
}

/// Different countries produce different submissions.
#[test]
fn different_countries_produce_different_submissions() {
    let f = deploy_initialized();

    let id1 = f.client.submit(&f.submitter, &US, &FOOD, &100, &USD, &100);
    let id2 = f.client.submit(&f.submitter, &NG, &FOOD, &100, &USD, &100);

    assert_ne!(id1, id2);
}

/// Different categories produce different submissions.
#[test]
fn different_categories_produce_different_submissions() {
    let f = deploy_initialized();

    let id1 = f.client.submit(&f.submitter, &US, &FOOD, &100, &USD, &100);
    let id2 = f.client.submit(&f.submitter, &US, &RENT, &100, &USD, &100);

    assert_ne!(id1, id2);
}

// ═══════════════════════════════════════════════════════════════════════════
// CT-004 — Validate countries and categories
// ═══════════════════════════════════════════════════════════════════════════

/// Invalid country code is rejected.
#[test]
fn an_invalid_country_code_is_rejected() {
    let f = deploy_initialized();

    assert_eq!(
        f.client.try_submit(&f.submitter, &ZZ, &FOOD, &100, &USD, &100),
        Err(Ok(Error::InvalidCountry))
    );
}

/// Valid country codes are accepted.
#[test]
fn valid_country_codes_are_accepted() {
    let f = deploy_initialized();

    // US
    let id = f.client.submit(&f.submitter, &US, &FOOD, &100, &USD, &100);
    assert!(f.client.try_get_submission(&id).is_ok());

    // NG
    let id = f.client.submit(&f.submitter, &NG, &FOOD, &100, &NGN, &50000);
    assert!(f.client.try_get_submission(&id).is_ok());

    // KE
    let id = f.client.submit(&f.submitter, &KE, &FOOD, &100, &USD, &100);
    assert!(f.client.try_get_submission(&id).is_ok());
}

/// Invalid category is rejected.
#[test]
fn an_invalid_category_is_rejected() {
    let f = deploy_initialized();

    assert_eq!(
        f.client.try_submit(&f.submitter, &US, &INVALID_CAT, &100, &USD, &100),
        Err(Ok(Error::InvalidCategory))
    );
}

/// All valid categories are accepted.
#[test]
fn all_valid_categories_are_accepted() {
    let f = deploy_initialized();

    let categories = [
        (FOOD, "Food"),
        (RENT, "Rent"),
        (TRANSPORT, "Transport"),
        (UTILITIES, "Utilities"),
        (HEALTH, "Health"),
    ];

    for (cat, _name) in categories {
        let id = f.client.submit(&f.submitter, &US, &cat, &100, &USD, &100);
        assert!(f.client.try_get_submission(&id).is_ok());
    }
}

/// A rejected submission leaves storage untouched.
#[test]
fn a_rejected_submission_stores_nothing() {
    let f = deploy_initialized();

    assert!(f
        .client
        .try_submit(&f.submitter, &ZZ, &FOOD, &100, &USD, &100)
        .is_err());

    assert_eq!(f.client.submission_count(), 0);
    assert!(f.client.pending(&ZZ).is_empty());
}

// ═══════════════════════════════════════════════════════════════════════════
// CT-005 — Reject invalid price values
// ═══════════════════════════════════════════════════════════════════════════

/// Zero USD price is rejected.
#[test]
fn a_zero_usd_price_is_rejected() {
    let f = deploy_initialized();

    assert_eq!(
        f.client.try_submit(&f.submitter, &US, &FOOD, &0, &USD, &100),
        Err(Ok(Error::ZeroPrice))
    );
}

/// Zero local price is rejected.
#[test]
fn a_zero_local_price_is_rejected() {
    let f = deploy_initialized();

    assert_eq!(
        f.client.try_submit(&f.submitter, &US, &FOOD, &100, &USD, &0),
        Err(Ok(Error::ZeroPrice))
    );
}

/// Both prices zero is rejected.
#[test]
fn both_prices_zero_is_rejected() {
    let f = deploy_initialized();

    assert_eq!(
        f.client.try_submit(&f.submitter, &US, &FOOD, &0, &USD, &0),
        Err(Ok(Error::ZeroPrice))
    );
}

/// Prices that are too large are rejected.
#[test]
fn prices_that_are_too_large_are_rejected() {
    let f = deploy_initialized();

    // USD price too large
    assert_eq!(
        f.client.try_submit(&f.submitter, &US, &FOOD, &1_000_000_001, &USD, &100),
        Err(Ok(Error::PriceTooLarge))
    );

    // Local price too large
    assert_eq!(
        f.client.try_submit(&f.submitter, &US, &FOOD, &100, &USD, &1_000_000_001),
        Err(Ok(Error::PriceTooLarge))
    );
}

/// Boundary prices are accepted (exactly at the limit).
#[test]
fn boundary_prices_are_accepted() {
    let f = deploy_initialized();

    // Maximum allowed price
    let id = f.client.submit(&f.submitter, &US, &FOOD, &1_000_000_000, &USD, &1_000_000_000);
    let submission = f.client.try_get_submission(&id).unwrap().unwrap();
    assert_eq!(submission.price_usd_cents, 1_000_000_000);
    assert_eq!(submission.price_local, 1_000_000_000);
}

/// Minimum valid price (1) is accepted.
#[test]
fn minimum_valid_price_is_accepted() {
    let f = deploy_initialized();

    let id = f.client.submit(&f.submitter, &US, &FOOD, &1, &USD, &1);
    let submission = f.client.try_get_submission(&id).unwrap().unwrap();
    assert_eq!(submission.price_usd_cents, 1);
    assert_eq!(submission.price_local, 1);
}

/// A rejected price value does not emit an event.
#[test]
fn a_rejected_price_does_not_emit_an_event() {
    let f = deploy_initialized();

    assert!(f
        .client
        .try_submit(&f.submitter, &US, &FOOD, &0, &USD, &100)
        .is_err());

    assert_eq!(f.env.events().all().events().len(), 0);
}

// ═══════════════════════════════════════════════════════════════════════════
// Initialization and schema versioning
// ═══════════════════════════════════════════════════════════════════════════

/// A fresh deployment has no schema version.
#[test]
fn a_fresh_deployment_has_no_schema_version() {
    let f = deploy();

    assert_eq!(f.client.deployed_schema_version(), None);
    assert_eq!(f.client.expected_schema_version(), 1);
    assert!(!f.client.is_schema_compatible());
}

/// Initialization records the schema version and admin.
#[test]
fn initialization_records_the_schema_version_and_admin() {
    let f = deploy_initialized();

    assert_eq!(f.client.deployed_schema_version(), Some(1));
    assert_eq!(f.client.admin(), Some(f.admin.clone()));
    assert!(f.client.is_schema_compatible());
}

/// Initializing twice is rejected.
#[test]
fn initializing_twice_is_rejected() {
    let f = deploy_initialized();

    assert_eq!(
        f.client.try_initialize(&f.admin),
        Err(Ok(Error::AlreadyInitialized))
    );
}

/// Operations are rejected before initialization.
#[test]
fn operations_are_rejected_before_initialization() {
    let f = deploy();

    assert_eq!(
        f.client.try_submit(&f.submitter, &US, &FOOD, &100, &USD, &100),
        Err(Ok(Error::NotInitialized))
    );

    assert_eq!(
        f.client.try_get_submission(&0),
        Err(Ok(Error::NotInitialized))
    );
}

/// An incompatible schema is rejected.
#[test]
fn an_incompatible_schema_is_rejected() {
    let f = deploy_initialized();

    // Simulate a different schema version
    f.env.as_contract(&f.client.address, || {
        f.env
            .storage()
            .instance()
            .set(&crate::price_vault::DataKey::Schema, &2u32);
    });

    assert!(!f.client.is_schema_compatible());
    assert_eq!(
        f.client.try_submit(&f.submitter, &US, &FOOD, &100, &USD, &100),
        Err(Ok(Error::IncompatibleSchema))
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// Authorization
// ═══════════════════════════════════════════════════════════════════════════

/// An unsigned submission is rejected by the host.
#[test]
#[should_panic(expected = "Unauthorized function call for address")]
fn an_unsigned_submission_is_rejected() {
    let f = deploy_initialized();

    f.env.set_auths(&[]);

    f.client.submit(&f.submitter, &US, &FOOD, &100, &USD, &100);
}
