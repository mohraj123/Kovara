#![cfg(test)]

use crate::{KovaraContract, KovaraContractClient};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env,
};
use crate::sentinel_pool::{Verdict, Resolution};

// ── Shared setup ──────────────────────────────────────────────────────────────

fn setup_env<'a>() -> (Env, KovaraContractClient<'a>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    client.initialize(&admin, &treasury, &500);
    (env, client, admin)
}

/// Mint `amount` of a fresh Stellar asset to `recipient` and return the token address.
fn make_funded_token(env: &Env, recipient: &Address, amount: i128) -> Address {
    let token_admin = Address::generate(env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token = token_id.address();
    StellarAssetClient::new(env, &token).mint(recipient, &amount);
    token
}

// ── Existing lifecycle tests (preserved) ─────────────────────────────────────

#[test]
fn test_open_round() {
    let (env, client, _admin) = setup_env();
    let submission_id = 1u64;
    let duration = 10u32;

    client.open_round(&submission_id, &duration);
    // Verify it doesn't crash and the round is now open.
    // Opening again should panic with RoundAlreadyExists (46).
}

#[test]
fn test_vote_and_resolve_approved() {
    let (env, client, _admin) = setup_env();
    let submission_id = 2u64;
    let duration = 5u32;

    client.open_round(&submission_id, &duration);

    let verifier1 = Address::generate(&env);
    let verifier2 = Address::generate(&env);
    let verifier3 = Address::generate(&env);

    client.vote(&verifier1, &submission_id, &Verdict::Approve);
    client.vote(&verifier2, &submission_id, &Verdict::Approve);
    client.vote(&verifier3, &submission_id, &Verdict::Reject);

    // Fast forward ledger past the deadline.
    let mut info = env.ledger().get();
    info.sequence_number += duration + 1;
    env.ledger().set(info);

    let res = client.resolve(&submission_id);
    assert_eq!(res, Resolution::Approved);
}

#[test]
fn test_vote_and_resolve_rejected() {
    let (env, client, _admin) = setup_env();
    let submission_id = 3u64;
    let duration = 5u32;

    client.open_round(&submission_id, &duration);

    let verifier1 = Address::generate(&env);
    let verifier2 = Address::generate(&env);
    let verifier3 = Address::generate(&env);

    client.vote(&verifier1, &submission_id, &Verdict::Reject);
    client.vote(&verifier2, &submission_id, &Verdict::Approve);
    client.vote(&verifier3, &submission_id, &Verdict::Reject);

    let mut info = env.ledger().get();
    info.sequence_number += duration + 1;
    env.ledger().set(info);

    let res = client.resolve(&submission_id);
    assert_eq!(res, Resolution::Rejected);
}

#[test]
fn test_vote_and_resolve_tie() {
    let (env, client, _admin) = setup_env();
    let submission_id = 4u64;
    let duration = 5u32;

    client.open_round(&submission_id, &duration);

    let verifier1 = Address::generate(&env);
    let verifier2 = Address::generate(&env);

    client.vote(&verifier1, &submission_id, &Verdict::Reject);
    client.vote(&verifier2, &submission_id, &Verdict::Approve);

    let mut info = env.ledger().get();
    info.sequence_number += duration + 1;
    env.ledger().set(info);

    let res = client.resolve(&submission_id);
    assert_eq!(res, Resolution::Tie);
}

#[test]
#[should_panic(expected = "HostError: Error(Contract, #65)")]
fn test_late_vote_fails() {
    let (env, client, _admin) = setup_env();
    let submission_id = 5u64;
    let duration = 5u32;

    client.open_round(&submission_id, &duration);

    // Advance ledger past deadline.
    let mut info = env.ledger().get();
    info.sequence_number += duration + 1;
    env.ledger().set(info);

    let verifier = Address::generate(&env);
    // Expects ContractError::RoundClosed = 48
    client.vote(&verifier, &submission_id, &Verdict::Approve);
}

#[test]
#[should_panic(expected = "HostError: Error(Contract, #68)")]
fn test_resolve_too_early_fails() {
    let (env, client, _admin) = setup_env();
    let submission_id = 6u64;
    let duration = 5u32;

    client.open_round(&submission_id, &duration);

    // Attempting to resolve before deadline — ContractError::RoundStillOpen = 51
    client.resolve(&submission_id);
}

#[test]
#[should_panic(expected = "HostError: Error(Contract, #66)")]
fn test_resolve_already_finalized() {
    let (env, client, _admin) = setup_env();
    let submission_id = 7u64;
    let duration = 5u32;

    client.open_round(&submission_id, &duration);

    let mut info = env.ledger().get();
    info.sequence_number += duration + 1;
    env.ledger().set(info);

    client.resolve(&submission_id);

    // Second resolve — ContractError::RoundAlreadyFinalized = 49
    client.resolve(&submission_id);
}

// ── CT-022: Stake deposit — overflow ─────────────────────────────────────────

/// Depositing an amount that would push the stake balance past i128::MAX must
/// revert with `StakeBalanceOverflow` (error 57) and leave state unchanged.
///
/// We seed the storage with i128::MAX - 50 then try to deposit 100.
/// Because Soroban test environments don't expose direct storage injection, we
/// build the near-overflow balance through a helper that mints enough tokens,
/// then verify the final rejected call leaves the previous balance intact.
#[test]
#[should_panic(expected = "Error(Contract, #57)")]
fn test_stake_deposit_overflow_is_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    client.initialize(&admin, &treasury, &0);

    let verifier = Address::generate(&env);
    // Mint i128::MAX worth of tokens to the verifier.
    let token_admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token = token_id.address();
    let sac = StellarAssetClient::new(&env, &token);
    // i128::MAX = 170_141_183_460_469_231_731_687_303_715_884_105_727
    sac.mint(&verifier, &i128::MAX);

    client.set_minimum_verifier_stake(&1);
    client.register_verifier(&verifier);

    // First deposit: i128::MAX - 1  (fills balance to one below max)
    client.deposit_stake(&verifier, &token, &(i128::MAX - 1));

    // State check: balance is now i128::MAX - 1
    assert_eq!(client.get_verifier_stake(&verifier, &token), i128::MAX - 1);

    // Second deposit of 2 would overflow: (i128::MAX - 1) + 2 wraps.
    // Must panic with StakeBalanceOverflow = 57.
    // Mint 2 more so the token transfer itself won't fail first.
    sac.mint(&verifier, &2);
    client.deposit_stake(&verifier, &token, &2);
}

/// After the overflowing deposit is rejected the on-chain balance must be
/// exactly what it was before the failed call (no partial mutation).
#[test]
fn test_stake_deposit_overflow_leaves_state_unchanged() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin, &Address::generate(&env), &0);

    let verifier = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token = token_id.address();
    let sac = StellarAssetClient::new(&env, &token);
    sac.mint(&verifier, &i128::MAX);

    client.set_minimum_verifier_stake(&1);
    client.register_verifier(&verifier);

    // Deposit i128::MAX - 1 successfully.
    client.deposit_stake(&verifier, &token, &(i128::MAX - 1));
    let balance_before = client.get_verifier_stake(&verifier, &token);
    assert_eq!(balance_before, i128::MAX - 1);

    // Attempt the overflowing deposit; catch the panic so the test continues.
    sac.mint(&verifier, &2);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.deposit_stake(&verifier, &token, &2);
    }));
    assert!(result.is_err(), "expected overflow deposit to panic");

    // Balance must be unchanged after the failed call.
    let balance_after = client.get_verifier_stake(&verifier, &token);
    assert_eq!(
        balance_after, balance_before,
        "CT-022: overflowing deposit must not mutate the balance"
    );
}

// ── CT-022: Stake withdrawal — underflow ─────────────────────────────────────

/// Withdrawing more than the current balance must revert with
/// `PoolBalanceUnderflow` (error 35) and leave the balance unchanged.
#[test]
#[should_panic(expected = "Error(Contract, #35)")]
fn test_stake_withdraw_underflow_is_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);
    client.initialize(&Address::generate(&env), &Address::generate(&env), &0);

    let verifier = Address::generate(&env);
    let token = make_funded_token(&env, &verifier, 1_000);

    client.set_minimum_verifier_stake(&1);
    client.register_verifier(&verifier);
    client.deposit_stake(&verifier, &token, &500);

    // 501 > 500 — must revert with PoolBalanceUnderflow = 35
    client.withdraw_stake(&verifier, &token, &501);
}

/// After the rejected withdrawal the balance must remain exactly 500.
#[test]
fn test_stake_withdraw_underflow_leaves_state_unchanged() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);
    client.initialize(&Address::generate(&env), &Address::generate(&env), &0);

    let verifier = Address::generate(&env);
    let token = make_funded_token(&env, &verifier, 1_000);

    client.set_minimum_verifier_stake(&1);
    client.register_verifier(&verifier);
    client.deposit_stake(&verifier, &token, &500);

    let balance_before = client.get_verifier_stake(&verifier, &token);
    assert_eq!(balance_before, 500);

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.withdraw_stake(&verifier, &token, &501);
    }));
    assert!(result.is_err(), "expected underflow withdrawal to panic");

    let balance_after = client.get_verifier_stake(&verifier, &token);
    assert_eq!(
        balance_after, balance_before,
        "CT-022: underflowing withdrawal must not mutate the balance"
    );
}

// ── CT-022: Conservation — deposits and withdrawals ──────────────────────────

/// After any sequence of successful deposits and withdrawals (including
/// attempted operations that fail), the on-chain stake balance must equal
/// the net of all *successful* deposits minus *successful* withdrawals.
#[test]
fn test_stake_conservation_across_deposits_and_withdrawals() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);
    client.initialize(&Address::generate(&env), &Address::generate(&env), &0);

    let verifier = Address::generate(&env);
    let token = make_funded_token(&env, &verifier, 10_000);

    client.set_minimum_verifier_stake(&1);
    client.register_verifier(&verifier);

    // Track expected balance alongside the contract calls.
    let mut expected: i128 = 0;

    // Deposit 1 000 → expected = 1 000
    client.deposit_stake(&verifier, &token, &1_000);
    expected += 1_000;
    assert_eq!(client.get_verifier_stake(&verifier, &token), expected);

    // Deposit 500 → expected = 1 500
    client.deposit_stake(&verifier, &token, &500);
    expected += 500;
    assert_eq!(client.get_verifier_stake(&verifier, &token), expected);

    // Withdraw 300 → expected = 1 200
    client.withdraw_stake(&verifier, &token, &300);
    expected -= 300;
    assert_eq!(client.get_verifier_stake(&verifier, &token), expected);

    // Attempt an underflowing withdrawal of 2 000 — must fail, expected unchanged.
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.withdraw_stake(&verifier, &token, &2_000);
    }));
    assert!(result.is_err());
    assert_eq!(
        client.get_verifier_stake(&verifier, &token),
        expected,
        "CT-022: failed withdrawal must not change the balance"
    );

    // Deposit 200 → expected = 1 400
    client.deposit_stake(&verifier, &token, &200);
    expected += 200;
    assert_eq!(client.get_verifier_stake(&verifier, &token), expected);

    // Withdraw all remaining → expected = 0
    client.withdraw_stake(&verifier, &token, &expected);
    expected = 0;
    assert_eq!(
        client.get_verifier_stake(&verifier, &token),
        0,
        "CT-022: withdrawing full balance must leave exactly zero"
    );
}

// ── CT-022: Boundary — maximum-value deposit ─────────────────────────────────

/// A deposit of exactly i128::MAX into an empty account must succeed and store
/// the correct value.
#[test]
fn test_stake_deposit_max_value_succeeds() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);
    client.initialize(&Address::generate(&env), &Address::generate(&env), &0);

    let verifier = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token = token_id.address();
    StellarAssetClient::new(&env, &token).mint(&verifier, &i128::MAX);

    client.set_minimum_verifier_stake(&1);
    client.register_verifier(&verifier);

    client.deposit_stake(&verifier, &token, &i128::MAX);
    assert_eq!(
        client.get_verifier_stake(&verifier, &token),
        i128::MAX,
        "CT-022: deposit of i128::MAX into empty account must succeed"
    );
}

// ── CT-022: Boundary — zero-amount deposit and withdrawal ────────────────────

/// A deposit of exactly 0 must be rejected (`StakeAmountMustBePositive = 56`).
#[test]
#[should_panic(expected = "Error(Contract, #56)")]
fn test_stake_deposit_zero_is_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);
    client.initialize(&Address::generate(&env), &Address::generate(&env), &0);

    let verifier = Address::generate(&env);
    let token = make_funded_token(&env, &verifier, 1_000);

    client.set_minimum_verifier_stake(&1);
    client.register_verifier(&verifier);

    // StakeAmountMustBePositive = 56
    client.deposit_stake(&verifier, &token, &0);
}

/// A withdrawal of exactly 0 must also be rejected (`StakeAmountMustBePositive = 56`).
#[test]
#[should_panic(expected = "Error(Contract, #56)")]
fn test_stake_withdraw_zero_is_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);
    client.initialize(&Address::generate(&env), &Address::generate(&env), &0);

    let verifier = Address::generate(&env);
    let token = make_funded_token(&env, &verifier, 1_000);

    client.set_minimum_verifier_stake(&1);
    client.register_verifier(&verifier);
    client.deposit_stake(&verifier, &token, &500);

    // StakeAmountMustBePositive = 56
    client.withdraw_stake(&verifier, &token, &0);
}

// ── CT-022: Boundary — withdraw exactly the full balance ─────────────────────

/// Withdrawing exactly the current balance must succeed and leave the
/// on-chain stake at precisely zero.
#[test]
fn test_stake_withdraw_exact_balance_leaves_zero() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);
    client.initialize(&Address::generate(&env), &Address::generate(&env), &0);

    let verifier = Address::generate(&env);
    let token = make_funded_token(&env, &verifier, 1_000);

    client.set_minimum_verifier_stake(&1);
    client.register_verifier(&verifier);
    client.deposit_stake(&verifier, &token, &750);

    // Withdraw all 750 — must succeed.
    client.withdraw_stake(&verifier, &token, &750);

    assert_eq!(
        client.get_verifier_stake(&verifier, &token),
        0,
        "CT-022: withdrawing exactly the full balance must leave 0"
    );

    // Token must be back in the verifier's wallet.
    assert_eq!(
        TokenClient::new(&env, &token).balance(&verifier),
        1_000,
        "CT-022: verifier wallet must be fully restored after full withdrawal"
    );
}

// ── CT-022: Conservation — two verifiers, independent balances ───────────────

/// Two verifiers depositing into the same token must maintain independent
/// balances — one verifier's withdrawal must not touch the other's stake.
#[test]
fn test_stake_two_verifiers_independent_conservation() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);
    client.initialize(&Address::generate(&env), &Address::generate(&env), &0);

    let verifier_a = Address::generate(&env);
    let verifier_b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token = token_id.address();
    StellarAssetClient::new(&env, &token).mint(&verifier_a, &2_000);
    StellarAssetClient::new(&env, &token).mint(&verifier_b, &2_000);

    client.set_minimum_verifier_stake(&1);
    client.register_verifier(&verifier_a);
    client.register_verifier(&verifier_b);

    client.deposit_stake(&verifier_a, &token, &1_000);
    client.deposit_stake(&verifier_b, &token, &800);

    // Withdraw from A — B's balance must be unchanged.
    client.withdraw_stake(&verifier_a, &token, &400);
    assert_eq!(client.get_verifier_stake(&verifier_a, &token), 600);
    assert_eq!(
        client.get_verifier_stake(&verifier_b, &token),
        800,
        "CT-022: verifier A withdrawal must not affect verifier B's balance"
    );

    // Attempt underflow on B — A's balance must be unchanged.
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.withdraw_stake(&verifier_b, &token, &1_000);
    }));
    assert_eq!(
        client.get_verifier_stake(&verifier_a, &token),
        600,
        "CT-022: failed withdrawal on B must not affect A's balance"
    );
    assert_eq!(
        client.get_verifier_stake(&verifier_b, &token),
        800,
        "CT-022: failed withdrawal must leave B's balance unchanged"
    );
}

// ── CT-022: Pool balance — deposit overflow ───────────────────────────────────

/// Depositing into a community pool such that balance would overflow i128::MAX
/// must revert with `PoolBalanceOverflow` (error 34).
#[test]
#[should_panic(expected = "Error(Contract, #34)")]
fn test_pool_deposit_overflow_is_rejected() {
    use soroban_sdk::symbol_short;

    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin, &Address::generate(&env), &0);

    let depositor = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token = token_id.address();
    let sac = StellarAssetClient::new(&env, &token);

    let pool_id = symbol_short!("p1");
    let mut admins = soroban_sdk::Vec::new(&env);
    admins.push_back(admin.clone());
    client.create_pool(&admin, &pool_id, &token, &admins, &1);

    // First deposit: i128::MAX - 1
    sac.mint(&depositor, &(i128::MAX - 1));
    client.pool_deposit(&depositor, &pool_id, &token, &(i128::MAX - 1));

    // Second deposit of 2 would overflow — PoolBalanceOverflow = 34
    sac.mint(&depositor, &2);
    client.pool_deposit(&depositor, &pool_id, &token, &2);
}

/// After the rejected deposit the pool balance must still equal i128::MAX - 1.
#[test]
fn test_pool_deposit_overflow_leaves_state_unchanged() {
    use soroban_sdk::symbol_short;

    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin, &Address::generate(&env), &0);

    let depositor = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token = token_id.address();
    let sac = StellarAssetClient::new(&env, &token);

    let pool_id = symbol_short!("p2");
    let mut admins = soroban_sdk::Vec::new(&env);
    admins.push_back(admin.clone());
    client.create_pool(&admin, &pool_id, &token, &admins, &1);

    sac.mint(&depositor, &(i128::MAX - 1));
    client.pool_deposit(&depositor, &pool_id, &token, &(i128::MAX - 1));

    let pool_before = client.get_pool(&pool_id).unwrap();
    assert_eq!(pool_before.balance, i128::MAX - 1);

    sac.mint(&depositor, &2);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.pool_deposit(&depositor, &pool_id, &token, &2);
    }));
    assert!(result.is_err(), "expected pool overflow deposit to panic");

    let pool_after = client.get_pool(&pool_id).unwrap();
    assert_eq!(
        pool_after.balance,
        pool_before.balance,
        "CT-022: overflowing pool deposit must not change the balance"
    );
}

// ── CT-022: Pool balance — withdrawal underflow ───────────────────────────────

/// Withdrawing more than the pool balance must revert with
/// `PoolBalanceUnderflow` (error 35).
#[test]
#[should_panic(expected = "Error(Contract, #35)")]
fn test_pool_withdraw_underflow_is_rejected() {
    use soroban_sdk::{symbol_short, vec};

    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin, &Address::generate(&env), &0);

    let depositor = Address::generate(&env);
    let token = make_funded_token(&env, &depositor, 1_000);

    let pool_id = symbol_short!("p3");
    let mut admins = soroban_sdk::Vec::new(&env);
    admins.push_back(admin.clone());
    client.create_pool(&admin, &pool_id, &token, &admins, &1);
    client.pool_deposit(&depositor, &pool_id, &token, &500);

    let recipient = Address::generate(&env);
    let signers = vec![&env, admin.clone()];
    // 501 > 500 — must revert with PoolBalanceUnderflow = 35
    client.pool_withdraw(&signers, &pool_id, &500 + 1, &recipient);
}

// ── CT-022: Pool balance — conservation ──────────────────────────────────────

/// Sum of all individual deposits minus successful withdrawals must always
/// equal the pool's tracked balance, including after failed operations.
#[test]
fn test_pool_balance_conservation() {
    use soroban_sdk::{symbol_short, vec};

    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KovaraContract, ());
    let client = KovaraContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin, &Address::generate(&env), &0);

    let depositor = Address::generate(&env);
    let token = make_funded_token(&env, &depositor, 10_000);

    let pool_id = symbol_short!("p4");
    let mut admins_vec = soroban_sdk::Vec::new(&env);
    admins_vec.push_back(admin.clone());
    client.create_pool(&admin, &pool_id, &token, &admins_vec, &1);

    let recipient = Address::generate(&env);
    let signers = vec![&env, admin.clone()];
    let mut expected_balance: i128 = 0;

    // Deposit 3 000 → expected = 3 000
    client.pool_deposit(&depositor, &pool_id, &token, &3_000);
    expected_balance += 3_000;
    assert_eq!(client.get_pool(&pool_id).unwrap().balance, expected_balance);

    // Deposit 2 000 → expected = 5 000
    client.pool_deposit(&depositor, &pool_id, &token, &2_000);
    expected_balance += 2_000;
    assert_eq!(client.get_pool(&pool_id).unwrap().balance, expected_balance);

    // Withdraw 1 000 → expected = 4 000
    client.pool_withdraw(&signers, &pool_id, &1_000, &recipient);
    expected_balance -= 1_000;
    assert_eq!(client.get_pool(&pool_id).unwrap().balance, expected_balance);

    // Attempt underflowing withdrawal of 9 999 — must fail, expected unchanged.
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.pool_withdraw(&signers, &pool_id, &9_999, &recipient);
    }));
    assert!(result.is_err(), "expected underflow withdrawal to panic");
    assert_eq!(
        client.get_pool(&pool_id).unwrap().balance,
        expected_balance,
        "CT-022: failed pool withdrawal must not change the balance"
    );

    // Withdraw exactly the remaining balance → expected = 0
    client.pool_withdraw(&signers, &pool_id, &expected_balance, &recipient);
    expected_balance = 0;
    assert_eq!(
        client.get_pool(&pool_id).unwrap().balance,
        0,
        "CT-022: withdrawing full pool balance must leave exactly zero"
    );
}
