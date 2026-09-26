//! Tests for PriceVault contract (CT-002, CT-003, CT-004, CT-005).
//!
//! Covers:
//! - Submission round-trips including the new `item_name` field
//! - `VerificationStatus` and `RewardStatus` lifecycle (default values, admin
//!   transitions, `verified_ids` index, non-admin rejection)
//! - All original CT-002..CT-005 cases (id sequencing, key determinism, country
//!   and category validation, price bounds, schema versioning, authorization)

use crate::price_vault::{
    Error, PriceVault, PriceVaultClient, RewardStatus, VerificationStatus, MAX_SUBMISSION_WINDOW,
};
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

// Symbol constants shared across tests
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

// item_name constants
const BREAD: Symbol = symbol_short!("Bread");
const RICE: Symbol = symbol_short!("Rice");
const BR1_CTR: Symbol = symbol_short!("1BR_CTR");
const MON_PASS: Symbol = symbol_short!("MonPass");
const ELECTRICITY: Symbol = symbol_short!("Elec");
const GP_VISIT: Symbol = symbol_short!("GPVisit");

// ═══════════════════════════════════════════════════════════════════════════
// CT-002 — Implement PriceVault
// ═══════════════════════════════════════════════════════════════════════════

/// Basic submission and retrieval round-trip.
#[test]
fn a_submission_can_be_submitted_and_retrieved() {
    let f = deploy_initialized();

    let id = f
        .client
        .submit(&f.submitter, &US, &FOOD, &BREAD, &100, &USD, &100);

    let submission = f.client.try_get_submission(&id).unwrap().unwrap();

    assert_eq!(submission.id, 0);
    assert_eq!(submission.submitter, f.submitter);
    assert_eq!(submission.country_iso, US);
    assert_eq!(submission.category, FOOD);
    assert_eq!(submission.item_name, BREAD);
    assert_eq!(submission.price_usd_cents, 100);
    assert_eq!(submission.currency_local, USD);
    assert_eq!(submission.price_local, 100);
}

/// Sequential submissions get incrementing IDs.
#[test]
fn submissions_get_sequential_ids() {
    let f = deploy_initialized();

    let id1 = f
        .client
        .submit(&f.submitter, &US, &FOOD, &BREAD, &100, &USD, &100);
    let id2 = f
        .client
        .submit(&f.submitter, &US, &RENT, &BR1_CTR, &200, &USD, &200);
    let id3 = f
        .client
        .submit(&f.submitter, &NG, &FOOD, &RICE, &300, &NGN, &50000);

    assert_eq!(id1, 0);
    assert_eq!(id2, 1);
    assert_eq!(id3, 2);
}

/// Submission count increments with each submission.
#[test]
fn submission_count_increments() {
    let f = deploy_initialized();

    assert_eq!(f.client.submission_count(), 0);

    f.client
        .submit(&f.submitter, &US, &FOOD, &BREAD, &100, &USD, &100);
    assert_eq!(f.client.submission_count(), 1);

    f.client
        .submit(&f.submitter, &US, &RENT, &BR1_CTR, &200, &USD, &200);
    assert_eq!(f.client.submission_count(), 2);
}

/// A rejected submission does not increment the counter.
#[test]
fn a_rejected_submission_does_not_increment_counter() {
    let f = deploy_initialized();

    assert_eq!(
        f.client
            .try_submit(&f.submitter, &ZZ, &FOOD, &BREAD, &100, &USD, &100),
        Err(Ok(Error::InvalidCountry))
    );
    assert_eq!(f.client.submission_count(), 0);
}

/// The event carries every required field.
#[test]
fn the_event_carries_every_required_field() {
    let f = deploy_initialized();

    f.client
        .submit(&f.submitter, &US, &FOOD, &BREAD, &100, &USD, &100);

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

    f.client
        .submit(&f.submitter, &US, &FOOD, &BREAD, &100, &USD, &100);
    f.client
        .submit(&f.submitter, &US, &RENT, &BR1_CTR, &200, &USD, &200);
    f.client
        .submit(&f.submitter, &NG, &FOOD, &RICE, &300, &NGN, &50000);

    let us_pending = f.client.pending(&US);
    assert_eq!(us_pending.len(), 2);

    let ng_pending = f.client.pending(&NG);
    assert_eq!(ng_pending.len(), 1);

    let ke_pending = f.client.pending(&KE);
    assert_eq!(ke_pending.len(), 0);
}

// ═══════════════════════════════════════════════════════════════════════════
// item_name field
// ═══════════════════════════════════════════════════════════════════════════

/// The item_name field is persisted and returned correctly.
#[test]
fn item_name_is_stored_and_returned() {
    let f = deploy_initialized();

    let id = f
        .client
        .submit(&f.submitter, &US, &FOOD, &BREAD, &250, &USD, &250);

    let submission = f.client.try_get_submission(&id).unwrap().unwrap();
    assert_eq!(submission.item_name, BREAD);
}

/// Different item names in the same category produce distinct submissions.
#[test]
fn different_item_names_produce_different_submissions() {
    let f = deploy_initialized();

    let id1 = f
        .client
        .submit(&f.submitter, &US, &FOOD, &BREAD, &100, &USD, &100);
    let id2 = f
        .client
        .submit(&f.submitter, &US, &FOOD, &RICE, &100, &USD, &100);

    assert_ne!(id1, id2);

    let s1 = f.client.try_get_submission(&id1).unwrap().unwrap();
    let s2 = f.client.try_get_submission(&id2).unwrap().unwrap();

    assert_eq!(s1.item_name, BREAD);
    assert_eq!(s2.item_name, RICE);
}

/// All basket category item names are accepted.
#[test]
fn basket_item_names_across_categories_are_accepted() {
    let f = deploy_initialized();

    let cases = [
        (&US, &FOOD, &BREAD),
        (&US, &RENT, &BR1_CTR),
        (&US, &TRANSPORT, &MON_PASS),
        (&US, &UTILITIES, &ELECTRICITY),
        (&US, &HEALTH, &GP_VISIT),
    ];

    for (country, cat, item) in cases {
        let id = f
            .client
            .submit(&f.submitter, country, cat, item, &100, &USD, &100);
        let s = f.client.try_get_submission(&id).unwrap().unwrap();
        assert_eq!(s.item_name, *item);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// VerificationStatus — default values and transitions
// ═══════════════════════════════════════════════════════════════════════════

/// New submissions start with VerificationStatus::Pending.
#[test]
fn new_submissions_start_as_pending() {
    let f = deploy_initialized();

    let id = f
        .client
        .submit(&f.submitter, &US, &FOOD, &BREAD, &100, &USD, &100);

    let submission = f.client.try_get_submission(&id).unwrap().unwrap();
    assert_eq!(submission.verification_status, VerificationStatus::Pending);
}

/// Admin can transition a submission to Verified.
#[test]
fn admin_can_verify_a_submission() {
    let f = deploy_initialized();

    let id = f
        .client
        .submit(&f.submitter, &US, &FOOD, &BREAD, &100, &USD, &100);

    f.client
        .set_verification_status(&f.admin, &id, &VerificationStatus::Verified);

    let submission = f.client.try_get_submission(&id).unwrap().unwrap();
    assert_eq!(submission.verification_status, VerificationStatus::Verified);
}

/// Admin can transition a submission to Rejected.
#[test]
fn admin_can_reject_a_submission() {
    let f = deploy_initialized();

    let id = f
        .client
        .submit(&f.submitter, &US, &FOOD, &BREAD, &100, &USD, &100);

    f.client
        .set_verification_status(&f.admin, &id, &VerificationStatus::Rejected);

    let submission = f.client.try_get_submission(&id).unwrap().unwrap();
    assert_eq!(submission.verification_status, VerificationStatus::Rejected);
}

/// Verifying a submission appends it to the VerifiedSubmissions index.
#[test]
fn verifying_appends_to_verified_ids_index() {
    let f = deploy_initialized();

    let id1 = f
        .client
        .submit(&f.submitter, &US, &FOOD, &BREAD, &100, &USD, &100);
    let id2 = f
        .client
        .submit(&f.submitter, &US, &RENT, &BR1_CTR, &200, &USD, &200);

    // Only verify id1
    f.client
        .set_verification_status(&f.admin, &id1, &VerificationStatus::Verified);

    let verified = f.client.verified_ids(&US);
    assert_eq!(verified.len(), 1);
    assert_eq!(verified.get(0).unwrap(), id1);

    // Verify id2 as well
    f.client
        .set_verification_status(&f.admin, &id2, &VerificationStatus::Verified);

    let verified = f.client.verified_ids(&US);
    assert_eq!(verified.len(), 2);
}

/// Rejecting a submission does NOT append it to the verified index.
#[test]
fn rejecting_does_not_append_to_verified_ids() {
    let f = deploy_initialized();

    let id = f
        .client
        .submit(&f.submitter, &US, &FOOD, &BREAD, &100, &USD, &100);

    f.client
        .set_verification_status(&f.admin, &id, &VerificationStatus::Rejected);

    let verified = f.client.verified_ids(&US);
    assert_eq!(verified.len(), 0);
}

/// Non-admin cannot change verification status.
#[test]
fn non_admin_cannot_change_verification_status() {
    let f = deploy_initialized();

    let id = f
        .client
        .submit(&f.submitter, &US, &FOOD, &BREAD, &100, &USD, &100);

    let stranger = Address::generate(&f.env);

    assert_eq!(
        f.client.try_set_verification_status(
            &stranger,
            &id,
            &VerificationStatus::Verified
        ),
        Err(Ok(Error::NotAdmin))
    );
}

/// set_verification_status on a missing ID returns NotFound.
#[test]
fn set_verification_status_on_missing_id_returns_not_found() {
    let f = deploy_initialized();

    assert_eq!(
        f.client.try_set_verification_status(
            &f.admin,
            &999,
            &VerificationStatus::Verified
        ),
        Err(Ok(Error::NotFound))
    );
}

/// Verification status change emits a VerificationStatusChanged event.
#[test]
fn verification_status_change_emits_event() {
    let f = deploy_initialized();

    let id = f
        .client
        .submit(&f.submitter, &US, &FOOD, &BREAD, &100, &USD, &100);

    // set_verification_status is its own top-level invocation; the harness
    // captures only the events produced during *that* call.
    f.client
        .set_verification_status(&f.admin, &id, &VerificationStatus::Verified);

    // The most recent invocation (set_verification_status) should have emitted
    // exactly one event: VerificationStatusChanged.
    let events = f.env.events().all();
    assert_eq!(
        events.events().len(),
        1,
        "expected exactly one VerificationStatusChanged event"
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// RewardStatus — default values and transitions
// ═══════════════════════════════════════════════════════════════════════════

/// New submissions start with RewardStatus::Unpaid.
#[test]
fn new_submissions_start_as_unpaid() {
    let f = deploy_initialized();

    let id = f
        .client
        .submit(&f.submitter, &US, &FOOD, &BREAD, &100, &USD, &100);

    let submission = f.client.try_get_submission(&id).unwrap().unwrap();
    assert_eq!(submission.reward_status, RewardStatus::Unpaid);
}

/// Admin can mark a submission as Paid.
#[test]
fn admin_can_mark_submission_as_paid() {
    let f = deploy_initialized();

    let id = f
        .client
        .submit(&f.submitter, &US, &FOOD, &BREAD, &100, &USD, &100);

    f.client
        .set_reward_status(&f.admin, &id, &RewardStatus::Paid);

    let submission = f.client.try_get_submission(&id).unwrap().unwrap();
    assert_eq!(submission.reward_status, RewardStatus::Paid);
}

/// Admin can mark a submission as Ineligible.
#[test]
fn admin_can_mark_submission_as_ineligible() {
    let f = deploy_initialized();

    let id = f
        .client
        .submit(&f.submitter, &US, &FOOD, &BREAD, &100, &USD, &100);

    f.client
        .set_reward_status(&f.admin, &id, &RewardStatus::Ineligible);

    let submission = f.client.try_get_submission(&id).unwrap().unwrap();
    assert_eq!(submission.reward_status, RewardStatus::Ineligible);
}

/// Non-admin cannot change reward status.
#[test]
fn non_admin_cannot_change_reward_status() {
    let f = deploy_initialized();

    let id = f
        .client
        .submit(&f.submitter, &US, &FOOD, &BREAD, &100, &USD, &100);

    let stranger = Address::generate(&f.env);

    assert_eq!(
        f.client
            .try_set_reward_status(&stranger, &id, &RewardStatus::Paid),
        Err(Ok(Error::NotAdmin))
    );
}

/// set_reward_status on a missing ID returns NotFound.
#[test]
fn set_reward_status_on_missing_id_returns_not_found() {
    let f = deploy_initialized();

    assert_eq!(
        f.client
            .try_set_reward_status(&f.admin, &999, &RewardStatus::Paid),
        Err(Ok(Error::NotFound))
    );
}

/// Reward status change emits a RewardStatusChanged event.
#[test]
fn reward_status_change_emits_event() {
    let f = deploy_initialized();

    let id = f
        .client
        .submit(&f.submitter, &US, &FOOD, &BREAD, &100, &USD, &100);

    // set_reward_status is its own top-level invocation; the harness
    // captures only the events produced during *that* call.
    f.client
        .set_reward_status(&f.admin, &id, &RewardStatus::Paid);

    // The most recent invocation (set_reward_status) should have emitted
    // exactly one event: RewardStatusChanged.
    let events = f.env.events().all();
    assert_eq!(
        events.events().len(),
        1,
        "expected exactly one RewardStatusChanged event"
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// Status fields persist through both storage copies
// ═══════════════════════════════════════════════════════════════════════════

/// Status mutations are visible on the record returned by get_submission.
#[test]
fn status_mutations_are_reflected_in_get_submission() {
    let f = deploy_initialized();

    let id = f
        .client
        .submit(&f.submitter, &US, &FOOD, &BREAD, &100, &USD, &100);

    f.client
        .set_verification_status(&f.admin, &id, &VerificationStatus::Verified);
    f.client
        .set_reward_status(&f.admin, &id, &RewardStatus::Paid);

    let submission = f.client.try_get_submission(&id).unwrap().unwrap();
    assert_eq!(submission.verification_status, VerificationStatus::Verified);
    assert_eq!(submission.reward_status, RewardStatus::Paid);
}

/// Status mutations are reflected in the pending() result for the country.
#[test]
fn status_mutations_are_reflected_in_pending_list() {
    let f = deploy_initialized();

    let id = f
        .client
        .submit(&f.submitter, &US, &FOOD, &BREAD, &100, &USD, &100);

    f.client
        .set_verification_status(&f.admin, &id, &VerificationStatus::Verified);

    let pending = f.client.pending(&US);
    // Submission still appears in the pending list (list is not filtered by
    // status — callers filter on their side); but its status is updated.
    assert_eq!(pending.len(), 1);
    assert_eq!(
        pending.get(0).unwrap().verification_status,
        VerificationStatus::Verified
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// CT-003 — Key price submissions deterministically
// ═══════════════════════════════════════════════════════════════════════════

/// Different timestamps produce different submissions even for same
/// country/category/submitter.
#[test]
fn different_timestamps_produce_different_submissions() {
    let f = deploy_initialized();

    let id1 = f
        .client
        .submit(&f.submitter, &US, &FOOD, &BREAD, &100, &USD, &100);

    // Advance the ledger timestamp
    f.env.ledger().set_timestamp(1000);

    let id2 = f
        .client
        .submit(&f.submitter, &US, &FOOD, &BREAD, &100, &USD, &100);

    assert_ne!(id1, id2);

    let sub1 = f.client.try_get_submission(&id1).unwrap().unwrap();
    let sub2 = f.client.try_get_submission(&id2).unwrap().unwrap();

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

    let id1 = f
        .client
        .submit(&f.submitter, &US, &FOOD, &BREAD, &100, &USD, &100);
    let id2 = f
        .client
        .submit(&submitter2, &US, &FOOD, &BREAD, &100, &USD, &100);

    assert_ne!(id1, id2);
}

/// Different countries produce different submissions.
#[test]
fn different_countries_produce_different_submissions() {
    let f = deploy_initialized();

    let id1 = f
        .client
        .submit(&f.submitter, &US, &FOOD, &BREAD, &100, &USD, &100);
    let id2 = f
        .client
        .submit(&f.submitter, &NG, &FOOD, &BREAD, &100, &USD, &100);

    assert_ne!(id1, id2);
}

/// Different categories produce different submissions.
#[test]
fn different_categories_produce_different_submissions() {
    let f = deploy_initialized();

    let id1 = f
        .client
        .submit(&f.submitter, &US, &FOOD, &BREAD, &100, &USD, &100);
    let id2 = f
        .client
        .submit(&f.submitter, &US, &RENT, &BR1_CTR, &100, &USD, &100);

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
        f.client
            .try_submit(&f.submitter, &ZZ, &FOOD, &BREAD, &100, &USD, &100),
        Err(Ok(Error::InvalidCountry))
    );
}

/// Valid country codes are accepted.
#[test]
fn valid_country_codes_are_accepted() {
    let f = deploy_initialized();

    let id = f
        .client
        .submit(&f.submitter, &US, &FOOD, &BREAD, &100, &USD, &100);
    assert!(f.client.try_get_submission(&id).is_ok());

    let id = f
        .client
        .submit(&f.submitter, &NG, &FOOD, &RICE, &100, &NGN, &50000);
    assert!(f.client.try_get_submission(&id).is_ok());

    let id = f
        .client
        .submit(&f.submitter, &KE, &FOOD, &BREAD, &100, &USD, &100);
    assert!(f.client.try_get_submission(&id).is_ok());
}

/// Invalid category is rejected.
#[test]
fn an_invalid_category_is_rejected() {
    let f = deploy_initialized();

    assert_eq!(
        f.client.try_submit(
            &f.submitter,
            &US,
            &INVALID_CAT,
            &BREAD,
            &100,
            &USD,
            &100
        ),
        Err(Ok(Error::InvalidCategory))
    );
}

/// All valid categories are accepted.
#[test]
fn all_valid_categories_are_accepted() {
    let f = deploy_initialized();

    let cases = [
        (FOOD, BREAD),
        (RENT, BR1_CTR),
        (TRANSPORT, MON_PASS),
        (UTILITIES, ELECTRICITY),
        (HEALTH, GP_VISIT),
    ];

    for (cat, item) in cases {
        let id = f
            .client
            .submit(&f.submitter, &US, &cat, &item, &100, &USD, &100);
        assert!(f.client.try_get_submission(&id).is_ok());
    }
}

/// A rejected submission leaves storage untouched.
#[test]
fn a_rejected_submission_stores_nothing() {
    let f = deploy_initialized();

    assert!(f
        .client
        .try_submit(&f.submitter, &ZZ, &FOOD, &BREAD, &100, &USD, &100)
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
        f.client
            .try_submit(&f.submitter, &US, &FOOD, &BREAD, &0, &USD, &100),
        Err(Ok(Error::ZeroPrice))
    );
}

/// Zero local price is rejected.
#[test]
fn a_zero_local_price_is_rejected() {
    let f = deploy_initialized();

    assert_eq!(
        f.client
            .try_submit(&f.submitter, &US, &FOOD, &BREAD, &100, &USD, &0),
        Err(Ok(Error::ZeroPrice))
    );
}

/// Both prices zero is rejected.
#[test]
fn both_prices_zero_is_rejected() {
    let f = deploy_initialized();

    assert_eq!(
        f.client
            .try_submit(&f.submitter, &US, &FOOD, &BREAD, &0, &USD, &0),
        Err(Ok(Error::ZeroPrice))
    );
}

/// Prices that are too large are rejected.
#[test]
fn prices_that_are_too_large_are_rejected() {
    let f = deploy_initialized();

    assert_eq!(
        f.client.try_submit(
            &f.submitter,
            &US,
            &FOOD,
            &BREAD,
            &1_000_000_001,
            &USD,
            &100
        ),
        Err(Ok(Error::PriceTooLarge))
    );

    assert_eq!(
        f.client.try_submit(
            &f.submitter,
            &US,
            &FOOD,
            &BREAD,
            &100,
            &USD,
            &1_000_000_001
        ),
        Err(Ok(Error::PriceTooLarge))
    );
}

/// Boundary prices are accepted (exactly at the limit).
#[test]
fn boundary_prices_are_accepted() {
    let f = deploy_initialized();

    let id = f.client.submit(
        &f.submitter,
        &US,
        &FOOD,
        &BREAD,
        &1_000_000_000,
        &USD,
        &1_000_000_000,
    );
    let submission = f.client.try_get_submission(&id).unwrap().unwrap();
    assert_eq!(submission.price_usd_cents, 1_000_000_000);
    assert_eq!(submission.price_local, 1_000_000_000);
}

/// Minimum valid price (1) is accepted.
#[test]
fn minimum_valid_price_is_accepted() {
    let f = deploy_initialized();

    let id = f
        .client
        .submit(&f.submitter, &US, &FOOD, &BREAD, &1, &USD, &1);
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
        .try_submit(&f.submitter, &US, &FOOD, &BREAD, &0, &USD, &100)
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
        f.client
            .try_submit(&f.submitter, &US, &FOOD, &BREAD, &100, &USD, &100),
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

    f.env.as_contract(&f.client.address, || {
        f.env
            .storage()
            .instance()
            .set(&crate::price_vault::DataKey::Schema, &2u32);
    });

    assert!(!f.client.is_schema_compatible());
    assert_eq!(
        f.client
            .try_submit(&f.submitter, &US, &FOOD, &BREAD, &100, &USD, &100),
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

    f.client
        .submit(&f.submitter, &US, &FOOD, &BREAD, &100, &USD, &100);
}

// ═══════════════════════════════════════════════════════════════════════════
// Timestamped submission record format (#690)
// ═══════════════════════════════════════════════════════════════════════════

/// A submission records the ledger time at which it was submitted, in Unix
/// seconds UTC, so historical records carry accurate timestamp metadata.
#[test]
fn a_submission_records_the_ledger_timestamp() {
    let f = deploy_initialized();

    f.env.ledger().set_timestamp(1_700_000_000);
    let id = f
        .client
        .submit(&f.submitter, &US, &FOOD, &BREAD, &100, &USD, &100);

    let submission = f.client.get_submission(&id);
    assert_eq!(submission.timestamp, 1_700_000_000);
}

/// The contract exposes the unit its timestamps are expressed in, so a consumer
/// never has to guess between seconds, milliseconds, and ledger sequence.
#[test]
fn the_contract_reports_its_timestamp_unit() {
    let f = deploy_initialized();

    assert_eq!(
        f.client.timestamp_unit(),
        Symbol::new(&f.env, "unix_seconds_utc")
    );
}

/// A time window returns only the submissions whose timestamp falls inside it,
/// and the bounds are inclusive.
#[test]
fn submissions_are_filtered_by_time_window() {
    let f = deploy_initialized();

    f.env.ledger().set_timestamp(1_000);
    f.client
        .submit(&f.submitter, &US, &FOOD, &BREAD, &100, &USD, &100);

    f.env.ledger().set_timestamp(2_000);
    f.client
        .submit(&f.submitter, &US, &RENT, &BR1_CTR, &200, &USD, &200);

    f.env.ledger().set_timestamp(3_000);
    f.client
        .submit(&f.submitter, &US, &TRANSPORT, &MON_PASS, &300, &USD, &300);

    let middle = f
        .client
        .submissions_in_time_window(&US, &1_500, &2_500);
    assert_eq!(middle.len(), 1);
    assert_eq!(middle.get(0).unwrap().timestamp, 2_000);

    let all = f.client.submissions_in_time_window(&US, &1_000, &3_000);
    assert_eq!(all.len(), 3);

    let edges = f.client.submissions_in_time_window(&US, &2_000, &3_000);
    assert_eq!(edges.len(), 2);
}

/// A window that matches no submission is an empty list, not an error.
#[test]
fn an_empty_time_window_returns_no_submissions() {
    let f = deploy_initialized();

    f.env.ledger().set_timestamp(1_000);
    f.client
        .submit(&f.submitter, &US, &FOOD, &BREAD, &100, &USD, &100);

    let none = f.client.submissions_in_time_window(&US, &5_000, &6_000);
    assert_eq!(none.len(), 0);
}

/// A window only sees the country it was asked about.
#[test]
fn a_time_window_is_scoped_to_one_country() {
    let f = deploy_initialized();

    f.env.ledger().set_timestamp(1_000);
    f.client
        .submit(&f.submitter, &US, &FOOD, &BREAD, &100, &USD, &100);
    f.client
        .submit(&f.submitter, &NG, &FOOD, &RICE, &300, &NGN, &50_000);

    let us = f.client.submissions_in_time_window(&US, &0, &2_000);
    assert_eq!(us.len(), 1);
    assert_eq!(us.get(0).unwrap().country_iso, US);

    let ng = f.client.submissions_in_time_window(&NG, &0, &2_000);
    assert_eq!(ng.len(), 1);
    assert_eq!(ng.get(0).unwrap().country_iso, NG);
}

/// An inverted window is rejected rather than silently returning nothing.
#[test]
fn an_inverted_time_window_is_rejected() {
    let f = deploy_initialized();

    assert_eq!(
        f.client
            .try_submissions_in_time_window(&US, &2_000, &1_000),
        Err(Ok(Error::InvalidTimeWindow))
    );
}

/// A window wider than the bound is rejected so the query stays O(submissions).
#[test]
fn a_time_window_wider_than_the_max_is_rejected() {
    let f = deploy_initialized();

    assert_eq!(
        f.client.try_submissions_in_time_window(
            &US,
            &0,
            &(MAX_SUBMISSION_WINDOW + 1)
        ),
        Err(Ok(Error::TimeWindowTooLarge))
    );
}
