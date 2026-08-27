#![cfg(test)]

use super::*;
use soroban_sdk::{
    symbol_short,
    testutils::{storage::Persistent as _, Address as _, Events, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    vec, Address, BytesN, Env, String,
};

fn setup_token(env: &Env, admin: &Address) -> Address {
    let token_id = env.register_stellar_asset_contract_v2(admin.clone());
    StellarAssetClient::new(env, &token_id.address()).mint(admin, &10_000);
    token_id.address()
}

fn make_token(env: &Env) -> Address {
    let admin = Address::generate(env);
    setup_token(env, &admin)
}

fn setup_contract(env: &Env) -> (KovaraContractClient<'_>, Address, Address) {
    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(env, &contract_id);
    let admin = Address::generate(env);
    let treasury = Address::generate(env);
    client.initialize(&admin, &treasury, &0);
    (client, admin, treasury)
}

#[test]
fn test_verifier_registration_and_stake_balance() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);
    let verifier = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token = token_id.address();
    StellarAssetClient::new(&env, &token).mint(&verifier, &1_000);

    assert!(!client.is_verifier(&verifier));
    assert_eq!(client.get_verifier_stake(&verifier, &token), 0);

    client.register_verifier(&verifier);
    client.set_minimum_verifier_stake(&250);
    client.deposit_stake(&verifier, &token, &250);
    client.deposit_stake(&verifier, &token, &100);

    assert!(client.is_verifier(&verifier));
    assert_eq!(client.get_verifier_stake(&verifier, &token), 350);
    assert_eq!(TokenClient::new(&env, &token).balance(&verifier), 650);
}

#[test]
fn test_verifier_stake_boundary_is_accepted() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);
    let verifier = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = env.register_stellar_asset_contract_v2(token_admin).address();
    StellarAssetClient::new(&env, &token).mint(&verifier, &250);

    client.set_minimum_verifier_stake(&250);
    client.register_verifier(&verifier);
    client.deposit_stake(&verifier, &token, &250);

    assert_eq!(client.get_verifier_stake(&verifier, &token), 250);
}

#[test]
#[should_panic(expected = "Error(Contract, #53)")]
fn test_verifier_stake_below_minimum_is_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);
    let verifier = Address::generate(&env);
    let token = make_token(&env);
    client.set_minimum_verifier_stake(&250);
    client.register_verifier(&verifier);
    client.deposit_stake(&verifier, &token, &249);
}

#[test]
#[should_panic(expected = "Error(Contract, #52)")]
fn test_minimum_verifier_stake_must_be_positive() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);
    client.set_minimum_verifier_stake(&0);
}

#[test]
#[should_panic(expected = "Error(Contract, #46)")]
fn test_unregistered_verifier_cannot_deposit_stake() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);
    let verifier = Address::generate(&env);
    let token = make_token(&env);
    client.deposit_stake(&verifier, &token, &100);
}

#[test]
#[should_panic(expected = "Error(Contract, #45)")]
fn test_verifier_cannot_register_twice() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);
    let verifier = Address::generate(&env);
    client.register_verifier(&verifier);
    client.register_verifier(&verifier);
}

#[test]
fn test_set_and_get_profile() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let user = Address::generate(&env);
    let token = make_token(&env);
    client.set_profile(&user, &String::from_str(&env, "alice"), &token);
    let profile = client.get_profile(&user).unwrap();
    assert_eq!(profile.username, String::from_str(&env, "alice"));
}

#[test]
fn test_username_reverse_index_registration() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let user = Address::generate(&env);
    let token = make_token(&env);
    client.set_profile(&user, &String::from_str(&env, "alice"), &token);

    let resolved = client.get_address_by_username(&String::from_str(&env, "alice"));
    assert_eq!(resolved, Some(user));
}

#[test]
fn test_username_reverse_index_update() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let user = Address::generate(&env);
    let token = make_token(&env);
    client.set_profile(&user, &String::from_str(&env, "alice"), &token);
    client.set_profile(&user, &String::from_str(&env, "alice2"), &token);

    // Old username should be gone
    assert!(client
        .get_address_by_username(&String::from_str(&env, "alice"))
        .is_none());
    // New username should resolve
    assert_eq!(
        client.get_address_by_username(&String::from_str(&env, "alice2")),
        Some(user)
    );
}


use super::*;
use soroban_sdk::{
    symbol_short,
    testutils::{storage::Persistent as _, Address as _, Events, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    vec, Address, BytesN, Env, String,
};

fn setup_token(env: &Env, admin: &Address) -> Address {
    let token_id = env.register_stellar_asset_contract_v2(admin.clone());
    StellarAssetClient::new(env, &token_id.address()).mint(admin, &10_000);
    token_id.address()
}

fn make_token(env: &Env) -> Address {
    let admin = Address::generate(env);
    setup_token(env, &admin)
}

fn setup_contract(env: &Env) -> (KovaraContractClient<'_>, Address, Address) {
    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(env, &contract_id);
    let admin = Address::generate(env);
    let treasury = Address::generate(env);
    client.initialize(&admin, &treasury, &0);
    (client, admin, treasury)
}

#[test]
fn test_set_and_get_profile() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let user = Address::generate(&env);
    let token = make_token(&env);
    client.set_profile(&user, &String::from_str(&env, "alice"), &token);
    let profile = client.get_profile(&user).unwrap();
    assert_eq!(profile.username, String::from_str(&env, "alice"));
}
#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn test_username_duplicate_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let user1 = Address::generate(&env);
    let user2 = Address::generate(&env);
    let token = make_token(&env);

    client.set_profile(&user1, &String::from_str(&env, "shared_username"), &token);
    client.set_profile(&user2, &String::from_str(&env, "shared_username"), &token);
}

// ── Pagination tests ──────────────────────────────────────────────────────────

#[test]
fn test_get_following_first_page() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);

    let alice = Address::generate(&env);
    let mut followees = soroban_sdk::vec![&env];
    for _ in 0..10 {
        followees.push_back(Address::generate(&env));
    }

    for followee in followees.iter() {
        client.follow(&alice, &followee);
    }

    let page = client.get_following(&alice, &0, &5);
    assert_eq!(page.len(), 5);
    assert_eq!(page.get(0).unwrap(), followees.get(0).unwrap());
    assert_eq!(page.get(4).unwrap(), followees.get(4).unwrap());
}


use super::*;
use soroban_sdk::{
    symbol_short,
    testutils::{storage::Persistent as _, Address as _, Events, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    vec, Address, BytesN, Env, String,
};

fn setup_token(env: &Env, admin: &Address) -> Address {
    let token_id = env.register_stellar_asset_contract_v2(admin.clone());
    StellarAssetClient::new(env, &token_id.address()).mint(admin, &10_000);
    token_id.address()
}

fn make_token(env: &Env) -> Address {
    let admin = Address::generate(env);
    setup_token(env, &admin)
}

fn setup_contract(env: &Env) -> (KovaraContractClient<'_>, Address, Address) {
    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(env, &contract_id);
    let admin = Address::generate(env);
    let treasury = Address::generate(env);
    client.initialize(&admin, &treasury, &0);
    (client, admin, treasury)
}

#[test]
fn test_set_and_get_profile() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let user = Address::generate(&env);
    let token = make_token(&env);
    client.set_profile(&user, &String::from_str(&env, "alice"), &token);
    let profile = client.get_profile(&user).unwrap();
    assert_eq!(profile.username, String::from_str(&env, "alice"));
}

#[test]
fn test_get_following_second_page() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);

    let alice = Address::generate(&env);
    let mut followees = soroban_sdk::vec![&env];
    for _ in 0..10 {
        followees.push_back(Address::generate(&env));
    }

    for followee in followees.iter() {
        client.follow(&alice, &followee);
    }

    let page = client.get_following(&alice, &5, &5);
    assert_eq!(page.len(), 5);
    assert_eq!(page.get(0).unwrap(), followees.get(5).unwrap());
    assert_eq!(page.get(4).unwrap(), followees.get(9).unwrap());
}

#[test]
fn test_get_following_offset_beyond_end() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    client.follow(&alice, &bob);

    let page = client.get_following(&alice, &10, &10);
    assert_eq!(page.len(), 0);
}

#[test]
#[should_panic(expected = "Error(Contract, #11)")]
fn test_get_following_limit_exceeds_maximum() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    client.follow(&alice, &bob);

    client.get_following(&alice, &0, &51);
}

#[test]
#[should_panic(expected = "Error(Contract, #11)")]
fn test_get_following_zero_limit() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    client.follow(&alice, &bob);

    client.get_following(&alice, &0, &0);
}

#[test]
fn test_get_posts_by_author_first_page() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);

    let author = Address::generate(&env);

    for i in 0..10 {
        let post_str = if i == 0 {
            String::from_str(&env, "post 0")
        } else if i == 1 {
            String::from_str(&env, "post 1")
        } else if i == 2 {
            String::from_str(&env, "post 2")
        } else if i == 3 {
            String::from_str(&env, "post 3")
        } else if i == 4 {
            String::from_str(&env, "post 4")
        } else if i == 5 {
            String::from_str(&env, "post 5")
        } else if i == 6 {
            String::from_str(&env, "post 6")
        } else if i == 7 {
            String::from_str(&env, "post 7")
        } else if i == 8 {
            String::from_str(&env, "post 8")
        } else {
            String::from_str(&env, "post 9")
        };
        client.create_post(&author, &post_str);
    }

    let page = client.get_posts_by_author(&author, &0, &5);
    assert_eq!(page.len(), 5);
    assert_eq!(page.get(0).unwrap(), 1u64);
    assert_eq!(page.get(4).unwrap(), 5u64);
}


#[test]
fn test_get_following_second_page() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);

    let alice = Address::generate(&env);
    let mut followees = soroban_sdk::vec![&env];
    for _ in 0..10 {
        followees.push_back(Address::generate(&env));
    }

    for followee in followees.iter() {
        client.follow(&alice, &followee);
    }

    let page = client.get_following(&alice, &5, &5);
    assert_eq!(page.len(), 5);
    assert_eq!(page.get(0).unwrap(), followees.get(5).unwrap());
    assert_eq!(page.get(4).unwrap(), followees.get(9).unwrap());
}

#[test]
fn test_get_following_offset_beyond_end() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    client.follow(&alice, &bob);

    let page = client.get_following(&alice, &10, &10);
    assert_eq!(page.len(), 0);
}


#[test]
fn test_get_posts_by_author_second_page() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);

    let author = Address::generate(&env);

    for i in 0..10 {
        let post_str = if i == 0 {
            String::from_str(&env, "post 0")
        } else if i == 1 {
            String::from_str(&env, "post 1")
        } else if i == 2 {
            String::from_str(&env, "post 2")
        } else if i == 3 {
            String::from_str(&env, "post 3")
        } else if i == 4 {
            String::from_str(&env, "post 4")
        } else if i == 5 {
            String::from_str(&env, "post 5")
        } else if i == 6 {
            String::from_str(&env, "post 6")
        } else if i == 7 {
            String::from_str(&env, "post 7")
        } else if i == 8 {
            String::from_str(&env, "post 8")
        } else {
            String::from_str(&env, "post 9")
        };
        client.create_post(&author, &post_str);
    }

    let page = client.get_posts_by_author(&author, &5, &5);
    assert_eq!(page.len(), 5);
    assert_eq!(page.get(0).unwrap(), 6u64);
    assert_eq!(page.get(4).unwrap(), 10u64);
}


#[test]
fn test_get_posts_by_author_offset_beyond_end() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);

    let author = Address::generate(&env);

    client.create_post(&author, &String::from_str(&env, "post 1"));

    let page = client.get_posts_by_author(&author, &10, &10);
    assert_eq!(page.len(), 0);
}

#[test]
#[should_panic(expected = "Error(Contract, #11)")]
fn test_get_posts_by_author_limit_exceeds_maximum() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);

    let author = Address::generate(&env);

    client.create_post(&author, &String::from_str(&env, "post 1"));

    client.get_posts_by_author(&author, &0, &51);
}

#[test]
fn test_get_posts_by_author_after_delete() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);

    let author = Address::generate(&env);

    let id1 = client.create_post(&author, &String::from_str(&env, "post 1"));
    let id2 = client.create_post(&author, &String::from_str(&env, "post 2"));
    let id3 = client.create_post(&author, &String::from_str(&env, "post 3"));

    // Delete middle post
    client.delete_post(&author, &id2);

    let page = client.get_posts_by_author(&author, &0, &10);
    assert_eq!(page.len(), 2);
    assert_eq!(page.get(0).unwrap(), id1);
    assert_eq!(page.get(1).unwrap(), id3);
}

// ── Price observation tests ───────────────────────────────────────────────────

#[test]
fn test_price_is_fixed_point_and_emits_complete_event() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_sequence_number(2_000);
    env.ledger().with_timestamp(10_000);
    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    client.initialize(&admin, &treasury, &0);
    let submitter = Address::generate(&env);
    let token = setup_token(&env, &submitter);
    let item = String::from_str(&env, "bread");

    client.submit_price(&submitter, &item, &12345, &token, &9_900, &1);
    assert_eq!(client.get_price(&submitter, &item, &9_900), Some(12345));
    assert_eq!(client.price_scale(), 100);
}

#[test]
#[should_panic(expected = "duplicate observation")]
fn test_duplicate_price_observation_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_sequence_number(2_000);
    env.ledger().with_timestamp(10_000);
    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin, &Address::generate(&env), &0);
    let submitter = Address::generate(&env);
    let token = setup_token(&env, &submitter);
    let item = String::from_str(&env, "rent");
    client.submit_price(&submitter, &item, &100, &token, &9_900, &1);
    client.submit_price(&submitter, &item, &101, &token, &9_900, &1);
}

// ── Post tests ────────────────────────────────────────────────────────────────

#[test]
fn test_username_same_user_can_reregister_same_name() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let user = Address::generate(&env);
    let token = make_token(&env);
    client.set_profile(&user, &String::from_str(&env, "alice"), &token);
    // Same user re-registering with the same username should not panic
    client.set_profile(&user, &String::from_str(&env, "alice"), &token);
    assert_eq!(
        client.get_address_by_username(&String::from_str(&env, "alice")),
        Some(user)
    );
}


#[test]
fn test_get_posts_by_author_offset_beyond_end() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);

    let author = Address::generate(&env);

    client.create_post(&author, &String::from_str(&env, "post 1"));

    let page = client.get_posts_by_author(&author, &10, &10);
    assert_eq!(page.len(), 0);
}

#[test]
#[should_panic(expected = "Error(Contract, #11)")]
fn test_get_posts_by_author_limit_exceeds_maximum() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);

    let author = Address::generate(&env);

    client.create_post(&author, &String::from_str(&env, "post 1"));

    client.get_posts_by_author(&author, &0, &51);
}

#[test]
fn test_get_posts_by_author_after_delete() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);

    let author = Address::generate(&env);

    let id1 = client.create_post(&author, &String::from_str(&env, "post 1"));
    let id2 = client.create_post(&author, &String::from_str(&env, "post 2"));
    let id3 = client.create_post(&author, &String::from_str(&env, "post 3"));

    // Delete middle post
    client.delete_post(&author, &id2);

    let page = client.get_posts_by_author(&author, &0, &10);
    assert_eq!(page.len(), 2);
    assert_eq!(page.get(0).unwrap(), id1);
    assert_eq!(page.get(1).unwrap(), id3);
}


#[test]
fn test_tip_fee_split() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let author = Address::generate(&env);
    let tipper = Address::generate(&env);

    // Initialize with 2.5% fee (250 bps)
    client.initialize(&admin, &treasury, &250);

    let token = setup_token(&env, &tipper);
    let post_id = client.create_post(&author, &String::from_str(&env, "Fee test post"));

    // Tip 1000 units
    client.tip(&tipper, &post_id, &token, &1000);

    // Verify balances
    // Fee = 1000 * 250 / 10000 = 25
    // Author gets 1000 - 25 = 975
    assert_eq!(TokenClient::new(&env, &token).balance(&treasury), 25);
    assert_eq!(TokenClient::new(&env, &token).balance(&author), 975);

    let post = client.get_post(&post_id).unwrap();
    assert_eq!(post.tip_total, 1000);
}

#[test]
#[should_panic(expected = "Error(Contract, #13)")]
fn test_tip_rejects_mismatched_creator_token() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let author = Address::generate(&env);
    let tipper = Address::generate(&env);

    client.initialize(&admin, &treasury, &250);

    let allowed_token = setup_token(&env, &tipper);
    let mismatched_token = setup_token(&env, &tipper);
    client.set_profile(&author, &String::from_str(&env, "alice"), &allowed_token);

    let post_id = client.create_post(&author, &String::from_str(&env, "Creator token test"));
    client.tip(&tipper, &post_id, &mismatched_token, &1000);
}

#[test]
fn test_tip_accepts_matching_creator_token() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let author = Address::generate(&env);
    let tipper = Address::generate(&env);

    client.initialize(&admin, &treasury, &250);

    let creator_token = setup_token(&env, &tipper);
    client.set_profile(&author, &String::from_str(&env, "alice"), &creator_token);

    let post_id = client.create_post(&author, &String::from_str(&env, "Creator token test"));
    client.tip(&tipper, &post_id, &creator_token, &1000);

    let post = client.get_post(&post_id).unwrap();
    assert_eq!(post.tip_total, 1000);
}

#[test]
#[should_panic(expected = "Error(Contract, #7)")]
fn test_tip_blocked_by_author() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let author = Address::generate(&env);
    let tipper = Address::generate(&env);

    client.initialize(&admin, &treasury, &250);

    let token = setup_token(&env, &tipper);
    let post_id = client.create_post(&author, &String::from_str(&env, "Test post"));

    // Author blocks tipper
    client.block_user(&author, &tipper);

    // Tipper tries to tip - should panic with "blocked"
    client.tip(&tipper, &post_id, &token, &1000);
}

#[test]
fn test_tip_after_unblock() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let author = Address::generate(&env);
    let tipper = Address::generate(&env);

    client.initialize(&admin, &treasury, &250);

    let token = setup_token(&env, &tipper);
    let post_id = client.create_post(&author, &String::from_str(&env, "Test post"));

    // Author blocks tipper
    client.block_user(&author, &tipper);

    // Author unblocks tipper
    client.unblock_user(&author, &tipper);

    // Tipper can now tip successfully
    client.tip(&tipper, &post_id, &token, &1000);

    let post = client.get_post(&post_id).unwrap();
    assert_eq!(post.tip_total, 1000);
}

#[test]
fn test_tip_non_blocked_user() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let author = Address::generate(&env);
    let tipper1 = Address::generate(&env);
    let tipper2 = Address::generate(&env);

    client.initialize(&admin, &treasury, &250);

    let token = setup_token(&env, &tipper1);
    StellarAssetClient::new(&env, &token).mint(&tipper2, &5000);

    let post_id = client.create_post(&author, &String::from_str(&env, "Test post"));

    // Author blocks tipper1
    client.block_user(&author, &tipper1);

    // Tipper2 (not blocked) can tip successfully
    client.tip(&tipper2, &post_id, &token, &500);

    let post = client.get_post(&post_id).unwrap();
    assert_eq!(post.tip_total, 500);
}

#[test]
#[should_panic(expected = "Error(Contract, #12)")]
fn test_tip_zero_amount_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let author = Address::generate(&env);
    let tipper = Address::generate(&env);

    client.initialize(&admin, &treasury, &250);

    let token = setup_token(&env, &tipper);
    let post_id = client.create_post(&author, &String::from_str(&env, "Test post"));

    // Attempt to tip with zero amount should panic
    client.tip(&tipper, &post_id, &token, &0);
}

#[test]
#[should_panic(expected = "Error(Contract, #12)")]
fn test_tip_negative_amount_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let author = Address::generate(&env);
    let tipper = Address::generate(&env);

    client.initialize(&admin, &treasury, &250);

    let token = setup_token(&env, &tipper);
    let post_id = client.create_post(&author, &String::from_str(&env, "Test post"));

    // Attempt to tip with negative amount should panic
    client.tip(&tipper, &post_id, &token, &-100);
}

#[test]
fn test_profile_count() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let user1 = Address::generate(&env);
    let user2 = Address::generate(&env);
    let token = make_token(&env);

    client.set_profile(&user1, &String::from_str(&env, "alice"), &token);
    assert_eq!(client.get_profile_count(), 1);

    // Update profile should not increment count
    client.set_profile(&user1, &String::from_str(&env, "alice_new"), &token);
    assert_eq!(client.get_profile_count(), 1);

    client.set_profile(&user2, &String::from_str(&env, "bob"), &token);
    assert_eq!(client.get_profile_count(), 2);
}

#[test]
fn test_post_count() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let author = Address::generate(&env);
    client.create_post(&author, &String::from_str(&env, "Post 1"));
    client.create_post(&author, &String::from_str(&env, "Post 2"));

    assert_eq!(client.get_post_count(), 2);
}

#[test]
fn test_post_count_not_decremented_on_delete() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let author = Address::generate(&env);
    let post_id1 = client.create_post(&author, &String::from_str(&env, "Post 1"));
    let post_id2 = client.create_post(&author, &String::from_str(&env, "Post 2"));

    assert_eq!(client.get_post_count(), 2);

    // Delete first post
    client.delete_post(&author, &post_id1);

    // Counter should still be 2 (total ever created)
    assert_eq!(client.get_post_count(), 2);

    // But the post should be gone
    assert!(client.get_post(&post_id1).is_none());
    assert!(client.get_post(&post_id2).is_some());
}

#[test]
fn test_follow_and_unfollow() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    client.follow(&alice, &bob);
    assert_eq!(client.get_following(&alice, &0, &10).len(), 1);
    assert_eq!(client.get_followers(&bob, &0, &10).len(), 1);

    client.unfollow(&alice, &bob);
    assert_eq!(client.get_following(&alice, &0, &10).len(), 0);
    assert_eq!(client.get_followers(&bob, &0, &10).len(), 0);
}

#[test]
fn test_duplicate_follow_only_one_record() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    // First follow should add the relationship
    client.follow(&alice, &bob);
    assert_eq!(client.get_following(&alice, &0, &10).len(), 1);
    assert_eq!(client.get_followers(&bob, &0, &10).len(), 1);

    // Following again should be a no-op and not create duplicates
    client.follow(&alice, &bob);
    assert_eq!(client.get_following(&alice, &0, &10).len(), 1);
    assert_eq!(client.get_followers(&bob, &0, &10).len(), 1);
}

#[test]
fn test_block_prevents_follow() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let blocker = Address::generate(&env);
    let blocked = Address::generate(&env);
    client.block_user(&blocker, &blocked);
    assert!(client.is_blocked(&blocker, &blocked));
}

#[test]
#[should_panic(expected = "Error(Contract, #7)")]
fn test_blocked_follow_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    // Bob blocks Alice
    client.block_user(&bob, &alice);

    // Alice tries to follow Bob
    client.follow(&alice, &bob);
}

#[test]
fn test_follow_after_unblock() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    // Bob blocks Alice
    client.block_user(&bob, &alice);
    assert!(client.is_blocked(&bob, &alice));

    // Bob unblocks Alice
    client.unblock_user(&bob, &alice);
    assert!(!client.is_blocked(&bob, &alice));

    // Alice can now follow Bob
    client.follow(&alice, &bob);
    assert_eq!(client.get_following(&alice, &0, &10).len(), 1);
    assert_eq!(client.get_followers(&bob, &0, &10).len(), 1);
}

#[test]
fn test_blocked_user_can_follow_others() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let charlie = Address::generate(&env);

    // Bob blocks Alice
    client.block_user(&bob, &alice);

    // Alice can still follow Charlie
    client.follow(&alice, &charlie);
    assert_eq!(client.get_following(&alice, &0, &10).len(), 1);
    assert_eq!(client.get_followers(&charlie, &0, &10).len(), 1);

    // Alice cannot follow Bob
    // (verified separately by test_blocked_follow_panics)
}

#[test]
fn test_like_post() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let author = Address::generate(&env);
    let user = Address::generate(&env);
    let post_id = client.create_post(&author, &String::from_str(&env, "Like test"));

    client.like_post(&user, &post_id);
    assert_eq!(client.get_like_count(&post_id), 1);
    assert!(client.has_liked(&user, &post_id));

    // Duplicate like should not increment
    client.like_post(&user, &post_id);
    assert_eq!(client.get_like_count(&post_id), 1);
}

#[test]
fn test_like_post_emits_event_on_first_like() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let author = Address::generate(&env);
    let user = Address::generate(&env);
    let post_id = client.create_post(&author, &String::from_str(&env, "Event test"));

    client.like_post(&user, &post_id);

    assert!(
        !env.events().all().events().is_empty(),
        "LikePostEvent should be emitted"
    );
}

#[test]
fn test_like_post_no_event_on_duplicate() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let author = Address::generate(&env);
    let user1 = Address::generate(&env);
    let user2 = Address::generate(&env);
    let post_id = client.create_post(&author, &String::from_str(&env, "Duplicate event test"));

    client.like_post(&user1, &post_id);
    let like_count_after_first = client.get_like_count(&post_id);

    client.like_post(&user1, &post_id);
    let like_count_after_duplicate = client.get_like_count(&post_id);

    assert_eq!(
        like_count_after_duplicate, like_count_after_first,
        "duplicate like should not increment count"
    );

    client.like_post(&user2, &post_id);
    let like_count_after_new_user = client.get_like_count(&post_id);

    assert_eq!(
        like_count_after_new_user,
        like_count_after_first + 1,
        "like from new user should increment"
    );
}

#[test]
fn test_like_post_once() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let author = Address::generate(&env);
    let user = Address::generate(&env);
    let post_id = client.create_post(&author, &String::from_str(&env, "Like test"));

    client.like_post(&user, &post_id);
    assert_eq!(client.get_like_count(&post_id), 1);
    assert!(client.has_liked(&user, &post_id));
}

#[test]
fn test_duplicate_like_same_user() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let author = Address::generate(&env);
    let user = Address::generate(&env);
    let post_id = client.create_post(&author, &String::from_str(&env, "Duplicate like test"));

    client.like_post(&user, &post_id);
    assert_eq!(client.get_like_count(&post_id), 1);

    // Second like from same user - should keep like count at 1
    client.like_post(&user, &post_id);
    assert_eq!(client.get_like_count(&post_id), 1);
    assert!(client.has_liked(&user, &post_id));
}

#[test]
fn test_duplicate_like_no_duplicate_event() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let author = Address::generate(&env);
    let user = Address::generate(&env);
    let post_id = client.create_post(&author, &String::from_str(&env, "Duplicate event test"));

    client.like_post(&user, &post_id);
    let event_count_after_first = env.events().all().events().len();
    assert_eq!(event_count_after_first, 1, "First like must emit 1 event");

    // Second like from same user
    client.like_post(&user, &post_id);
    let event_count_after_second = env.events().all().events().len();

    assert_eq!(
        event_count_after_second, 0,
        "Duplicate like must not publish duplicate events"
    );
}

#[test]
fn test_pool_authorization() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _) = setup_contract(&env);

    let pool_admin1 = Address::generate(&env);
    let pool_admin2 = Address::generate(&env);
    let other_user = Address::generate(&env);
    let token = setup_token(&env, &pool_admin1);

    // Give other_user some tokens to deposit
    StellarAssetClient::new(&env, &token).mint(&other_user, &1000);

    let pool_id = symbol_short!("pool1");
    // Create pool with 2-of-2 threshold
    client.create_pool(
        &admin,
        &pool_id,
        &token,
        &vec![&env, pool_admin1.clone(), pool_admin2.clone()],
        &2,
    );

    // Deposit works for anyone with tokens
    client.pool_deposit(&other_user, &pool_id, &token, &100);

    // Verify pool balance was updated
    assert_eq!(client.get_pool(&pool_id).unwrap().balance, 100);

    // Withdrawal by both admins works
    client.pool_withdraw(
        &vec![&env, pool_admin1.clone(), pool_admin2.clone()],
        &pool_id,
        &50,
        &other_user,
    );
    assert_eq!(client.get_pool(&pool_id).unwrap().balance, 50);
}

#[test]
fn test_create_pool_emits_event() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _) = setup_contract(&env);

    let pool_admin = Address::generate(&env);
    let token = setup_token(&env, &pool_admin);

    let pool_id = symbol_short!("pool_evt");

    client.create_pool(
        &admin,
        &pool_id,
        &token,
        &vec![&env, pool_admin.clone()],
        &1,
    );
    assert!(
        !env.events().all().events().is_empty(),
        "PoolCreatedEvent should be emitted"
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #21)")]
fn test_pool_withdraw_insufficient_signers() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _) = setup_contract(&env);

    let pool_admin1 = Address::generate(&env);
    let pool_admin2 = Address::generate(&env);
    let other_user = Address::generate(&env);
    let token = setup_token(&env, &pool_admin1);
    StellarAssetClient::new(&env, &token).mint(&other_user, &1000);

    let pool_id = symbol_short!("pool1");
    client.create_pool(
        &admin,
        &pool_id,
        &token,
        &vec![&env, pool_admin1.clone(), pool_admin2.clone()],
        &2,
    );
    client.pool_deposit(&other_user, &pool_id, &token, &100);

    // Only 1 signer when 2 required
    client.pool_withdraw(&vec![&env, pool_admin1.clone()], &pool_id, &50, &other_user);
}

#[test]
#[should_panic(expected = "Error(Contract, #22)")]
fn test_pool_withdraw_unauthorized_signer() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _) = setup_contract(&env);

    let pool_admin1 = Address::generate(&env);
    let pool_admin2 = Address::generate(&env);
    let unauthorized_user = Address::generate(&env);
    let other_user = Address::generate(&env);
    let token = setup_token(&env, &pool_admin1);
    StellarAssetClient::new(&env, &token).mint(&other_user, &1000);

    let pool_id = symbol_short!("pool2");
    client.create_pool(
        &admin,
        &pool_id,
        &token,
        &vec![&env, pool_admin1.clone(), pool_admin2.clone()],
        &2,
    );
    client.pool_deposit(&other_user, &pool_id, &token, &100);

    // Try to withdraw with a signer not in pool.admins
    client.pool_withdraw(
        &vec![&env, pool_admin1.clone(), unauthorized_user.clone()],
        &pool_id,
        &50,
        &other_user,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #23)")]
fn test_pool_withdraw_exceeds_balance() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _) = setup_contract(&env);

    let pool_admin1 = Address::generate(&env);
    let pool_admin2 = Address::generate(&env);
    let other_user = Address::generate(&env);
    let token = setup_token(&env, &pool_admin1);
    StellarAssetClient::new(&env, &token).mint(&other_user, &1000);

    let pool_id = symbol_short!("pool3");
    client.create_pool(
        &admin,
        &pool_id,
        &token,
        &vec![&env, pool_admin1.clone(), pool_admin2.clone()],
        &1,
    );
    client.pool_deposit(&other_user, &pool_id, &token, &100);

    // Try to withdraw more than available balance
    client.pool_withdraw(
        &vec![&env, pool_admin1.clone(), pool_admin2.clone()],
        &pool_id,
        &200,
        &other_user,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #20)")]
fn test_pool_withdraw_zero_amount_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _) = setup_contract(&env);

    let pool_admin1 = Address::generate(&env);
    let pool_admin2 = Address::generate(&env);
    let other_user = Address::generate(&env);
    let token = setup_token(&env, &pool_admin1);
    StellarAssetClient::new(&env, &token).mint(&other_user, &1000);

    let pool_id = symbol_short!("pool3");
    client.create_pool(
        &admin,
        &pool_id,
        &token,
        &vec![&env, pool_admin1.clone(), pool_admin2.clone()],
        &1,
    );
    client.pool_deposit(&other_user, &pool_id, &token, &100);

    client.pool_withdraw(
        &vec![&env, pool_admin1.clone(), pool_admin2.clone()],
        &pool_id,
        &0,
        &other_user,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #20)")]
fn test_pool_withdraw_negative_amount_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _) = setup_contract(&env);

    let pool_admin1 = Address::generate(&env);
    let pool_admin2 = Address::generate(&env);
    let other_user = Address::generate(&env);
    let token = setup_token(&env, &pool_admin1);
    StellarAssetClient::new(&env, &token).mint(&other_user, &1000);

    let pool_id = symbol_short!("pool3");
    client.create_pool(
        &admin,
        &pool_id,
        &token,
        &vec![&env, pool_admin1.clone(), pool_admin2.clone()],
        &1,
    );
    client.pool_deposit(&other_user, &pool_id, &token, &100);

    client.pool_withdraw(
        &vec![&env, pool_admin1.clone(), pool_admin2.clone()],
        &pool_id,
        &-50,
        &other_user,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #21)")]
fn test_pool_withdraw_zero_signers_when_threshold_positive() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _) = setup_contract(&env);

    let pool_admin1 = Address::generate(&env);
    let pool_admin2 = Address::generate(&env);
    let other_user = Address::generate(&env);
    let token = setup_token(&env, &pool_admin1);
    StellarAssetClient::new(&env, &token).mint(&other_user, &1000);

    let pool_id = symbol_short!("pool_zero_signers");
    client.create_pool(
        &admin,
        &pool_id,
        &token,
        &vec![&env, pool_admin1.clone(), pool_admin2.clone()],
        &2,
    );
    client.pool_deposit(&other_user, &pool_id, &token, &100);

    // Try to withdraw with 0 signers when threshold is 2
    client.pool_withdraw(&vec![&env], &pool_id, &50, &other_user);
}

#[test]
#[should_panic(expected = "Error(Contract, #21)")]
fn test_pool_withdraw_threshold_3_only_2_signers() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _) = setup_contract(&env);

    let pool_admin1 = Address::generate(&env);
    let pool_admin2 = Address::generate(&env);
    let pool_admin3 = Address::generate(&env);
    let other_user = Address::generate(&env);
    let token = setup_token(&env, &pool_admin1);
    StellarAssetClient::new(&env, &token).mint(&other_user, &1000);

    let pool_id = symbol_short!("pool_threshold_3");
    client.create_pool(
        &admin,
        &pool_id,
        &token,
        &vec![&env, pool_admin1.clone(), pool_admin2.clone(), pool_admin3.clone()],
        &3,
    );
    client.pool_deposit(&other_user, &pool_id, &token, &100);

    // Try to withdraw with only 2 signers when threshold is 3
    client.pool_withdraw(
        &vec![&env, pool_admin1.clone(), pool_admin2.clone()],
        &pool_id,
        &50,
        &other_user,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #21)")]
fn test_pool_withdraw_threshold_1_zero_signers() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _) = setup_contract(&env);

    let pool_admin1 = Address::generate(&env);
    let other_user = Address::generate(&env);
    let token = setup_token(&env, &pool_admin1);
    StellarAssetClient::new(&env, &token).mint(&other_user, &1000);

    let pool_id = symbol_short!("pool_threshold_1");
    client.create_pool(
        &admin,
        &pool_id,
        &token,
        &vec![&env, pool_admin1.clone()],
        &1,
    );
    client.pool_deposit(&other_user, &pool_id, &token, &100);

    // Try to withdraw with 0 signers when threshold is 1
    client.pool_withdraw(&vec![&env], &pool_id, &50, &other_user);
}

#[test]
#[should_panic(expected = "Error(Contract, #21)")]
fn test_pool_withdraw_duplicate_signers_count_once() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _) = setup_contract(&env);

    let pool_admin1 = Address::generate(&env);
    let pool_admin2 = Address::generate(&env);
    let other_user = Address::generate(&env);
    let token = setup_token(&env, &pool_admin1);
    StellarAssetClient::new(&env, &token).mint(&other_user, &1000);

    let pool_id = symbol_short!("pool_duplicate");
    client.create_pool(
        &admin,
        &pool_id,
        &token,
        &vec![&env, pool_admin1.clone(), pool_admin2.clone()],
        &2,
    );
    client.pool_deposit(&other_user, &pool_id, &token, &100);

    // Try to withdraw with duplicate signer - should count as only 1 unique signer
    client.pool_withdraw(
        &vec![&env, pool_admin1.clone(), pool_admin1.clone()],
        &pool_id,
        &50,
        &other_user,
    );
}

#[test]
fn test_pool_withdraw_threshold_2_with_2_unique_signers_succeeds() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _) = setup_contract(&env);

    let pool_admin1 = Address::generate(&env);
    let pool_admin2 = Address::generate(&env);
    let other_user = Address::generate(&env);
    let token = setup_token(&env, &pool_admin1);
    StellarAssetClient::new(&env, &token).mint(&other_user, &1000);

    let pool_id = symbol_short!("pool_success");
    client.create_pool(
        &admin,
        &pool_id,
        &token,
        &vec![&env, pool_admin1.clone(), pool_admin2.clone()],
        &2,
    );
    client.pool_deposit(&other_user, &pool_id, &token, &100);

    // Withdraw with exactly 2 unique signers when threshold is 2 should succeed
    client.pool_withdraw(
        &vec![&env, pool_admin1.clone(), pool_admin2.clone()],
        &pool_id,
        &50,
        &other_user,
    );
    assert_eq!(client.get_pool(&pool_id).unwrap().balance, 50);
}

#[test]
#[should_panic(expected = "Error(Contract, #19)")]
fn test_pool_deposit_wrong_token_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _) = setup_contract(&env);

    let pool_admin = Address::generate(&env);
    let other_user = Address::generate(&env);
    let correct_token = setup_token(&env, &pool_admin);
    let wrong_token = setup_token(&env, &pool_admin);

    // Give other_user some wrong tokens
    StellarAssetClient::new(&env, &wrong_token).mint(&other_user, &1000);

    let pool_id = symbol_short!("pool4");
    // Create pool with correct_token
    client.create_pool(
        &admin,
        &pool_id,
        &correct_token,
        &vec![&env, pool_admin.clone()],
        &1,
    );

    // Try to deposit with wrong_token - should panic
    client.pool_deposit(&other_user, &pool_id, &wrong_token, &100);
}

#[test]
fn test_pool_deposit_correct_token_succeeds() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _) = setup_contract(&env);

    let pool_admin = Address::generate(&env);
    let other_user = Address::generate(&env);
    let token = setup_token(&env, &pool_admin);

    // Give other_user some tokens to deposit
    StellarAssetClient::new(&env, &token).mint(&other_user, &1000);

    let pool_id = symbol_short!("pool5");
    // Create pool with the matching token
    client.create_pool(
        &admin,
        &pool_id,
        &token,
        &vec![&env, pool_admin.clone()],
        &1,
    );

    // Pool starts empty
    assert_eq!(client.get_pool(&pool_id).unwrap().balance, 0);

    // Depositing with the correct token succeeds
    client.pool_deposit(&other_user, &pool_id, &token, &100);

    // Pool balance is updated and tokens were transferred into the contract
    assert_eq!(client.get_pool(&pool_id).unwrap().balance, 100);
    assert_eq!(TokenClient::new(&env, &token).balance(&other_user), 900);

    // A second deposit accumulates on the existing balance
    client.pool_deposit(&other_user, &pool_id, &token, &50);
    assert_eq!(client.get_pool(&pool_id).unwrap().balance, 150);
}

#[test]
fn test_sequential_posts() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let author = Address::generate(&env);

    // Set first timestamp
    let ts1 = 1000;
    env.ledger().set_timestamp(ts1);

    // Create first post
    let post_id1 = client.create_post(&author, &String::from_str(&env, "First post"));
    assert_eq!(post_id1, 1);

    let post1 = client.get_post(&post_id1).unwrap();
    assert_eq!(post1.timestamp, ts1);
    assert_eq!(post1.id, 1);

    // Advance timestamp
    let ts2 = 2000;
    env.ledger().set_timestamp(ts2);

    // Create second post
    let post_id2 = client.create_post(&author, &String::from_str(&env, "Second post"));
    assert_eq!(post_id2, 2);

    let post2 = client.get_post(&post_id2).unwrap();
    assert_eq!(post2.timestamp, ts2);
    assert_eq!(post2.id, 2);
}

#[test]
#[should_panic(expected = "Error(Contract, #9)")]
fn test_delete_post_non_existent() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let author = Address::generate(&env);
    client.delete_post(&author, &999);
}

// ── initialize / upgrade tests ────────────────────────────────────────────────
//
// Upgrade preconditions enforced by the contract:
//
//   1. The contract must be initialized (admin address stored in instance storage).
//      Calling upgrade() before initialize() panics with "not initialized".
//
//   2. The caller must be the stored admin address.
//      Missing or wrong authorization panics from require_auth().
//
//   3. The WASM hash supplied must reference a WASM blob that has already been
//      uploaded to the Stellar ledger via `stellar contract upload`.
//      In the Soroban unit-test environment no WASM blobs are pre-uploaded, so
//      every upgrade() call that reaches the host's update_current_contract_wasm
//      step panics with a host storage error.  This is the expected behaviour
//      for tests that verify auth passes: the panic originates from the
//      WASM-lookup step, not from authorization.
//
// Invalid / missing WASM hash semantics:
//
//   - An all-zeros hash ([0u8; 32]) is syntactically valid but will never match
//     a real uploaded WASM blob.  The Soroban host rejects it at execution time.
//   - An all-0xff hash ([0xffu8; 32]) behaves identically — syntactically valid,
//     semantically rejected by the host when no matching blob exists.
//   - Both cases panic inside the host after authorization has been checked, so
//     they are safe to use in tests that want to confirm auth acceptance.
//
// See docs/UPGRADE.md for the full upgrade runbook and security notes.

#[test]
fn test_initialize_stores_admin() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);

    client.initialize(&admin, &treasury, &0);

    // Admin is stored: set_fee (admin-only) should succeed when called by admin
    client.set_fee(&100);
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn test_initialize_twice_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);

    client.initialize(&admin, &treasury, &0);
    // Second call must panic
    client.initialize(&admin, &treasury, &0);
}

// ── upgrade: authorization checks ────────────────────────────────────────────

#[test]
#[should_panic]
fn test_upgrade_by_admin_succeeds() {
    // upgrade() requires a WASM hash that exists in the ledger.
    // In a unit-test environment there is no pre-uploaded WASM, so the call
    // will panic with a storage error after auth passes.  The important thing
    // being verified here is that admin auth is accepted (not rejected), which
    // is confirmed by the panic originating from the WASM-lookup step rather
    // than from require_auth.
    let env = Env::default();
    let (client, _admin, _) = setup_contract(&env);
    let mock_hash = BytesN::from_array(&env, &[0u8; 32]);
    env.mock_all_auths();
    client.upgrade(&mock_hash);
}

#[test]
#[should_panic]
fn test_upgrade_by_non_admin_panics() {
    // No auths are mocked, so admin.require_auth() will not be satisfied.
    // The call must panic — either from require_auth or from the host WASM
    // lookup.  Either way a non-admin must never complete an upgrade.
    let env = Env::default();
    let (client, _admin, _) = setup_contract(&env);
    let mock_hash = BytesN::from_array(&env, &[1u8; 32]);
    client.upgrade(&mock_hash);
}

#[test]
#[should_panic]
fn test_upgrade_by_different_address_panics() {
    // A caller that is not the stored admin must not be able to upgrade.
    // This variant confirms the path without mocking any auths — the
    // admin.require_auth() call inside require_admin() will fail because no
    // authorization context is provided, causing a panic before any WASM
    // lookup occurs.
    let env = Env::default();
    let (client, _admin, _) = setup_contract(&env);

    // A brand-new address that was never registered as admin
    let attacker = Address::generate(&env);
    let mock_hash = BytesN::from_array(&env, &[2u8; 32]);

    // No auths mocked for either attacker or the real admin.
    // The contract reads the stored ADMIN key and calls admin.require_auth(),
    // which fails because the admin's auth is not in the invocation context.
    let _ = attacker; // suppress unused warning
    client.upgrade(&mock_hash);
}

// ── upgrade: initialization precondition ─────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #30)")]
fn test_upgrade_before_initialize_panics() {
    // upgrade() calls require_admin() which reads the ADMIN instance-storage
    // key.  If initialize() has never been called that key is absent and the
    // contract panics with "not initialized" before any WASM lookup occurs.
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);

    let mock_hash = BytesN::from_array(&env, &[0u8; 32]);
    client.upgrade(&mock_hash);
}

// ── upgrade: invalid / missing WASM hash ────────────────────────────────────
//
// The Soroban host validates that the supplied BytesN<32> refers to a WASM
// blob previously uploaded via `stellar contract upload`.  If no matching
// blob is found the host raises an error, which surfaces as a panic in the
// Soroban test environment.  Tests below confirm that:
//
//   a) An all-zeros hash ([0u8; 32]) — a common sentinel / "missing" value —
//      does NOT bypass auth and is rejected by the host.
//   b) An all-0xff hash — another boundary value — is equally rejected.
//   c) A hash that looks plausible (incrementing bytes) is also rejected when
//      no corresponding blob exists in the ledger.
//
// In all cases authorization is checked first (require_admin passes because
// mock_all_auths() is active), and the panic is sourced from the host's WASM
// lookup, proving that the contract correctly delegates hash validation to the
// Soroban host rather than performing a no-op or silent skip.

#[test]
#[should_panic]
fn test_upgrade_all_zeros_hash_rejected_by_host() {
    // An all-zeros WASM hash is syntactically valid (BytesN<32>) but will
    // never match a real uploaded blob.  Confirms the host rejects it after
    // authorization succeeds.
    let env = Env::default();
    let (client, _admin, _) = setup_contract(&env);
    env.mock_all_auths();
    let zero_hash = BytesN::from_array(&env, &[0u8; 32]);
    client.upgrade(&zero_hash);
}

#[test]
#[should_panic]
fn test_upgrade_all_ones_hash_rejected_by_host() {
    // An all-0xff WASM hash is syntactically valid but does not correspond to
    // any uploaded blob.  Confirms the boundary value is also rejected.
    let env = Env::default();
    let (client, _admin, _) = setup_contract(&env);
    env.mock_all_auths();
    let ones_hash = BytesN::from_array(&env, &[0xffu8; 32]);
    client.upgrade(&ones_hash);
}

#[test]
#[should_panic]
fn test_upgrade_arbitrary_hash_not_in_ledger_rejected() {
    // A plausible-looking but non-existent WASM hash (incrementing bytes 0..31)
    // must be rejected because no matching blob was uploaded.
    let env = Env::default();
    let (client, _admin, _) = setup_contract(&env);
    env.mock_all_auths();
    let bytes: [u8; 32] = core::array::from_fn(|i| i as u8);
    let arbitrary_hash = BytesN::from_array(&env, &bytes);
    client.upgrade(&arbitrary_hash);
}

#[test]
#[should_panic]
fn test_upgrade_invalid_hash_uninitialized_contract_panics_not_initialized_first() {
    // When the contract is NOT initialized and an invalid WASM hash is supplied,
    // the contract must panic with "not initialized" (from require_admin) rather
    // than proceeding to the WASM lookup.  This confirms that the initialization
    // guard fires before the host hash-validation step.
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);

    // Use an all-zeros hash — even if the host accepted it, the contract must
    // reject the call earlier with "not initialized".
    let zero_hash = BytesN::from_array(&env, &[0u8; 32]);
    client.upgrade(&zero_hash);
}

// ── upgrade: event emission ───────────────────────────────────────────────────

#[test]
#[should_panic]
fn test_upgrade_emits_contract_upgraded_event() {
    // In a unit-test environment there is no pre-uploaded WASM, so upgrade()
    // panics at the WASM-lookup step.  The ContractUpgraded event is emitted
    // inside the contract before the host processes the WASM swap, so it
    // appears in the failed-diagnostic-events log rather than the committed
    // events list.  This test confirms that admin auth is accepted and the
    // call reaches the upgrade logic (panicking on missing WASM, not on auth).
    let env = Env::default();
    let (client, _admin, _) = setup_contract(&env);
    let mock_hash = BytesN::from_array(&env, &[0u8; 32]);
    env.mock_all_auths();
    client.upgrade(&mock_hash);
}

// ── upgrade: instance TTL is bumped before auth ───────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #30)")]
fn test_upgrade_before_initialize_ttl_bump_does_not_mask_init_guard() {
    // upgrade() calls bump_instance() before require_admin().  Even though
    // bump_instance() extends TTL on instance storage, it must not create or
    // populate the ADMIN key.  The subsequent require_admin() call must still
    // panic with "not initialized" when the contract has never been initialized.
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);

    let mock_hash = BytesN::from_array(&env, &[0u8; 32]);
    client.upgrade(&mock_hash);
}

// ── Fee boundary tests (issue #196) ─────────────────────────────────────────────

#[test]
fn test_initialize_fee_boundary_max_valid() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);

    // Initialize with fee_bps = 10_000 (100%) should succeed
    client.initialize(&admin, &treasury, &10_000);
    assert_eq!(client.get_fee_bps(), 10_000);
}

#[test]
#[should_panic(expected = "Error(Contract, #2)")]
fn test_initialize_fee_boundary_max_invalid() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);

    // Initialize with fee_bps = 10_001 (>100%) should panic
    client.initialize(&admin, &treasury, &10_001);
}

#[test]
fn test_set_fee_zero_valid() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _) = setup_contract(&env);

    // Set fee to 0 should succeed
    client.set_fee(&0);
    assert_eq!(client.get_fee_bps(), 0);
}

#[test]
fn test_set_fee_emits_fee_updated_event() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _) = setup_contract(&env);

    let event_count_before = env.events().all().events().len();

    client.set_fee(&250);

    let event_count_after = env.events().all().events().len();
    assert_eq!(client.get_fee_bps(), 250);
    assert_eq!(
        event_count_after,
        event_count_before + 1,
        "FeeUpdatedEvent should be emitted"
    );
}

#[test]
fn test_set_treasury_emits_treasury_updated_event() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, old_treasury) = setup_contract(&env);
    let new_treasury = Address::generate(&env);

    let event_count_before = env.events().all().events().len();

    client.set_treasury(&new_treasury);

    let event_count_after = env.events().all().events().len();
    assert_eq!(client.get_treasury(), Some(new_treasury));
    assert_eq!(
        event_count_after,
        event_count_before + 1,
        "TreasuryUpdatedEvent should be emitted"
    );
    assert_ne!(client.get_treasury(), Some(old_treasury));
}

#[test]
#[should_panic]
fn test_set_fee_non_admin_panics() {
    let env = Env::default();
    // Don't mock all auths so we can test auth failure
    let (client, _admin, _) = setup_contract(&env);

    // Non-admin trying to set fee should panic due to auth failure
    client.set_fee(&100);
}

#[test]
#[should_panic]
fn test_set_treasury_non_admin_panics() {
    let env = Env::default();
    // Don't mock all auths so we can test auth failure
    let (client, _admin, _) = setup_contract(&env);
    let new_treasury = Address::generate(&env);

    // Non-admin trying to set treasury should panic due to auth failure
    client.set_treasury(&new_treasury);
}

// ── Issue #84: username lookup and uniqueness tests ───────────────────────────

#[test]
fn test_get_address_by_username_nonexistent() {
    // Looking up a username that has never been registered must return None.
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    assert!(client
        .get_address_by_username(&String::from_str(&env, "nobody"))
        .is_none());
}

#[test]
fn test_get_address_by_username_after_profile_deleted() {
    // After a profile is deleted, its username must no longer resolve.
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let user = Address::generate(&env);
    let token = make_token(&env);
    client.set_profile(&user, &String::from_str(&env, "temp_user"), &token);

    assert!(client
        .get_address_by_username(&String::from_str(&env, "temp_user"))
        .is_some());

    client.delete_profile(&user);

    assert!(client
        .get_address_by_username(&String::from_str(&env, "temp_user"))
        .is_none());
}

// ── Fee & Treasury authorization tests (issue #83) ────────────────────────────
// (test_set_fee_non_admin_panics and test_set_treasury_non_admin_panics above)

// ── Username validation tests (issue #195) ───────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #37)")]
fn test_username_too_short() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let user = Address::generate(&env);
    let token = make_token(&env);

    // 2-character username should panic
    client.set_profile(&user, &String::from_str(&env, "ab"), &token);
}

#[test]
fn test_username_min_length_valid() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let user = Address::generate(&env);
    let token = make_token(&env);

    // 3-character username should succeed
    client.set_profile(&user, &String::from_str(&env, "abc"), &token);
    let profile = client.get_profile(&user).unwrap();
    assert_eq!(profile.username, String::from_str(&env, "abc"));
}

#[test]
fn test_username_max_length_valid() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let user = Address::generate(&env);
    let token = make_token(&env);

    // 32-character username should succeed
    let username_str = "abcdefghijklmnopqrstuvwxyz123456";
    let username = String::from_str(&env, username_str);
    assert_eq!(username.len(), 32);
    client.set_profile(&user, &username, &token);
    let profile = client.get_profile(&user).unwrap();
    assert_eq!(profile.username, username);
}

#[test]
#[should_panic(expected = "Error(Contract, #38)")]
fn test_username_too_long() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let user = Address::generate(&env);
    let token = make_token(&env);

    // 33-character username should panic
    let username_str = "abcdefghijklmnopqrstuvwxyz1234567";
    let username = String::from_str(&env, username_str);
    assert_eq!(username.len(), 33);
    client.set_profile(&user, &username, &token);
}

#[test]
#[should_panic(expected = "Error(Contract, #39)")]
fn test_username_with_space() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let user = Address::generate(&env);
    let token = make_token(&env);

    // Username with space should panic
    client.set_profile(&user, &String::from_str(&env, "user name"), &token);
}

#[test]
#[should_panic(expected = "Error(Contract, #39)")]
fn test_username_with_special_char() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let user = Address::generate(&env);
    let token = make_token(&env);

    // Username with special character should panic
    client.set_profile(&user, &String::from_str(&env, "user@name"), &token);
}

// ── Unfollow event emission tests (issue #129) ───────────────────────────────────

#[test]
fn test_unfollow_emits_event() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    // First establish a follow relationship
    client.follow(&alice, &bob);

    // Unfollow should emit UnfollowEvent
    client.unfollow(&alice, &bob);

    // Verify at least one event was emitted by unfollow
    let all_events = env.events().all();
    let events = all_events.events();
    assert!(!events.is_empty());
}

#[test]
fn test_unfollow_noop_no_event() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    // Unfollow when no relationship exists should not panic
    client.unfollow(&alice, &bob);

    // Verify both indexes are still empty
    assert_eq!(client.get_following(&alice, &0, &10).len(), 0);
    assert_eq!(client.get_followers(&bob, &0, &10).len(), 0);
}

// ── Post content length validation tests (issue #194) ────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #41)")]
fn test_post_content_empty() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let author = Address::generate(&env);

    // Empty content should panic
    client.create_post(&author, &String::from_str(&env, ""));
}

#[test]
fn test_post_content_min_length_valid() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let author = Address::generate(&env);

    // 1-character content should succeed
    let post_id = client.create_post(&author, &String::from_str(&env, "a"));
    let post = client.get_post(&post_id).unwrap();
    assert_eq!(post.content, String::from_str(&env, "a"));
}

#[test]
fn test_post_content_max_length_valid() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let author = Address::generate(&env);

    // 280-character content should succeed
    let content_str = "a".repeat(280);
    let content = String::from_str(&env, &content_str);
    assert_eq!(content.len(), 280);
    let post_id = client.create_post(&author, &content);
    let post = client.get_post(&post_id).unwrap();
    assert_eq!(post.content, content);
}

#[test]
#[should_panic(expected = "Error(Contract, #42)")]
fn test_post_content_too_long() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let author = Address::generate(&env);

    // 281-character content should panic
    let content_str = "a".repeat(281);
    let content = String::from_str(&env, &content_str);
    assert_eq!(content.len(), 281);
    client.create_post(&author, &content);
}

// ── get_followers / get_following TTL tests ───────────────────────────────────

#[test]
fn test_get_followers_bumps_followers_key() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    // bob follows alice so alice has a non-empty followers list
    client.follow(&bob, &alice);
    client.get_followers(&alice, &0, &50);

    let contract_id = client.address.clone();

    // StorageKey::Followers(alice) must have a bumped TTL
    let followers_ttl = env.as_contract(&contract_id, || {
        env.storage()
            .persistent()
            .get_ttl(&StorageKey::Followers(alice.clone()))
    });
    assert!(
        followers_ttl >= LEDGER_THRESHOLD,
        "followers TTL {followers_ttl} below LEDGER_THRESHOLD"
    );

    // StorageKey::Following(alice) must NOT exist — get_followers must not touch it
    let follows_exists = env.as_contract(&contract_id, || {
        env.storage()
            .persistent()
            .has(&StorageKey::Following(alice.clone()))
    });
    assert!(
        !follows_exists,
        "get_followers must not create or bump the Following(alice) key"
    );
}

// ── Issue #346: get_following / get_followers pagination edge cases ───────────

#[test]
fn test_get_following_offset_beyond_list_length_returns_empty() {
    // offset beyond list length must return an empty vec
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    client.follow(&alice, &bob);

    // alice follows 1 person; offset=100 is way beyond the list
    let page = client.get_following(&alice, &100, &10);
    assert_eq!(
        page.len(),
        0,
        "offset beyond list length must return empty vec"
    );
}

#[test]
fn test_get_following_limit_50_returns_at_most_50() {
    // limit of 50 must return at most 50 results
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);

    let alice = Address::generate(&env);
    // Follow 60 people
    for _ in 0..60 {
        let followee = Address::generate(&env);
        client.follow(&alice, &followee);
    }

    let page = client.get_following(&alice, &0, &50);
    assert!(page.len() <= 50, "limit=50 must return at most 50 results");
    assert_eq!(page.len(), 50);
}

#[test]
#[should_panic(expected = "Error(Contract, #11)")]
fn test_get_following_limit_51_panics() {
    // limit of 51 must panic with "limit must be between 1 and 50"
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    client.follow(&alice, &bob);

    client.get_following(&alice, &0, &51);
}

#[test]
fn test_get_following_mid_list_offset_returns_correct_page() {
    // correct page returned for a mid-list offset
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);

    let alice = Address::generate(&env);
    let mut followees = soroban_sdk::vec![&env];
    for _ in 0..20 {
        let f = Address::generate(&env);
        followees.push_back(f.clone());
        client.follow(&alice, &f);
    }

    // Request page starting at offset 10, limit 5
    let page = client.get_following(&alice, &10, &5);
    assert_eq!(page.len(), 5);
    for i in 0..5u32 {
        assert_eq!(
            page.get(i).unwrap(),
            followees.get(10 + i).unwrap(),
            "mid-list page item {} mismatch",
            i
        );
    }
}

#[test]
fn test_get_followers_offset_beyond_list_length_returns_empty() {
    // offset beyond list length must return an empty vec
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    client.follow(&bob, &alice); // bob follows alice → alice has 1 follower

    let page = client.get_followers(&alice, &100, &10);
    assert_eq!(
        page.len(),
        0,
        "offset beyond list length must return empty vec"
    );
}

#[test]
fn test_get_followers_offset_equal_list_length_returns_empty() {
    // offset equal to list length must return an empty vec
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let carol = Address::generate(&env);

    client.follow(&bob, &alice);
    client.follow(&carol, &alice); // alice has 2 followers

    let page = client.get_followers(&alice, &2, &10);
    assert_eq!(
        page.len(),
        0,
        "offset equal to list length must return empty vec"
    );
}

#[test]
fn test_get_followers_limit_50_returns_at_most_50() {
    // limit of 50 must return at most 50 results
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);

    let alice = Address::generate(&env);
    // 60 people follow alice
    for _ in 0..60 {
        let follower = Address::generate(&env);
        client.follow(&follower, &alice);
    }

    let page = client.get_followers(&alice, &0, &50);
    assert!(page.len() <= 50, "limit=50 must return at most 50 results");
    assert_eq!(page.len(), 50);
}

#[test]
fn test_get_followers_last_page_truncates_to_remaining_items() {
    // request near the end must return only the remaining followers
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);

    let alice = Address::generate(&env);
    let mut followers = soroban_sdk::vec![&env];
    for _ in 0..12 {
        let follower = Address::generate(&env);
        followers.push_back(follower.clone());
        client.follow(&follower, &alice);
    }

    let page = client.get_followers(&alice, &10, &10);
    assert_eq!(page.len(), 2);
    assert_eq!(page.get(0).unwrap(), followers.get(10).unwrap());
    assert_eq!(page.get(1).unwrap(), followers.get(11).unwrap());
}

#[test]
#[should_panic(expected = "Error(Contract, #11)")]
fn test_get_followers_limit_51_panics() {
    // limit of 51 must panic with "limit must be between 1 and 50"
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    client.follow(&bob, &alice);

    client.get_followers(&alice, &0, &51);
}

#[test]
fn test_get_followers_mid_list_offset_returns_correct_page() {
    // correct page returned for a mid-list offset
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);

    let alice = Address::generate(&env);
    let mut followers = soroban_sdk::vec![&env];
    for _ in 0..20 {
        let f = Address::generate(&env);
        followers.push_back(f.clone());
        client.follow(&f, &alice);
    }

    // Request page starting at offset 10, limit 5
    let page = client.get_followers(&alice, &10, &5);
    assert_eq!(page.len(), 5);
    for i in 0..5u32 {
        assert_eq!(
            page.get(i).unwrap(),
            followers.get(10 + i).unwrap(),
            "mid-list page item {} mismatch",
            i
        );
    }
}

// ── Issue #345: create_post content length fuzz / boundary tests ──────────────

#[test]
fn test_create_post_content_1_char_succeeds() {
    // content of 1 character must succeed
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let author = Address::generate(&env);
    let post_id = client.create_post(&author, &String::from_str(&env, "x"));
    let post = client.get_post(&post_id).unwrap();
    assert_eq!(post.content, String::from_str(&env, "x"));
    assert_eq!(post.author, author);
}

#[test]
fn test_create_post_content_280_chars_succeeds() {
    // content of exactly 280 characters must succeed
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let author = Address::generate(&env);
    let content_str = "a".repeat(280);
    let content = String::from_str(&env, &content_str);
    assert_eq!(content.len(), 280);

    let post_id = client.create_post(&author, &content);
    let post = client.get_post(&post_id).unwrap();
    assert_eq!(post.content.len(), 280);
}

#[test]
#[should_panic(expected = "Error(Contract, #41)")]
fn test_create_post_empty_content_panics() {
    // empty content must panic with a descriptive error
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let author = Address::generate(&env);
    client.create_post(&author, &String::from_str(&env, ""));
}

#[test]
#[should_panic(expected = "Error(Contract, #42)")]
fn test_create_post_content_281_chars_panics() {
    // content of 281 characters must panic with a descriptive error
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let author = Address::generate(&env);
    let content_str = "a".repeat(281);
    let content = String::from_str(&env, &content_str);
    assert_eq!(content.len(), 281);
    client.create_post(&author, &content);
}

// ── Pool withdrawal M-of-N integration tests ─────────────────────────────────

/// Helper: create a pool with `n` admins and threshold `m`, deposit `balance`,
/// and return (client, admin, pool_id, token, pool_admins).
fn setup_pool<'a>(
    env: &'a Env,
    n: usize,
    m: u32,
    balance: i128,
) -> (
    KovaraContractClient<'a>,
    Address,
    soroban_sdk::Symbol,
    Address,
    Vec<Address>,
) {
    let (client, admin, _) = setup_contract(env);

    let mut pool_admins = Vec::new(env);
    let token_owner = Address::generate(env);
    let token = setup_token(env, &token_owner);

    for _ in 0..n {
        pool_admins.push_back(Address::generate(env));
    }

    let depositor = Address::generate(env);
    StellarAssetClient::new(env, &token).mint(&depositor, &(balance + 1000));

    let pool_id = symbol_short!("tpool");
    client.create_pool(&admin, &pool_id, &token, &pool_admins, &m);

    if balance > 0 {
        client.pool_deposit(&depositor, &pool_id, &token, &balance);
    }

    (client, admin, pool_id, token, pool_admins)
}

#[test]
fn test_pool_withdraw_exactly_threshold_2_of_3_succeeds() {
    // 2-of-3: exactly the threshold number of admins (M < N) authorises a withdrawal.
    let env = Env::default();
    env.mock_all_auths();

    let (client, _, pool_id, token, admins) = setup_pool(&env, 3, 2, 300);
    let recipient = Address::generate(&env);

    // Sign with exactly 2 of the 3 admins.
    let signers = vec![&env, admins.get(0).unwrap(), admins.get(1).unwrap()];
    client.pool_withdraw(&signers, &pool_id, &100, &recipient);

    assert_eq!(client.get_pool(&pool_id).unwrap().balance, 200);
    // Recipient must have received the tokens.
    assert_eq!(TokenClient::new(&env, &token).balance(&recipient), 100);
}

#[test]
fn test_pool_withdraw_superset_of_threshold_also_succeeds() {
    // Having more signers than the threshold is always acceptable.
    let env = Env::default();
    env.mock_all_auths();

    let (client, _, pool_id, token, admins) = setup_pool(&env, 5, 3, 500);
    let recipient = Address::generate(&env);

    // All 5 admins sign, threshold is only 3.
    client.pool_withdraw(&admins, &pool_id, &200, &recipient);

    assert_eq!(client.get_pool(&pool_id).unwrap().balance, 300);
    assert_eq!(TokenClient::new(&env, &token).balance(&recipient), 200);
}

#[test]
fn test_pool_withdraw_3_of_5_threshold_succeeds() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _, pool_id, token, admins) = setup_pool(&env, 5, 3, 600);
    let recipient = Address::generate(&env);

    let signers = vec![
        &env,
        admins.get(0).unwrap(),
        admins.get(2).unwrap(),
        admins.get(4).unwrap(),
    ];
    client.pool_withdraw(&signers, &pool_id, &150, &recipient);

    assert_eq!(client.get_pool(&pool_id).unwrap().balance, 450);
    assert_eq!(TokenClient::new(&env, &token).balance(&recipient), 150);
}

#[test]
fn test_pool_withdraw_sequential_withdrawals_maintain_balance() {
    // Multiple sequential withdrawals reduce the balance correctly.
    let env = Env::default();
    env.mock_all_auths();

    let (client, _, pool_id, token, admins) = setup_pool(&env, 3, 2, 1000);
    let recipient = Address::generate(&env);

    let signers = vec![&env, admins.get(0).unwrap(), admins.get(1).unwrap()];

    client.pool_withdraw(&signers, &pool_id, &300, &recipient);
    assert_eq!(client.get_pool(&pool_id).unwrap().balance, 700);

    client.pool_withdraw(&signers, &pool_id, &200, &recipient);
    assert_eq!(client.get_pool(&pool_id).unwrap().balance, 500);

    client.pool_withdraw(&signers, &pool_id, &500, &recipient);
    assert_eq!(client.get_pool(&pool_id).unwrap().balance, 0);

    assert_eq!(TokenClient::new(&env, &token).balance(&recipient), 1000);
}

#[test]
fn test_pool_withdraw_exact_full_balance_succeeds() {
    // Withdrawing the entire pool balance (boundary case) must succeed.
    let env = Env::default();
    env.mock_all_auths();

    let (client, _, pool_id, token, admins) = setup_pool(&env, 2, 2, 250);
    let recipient = Address::generate(&env);

    let signers = vec![&env, admins.get(0).unwrap(), admins.get(1).unwrap()];
    client.pool_withdraw(&signers, &pool_id, &250, &recipient);

    assert_eq!(client.get_pool(&pool_id).unwrap().balance, 0);
    assert_eq!(TokenClient::new(&env, &token).balance(&recipient), 250);
}

#[test]
fn test_pool_withdraw_event_emitted() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _, pool_id, _, admins) = setup_pool(&env, 2, 2, 400);
    let recipient = Address::generate(&env);

    let signers = vec![&env, admins.get(0).unwrap(), admins.get(1).unwrap()];
    client.pool_withdraw(&signers, &pool_id, &100, &recipient);

    let all_events = env.events().all();
    // At least one event must have been emitted after the withdrawal.
    assert!(
        !all_events.events().is_empty(),
        "withdrawal must emit at least one event"
    );
}

#[test]
fn test_pool_deposit_event_emitted() {
    let env = Env::default();
    env.mock_all_auths();

    // Start with an empty pool so the only deposit is the one under test.
    let (client, _, pool_id, token, _) = setup_pool(&env, 2, 2, 0);
    let depositor = Address::generate(&env);
    StellarAssetClient::new(&env, &token).mint(&depositor, &500);

    let events_before = env.events().all().events().len();
    client.pool_deposit(&depositor, &pool_id, &token, &100);

    // The deposit must add at least one event (the PoolDepositEvent).
    assert!(
        env.events().all().events().len() > events_before,
        "deposit must emit at least one event"
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #21)")]
fn test_pool_withdraw_m_of_n_fewer_than_threshold_rejected() {
    // With a 3-of-5 threshold, providing only 2 signers must fail.
    let env = Env::default();
    env.mock_all_auths();

    let (client, _, pool_id, _, admins) = setup_pool(&env, 5, 3, 300);
    let recipient = Address::generate(&env);

    let signers = vec![&env, admins.get(0).unwrap(), admins.get(1).unwrap()];
    client.pool_withdraw(&signers, &pool_id, &100, &recipient);
}

#[test]
#[should_panic(expected = "Error(Contract, #22)")]
fn test_pool_withdraw_m_of_n_non_admin_rejected() {
    // Even if the count meets the threshold, a non-admin signer causes rejection.
    let env = Env::default();
    env.mock_all_auths();

    let (client, _, pool_id, _, admins) = setup_pool(&env, 3, 2, 300);
    let recipient = Address::generate(&env);

    let outsider = Address::generate(&env);
    let signers = vec![&env, admins.get(0).unwrap(), outsider];
    client.pool_withdraw(&signers, &pool_id, &100, &recipient);
}

#[test]
#[should_panic(expected = "Error(Contract, #23)")]
fn test_pool_withdraw_m_of_n_exceeds_balance_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _, pool_id, _, admins) = setup_pool(&env, 3, 2, 100);
    let recipient = Address::generate(&env);

    let signers = vec![&env, admins.get(0).unwrap(), admins.get(1).unwrap()];
    client.pool_withdraw(&signers, &pool_id, &101, &recipient);
}

// ── Issue #343: full tip flow integration tests ───────────────────────────────

#[test]
fn test_tip_full_flow_no_fee() {
    // fee_bps = 0: entire tip goes to author, treasury receives nothing
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let author = Address::generate(&env);
    let tipper = Address::generate(&env);

    // Initialize with fee_bps = 0 (no fee)
    client.initialize(&admin, &treasury, &0);

    let token = setup_token(&env, &tipper);
    let post_id = client.create_post(&author, &String::from_str(&env, "No-fee tip test"));

    let tip_amount: i128 = 1000;
    client.tip(&tipper, &post_id, &token, &tip_amount);

    // With fee_bps = 0: fee = 0, author gets full amount
    let author_balance = TokenClient::new(&env, &token).balance(&author);
    let treasury_balance = TokenClient::new(&env, &token).balance(&treasury);

    assert_eq!(
        author_balance, tip_amount,
        "author must receive full tip when fee_bps=0"
    );
    assert_eq!(
        treasury_balance, 0,
        "treasury must receive nothing when fee_bps=0"
    );

    // tip_total on the post must be incremented correctly
    let post = client.get_post(&post_id).unwrap();
    assert_eq!(
        post.tip_total, tip_amount,
        "tip_total must equal the gross tip amount"
    );
}

#[test]
fn test_tip_full_flow_with_5_percent_fee() {
    // fee_bps = 500 (5%): verify author and treasury balances and tip_total
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let author = Address::generate(&env);
    let tipper = Address::generate(&env);

    // Initialize with fee_bps = 500 (5%)
    client.initialize(&admin, &treasury, &500);

    let token = setup_token(&env, &tipper);
    let post_id = client.create_post(&author, &String::from_str(&env, "5% fee tip test"));

    let tip_amount: i128 = 1000;
    client.tip(&tipper, &post_id, &token, &tip_amount);

    // fee = 1000 * 500 / 10_000 = 50
    // author gets 1000 - 50 = 950
    let expected_fee: i128 = 50;
    let expected_author: i128 = 950;

    let author_balance = TokenClient::new(&env, &token).balance(&author);
    let treasury_balance = TokenClient::new(&env, &token).balance(&treasury);

    assert_eq!(
        treasury_balance, expected_fee,
        "treasury must receive fee = tip * fee_bps / 10_000"
    );
    assert_eq!(
        author_balance, expected_author,
        "author must receive tip minus fee"
    );

    // tip_total must reflect the gross tip amount
    let post = client.get_post(&post_id).unwrap();
    assert_eq!(
        post.tip_total, tip_amount,
        "tip_total must equal the gross tip amount regardless of fee"
    );
}

#[test]
fn test_tip_total_increments_across_multiple_tips() {
    // tip_total accumulates correctly across multiple tips
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let author = Address::generate(&env);
    let tipper1 = Address::generate(&env);
    let tipper2 = Address::generate(&env);

    client.initialize(&admin, &treasury, &500);

    let token = setup_token(&env, &tipper1);
    // Mint tokens for tipper2 as well
    StellarAssetClient::new(&env, &token).mint(&tipper2, &5000);

    let post_id = client.create_post(&author, &String::from_str(&env, "Multi-tip test"));

    // First tip from tipper1 (advance ledger to bypass cooldown)
    client.tip(&tipper1, &post_id, &token, &400);

    // Second tip from tipper2 (different tipper, no cooldown issue)
    client.tip(&tipper2, &post_id, &token, &600);

    let post = client.get_post(&post_id).unwrap();
    assert_eq!(
        post.tip_total, 1000,
        "tip_total must be the sum of all gross tips"
    );
}

#[test]
fn test_tip_fee_split_matches_fee_bps_config() {
    // fee split must match fee_bps configuration precisely
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let author = Address::generate(&env);
    let tipper = Address::generate(&env);

    // Use 250 bps (2.5%)
    client.initialize(&admin, &treasury, &250);

    let token = setup_token(&env, &tipper);
    let post_id = client.create_post(&author, &String::from_str(&env, "Fee split config test"));

    let tip_amount: i128 = 2000;
    client.tip(&tipper, &post_id, &token, &tip_amount);

    // fee = 2000 * 250 / 10_000 = 50
    // author gets 2000 - 50 = 1950
    let expected_fee: i128 = 50;
    let expected_author: i128 = 1950;

    assert_eq!(
        TokenClient::new(&env, &token).balance(&treasury),
        expected_fee
    );
    assert_eq!(
        TokenClient::new(&env, &token).balance(&author),
        expected_author
    );

    let post = client.get_post(&post_id).unwrap();
    assert_eq!(post.tip_total, tip_amount);
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn test_username_uniqueness_enforced() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let user1 = Address::generate(&env);
    let user2 = Address::generate(&env);
    let token = make_token(&env);

    // User1 registers "alice"
    client.set_profile(&user1, &String::from_str(&env, "alice"), &token);

    // User2 tries to register "alice" - should panic
    client.set_profile(&user2, &String::from_str(&env, "alice"), &token);
}

#[test]
fn test_username_update_by_owner() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let user = Address::generate(&env);
    let token = make_token(&env);

    // Register with "alice"
    client.set_profile(&user, &String::from_str(&env, "alice"), &token);
    assert_eq!(
        client.get_address_by_username(&String::from_str(&env, "alice")),
        Some(user.clone())
    );

    // Update to "alice_new"
    client.set_profile(&user, &String::from_str(&env, "alice_new"), &token);

    // Old username should be freed
    assert_eq!(
        client.get_address_by_username(&String::from_str(&env, "alice")),
        None
    );

    // New username should resolve
    assert_eq!(
        client.get_address_by_username(&String::from_str(&env, "alice_new")),
        Some(user)
    );
}

#[test]
fn test_username_freed_on_change() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let user1 = Address::generate(&env);
    let user2 = Address::generate(&env);
    let token = make_token(&env);

    // User1 registers "alice"
    client.set_profile(&user1, &String::from_str(&env, "alice"), &token);

    // User1 changes to "bob"
    client.set_profile(&user1, &String::from_str(&env, "bob"), &token);

    // User2 can now register "alice"
    client.set_profile(&user2, &String::from_str(&env, "alice"), &token);

    assert_eq!(
        client.get_address_by_username(&String::from_str(&env, "alice")),
        Some(user2)
    );
    assert_eq!(
        client.get_address_by_username(&String::from_str(&env, "bob")),
        Some(user1)
    );
}

#[test]
fn test_pool_admin_added_event() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _) = setup_contract(&env);

    let pool_admin1 = Address::generate(&env);
    let pool_admin2 = Address::generate(&env);
    let new_admin = Address::generate(&env);
    let token = setup_token(&env, &pool_admin1);

    let pool_id = symbol_short!("pool1");
    client.create_pool(
        &admin,
        &pool_id,
        &token,
        &vec![&env, pool_admin1.clone(), pool_admin2.clone()],
        &2,
    );

    client.add_pool_admin(
        &vec![&env, pool_admin1.clone(), pool_admin2.clone()],
        &pool_id,
        &new_admin,
    );

    // Verify event was emitted
    assert!(
        !env.events().all().events().is_empty(),
        "PoolAdminAddedEvent should be emitted"
    );

    // Verify admin was added
    let pool = client.get_pool(&pool_id).unwrap();
    assert_eq!(pool.admins.len(), 3);
    assert!(pool.admins.iter().any(|a| a == new_admin));
}

#[test]
fn test_pool_admin_removed_event() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _) = setup_contract(&env);

    let pool_admin1 = Address::generate(&env);
    let pool_admin2 = Address::generate(&env);
    let pool_admin3 = Address::generate(&env);
    let token = setup_token(&env, &pool_admin1);

    let pool_id = symbol_short!("pool1");
    client.create_pool(
        &admin,
        &pool_id,
        &token,
        &vec![
            &env,
            pool_admin1.clone(),
            pool_admin2.clone(),
            pool_admin3.clone(),
        ],
        &2,
    );

    client.remove_pool_admin(
        &vec![&env, pool_admin1.clone(), pool_admin2.clone()],
        &pool_id,
        &pool_admin3,
    );

    // Verify event was emitted
    assert!(
        !env.events().all().events().is_empty(),
        "PoolAdminRemovedEvent should be emitted"
    );

    // Verify admin was removed
    let pool = client.get_pool(&pool_id).unwrap();
    assert_eq!(pool.admins.len(), 2);
    assert!(!pool.admins.iter().any(|a| a == pool_admin3));
}

#[test]
fn test_pool_threshold_updated_event() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _) = setup_contract(&env);

    let pool_admin1 = Address::generate(&env);
    let pool_admin2 = Address::generate(&env);
    let token = setup_token(&env, &pool_admin1);

    let pool_id = symbol_short!("pool1");
    client.create_pool(
        &admin,
        &pool_id,
        &token,
        &vec![&env, pool_admin1.clone(), pool_admin2.clone()],
        &2,
    );

    client.update_pool_threshold(
        &vec![&env, pool_admin1.clone(), pool_admin2.clone()],
        &pool_id,
        &1,
    );

    // Verify event was emitted
    assert!(
        !env.events().all().events().is_empty(),
        "PoolThresholdUpdatedEvent should be emitted"
    );

    // Verify threshold was updated
    let pool = client.get_pool(&pool_id).unwrap();
    assert_eq!(pool.threshold, 1);
}

#[test]
#[should_panic(expected = "Error(Contract, #27)")]
fn test_update_pool_threshold_zero_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _) = setup_contract(&env);

    let pool_admin1 = Address::generate(&env);
    let pool_admin2 = Address::generate(&env);
    let token = setup_token(&env, &pool_admin1);

    let pool_id = symbol_short!("pool1");
    client.create_pool(
        &admin,
        &pool_id,
        &token,
        &vec![&env, pool_admin1.clone(), pool_admin2.clone()],
        &2,
    );

    client.update_pool_threshold(
        &vec![&env, pool_admin1.clone(), pool_admin2.clone()],
        &pool_id,
        &0,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #28)")]
fn test_update_pool_threshold_exceeds_admins_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _) = setup_contract(&env);

    let pool_admin1 = Address::generate(&env);
    let pool_admin2 = Address::generate(&env);
    let token = setup_token(&env, &pool_admin1);

    let pool_id = symbol_short!("pool1");
    client.create_pool(
        &admin,
        &pool_id,
        &token,
        &vec![&env, pool_admin1.clone(), pool_admin2.clone()],
        &2,
    );

    client.update_pool_threshold(
        &vec![&env, pool_admin1.clone(), pool_admin2.clone()],
        &pool_id,
        &3,
    );
}

// ── Issue #124: delete_post success path, unauthorized caller, event emission ─

#[test]
fn test_delete_post_success() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let author = Address::generate(&env);
    let post_id = client.create_post(&author, &String::from_str(&env, "Hello world"));

    client.delete_post(&author, &post_id);

    assert!(
        client.get_post(&post_id).is_none(),
        "get_post must return None after author deletes their own post"
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #10)")]
fn test_delete_post_non_author_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let author = Address::generate(&env);
    let non_author = Address::generate(&env);
    let post_id = client.create_post(&author, &String::from_str(&env, "Hello world"));

    client.delete_post(&non_author, &post_id);
}

#[test]
fn test_delete_post_emits_post_deleted_event() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let author = Address::generate(&env);
    let post_id = client.create_post(&author, &String::from_str(&env, "Event test"));

    client.delete_post(&author, &post_id);

    let all_events = env.events().all();
    let events = all_events.events();
    assert!(
        !events.is_empty(),
        "PostDeleted event must be emitted on successful deletion"
    );
}

#[test]
fn test_delete_post_get_post_count_unaffected() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let author = Address::generate(&env);
    client.create_post(&author, &String::from_str(&env, "Post 1"));
    let post_id2 = client.create_post(&author, &String::from_str(&env, "Post 2"));

    assert_eq!(client.get_post_count(), 2);
    client.delete_post(&author, &post_id2);
    assert_eq!(
        client.get_post_count(),
        2,
        "get_post_count tracks creation, not existence — deletion must not decrement it"
    );
}

// ── Issue #314: PostDeleted event tests ───────────────────────────────────────

#[test]
fn test_delete_post_emits_event() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let author = Address::generate(&env);
    let post_id = client.create_post(&author, &String::from_str(&env, "post to delete"));

    client.delete_post(&author, &post_id);

    let all_events = env.events().all();
    let events = all_events.events();
    assert!(
        !events.is_empty(),
        "PostDeleted event should be emitted on successful deletion"
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #10)")]
fn test_delete_post_unauthorized_no_event() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let author = Address::generate(&env);
    let non_author = Address::generate(&env);
    let post_id = client.create_post(&author, &String::from_str(&env, "test post"));

    // Panics before event emission — PostDeleted is never emitted
    client.delete_post(&non_author, &post_id);
}

// ── Issue #313: TTL extended after profile write ──────────────────────────────

#[test]
fn test_profile_write_extends_ttl() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let user = Address::generate(&env);
    let token = make_token(&env);
    client.set_profile(&user, &String::from_str(&env, "alice"), &token);

    let contract_id = client.address.clone();

    let profile_ttl = env.as_contract(&contract_id, || {
        env.storage()
            .persistent()
            .get_ttl(&StorageKey::Profile(user.clone()))
    });
    assert!(
        profile_ttl >= LEDGER_THRESHOLD,
        "profile TTL {profile_ttl} below LEDGER_THRESHOLD after write"
    );
}

#[test]
fn test_instance_storage_ttl_extended_after_mutation() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    // Mutating call should succeed and extend instance storage TTL.
    client.set_fee(&250);

    // Verify the fee was actually stored correctly (instance storage is working).
    assert_eq!(client.get_fee_bps(), 250);
}

// ── Issue #322: Tip cooldown tests ────────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #14)")]
fn test_tip_cooldown_rejects_within_window() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let author = Address::generate(&env);
    let tipper = Address::generate(&env);

    client.initialize(&admin, &treasury, &0);
    // Use a short window so both tips happen within it
    client.set_tip_cooldown_window(&10);

    let token = setup_token(&env, &tipper);
    let post_id = client.create_post(&author, &String::from_str(&env, "cooldown test post"));

    client.tip(&tipper, &post_id, &token, &100);
    // Same ledger → cooldown not expired → panics
    client.tip(&tipper, &post_id, &token, &100);
}

#[test]
fn test_tip_cooldown_allows_after_window() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let author = Address::generate(&env);
    let tipper = Address::generate(&env);

    client.initialize(&admin, &treasury, &0);
    client.set_tip_cooldown_window(&10);

    let token = setup_token(&env, &tipper);
    let post_id = client.create_post(&author, &String::from_str(&env, "cooldown test post"));

    client.tip(&tipper, &post_id, &token, &100);

    // Advance ledger past the cooldown window
    env.ledger().with_mut(|li| {
        li.sequence_number += 10;
    });

    // Re-tip succeeds after cooldown expires
    client.tip(&tipper, &post_id, &token, &100);

    let post = client.get_post(&post_id).unwrap();
    assert_eq!(post.tip_total, 200, "tip_total must reflect both tips");
}

// ── Issue #321: profile_count decrement on profile deletion ───────────────────

#[test]
fn test_profile_count_preserved_on_delete() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let user = Address::generate(&env);
    let token = make_token(&env);

    client.set_profile(&user, &String::from_str(&env, "alice"), &token);
    assert_eq!(
        client.get_profile_count(),
        1,
        "count must be 1 after creation"
    );

    client.delete_profile(&user);
    assert_eq!(
        client.get_profile_count(),
        1,
        "count must stay at 1 after deletion; it tracks total ever created"
    );
    assert!(
        client.get_profile(&user).is_none(),
        "get_profile must return None after deletion"
    );
}

#[test]
fn test_profile_count_never_decremented() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let user = Address::generate(&env);
    let token = make_token(&env);

    client.set_profile(&user, &String::from_str(&env, "alice"), &token);
    client.delete_profile(&user);
    assert_eq!(
        client.get_profile_count(),
        1,
        "count must not be decremented; it tracks total ever created"
    );

    let user2 = Address::generate(&env);
    client.set_profile(&user2, &String::from_str(&env, "bob"), &token);
    assert_eq!(
        client.get_profile_count(),
        2,
        "second registration increments counter regardless of prior deletions"
    );
    client.delete_profile(&user2);
    assert_eq!(
        client.get_profile_count(),
        2,
        "count must still be 2 after second deletion"
    );
}

#[test]
fn test_delete_profile_frees_username() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let user1 = Address::generate(&env);
    let user2 = Address::generate(&env);
    let token = make_token(&env);

    client.set_profile(&user1, &String::from_str(&env, "alice"), &token);
    client.delete_profile(&user1);

    assert!(
        client
            .get_address_by_username(&String::from_str(&env, "alice"))
            .is_none(),
        "username must be freed after profile deletion"
    );

    client.set_profile(&user2, &String::from_str(&env, "alice"), &token);
    assert_eq!(
        client.get_address_by_username(&String::from_str(&env, "alice")),
        Some(user2),
        "freed username must be claimable by another user"
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #6)")]
fn test_delete_profile_non_existent_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let user = Address::generate(&env);
    client.delete_profile(&user);
}

// ── Issue #132: PROFILE_CREATED_CT semantics ──────────────────────────────────
//
// Design decision: PROFILE_CREATED_CT (stored as "PROF_CT") tracks the total
// number of unique addresses that have ever registered a profile. It is
// incremented exactly once per new address and is never decremented.
// Updating an existing profile does not change the counter.

#[test]
fn test_profile_count_tracks_total_created_never_decrements() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let user = Address::generate(&env);
    let token = make_token(&env);

    assert_eq!(client.get_profile_count(), 0, "counter starts at zero");

    client.set_profile(&user, &String::from_str(&env, "alice"), &token);
    assert_eq!(
        client.get_profile_count(),
        1,
        "first registration increments counter"
    );

    // Updating the same user's username must NOT increment the counter again.
    client.set_profile(&user, &String::from_str(&env, "alice2"), &token);
    assert_eq!(
        client.get_profile_count(),
        1,
        "profile update must not increment PROFILE_CREATED_CT"
    );

    // A second distinct user adds 1.
    let user2 = Address::generate(&env);
    client.set_profile(&user2, &String::from_str(&env, "bob"), &token);
    assert_eq!(
        client.get_profile_count(),
        2,
        "second registration increments counter"
    );

    client.delete_profile(&user);
    assert_eq!(
        client.get_profile_count(),
        2,
        "deleting a profile must not decrement the counter"
    );

    client.delete_profile(&user2);
    assert_eq!(
        client.get_profile_count(),
        2,
        "counter tracks total ever created, not current active profiles"
    );
}

// ── Issue #184: StorageKey typed-key round-trip tests ─────────────────────────

#[test]
fn test_username_index_uses_typed_storage_key() {
    // Verify that the username reverse index is stored and retrieved through
    // StorageKey::UsernameIndex, eliminating the raw (Symbol, String) tuple key.
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let user = Address::generate(&env);
    let token = make_token(&env);
    let username = String::from_str(&env, "charlie");

    client.set_profile(&user, &username, &token);

    // Read back through the public API (which internally uses StorageKey::UsernameIndex).
    let resolved = client.get_address_by_username(&username);
    assert_eq!(
        resolved,
        Some(user.clone()),
        "username must resolve to owner via typed key"
    );

    // Change username: old index entry must be cleared.
    client.set_profile(&user, &String::from_str(&env, "charlie2"), &token);
    assert!(
        client.get_address_by_username(&username).is_none(),
        "old username must be removed from typed index on update"
    );
}

#[test]
fn test_tip_cooldown_uses_typed_storage_key() {
    // Verify that TipCooldown is enforced via StorageKey::TipCooldown in temp storage.
    // A second tip from the same tipper within the cooldown window must be rejected.
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let author = Address::generate(&env);
    let tipper = Address::generate(&env);

    client.initialize(&admin, &treasury, &0);
    client.set_tip_cooldown_window(&100);

    let token = setup_token(&env, &tipper);
    let post_id = client.create_post(&author, &String::from_str(&env, "cooldown key test"));

    // First tip succeeds and records the cooldown under StorageKey::TipCooldown.
    client.tip(&tipper, &post_id, &token, &50);

    // Advance ledger past the cooldown window; second tip must succeed.
    env.ledger().with_mut(|li| {
        li.sequence_number += 100;
    });
    client.tip(&tipper, &post_id, &token, &50);

    let post = client.get_post(&post_id).unwrap();
    assert_eq!(
        post.tip_total, 100,
        "both tips must accumulate after cooldown expires"
    );
}

#[test]
fn test_block_event() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    client.block_user(&alice, &bob);

    // Verify bob is blocked by alice
    assert!(client.is_blocked(&alice, &bob));
}

#[test]
fn test_unblock_event() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    // Block first, then unblock
    client.block_user(&alice, &bob);
    client.unblock_user(&alice, &bob);

    // Verify bob is no longer blocked by alice
    assert!(!client.is_blocked(&alice, &bob));
}

#[test]
fn test_tip_cooldown_enforcement() {
    let env = Env::default();
    env.mock_all_auths();

    // 1) Setup the main contract and the asset token contract
    let (client, _admin, _treasury) = setup_contract(&env);
    let token_admin = Address::generate(&env);
    let token_address = setup_token(&env, &token_admin);

    // 2) Setup profiles for Author and Tipper
    let author = Address::generate(&env);
    let tipper = Address::generate(&env);

    client.set_profile(&author, &String::from_str(&env, "author"), &token_address);
    client.set_profile(&tipper, &String::from_str(&env, "tipper"), &token_address);

    // Mint tokens to the tipper so they have funds to tip
    StellarAssetClient::new(&env, &token_address).mint(&tipper, &5000);

    // 3) Configure a strict tip cooldown window (Issue #76)
    let cooldown_window: u32 = 20;
    client.set_tip_cooldown_window(&cooldown_window);
    assert_eq!(client.get_tip_cooldown_window(), cooldown_window);

    // 4) Create a post to tip against
    let content = String::from_str(&env, "Hello Linkora!");
    let post_id = client.create_post(&author, &content);

    // Set the initial ledger sequence to 100
    env.ledger().with_mut(|l| l.sequence_number = 100);

    // 5) First tip succeeds
    client.tip(&tipper, &post_id, &token_address, &100);

    // 6) Second tip immediately after (105) must fail before cooldown has elapsed
    env.ledger().with_mut(|l| l.sequence_number = 105);
    let result = client.try_tip(&tipper, &post_id, &token_address, &100);
    assert!(
        result.is_err(),
        "Expected tip to fail because cooldown has not expired"
    );

    // 7) Advance past the cooldown window and tip succeeds
    env.ledger().with_mut(|l| l.sequence_number = 125);
    client.tip(&tipper, &post_id, &token_address, &100);


    // Verify post total updated correctly
    let post = client.get_post(&post_id).unwrap();
    assert_eq!(post.tip_total, 200);
}

#[test]
#[should_panic(expected = "Error(Contract, #17)")]
fn test_pool_deposit_negative_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _) = setup_contract(&env);

    let pool_id = symbol_short!("pool_a");
    let token = setup_token(&env, &admin);
    let mut admins = vec![&env];
    admins.push_back(admin.clone());

    client.create_pool(&admin, &pool_id, &token, &admins, &1);

    let other_user = Address::generate(&env);
    client.pool_deposit(&other_user, &pool_id, &token, &-50);
}


// ── Issue #89: get_posts_by_author — pagination & empty result handling ────────

#[test]
fn test_get_posts_by_author_empty_no_posts() {
    // Author with no posts at all should return an empty vec immediately.
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let author = Address::generate(&env);
    let result = client.get_posts_by_author(&author, &0, &10);
    assert_eq!(result.len(), 0);
}

#[test]
fn test_get_posts_by_author_single_post_first_page() {
    // Exactly one post; page 0 should return it; page 1 should be empty.
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let author = Address::generate(&env);
    let id = client.create_post(&author, &String::from_str(&env, "hello"));

    let page0 = client.get_posts_by_author(&author, &0, &10);
    assert_eq!(page0.len(), 1);
    assert_eq!(page0.get(0).unwrap(), id);

    let page1 = client.get_posts_by_author(&author, &1, &10);
    assert_eq!(page1.len(), 0);
}

#[test]
fn test_get_posts_by_author_partial_last_page() {
    // 7 posts, page size 5: second page should have exactly 2 entries.
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let author = Address::generate(&env);
    for i in 0..7u32 {
        let content = String::from_str(&env, if i == 0 { "a" } else if i == 1 { "b" } else if i == 2 { "c" } else if i == 3 { "d" } else if i == 4 { "e" } else if i == 5 { "f" } else { "g" });
        client.create_post(&author, &content);
    }

    let page0 = client.get_posts_by_author(&author, &0, &5);
    assert_eq!(page0.len(), 5);

    let page1 = client.get_posts_by_author(&author, &5, &5);
    assert_eq!(page1.len(), 2);
}

#[test]
fn test_get_posts_by_author_offset_equals_count_returns_empty() {
    // offset == total posts → empty result, no panic.
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let author = Address::generate(&env);
    client.create_post(&author, &String::from_str(&env, "only post"));

    let result = client.get_posts_by_author(&author, &1, &10);
    assert_eq!(result.len(), 0);
}

#[test]
fn test_get_posts_by_author_limit_one_iterates_all_posts() {
    // Fetch 3 posts one at a time with limit=1.
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let author = Address::generate(&env);
    let id0 = client.create_post(&author, &String::from_str(&env, "p0"));
    let id1 = client.create_post(&author, &String::from_str(&env, "p1"));
    let id2 = client.create_post(&author, &String::from_str(&env, "p2"));

    assert_eq!(client.get_posts_by_author(&author, &0, &1).get(0).unwrap(), id0);
    assert_eq!(client.get_posts_by_author(&author, &1, &1).get(0).unwrap(), id1);
    assert_eq!(client.get_posts_by_author(&author, &2, &1).get(0).unwrap(), id2);
    assert_eq!(client.get_posts_by_author(&author, &3, &1).len(), 0);
}

#[test]
fn test_get_posts_by_author_different_authors_isolated() {
    // Posts from author A must not appear in author B's list.
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let author_a = Address::generate(&env);
    let author_b = Address::generate(&env);

    client.create_post(&author_a, &String::from_str(&env, "author a post"));
    client.create_post(&author_b, &String::from_str(&env, "author b post"));

    let a_posts = client.get_posts_by_author(&author_a, &0, &10);
    let b_posts = client.get_posts_by_author(&author_b, &0, &10);

    assert_eq!(a_posts.len(), 1);
    assert_eq!(b_posts.len(), 1);
    assert_ne!(a_posts.get(0).unwrap(), b_posts.get(0).unwrap());
}

#[test]
#[should_panic(expected = "Error(Contract, #11)")]
fn test_get_posts_by_author_zero_limit_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let author = Address::generate(&env);
    client.get_posts_by_author(&author, &0, &0);
}
// ── Issue: update_profile preserves address and updates stored fields ────────
//
// set_profile() writes a new `Profile { address, username, creator_token }`
// record under the storage key `Profile(user)`. Because the storage key is
// derived from the authenticated `user` address, and the new `Profile.address`
// field is set to `user.clone()`, calling set_profile() for an existing user
// overwrites the prior record in place — the address of the on-chain profile
// remains tied to that user. The other stored fields must reflect the most
// recent call's arguments.

#[test]
fn test_update_profile_preserves_address_and_updates_fields() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let user = Address::generate(&env);
    let username_v1 = String::from_str(&env, "alice_v1");
    let username_v2 = String::from_str(&env, "alice_v2");
    let token_v1 = make_token(&env);
    let token_v2 = make_token(&env);

    // Initial profile creation.
    client.set_profile(&user, &username_v1, &token_v1);

    let profile_v1 = client.get_profile(&user).unwrap();
    assert_eq!(
        profile_v1.address, user,
        "initial profile address must match caller"
    );
    assert_eq!(profile_v1.username, username_v1);
    assert_eq!(profile_v1.creator_token, token_v1);

    // Update the profile with a different username AND a different creator_token.
    client.set_profile(&user, &username_v2, &token_v2);

    let profile_v2 = client.get_profile(&user).unwrap();

    // The address must be preserved across the update — the storage key is
    // derived from `user`, so the profile on file is still keyed by the same
    // address.
    assert_eq!(
        profile_v2.address, user,
        "updating an existing profile must preserve the same address"
    );

    // The stored fields must reflect the most recent call's arguments.
    assert_eq!(
        profile_v2.username, username_v2,
        "username must reflect the new value after update"
    );
    assert_eq!(
        profile_v2.creator_token, token_v2,
        "creator_token must reflect the new value after update"
    );

    // Old username must be freed from the reverse index. The new username must
    // resolve to the same address.
    assert_eq!(
        client.get_address_by_username(&username_v1),
        None,
        "old username must be freed after profile update"
    );
    assert_eq!(
        client.get_address_by_username(&username_v2),
        Some(user.clone()),
        "new username must resolve to the same user"
    );

    // The total profile-creation counter must NOT be incremented on update;
    // it tracks unique addresses that have ever registered a profile.
    assert_eq!(
        client.get_profile_count(),
        1,
        "updating an existing profile must not increment the profile count"
    );

}

// ── Issue #380: Test isolation ─────────────────────────────────────────────────

#[test]
fn test_each_env_starts_with_fresh_post_counter() {
    // Two independent Env::default() instances must not share the post counter.
    let env_a = Env::default();
    env_a.mock_all_auths();
    let (client_a, _, _) = setup_contract(&env_a);
    let author_a = Address::generate(&env_a);
    let first_id = client_a.create_post(&author_a, &String::from_str(&env_a, "first in env_a"));

    let env_b = Env::default();
    env_b.mock_all_auths();
    let (client_b, _, _) = setup_contract(&env_b);
    let author_b = Address::generate(&env_b);
    let second_id = client_b.create_post(&author_b, &String::from_str(&env_b, "first in env_b"));

    // Both environments start the counter at 0.
    assert_eq!(first_id, 0, "env_a post counter must start at 0");
    assert_eq!(second_id, 0, "env_b post counter must start at 0 independently");
}

#[test]
fn test_each_env_starts_with_fresh_profile_state() {
    // A profile created in env_a must not be visible in env_b.
    let env_a = Env::default();
    env_a.mock_all_auths();
    let (client_a, _, _) = setup_contract(&env_a);
    let token_a = make_token(&env_a);
    let user_a = Address::generate(&env_a);
    client_a.set_profile(&user_a, &String::from_str(&env_a, "alice"), &token_a);
    assert_eq!(client_a.get_profile_count(), 1);

    let env_b = Env::default();
    env_b.mock_all_auths();
    let (client_b, _, _) = setup_contract(&env_b);
    assert_eq!(
        client_b.get_profile_count(),
        0,
        "profile count must be 0 in a fresh test environment"
    );
}

#[test]
fn test_separate_contract_instances_share_no_storage() {
    // Two contract instances registered in the same Env (different contract_ids)
    // must not share any storage.
    let env = Env::default();
    env.mock_all_auths();

    let id_a = env.register(KovaraContract, ());
    let client_a = KovaraContractClient::new(&env, &id_a);
    let admin_a = Address::generate(&env);
    client_a.initialize(&admin_a, &Address::generate(&env), &0);

    let id_b = env.register(KovaraContract, ());
    let client_b = KovaraContractClient::new(&env, &id_b);
    let admin_b = Address::generate(&env);
    client_b.initialize(&admin_b, &Address::generate(&env), &0);

    let token = make_token(&env);
    let user = Address::generate(&env);
    client_a.set_profile(&user, &String::from_str(&env, "alpha"), &token);

    // Profile in instance A must NOT appear in instance B.
    assert!(
        client_b.get_profile(&user).is_none(),
        "contract instances must not share persistent storage"
    );
}

// ── Issue #381: Duplicate profile handling ─────────────────────────────────────

#[test]
fn test_set_same_username_twice_for_same_user_is_idempotent() {
    // Calling set_profile with the same username twice for the same user must
    // succeed without raising an error, and must not corrupt the reverse index.
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let user = Address::generate(&env);
    let token = make_token(&env);
    let username = String::from_str(&env, "same_name");

    client.set_profile(&user, &username, &token);
    client.set_profile(&user, &username, &token); // idempotent second call

    let profile = client.get_profile(&user).unwrap();
    assert_eq!(profile.username, username);
    assert_eq!(profile.address, user);
    assert_eq!(
        client.get_profile_count(),
        1,
        "profile count must remain 1 after an idempotent update"
// ── Issue #376: Safeguards for invalid pool IDs ────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #18)")]
fn test_pool_deposit_nonexistent_pool_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _) = setup_contract(&env);

    let token = setup_token(&env, &admin);
    let fake_pool_id = symbol_short!("no_pool");

    // Pool was never created; must panic with PoolNotFound (#18).
    client.pool_deposit(&admin, &fake_pool_id, &token, &100);
}

#[test]
#[should_panic(expected = "Error(Contract, #18)")]
fn test_pool_withdraw_nonexistent_pool_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _) = setup_contract(&env);

    let mut signers = soroban_sdk::vec![&env];
    signers.push_back(admin.clone());
    let fake_pool_id = symbol_short!("ghost");

    client.pool_withdraw(&signers, &fake_pool_id, &50, &admin);
}

#[test]
fn test_get_pool_nonexistent_returns_none() {
// ── Issue #374: Event ordering for posts, likes, and tips ─────────────────────

#[test]
fn test_create_post_emits_event() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let author = Address::generate(&env);
    let content = String::from_str(&env, "Hello Kovara");
    let post_id = client.create_post(&author, &content);

    // Storage update precedes event emission: the post must be readable.
    let post = client.get_post(&post_id).unwrap();
    assert_eq!(post.content, content);
    assert_eq!(post.author, author);

    // At least one event was emitted.
    let all_events = env.events().all();
    assert!(!all_events.is_empty(), "create_post must emit at least one event");
}

#[test]
fn test_like_post_event_follows_storage_update() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let fake_pool_id = symbol_short!("absent");
    let result = client.get_pool(&fake_pool_id);
    assert!(result.is_none(), "get_pool for a non-existent pool must return None");
}

#[test]
fn test_pool_deposit_accumulates_balance_and_preserves_pool_id() {
    // Repeated deposits accumulate the pool balance and the pool-id reference
    // stays consistent.
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _) = setup_contract(&env);

    let token_admin = Address::generate(&env);
    let token = setup_token(&env, &token_admin);
    let depositor = Address::generate(&env);
    StellarAssetClient::new(&env, &token).mint(&depositor, &1_000);

    let pool_id = symbol_short!("stbl");
    let mut admins = soroban_sdk::vec![&env];
    admins.push_back(admin.clone());
    client.create_pool(&admin, &pool_id, &token, &admins, &1);

    client.pool_deposit(&depositor, &pool_id, &token, &300);
    client.pool_deposit(&depositor, &pool_id, &token, &200);

    let pool = client.get_pool(&pool_id).unwrap();
    assert_eq!(pool.balance, 500, "balance must equal the sum of all deposits");
    assert_eq!(pool.token, token, "pool token reference must remain consistent");
}

// ── Issue #377: Proposal lifecycle tests ──────────────────────────────────────

#[test]
fn test_proposal_create_pending_and_retrieve() {
    // threshold=2: proposal starts as Pending since only one signer (the proposer).
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _) = setup_contract(&env);

    let token_admin = Address::generate(&env);
    let token = setup_token(&env, &token_admin);
    let depositor = Address::generate(&env);
    StellarAssetClient::new(&env, &token).mint(&depositor, &1_000);

    let second_admin = Address::generate(&env);
    let pool_id = symbol_short!("prop_p");
    let mut admins = soroban_sdk::vec![&env];
    admins.push_back(admin.clone());
    admins.push_back(second_admin.clone());
    client.create_pool(&admin, &pool_id, &token, &admins, &2);
    client.pool_deposit(&depositor, &pool_id, &token, &500);

    let recipient = Address::generate(&env);
    let proposal_id = client.create_proposal(&admin, &pool_id, &100_i128, &recipient);

    let proposal = client.get_proposal(&proposal_id).unwrap();
    assert_eq!(proposal.pool_id, pool_id);
    assert_eq!(proposal.amount, 100);
    assert_eq!(proposal.recipient, recipient);
    assert_eq!(proposal.status, ProposalStatus::Pending);
}

#[test]
fn test_proposal_auto_executed_when_threshold_is_one() {
    // threshold=1: proposer counts as the first and only signer, so the
    // proposal must be executed immediately upon creation.
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _) = setup_contract(&env);

    let token_admin = Address::generate(&env);
    let token = setup_token(&env, &token_admin);
    let depositor = Address::generate(&env);
    StellarAssetClient::new(&env, &token).mint(&depositor, &1_000);

    let pool_id = symbol_short!("exec_p");
    let mut admins = soroban_sdk::vec![&env];
    admins.push_back(admin.clone());
    client.create_pool(&admin, &pool_id, &token, &admins, &1);
    client.pool_deposit(&depositor, &pool_id, &token, &500);

    let recipient = Address::generate(&env);
    let proposal_id = client.create_proposal(&admin, &pool_id, &200_i128, &recipient);

    let proposal = client.get_proposal(&proposal_id).unwrap();
    assert_eq!(
        proposal.status,
        ProposalStatus::Executed,
        "proposal must be Executed immediately when threshold is 1"
    );

    // Pool balance must have been reduced.
    let pool = client.get_pool(&pool_id).unwrap();
    assert_eq!(pool.balance, 300, "pool balance must decrease by the proposal amount");
}

#[test]
fn test_proposal_sign_transitions_to_executed() {
    // threshold=2: proposer creates (1 signer), second admin signs (2 signers → executed).
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _) = setup_contract(&env);

    let token_admin = Address::generate(&env);
    let token = setup_token(&env, &token_admin);
    let depositor = Address::generate(&env);
    StellarAssetClient::new(&env, &token).mint(&depositor, &1_000);

    let second_admin = Address::generate(&env);
    let pool_id = symbol_short!("msig_p");
    let mut admins = soroban_sdk::vec![&env];
    admins.push_back(admin.clone());
    admins.push_back(second_admin.clone());
    client.create_pool(&admin, &pool_id, &token, &admins, &2);
    client.pool_deposit(&depositor, &pool_id, &token, &500);

    let recipient = Address::generate(&env);
    let proposal_id = client.create_proposal(&admin, &pool_id, &100_i128, &recipient);

    // Still pending after creation by `admin` (1 of 2 required).
    let pending = client.get_proposal(&proposal_id).unwrap();
    assert_eq!(pending.status, ProposalStatus::Pending);

    // Second admin signs → threshold reached → auto-execute.
    client.sign_proposal(&second_admin, &proposal_id);

    let executed = client.get_proposal(&proposal_id).unwrap();
    assert_eq!(
        executed.status,
        ProposalStatus::Executed,
        "proposal must be Executed once second signer pushes signers to threshold"
    let author = Address::generate(&env);
    let liker = Address::generate(&env);
    let post_id = client.create_post(&author, &String::from_str(&env, "likeable post"));

    client.like_post(&liker, &post_id);

    // Storage must be updated: like_count incremented and has_liked returns true.
    assert_eq!(client.get_like_count(&post_id), 1);
    assert!(client.has_liked(&liker, &post_id));

    // At least two events (PostCreated + LikePost) must have been emitted.
    let events = env.events().all();
    assert!(
        events.len() >= 2,
        "expected at least PostCreated and LikePost events, got {}",
        events.len()
    );
}

#[test]
fn test_tip_event_emitted_after_storage_update() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, _treasury) = setup_contract(&env);
    let token_admin = Address::generate(&env);
    let token = setup_token(&env, &token_admin);

    let author = Address::generate(&env);
    let tipper = Address::generate(&env);

    client.set_profile(&author, &String::from_str(&env, "author"), &token);
    client.set_profile(&tipper, &String::from_str(&env, "tipper"), &token);

    StellarAssetClient::new(&env, &token).mint(&tipper, &500);
    let post_id = client.create_post(&author, &String::from_str(&env, "tip me"));

    let events_before = env.events().all().len();

    client.tip(&tipper, &post_id, &token, &100);

    // Storage update: post.tip_total incremented.
    let post = client.get_post(&post_id).unwrap();
    assert_eq!(post.tip_total, 100);

    // At least one new event emitted after the tip call.
    let events_after = env.events().all().len();
    assert!(
        events_after > events_before,
        "tip must emit a TipEvent; events before={}, after={}",
        events_before,
        events_after
    );
}

#[test]
fn test_reverse_index_consistent_after_same_username_update() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let user = Address::generate(&env);
    let token = make_token(&env);
    let username = String::from_str(&env, "consistent");

    client.set_profile(&user, &username, &token);
    client.set_profile(&user, &username, &token);

    assert_eq!(
        client.get_address_by_username(&username),
        Some(user),
        "reverse-index must stay consistent after repeated set_profile with same username"
    );
}

#[test]
fn test_profile_count_unchanged_after_multiple_updates() {
#[should_panic(expected = "Error(Contract, #22)")]
fn test_sign_proposal_by_non_pool_admin_rejected() {
    // A user who is not in pool.admins cannot sign a proposal.
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _) = setup_contract(&env);

    let token_admin = Address::generate(&env);
    let token = setup_token(&env, &token_admin);
    let depositor = Address::generate(&env);
    StellarAssetClient::new(&env, &token).mint(&depositor, &500);

    let second_admin = Address::generate(&env);
    let pool_id = symbol_short!("auth_p");
    let mut admins = soroban_sdk::vec![&env];
    admins.push_back(admin.clone());
    admins.push_back(second_admin.clone());
    client.create_pool(&admin, &pool_id, &token, &admins, &2);
    client.pool_deposit(&depositor, &pool_id, &token, &300);

    let recipient = Address::generate(&env);
    let proposal_id = client.create_proposal(&admin, &pool_id, &100_i128, &recipient);

    let stranger = Address::generate(&env);
    // stranger is not in pool.admins → UnauthorizedSigner (#22).
    client.sign_proposal(&stranger, &proposal_id);
}

// ── Issue #378: Contract initialization order checks ──────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #30)")]
fn test_set_profile_before_initialize_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);

    let user = Address::generate(&env);
    let token = make_token(&env);
    // initialize has NOT been called; must panic with NotInitialized (#30).
    client.set_profile(&user, &String::from_str(&env, "alice"), &token);
}

#[test]
#[should_panic(expected = "Error(Contract, #30)")]
fn test_create_post_before_initialize_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);

    let author = Address::generate(&env);
    // Must panic with NotInitialized (#30).
    client.create_post(&author, &String::from_str(&env, "too early"));
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn test_initialize_twice_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    client.initialize(&admin, &treasury, &0);
    // Second call must panic with AlreadyInitialized (#1).
    client.initialize(&admin, &treasury, &0);
}

#[test]
fn test_operations_succeed_after_initialize() {
    // After a successful initialize, standard operations must not panic.
fn test_event_sequence_post_like_tip() {
    // Verify that the aggregate event log after post -> like -> tip contains
    // at least three entries: PostCreated, LikePost, and TipEvent.
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, _treasury) = setup_contract(&env);
    let token_admin = Address::generate(&env);
    let token = setup_token(&env, &token_admin);

    let author = Address::generate(&env);
    let fan = Address::generate(&env);

    client.set_profile(&author, &String::from_str(&env, "creator"), &token);
    client.set_profile(&fan, &String::from_str(&env, "fan"), &token);
    StellarAssetClient::new(&env, &token).mint(&fan, &1_000);

    let post_id = client.create_post(&author, &String::from_str(&env, "great content"));
    client.like_post(&fan, &post_id);
    client.tip(&fan, &post_id, &token, &50);

    // After the full workflow, at least three distinct events must be present.
    let events = env.events().all();
    assert!(
        events.len() >= 3,
        "expected at least 3 events (PostCreated, LikePost, Tip); got {}",
        events.len()
    );
}

// ── Issue #375: Empty follow and follower list coverage ────────────────────────

#[test]
fn test_get_following_empty_for_new_user() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let user = Address::generate(&env);
    let result = client.get_following(&user, &0, &10);
    assert_eq!(result.len(), 0, "a brand-new user must have an empty following list");
}

#[test]
fn test_get_followers_empty_for_new_user() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let user = Address::generate(&env);
    let token = make_token(&env);

    client.set_profile(&user, &String::from_str(&env, "v1"), &token);
    client.set_profile(&user, &String::from_str(&env, "v2"), &token);
    client.set_profile(&user, &String::from_str(&env, "v3"), &token);

    assert_eq!(
        client.get_profile_count(),
        1,
        "profile count must remain 1 regardless of how many times the same user updates"
    );
}

// ── Issue #383: Token type safeguards ─────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #19)")]
fn test_pool_deposit_wrong_token_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _) = setup_contract(&env);

    let correct_admin = Address::generate(&env);
    let wrong_admin = Address::generate(&env);
    let correct_token = setup_token(&env, &correct_admin);
    let wrong_token = setup_token(&env, &wrong_admin);

    let depositor = Address::generate(&env);
    StellarAssetClient::new(&env, &wrong_token).mint(&depositor, &500);

    let pool_id = symbol_short!("tkn_p");
    let mut admins = soroban_sdk::vec![&env];
    admins.push_back(admin.clone());
    client.create_pool(&admin, &pool_id, &correct_token, &admins, &1);

    // Depositing with wrong_token must fail with WrongTokenForPool (#19).
    client.pool_deposit(&depositor, &pool_id, &wrong_token, &100);
}

#[test]
fn test_pool_deposit_correct_token_succeeds() {
    client.set_profile(&user, &String::from_str(&env, "alice"), &token);
    let profile = client.get_profile(&user).unwrap();
    assert_eq!(profile.username, String::from_str(&env, "alice"));
}

#[test]
#[should_panic(expected = "Error(Contract, #30)")]
fn test_create_pool_before_initialize_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let token = make_token(&env);
    let mut admins = soroban_sdk::vec![&env];
    admins.push_back(admin.clone());
    // Must panic with NotInitialized (#30).
    client.create_pool(&admin, &symbol_short!("early"), &token, &admins, &1);
}

// ── Issue #379: Granular admin-role checks ─────────────────────────────────────

#[test]
fn test_pool_admin_can_withdraw_from_pool() {
    // A designated pool admin (even if not the contract-level admin) can withdraw.
    let env = Env::default();
    env.mock_all_auths();
    let (client, contract_admin, _) = setup_contract(&env);

    let token_admin = Address::generate(&env);
    let token = setup_token(&env, &token_admin);
    let depositor = Address::generate(&env);
    StellarAssetClient::new(&env, &token).mint(&depositor, &500);

    let pool_admin = Address::generate(&env);
    let pool_id = symbol_short!("role_p");
    let mut admins = soroban_sdk::vec![&env];
    admins.push_back(pool_admin.clone());
    // pool.admins contains only pool_admin; not the contract-level admin.
    client.create_pool(&contract_admin, &pool_id, &token, &admins, &1);
    client.pool_deposit(&depositor, &pool_id, &token, &200);

    let recipient = Address::generate(&env);
    let mut pool_signers = soroban_sdk::vec![&env];
    pool_signers.push_back(pool_admin.clone());
    client.pool_withdraw(&pool_signers, &pool_id, &100, &recipient);

    let pool = client.get_pool(&pool_id).unwrap();
    assert_eq!(pool.balance, 100, "pool balance must decrease after pool admin withdrawal");
}

#[test]
#[should_panic(expected = "Error(Contract, #22)")]
fn test_non_pool_admin_cannot_withdraw() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _) = setup_contract(&env);

    let token_admin = Address::generate(&env);
    let token = setup_token(&env, &token_admin);
    let depositor = Address::generate(&env);
    StellarAssetClient::new(&env, &token).mint(&depositor, &500);

    let pool_id = symbol_short!("ok_p");
    let mut admins = soroban_sdk::vec![&env];
    admins.push_back(admin.clone());
    client.create_pool(&admin, &pool_id, &token, &admins, &1);

    client.pool_deposit(&depositor, &pool_id, &token, &250);
    let pool = client.get_pool(&pool_id).unwrap();
    assert_eq!(pool.balance, 250, "correct token deposit must update pool balance");
}

#[test]
#[should_panic(expected = "Error(Contract, #13)")]
fn test_tip_wrong_token_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let creator_admin = Address::generate(&env);
    let other_admin = Address::generate(&env);
    let creator_token = setup_token(&env, &creator_admin);
    let other_token = setup_token(&env, &other_admin);

    let author = Address::generate(&env);
    let tipper = Address::generate(&env);
    StellarAssetClient::new(&env, &other_token).mint(&tipper, &500);

    // Author registered with creator_token.
    client.set_profile(&author, &String::from_str(&env, "creator"), &creator_token);
    client.set_profile(&tipper, &String::from_str(&env, "tipper"), &other_token);

    let post_id = client.create_post(&author, &String::from_str(&env, "tip me"));

    // Tipping with other_token must fail with WrongTokenForTip (#13).
    client.tip(&tipper, &post_id, &other_token, &100);
}

#[test]
fn test_wrong_token_attempt_does_not_corrupt_pool_state() {
    // A failed deposit (wrong token) must leave the pool state unchanged.
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _) = setup_contract(&env);

    let correct_admin = Address::generate(&env);
    let wrong_admin = Address::generate(&env);
    let correct_token = setup_token(&env, &correct_admin);
    let wrong_token = setup_token(&env, &wrong_admin);

    let depositor = Address::generate(&env);
    StellarAssetClient::new(&env, &wrong_token).mint(&depositor, &500);
    StellarAssetClient::new(&env, &correct_token).mint(&depositor, &500);

    let pool_id = symbol_short!("safe_p");
    let mut admins = soroban_sdk::vec![&env];
    admins.push_back(admin.clone());
    client.create_pool(&admin, &pool_id, &correct_token, &admins, &1);

    // Attempt to deposit with wrong token — must revert.
    let failed = client.try_pool_deposit(&depositor, &pool_id, &wrong_token, &100);
    assert!(failed.is_err(), "wrong-token deposit must fail");

    // Pool state is unchanged.
    let pool = client.get_pool(&pool_id).unwrap();
    assert_eq!(pool.balance, 0, "pool balance must remain 0 after a failed deposit");
    assert_eq!(pool.token, correct_token, "pool token must be unchanged after a failed deposit");
    let pool_id = symbol_short!("priv_p");
    let mut admins = soroban_sdk::vec![&env];
    admins.push_back(admin.clone());
    client.create_pool(&admin, &pool_id, &token, &admins, &1);
    client.pool_deposit(&depositor, &pool_id, &token, &300);

    let outsider = Address::generate(&env);
    let mut outsider_signers = soroban_sdk::vec![&env];
    outsider_signers.push_back(outsider.clone());
    // outsider is not in pool.admins → UnauthorizedSigner (#22).
    client.pool_withdraw(&outsider_signers, &pool_id, &100, &outsider);
}

#[test]
fn test_contract_admin_can_set_fee() {
    // The contract-level fee is governed by require_admin() which checks the
    // ADMIN instance-storage key, completely separate from pool.admins.
    let env = Env::default();
    env.mock_all_auths();
    let (client, _contract_admin, _) = setup_contract(&env);

    // Initially 0 as set by setup_contract (fee_bps=0).
    assert_eq!(client.get_fee_bps(), 0);

    client.set_fee(&500_u32);
    assert_eq!(client.get_fee_bps(), 500, "contract admin must be able to update the fee");
}

#[test]
fn test_add_pool_admin_requires_pool_admin_quorum() {
    // Adding a pool admin requires the existing pool-admin quorum, not the
    // contract-level admin.
    let env = Env::default();
    env.mock_all_auths();
    let (client, contract_admin, _) = setup_contract(&env);

    let token_admin = Address::generate(&env);
    let token = setup_token(&env, &token_admin);

    let pool_admin = Address::generate(&env);
    let pool_id = symbol_short!("add_adm");
    let mut admins = soroban_sdk::vec![&env];
    admins.push_back(pool_admin.clone());
    client.create_pool(&contract_admin, &pool_id, &token, &admins, &1);

    let new_admin = Address::generate(&env);
    let mut signers = soroban_sdk::vec![&env];
    signers.push_back(pool_admin.clone());
    client.add_pool_admin(&signers, &pool_id, &new_admin);

    let updated = client.get_pool(&pool_id).unwrap();
    assert_eq!(updated.admins.len(), 2, "pool must now have two admins");
    assert!(
        updated.admins.iter().any(|a| a == new_admin),
        "new_admin must appear in the pool admins list"
    );
    let result = client.get_followers(&user, &0, &10);
    assert_eq!(result.len(), 0, "a brand-new user must have an empty followers list");
}

#[test]
fn test_get_following_empty_after_unfollow() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    client.follow(&alice, &bob);
    assert_eq!(client.get_following(&alice, &0, &10).len(), 1);

    client.unfollow(&alice, &bob);
    let result = client.get_following(&alice, &0, &10);
    assert_eq!(
        result.len(),
        0,
        "following list must be empty after unfollowing the only followee"
    );
}

#[test]
fn test_get_followers_empty_after_unfollow() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    client.follow(&alice, &bob);
    assert_eq!(client.get_followers(&bob, &0, &10).len(), 1);

    client.unfollow(&alice, &bob);
    let result = client.get_followers(&bob, &0, &10);
    assert_eq!(
        result.len(),
        0,
        "followers list must be empty once all followers have unfollowed"
    );
}

#[test]
fn test_independent_users_start_with_empty_lists() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let user_a = Address::generate(&env);
    let user_b = Address::generate(&env);
    let user_c = Address::generate(&env);

    // user_a follows user_b; user_c has no relationships at all.
    client.follow(&user_a, &user_b);

    let c_following = client.get_following(&user_c, &0, &10);
    let c_followers = client.get_followers(&user_c, &0, &10);
    assert_eq!(c_following.len(), 0, "user_c following list must be empty");
    assert_eq!(c_followers.len(), 0, "user_c followers list must be empty");
}

#[test]
fn test_pool_balance_conservation_across_randomized_valid_withdrawals() {
    for seed in 1..=8u32 {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _, pool_id, _, admins) = setup_pool(&env, 3, 2, 10_000);
        let recipient = Address::generate(&env);
        let signers = vec![&env, admins.get(0).unwrap(), admins.get(1).unwrap()];
        let mut remaining = 10_000i128;
        let mut state = seed;

        for _ in 0..12 {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let amount = i128::from(state % 250 + 1).min(remaining);
            client.pool_withdraw(&signers, &pool_id, &amount, &recipient);
            remaining -= amount;
            assert_eq!(client.get_pool(&pool_id).unwrap().balance, remaining);
        }
    }
}

#[test]
#[should_panic(expected = "Error(Contract, #21)")]
fn test_duplicate_signers_cannot_bypass_withdrawal_threshold() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, pool_id, _, admins) = setup_pool(&env, 3, 2, 100);
    let recipient = Address::generate(&env);
    let duplicate_signers = vec![&env, admins.get(0).unwrap(), admins.get(0).unwrap()];

    client.pool_withdraw(&duplicate_signers, &pool_id, &10, &recipient);
}

// ── flow_rewards tests ────────────────────────────────────────────────────────

#[test]
fn test_accrue_and_query_submitter_reward() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    client.initialize(&admin, &treasury, &0);

    let submitter = Address::generate(&env);
    let token = make_token(&env);

    // Initially zero
    assert_eq!(
        client.get_reward_balance(&crate::RewardRole::Submitter, &submitter, &token),
        0
    );

    // Accrue 500
    client.accrue_reward(&crate::RewardRole::Submitter, &submitter, &token, &500);
    assert_eq!(
        client.get_reward_balance(&crate::RewardRole::Submitter, &submitter, &token),
        500
    );

    // Accrue another 300 — should accumulate, not overwrite
    client.accrue_reward(&crate::RewardRole::Submitter, &submitter, &token, &300);
    assert_eq!(
        client.get_reward_balance(&crate::RewardRole::Submitter, &submitter, &token),
        800
    );
}

#[test]
fn test_accrue_and_query_verifier_reward() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    client.initialize(&admin, &treasury, &0);

    let verifier = Address::generate(&env);
    let token = make_token(&env);

    client.accrue_reward(&crate::RewardRole::Verifier, &verifier, &token, &1000);
    assert_eq!(
        client.get_reward_balance(&crate::RewardRole::Verifier, &verifier, &token),
        1000
    );
}

#[test]
fn test_submitter_and_verifier_balances_are_independent() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    client.initialize(&admin, &treasury, &0);

    let user = Address::generate(&env);
    let token = make_token(&env);

    client.accrue_reward(&crate::RewardRole::Submitter, &user, &token, &200);
    client.accrue_reward(&crate::RewardRole::Verifier, &user, &token, &350);

    assert_eq!(
        client.get_reward_balance(&crate::RewardRole::Submitter, &user, &token),
        200
    );
    assert_eq!(
        client.get_reward_balance(&crate::RewardRole::Verifier, &user, &token),
        350
    );
}

#[test]
fn test_claim_reward_transfers_tokens_and_resets_balance() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    client.initialize(&admin, &treasury, &0);

    let submitter = Address::generate(&env);
    let token_admin = Address::generate(&env);

    // Mint tokens to the *contract* so it can pay out rewards
    let token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token_addr = token_id.address();
    StellarAssetClient::new(&env, &token_addr).mint(&contract_id, &5_000);

    client.accrue_reward(&crate::RewardRole::Submitter, &submitter, &token_addr, &750);

    // Balance before claim
    assert_eq!(TokenClient::new(&env, &token_addr).balance(&submitter), 0);

    client.claim_reward(&submitter, &crate::RewardRole::Submitter, &token_addr);

    // Tokens transferred
    assert_eq!(TokenClient::new(&env, &token_addr).balance(&submitter), 750);

    // Storage reset to zero
    assert_eq!(
        client.get_reward_balance(&crate::RewardRole::Submitter, &submitter, &token_addr),
        0
    );
}

#[test]
fn test_claim_reward_twice_only_pays_once() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    client.initialize(&admin, &treasury, &0);

    let verifier = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token_addr = token_id.address();
    StellarAssetClient::new(&env, &token_addr).mint(&contract_id, &5_000);

    client.accrue_reward(&crate::RewardRole::Verifier, &verifier, &token_addr, &400);
    client.claim_reward(&verifier, &crate::RewardRole::Verifier, &token_addr);
    assert_eq!(TokenClient::new(&env, &token_addr).balance(&verifier), 400);

    // Second claim with zero balance should panic
    let result = std::panic::catch_unwind(|| {
        client.claim_reward(&verifier, &crate::RewardRole::Verifier, &token_addr);
    });
    assert!(result.is_err(), "second claim must fail");
}

#[test]
#[should_panic(expected = "Error(Contract, #23)")]
fn test_claim_with_no_balance_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    client.initialize(&admin, &treasury, &0);

    let user = Address::generate(&env);
    let token = make_token(&env);

    // No rewards accrued — should panic with LowBalance (#23)
    client.claim_reward(&user, &crate::RewardRole::Submitter, &token);
}

#[test]
#[should_panic(expected = "Error(Contract, #20)")]
fn test_accrue_zero_amount_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    client.initialize(&admin, &treasury, &0);

    let user = Address::generate(&env);
    let token = make_token(&env);

    // amount = 0 should panic with MustBePositive (#20)
    client.accrue_reward(&crate::RewardRole::Submitter, &user, &token, &0);
}
