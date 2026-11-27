//! #1093: paginated resolved-slash history.

use kovara_sentinel_pool::{SentinelPool, SentinelPoolClient, SlashEvidence, MAX_RESOLVED_PAGE};
use soroban_sdk::{testutils::Address as _, Address, Bytes, Env, String, Symbol};

fn evidence(env: &Env, proof: &str) -> SlashEvidence {
    SlashEvidence {
        proof_ref: String::from_str(env, proof),
        uri: String::from_str(env, "ipfs://evidence"),
        content_hash: Bytes::from_slice(env, &[1, 2, 3]),
    }
}

#[test]
fn resolved_slashes_are_ordered_and_paged() {
    let env = Env::default();
    let id = env.register_contract(None, SentinelPool);
    let client = SentinelPoolClient::new(&env, &id);
    let admin = Address::generate(&env);
    let governance = Address::generate(&env);
    let sentinel = Address::generate(&env);
    env.mock_all_auths();
    client.initialize(&admin, &governance, &100, &10, &2);
    client.stake(&sentinel, &1_000);

    for proof in ["a", "b", "c"] {
        client.slash(&governance, &sentinel, &10, &evidence(&env, proof), &Symbol::new(&env, "fraud"));
        client.resolve_slash(&governance, &String::from_str(&env, proof), &true);
    }

    let first = client.resolved_slashes(&0, &2);
    assert_eq!(first.len(), 2);
    assert_eq!(first.get(0).unwrap().evidence.proof_ref, String::from_str(&env, "a"));
    assert_eq!(first.get(1).unwrap().evidence.proof_ref, String::from_str(&env, "b"));

    let next = client.resolved_slashes(&2, &2);
    assert_eq!(next.len(), 1);
    assert_eq!(next.get(0).unwrap().evidence.proof_ref, String::from_str(&env, "c"));

    assert_eq!(client.resolved_slashes(&3, &2).len(), 0);
    assert!(client.resolved_slashes(&0, &u32::MAX).len() <= MAX_RESOLVED_PAGE);
}
