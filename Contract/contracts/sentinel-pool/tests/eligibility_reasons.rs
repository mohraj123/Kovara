//! CT-014: queryable eligibility reasons alongside the boolean view.

use kovara_sentinel_pool::{EligibilityStatus, IneligibleReason, SentinelPool, SentinelPoolClient};
use soroban_sdk::{testutils::Address as _, Address, Env};

fn setup(env: &Env) -> SentinelPoolClient<'_> {
    let id = env.register_contract(None, SentinelPool);
    let client = SentinelPoolClient::new(env, &id);
    env.mock_all_auths();
    client.initialize(&Address::generate(env), &Address::generate(env), &100, &10, &2);
    client
}

#[test]
fn below_min_stake_is_reported() {
    let env = Env::default();
    let client = setup(&env);
    let sentinel = Address::generate(&env);
    client.stake(&sentinel, &150);
    env.ledger().with_mut(|l| l.sequence_number += 20);
    client.withdraw(&sentinel, &60);

    assert_eq!(
        client.eligibility_reason(&sentinel, &env.ledger().sequence()),
        EligibilityStatus::Ineligible(IneligibleReason::BelowMinStake)
    );
}

#[test]
fn lock_period_active_is_reported() {
    let env = Env::default();
    let client = setup(&env);
    let sentinel = Address::generate(&env);
    client.stake(&sentinel, &150);

    assert_eq!(
        client.eligibility_reason(&sentinel, &5),
        EligibilityStatus::Ineligible(IneligibleReason::LockPeriodActive)
    );
    assert!(!client.is_eligible(&sentinel, &5));
}

#[test]
fn deregistered_is_reported() {
    let env = Env::default();
    let client = setup(&env);
    let sentinel = Address::generate(&env);
    client.stake(&sentinel, &150);
    env.ledger().with_mut(|l| l.sequence_number += 20);
    client.deregister(&sentinel);

    assert_eq!(
        client.eligibility_reason(&sentinel, &env.ledger().sequence()),
        EligibilityStatus::Ineligible(IneligibleReason::Deregistered)
    );
    assert!(!client.is_eligible(&sentinel, &env.ledger().sequence()));
}

#[test]
fn eligible_sentinel_is_reported() {
    let env = Env::default();
    let client = setup(&env);
    let sentinel = Address::generate(&env);
    client.stake(&sentinel, &150);
    env.ledger().with_mut(|l| l.sequence_number += 20);

    assert_eq!(
        client.eligibility_reason(&sentinel, &env.ledger().sequence()),
        EligibilityStatus::Eligible
    );
    assert!(client.is_eligible(&sentinel, &env.ledger().sequence()));
}
