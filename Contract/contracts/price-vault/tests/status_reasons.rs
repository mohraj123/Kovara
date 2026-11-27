//! #1079 CT-008 — validated reason codes on status changes.
#![cfg(test)]

use kovara_price_vault::{
    status_reason, Error, PriceVault, PriceVaultClient, StatusChanged, SubmissionStatus,
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
    verifier: Address,
    country: Symbol,
    category: Symbol,
}

fn setup<'a>() -> Fixture<'a> {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(PriceVault, ());
    let client = PriceVaultClient::new(&env, &id);
    let submitter = Address::generate(&env);
    let verifier = Address::generate(&env);
    let country = Symbol::new(&env, "KE");
    let category = Symbol::new(&env, "Rent");
    client.submit(
        &submitter,
        &country,
        &category,
        &750,
        &TS,
        &DEFAULT_VALIDITY_WINDOW_SECS,
    );
    Fixture {
        env,
        id,
        client,
        verifier,
        country,
        category,
    }
}

fn set_with_reason(f: &Fixture, to: SubmissionStatus, reason: u32) -> Result<(), Error> {
    match f
        .client
        .try_set_status_with_reason(&f.verifier, &f.country, &f.category, &TS, &to, &reason)
    {
        Ok(_) => Ok(()),
        Err(e) => Err(e.unwrap()),
    }
}

#[test]
fn valid_reasons_are_published_on_the_event() {
    let cases = [
        (SubmissionStatus::Verified, status_reason::QUORUM_APPROVED),
        (SubmissionStatus::Verified, status_reason::GOVERNANCE_OVERRIDE),
        (SubmissionStatus::Rejected, status_reason::QUORUM_REJECTED),
        (SubmissionStatus::Rejected, status_reason::OUTLIER_VALUE),
        (SubmissionStatus::Rejected, status_reason::DUPLICATE_EVIDENCE),
        (SubmissionStatus::Rejected, status_reason::STALE_OBSERVATION),
        (SubmissionStatus::Rejected, status_reason::SUBMITTER_MISCONDUCT),
        (SubmissionStatus::Rejected, status_reason::GOVERNANCE_OVERRIDE),
    ];
    for (to, reason) in cases {
        let f = setup();
        set_with_reason(&f, to, reason).unwrap();

        let expected = StatusChanged {
            country_iso: f.country.clone(),
            category: f.category.clone(),
            timestamp: TS,
            actor: f.verifier.clone(),
            prior_status: SubmissionStatus::Pending,
            new_status: to,
            reason,
        };
        assert_eq!(f.env.events().all(), [expected.to_xdr(&f.env, &f.id)]);
        assert_eq!(f.client.get_status(&f.country, &f.category, &TS), Some(to));
        assert!(f.client.is_valid_status_reason(&reason, &to));
    }
}

#[test]
fn legacy_set_status_reports_unspecified() {
    let f = setup();
    f.client.set_status(
        &f.verifier,
        &f.country,
        &f.category,
        &TS,
        &SubmissionStatus::Verified,
    );
    let expected = StatusChanged {
        country_iso: f.country.clone(),
        category: f.category.clone(),
        timestamp: TS,
        actor: f.verifier.clone(),
        prior_status: SubmissionStatus::Pending,
        new_status: SubmissionStatus::Verified,
        reason: status_reason::UNSPECIFIED,
    };
    assert_eq!(f.env.events().all(), [expected.to_xdr(&f.env, &f.id)]);
}

#[test]
fn invalid_reasons_are_refused_without_side_effects() {
    let cases = [
        // Reserved / out of range.
        (SubmissionStatus::Verified, status_reason::UNSPECIFIED),
        (SubmissionStatus::Rejected, status_reason::MAX + 1),
        (SubmissionStatus::Verified, u32::MAX),
        // Known code, wrong direction.
        (SubmissionStatus::Verified, status_reason::QUORUM_REJECTED),
        (SubmissionStatus::Verified, status_reason::OUTLIER_VALUE),
        (SubmissionStatus::Rejected, status_reason::QUORUM_APPROVED),
    ];
    for (to, reason) in cases {
        let f = setup();
        assert_eq!(
            set_with_reason(&f, to, reason),
            Err(Error::InvalidStatusReason),
            "{to:?} with reason {reason}"
        );
        assert!(f.env.events().all().events().is_empty());
        assert_eq!(
            f.client.get_status(&f.country, &f.category, &TS),
            Some(SubmissionStatus::Pending)
        );
        assert!(!f.client.is_valid_status_reason(&reason, &to));
    }
}

#[test]
fn reason_is_checked_before_the_record_is_looked_up() {
    let f = setup();
    // A bad reason on a missing record reports the reason, not NotFound:
    // validation is pure and runs before any storage read.
    let err = f
        .client
        .try_set_status_with_reason(
            &f.verifier,
            &f.country,
            &f.category,
            &(TS + 1),
            &SubmissionStatus::Verified,
            &999,
        )
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::InvalidStatusReason);
}

#[test]
fn terminal_state_rules_are_unchanged() {
    for (terminal, first_reason) in [
        (SubmissionStatus::Verified, status_reason::QUORUM_APPROVED),
        (SubmissionStatus::Rejected, status_reason::QUORUM_REJECTED),
    ] {
        let f = setup();
        set_with_reason(&f, terminal, first_reason).unwrap();
        let before = f.client.get(&f.country, &f.category, &TS).unwrap();

        // Even a reason that fits the target cannot unlock a terminal record.
        for (to, reason) in [
            (SubmissionStatus::Verified, status_reason::GOVERNANCE_OVERRIDE),
            (SubmissionStatus::Rejected, status_reason::GOVERNANCE_OVERRIDE),
        ] {
            assert_eq!(
                set_with_reason(&f, to, reason),
                Err(Error::InvalidTransition)
            );
            assert!(f.env.events().all().events().is_empty());
            assert_eq!(f.client.get(&f.country, &f.category, &TS).unwrap(), before);
        }
    }
}

#[test]
fn pending_target_and_missing_record_keep_their_errors() {
    let f = setup();
    assert_eq!(
        set_with_reason(&f, SubmissionStatus::Pending, status_reason::GOVERNANCE_OVERRIDE),
        Err(Error::InvalidTransition)
    );

    let err = f
        .client
        .try_set_status_with_reason(
            &f.verifier,
            &f.country,
            &f.category,
            &(TS + 1),
            &SubmissionStatus::Verified,
            &status_reason::QUORUM_APPROVED,
        )
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::NotFound);
}
