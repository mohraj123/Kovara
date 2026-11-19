//! CT-016: minimum withdrawal amount, floor and full-exit lifecycle.

use kovara_sentinel_pool::{SentinelPool, SentinelPoolClient};
use soroban_sdk::{testutils::Address as _, Address, Env};

fn setup(env: &Env) -> (SentinelPoolClient<'_>, Address, Address) {
    let id = env.register_contract(None, SentinelPool);
    let client = SentinelPoolClient::new(env, &id);
    let admin = Address::generate(env);
    env.mock_all_auths();
    client.initialize(&admin, &Address::generate(env), &100, &1, &2);
    client.set_min_withdrawal(&admin, &20);
    (client, admin, Address::generate(env))
}

#[test]
fn below_minimum_withdrawal_is_rejected() {
    let env = Env::default();
    let (client, _admin, sentinel) = setup(&env);
    client.stake(&sentinel, &200);
    env.ledger().with_mut(|l| l.sequence_number += 2);

    assert!(client.try_withdraw(&sentinel, &10).is_err());
}

#[test]
fn exact_minimum_withdrawal_succeeds() {
    let env = Env::default();
    let (client, _admin, sentinel) = setup(&env);
    client.stake(&sentinel, &200);
    env.ledger().with_mut(|l| l.sequence_number += 2);

    client.withdraw(&sentinel, &20);
    assert_eq!(client.balance(&sentinel), 180);
}

#[test]
fn full_exit_bypasses_minimum_withdrawal() {
    let env = Env::default();
    let (client, _admin, sentinel) = setup(&env);
    client.stake(&sentinel, &100);
    env.ledger().with_mut(|l| l.sequence_number += 2);

    // Deregister, then wait out the challenge period before exiting fully
    // with an amount under the configured minimum withdrawal.
    client.deregister(&sentinel);
    let withdrawable_at = client.withdrawable_at(&sentinel).unwrap();
    env.ledger()
        .with_mut(|l| l.sequence_number = (withdrawable_at + 1) as u32);

    client.withdraw(&sentinel, &100);
    assert_eq!(client.balance(&sentinel), 0);
}
