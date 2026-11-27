//! #1078 CT-007 — metadata corrections emit a typed event; rejected
//! corrections are silent and leave the record untouched.
#![cfg(test)]

use kovara_price_vault::{
    Error, MetadataCorrected, PriceSubmission, PriceVault, PriceVaultClient, SubmissionStatus,
    DEFAULT_VALIDITY_WINDOW_SECS,
};
use soroban_sdk::{
    testutils::{Address as _, Events as _},
    Address, Env, Event, Symbol,
};

const TS: u64 = 1_000;

struct Fixture<'a> {
    env: Env,
    id: Address,
    client: PriceVaultClient<'a>,
    admin: Address,
    submitter: Address,
    country: Symbol,
    category: Symbol,
}

fn setup<'a>() -> Fixture<'a> {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(PriceVault, ());
    let client = PriceVaultClient::new(&env, &id);
    let admin = Address::generate(&env);
    let submitter = Address::generate(&env);
    let country = Symbol::new(&env, "NG");
    let category = Symbol::new(&env, "Food");
    client.initialize(&admin);
    client.submit(
        &submitter,
        &country,
        &category,
        &500,
        &TS,
        &DEFAULT_VALIDITY_WINDOW_SECS,
    );
    Fixture {
        env,
        id,
        client,
        admin,
        submitter,
        country,
        category,
    }
}

fn record(f: &Fixture) -> PriceSubmission {
    f.client.get(&f.country, &f.category, &TS).unwrap()
}

/// Assert the last call emitted nothing and left the record as `before`.
fn assert_silent_and_unchanged(f: &Fixture, before: &PriceSubmission) {
    assert!(f.env.events().all().events().is_empty());
    assert_eq!(&record(f), before);
}

#[test]
fn accepted_correction_emits_typed_event_with_all_fields() {
    let f = setup();
    let new_window = 3_600_u64;

    f.client
        .correct_metadata(&f.admin, &f.country, &f.category, &TS, &new_window);

    let expected = MetadataCorrected {
        country_iso: f.country.clone(),
        category: f.category.clone(),
        timestamp: TS,
        actor: f.admin.clone(),
        prior_valid_until: TS + DEFAULT_VALIDITY_WINDOW_SECS,
        new_valid_until: TS + new_window,
    };
    assert_eq!(f.env.events().all(), [expected.to_xdr(&f.env, &f.id)]);

    // The event matches what is now stored, and only the window moved.
    let after = record(&f);
    assert_eq!(after.valid_until, TS + new_window);
    assert_eq!(after.value, 500);
    assert_eq!(after.submitter, f.submitter);
    assert_eq!(after.status, SubmissionStatus::Pending);
}

#[test]
fn non_admin_correction_is_silent_and_state_preserving() {
    let f = setup();
    let before = record(&f);
    let stranger = Address::generate(&f.env);

    let err = f
        .client
        .try_correct_metadata(&stranger, &f.country, &f.category, &TS, &3_600)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::Unauthorized);
    assert_silent_and_unchanged(&f, &before);
}

#[test]
fn invalid_windows_are_silent_and_state_preserving() {
    let f = setup();
    let before = record(&f);

    for (window, expected) in [
        (0_u64, Error::InvalidWindow),
        (u64::MAX, Error::InvalidWindow),
    ] {
        let err = f
            .client
            .try_correct_metadata(&f.admin, &f.country, &f.category, &TS, &window)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, expected);
        assert_silent_and_unchanged(&f, &before);
    }

    // A window above the configured cap is refused too.
    f.client.set_max_validity_window(&f.admin, &Some(7_200));
    let err = f
        .client
        .try_correct_metadata(&f.admin, &f.country, &f.category, &TS, &7_201)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::WindowTooLong);
    assert_silent_and_unchanged(&f, &before);
}

#[test]
fn missing_record_and_no_op_corrections_are_silent() {
    let f = setup();
    let before = record(&f);

    let err = f
        .client
        .try_correct_metadata(&f.admin, &f.country, &f.category, &(TS + 1), &3_600)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::NotFound);
    assert!(f.env.events().all().events().is_empty());

    let err = f
        .client
        .try_correct_metadata(
            &f.admin,
            &f.country,
            &f.category,
            &TS,
            &DEFAULT_VALIDITY_WINDOW_SECS,
        )
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::MetadataUnchanged);
    assert_silent_and_unchanged(&f, &before);
}

#[test]
fn terminal_records_are_frozen() {
    for terminal in [SubmissionStatus::Verified, SubmissionStatus::Rejected] {
        let f = setup();
        let verifier = Address::generate(&f.env);
        f.client
            .set_status(&verifier, &f.country, &f.category, &TS, &terminal);
        let before = record(&f);

        let err = f
            .client
            .try_correct_metadata(&f.admin, &f.country, &f.category, &TS, &3_600)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, Error::RecordFinalized);
        assert_silent_and_unchanged(&f, &before);
    }
}

#[test]
fn a_record_can_be_corrected_more_than_once() {
    let f = setup();

    f.client
        .correct_metadata(&f.admin, &f.country, &f.category, &TS, &3_600);
    f.client
        .correct_metadata(&f.admin, &f.country, &f.category, &TS, &60);

    // Each correction reports the bound it actually overwrote.
    let expected = MetadataCorrected {
        country_iso: f.country.clone(),
        category: f.category.clone(),
        timestamp: TS,
        actor: f.admin.clone(),
        prior_valid_until: TS + 3_600,
        new_valid_until: TS + 60,
    };
    assert_eq!(f.env.events().all(), [expected.to_xdr(&f.env, &f.id)]);
    assert!(!f.client.is_fresh(&f.country, &f.category, &TS, &(TS + 60)));
}
