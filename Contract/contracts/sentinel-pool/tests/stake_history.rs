//! CT-015: paginated per-sentinel stake/withdrawal history.

use kovara_sentinel_pool::{HistoryKind, SentinelPool, SentinelPoolClient};
use soroban_sdk::{testutils::Address as _, Address, Env};

fn setup(env: &Env) -> (SentinelPoolClient<'_>, Address) {
    let id = env.register_contract(None, SentinelPool);
    let client = SentinelPoolClient::new(env, &id);
    env.mock_all_auths();
    client.initialize(&Address::generate(env), &Address::generate(env), &50, &1, &2);
    (client, Address::generate(env))
}

#[test]
fn history_covers_pagination_and_ordering() {
    let env = Env::default();
    let (client, sentinel) = setup(&env);

    client.stake(&sentinel, &100);
    env.ledger().with_mut(|l| l.sequence_number += 2);
    client.stake(&sentinel, &50);
    env.ledger().with_mut(|l| l.sequence_number += 2);
    client.withdraw(&sentinel, &30);

    let page1 = client.stake_history(&sentinel, &0, &2);
    assert_eq!(page1.len(), 2);
    assert_eq!(page1.get(0).unwrap().kind, HistoryKind::Stake);
    assert_eq!(page1.get(0).unwrap().amount, 100);
    assert_eq!(page1.get(0).unwrap().balance_after, 100);
    assert_eq!(page1.get(1).unwrap().kind, HistoryKind::Stake);
    assert_eq!(page1.get(1).unwrap().amount, 50);
    assert_eq!(page1.get(1).unwrap().balance_after, 150);

    let page2 = client.stake_history(&sentinel, &2, &2);
    assert_eq!(page2.len(), 1);
    assert_eq!(page2.get(0).unwrap().kind, HistoryKind::Withdraw);
    assert_eq!(page2.get(0).unwrap().amount, 30);
    assert_eq!(page2.get(0).unwrap().balance_after, 120);
}

#[test]
fn page_size_errors_are_rejected() {
    let env = Env::default();
    let (client, sentinel) = setup(&env);
    client.stake(&sentinel, &100);

    assert!(client.try_stake_history(&sentinel, &0, &0).is_err());
    assert!(client.try_stake_history(&sentinel, &0, &1_000).is_err());
}

#[test]
fn empty_history_for_unknown_sentinel() {
    let env = Env::default();
    let (client, _sentinel) = setup(&env);
    let unknown = Address::generate(&env);

    assert_eq!(client.stake_history(&unknown, &0, &10).len(), 0);
}
