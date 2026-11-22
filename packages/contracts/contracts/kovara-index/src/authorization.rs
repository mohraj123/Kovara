//! Tests for CT-043: KovaraIndex admin authorization.
//!
//! Verifies that index updates are restricted to the configured sentinel
//! roster, that unauthorized callers are rejected, and that pre-initialization
//! updates fail safely.

use crate::{Error, KovaraIndex, KovaraIndexClient};
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{symbol_short, vec, Address, Env, Symbol, Vec};

struct Fixture<'a> {
    env: Env,
    client: KovaraIndexClient<'a>,
    admin: Address,
    updater: Address,
}

fn deploy() -> Fixture<'static> {
    let env = Env::default();
    let contract_id = env.register(KovaraIndex, ());
    let client = KovaraIndexClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let updater = Address::generate(&env);

    env.mock_all_auths();

    Fixture {
        env,
        client,
        admin,
        updater,
    }
}

fn deploy_initialized() -> Fixture<'static> {
    let f = deploy();
    f.client.initialize(&f.admin);
    f.client
        .set_sentinels(&f.admin, &vec![&f.env, f.updater.clone()], &1);
    f
}

const NG: Symbol = symbol_short!("NG");
const DATE: u64 = 20_140;
const VALUE: i128 = 1_234_567;
const BASKET: u32 = 7;
const PS: u64 = 1_700_000_000;
const PE: u64 = 1_700_086_400;

fn cats(f: &Fixture) -> soroban_sdk::Vec<Symbol> {
    vec![&f.env, symbol_short!("food")]
}

fn try_write(f: &Fixture, signers: Vec<Address>) -> Result<Result<(), Error>, soroban_sdk::Error> {
    f.client.try_set_daily_index(
        &signers,
        &NG,
        &DATE,
        &VALUE,
        &BASKET,
        &PS,
        &PE,
        &cats(f),
    )
}

// ── Precondition: initialization ─────────────────────────────────────────

/// An update before initialization must be rejected — there is no roster to
/// authorize against and no schema to validate.
#[test]
fn update_before_initialization_is_rejected() {
    let f = deploy();

    assert_eq!(
        try_write(&f, vec![&f.env, f.updater.clone()]),
        Err(Ok(Error::NotInitialized))
    );
}

/// An update after initialization but before a roster is configured must
/// also be rejected.
#[test]
fn update_before_roster_is_configured_is_rejected() {
    let f = deploy();
    f.client.initialize(&f.admin);

    assert_eq!(
        try_write(&f, vec![&f.env, f.updater.clone()]),
        Err(Ok(Error::SentinelsNotConfigured))
    );
}

// ── Authorization: who may update ────────────────────────────────────────

/// A configured sentinel can authorize an update.
#[test]
fn authorized_sentinel_can_update() {
    let f = deploy_initialized();

    assert_eq!(
        try_write(&f, vec![&f.env, f.updater.clone()]),
        Ok(Ok(()))
    );
}

/// An address not on the roster cannot authorize an update.
#[test]
fn unauthorized_address_is_rejected() {
    let f = deploy_initialized();
    let outsider = Address::generate(&f.env);

    assert_eq!(
        try_write(&f, vec![&f.env, outsider]),
        Err(Ok(Error::NotASentinel))
    );
}

/// Sending no signers at all is rejected.
#[test]
fn empty_signer_list_is_rejected() {
    let f = deploy_initialized();

    assert_eq!(
        try_write(&f, Vec::new(&f.env)),
        Err(Ok(Error::InsufficientSignatures))
    );
}

/// When the threshold is 2-of-3, a single valid sentinel is not enough.
#[test]
fn below_threshold_is_rejected() {
    let f = deploy_initialized();
    let s0 = Address::generate(&f.env);
    let s1 = Address::generate(&f.env);
    let s2 = Address::generate(&f.env);
    f.client
        .set_sentinels(&f.admin, &vec![&f.env, s0.clone(), s1.clone(), s2.clone()], &2);

    assert_eq!(
        try_write(&f, vec![&f.env, s0]),
        Err(Ok(Error::InsufficientSignatures))
    );
}

/// When the threshold is met, the update succeeds.
#[test]
fn meeting_threshold_with_multiple_signers_succeeds() {
    let f = deploy_initialized();
    let s0 = Address::generate(&f.env);
    let s1 = Address::generate(&f.env);
    f.client
        .set_sentinels(&f.admin, &vec![&f.env, s0.clone(), s1.clone()], &2);

    assert_eq!(
        try_write(&f, vec![&f.env, s0, s1]),
        Ok(Ok(()))
    );
}

/// One sentinel signing twice must not satisfy a threshold of two.
#[test]
fn duplicate_signer_cannot_satisfy_threshold() {
    let f = deploy_initialized();
    let s = Address::generate(&f.env);
    let other = Address::generate(&f.env);
    f.client
        .set_sentinels(&f.admin, &vec![&f.env, s.clone(), other], &2);

    assert_eq!(
        try_write(&f, vec![&f.env, s.clone(), s]),
        Err(Ok(Error::DuplicateSigner))
    );
}

// ── Admin management ─────────────────────────────────────────────────────

/// Only the admin can install or rotate the sentinel roster.
#[test]
fn only_admin_can_set_sentinels() {
    let f = deploy_initialized();
    let stranger = Address::generate(&f.env);

    assert_eq!(
        f.client
            .try_set_sentinels(&stranger, &vec![&f.env, stranger.clone()], &1),
        Err(Ok(Error::NotAdmin))
    );
}

/// After rotating the roster, the old sentinels lose authorization.
#[test]
fn after_rotation_old_sentinels_are_rejected() {
    let f = deploy_initialized();
    let old = f.updater.clone();
    let new_sentinel = Address::generate(&f.env);

    // Rotate: replace the old updater with a new sentinel.
    f.client
        .set_sentinels(&f.admin, &vec![&f.env, new_sentinel.clone()], &1);

    assert_eq!(
        try_write(&f, vec![&f.env, old]),
        Err(Ok(Error::NotASentinel))
    );

    // The new sentinel can update.
    assert_eq!(
        try_write(&f, vec![&f.env, new_sentinel]),
        Ok(Ok(()))
    );
}
