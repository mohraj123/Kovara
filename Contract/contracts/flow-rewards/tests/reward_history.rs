//! CT-10 — paginated reward history.
//!
//! Verifies that `reward_history` returns bounded, deterministic pages of
//! grant records stored per recipient, and that `grant_count` reflects the
//! number of grants recorded.

use kovara_flow_rewards::{Error, FlowRewards, FlowRewardsClient, MAX_HISTORY_PAGE_SIZE};
use soroban_sdk::{symbol_short, testutils::Address as _, Address, Env, Vec};

fn setup() -> (Env, FlowRewardsClient<'static>, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(FlowRewards, ());
    let client = FlowRewardsClient::new(&env, &id);
    let admin = Address::generate(&env);
    let recipient = Address::generate(&env);
    let asset = Address::generate(&env);
    // Pre-fund treasury so grants don't hit InsufficientTreasury.
    client.fund_treasury(&admin, &asset, &100_000);
    (env, client, admin, recipient, asset)
}

// ── Basic storage ─────────────────────────────────────────────────────────────

#[test]
fn empty_history_before_any_grant() {
    let (_env, client, _admin, recipient, _asset) = setup();
    let page = client.reward_history(&recipient, &0, &10);
    assert_eq!(page.len(), 0);
    assert_eq!(client.grant_count(&recipient), 0);
}

#[test]
fn single_grant_appears_on_first_page() {
    let (_env, client, admin, recipient, asset) = setup();
    client.grant(
        &admin,
        &recipient,
        &asset,
        &symbol_short!("submit"),
        &100,
        &1,
    );

    assert_eq!(client.grant_count(&recipient), 1);
    let page = client.reward_history(&recipient, &0, &10);
    assert_eq!(page.len(), 1);
    let record = page.get(0).unwrap();
    assert_eq!(record.amount, 100);
    assert_eq!(record.claimed, 0);
    assert_eq!(record.revoked, 0);
}

#[test]
fn multiple_grants_stored_in_insertion_order() {
    let (_env, client, admin, recipient, asset) = setup();
    client.grant(
        &admin,
        &recipient,
        &asset,
        &symbol_short!("submit"),
        &10,
        &1,
    );
    client.grant(
        &admin,
        &recipient,
        &asset,
        &symbol_short!("submit"),
        &20,
        &2,
    );
    client.grant(
        &admin,
        &recipient,
        &asset,
        &symbol_short!("submit"),
        &30,
        &3,
    );

    assert_eq!(client.grant_count(&recipient), 3);
    let page = client.reward_history(&recipient, &0, &10);
    assert_eq!(page.len(), 3);
    assert_eq!(page.get(0).unwrap().amount, 10);
    assert_eq!(page.get(1).unwrap().amount, 20);
    assert_eq!(page.get(2).unwrap().amount, 30);
}

// ── Pagination ────────────────────────────────────────────────────────────────

#[test]
fn offset_zero_limit_one_returns_first_record() {
    let (_env, client, admin, recipient, asset) = setup();
    for id in 1u64..=5 {
        client.grant(
            &admin,
            &recipient,
            &asset,
            &symbol_short!("submit"),
            &(id as i128 * 10),
            &id,
        );
    }

    let page = client.reward_history(&recipient, &0, &1);
    assert_eq!(page.len(), 1);
    assert_eq!(page.get(0).unwrap().amount, 10);
}

#[test]
fn paging_through_all_records_covers_every_entry() {
    let (_env, client, admin, recipient, asset) = setup();
    let n: u32 = 7;
    for id in 1u64..=(n as u64) {
        client.grant(
            &admin,
            &recipient,
            &asset,
            &symbol_short!("submit"),
            &(id as i128 * 5),
            &id,
        );
    }

    // Page size 3 → pages at offsets 0, 3, 6.
    let page0 = client.reward_history(&recipient, &0, &3);
    let page1 = client.reward_history(&recipient, &3, &3);
    let page2 = client.reward_history(&recipient, &6, &3);

    assert_eq!(page0.len(), 3);
    assert_eq!(page1.len(), 3);
    assert_eq!(page2.len(), 1); // only one record at offset 6

    // Amounts are 5, 10, 15, 20, 25, 30, 35.
    assert_eq!(page0.get(0).unwrap().amount, 5);
    assert_eq!(page0.get(2).unwrap().amount, 15);
    assert_eq!(page1.get(0).unwrap().amount, 20);
    assert_eq!(page1.get(2).unwrap().amount, 30);
    assert_eq!(page2.get(0).unwrap().amount, 35);
}

#[test]
fn offset_beyond_end_returns_empty_page() {
    let (_env, client, admin, recipient, asset) = setup();
    client.grant(
        &admin,
        &recipient,
        &asset,
        &symbol_short!("submit"),
        &50,
        &1,
    );

    let page = client.reward_history(&recipient, &999, &10);
    assert_eq!(page.len(), 0);
}

#[test]
fn limit_clips_to_available_records() {
    let (_env, client, admin, recipient, asset) = setup();
    for id in 1u64..=3 {
        client.grant(
            &admin,
            &recipient,
            &asset,
            &symbol_short!("submit"),
            &10,
            &id,
        );
    }
    // Ask for 10 but only 3 exist starting at offset 1 → 2 returned.
    let page = client.reward_history(&recipient, &1, &10);
    assert_eq!(page.len(), 2);
}

// ── Determinism ───────────────────────────────────────────────────────────────

#[test]
fn existing_offsets_stable_after_new_grant() {
    let (_env, client, admin, recipient, asset) = setup();
    // Grant #1 → index position 0.
    client.grant(
        &admin,
        &recipient,
        &asset,
        &symbol_short!("submit"),
        &42,
        &1,
    );
    let before = client.reward_history(&recipient, &0, &1);
    assert_eq!(before.get(0).unwrap().amount, 42);

    // Grant #2 is appended to position 1 — position 0 must not shift.
    client.grant(
        &admin,
        &recipient,
        &asset,
        &symbol_short!("submit"),
        &99,
        &2,
    );
    let after = client.reward_history(&recipient, &0, &1);
    assert_eq!(after.get(0).unwrap().amount, 42);
}

// ── Isolation between recipients ──────────────────────────────────────────────

#[test]
fn history_is_scoped_to_recipient() {
    let (env, client, admin, recipient, asset) = setup();
    let other = Address::generate(&env);

    client.grant(
        &admin,
        &recipient,
        &asset,
        &symbol_short!("submit"),
        &10,
        &1,
    );
    client.grant(
        &admin,
        &other,
        &asset,
        &symbol_short!("submit"),
        &20,
        &2,
    );

    let page_r = client.reward_history(&recipient, &0, &10);
    let page_o = client.reward_history(&other, &0, &10);

    assert_eq!(page_r.len(), 1);
    assert_eq!(page_r.get(0).unwrap().amount, 10);

    assert_eq!(page_o.len(), 1);
    assert_eq!(page_o.get(0).unwrap().amount, 20);
}

// ── Validation ────────────────────────────────────────────────────────────────

#[test]
fn limit_zero_is_rejected() {
    let (_env, client, _admin, recipient, _asset) = setup();
    let result = client.try_reward_history(&recipient, &0, &0);
    assert_eq!(result, Err(Ok(Error::InvalidPageSize)));
}

#[test]
fn limit_above_max_is_rejected() {
    let (_env, client, _admin, recipient, _asset) = setup();
    let result = client.try_reward_history(&recipient, &0, &(MAX_HISTORY_PAGE_SIZE + 1));
    assert_eq!(result, Err(Ok(Error::InvalidPageSize)));
}

#[test]
fn limit_at_max_is_accepted() {
    let (_env, client, _admin, recipient, _asset) = setup();
    let result = client.try_reward_history(&recipient, &0, &MAX_HISTORY_PAGE_SIZE);
    assert!(result.is_ok());
}

// ── Records reflect claim and revoke state ────────────────────────────────────

#[test]
fn claimed_amount_reflected_in_history_record() {
    let (_env, client, admin, recipient, asset) = setup();
    client.grant(
        &admin,
        &recipient,
        &asset,
        &symbol_short!("submit"),
        &100,
        &1,
    );
    client.claim(&recipient, &asset, &40);

    let page = client.reward_history(&recipient, &0, &10);
    let record = page.get(0).unwrap();
    assert_eq!(record.amount, 100);
    assert_eq!(record.claimed, 40);
    assert_eq!(record.revoked, 0);
}

#[test]
fn revoked_amount_reflected_in_history_record() {
    let (_env, client, admin, recipient, asset) = setup();
    client.grant(
        &admin,
        &recipient,
        &asset,
        &symbol_short!("submit"),
        &80,
        &1,
    );
    client.revoke(&admin, &1);

    let page = client.reward_history(&recipient, &0, &10);
    let record = page.get(0).unwrap();
    assert_eq!(record.amount, 80);
    assert_eq!(record.claimed, 0);
    assert_eq!(record.revoked, 80);
}
