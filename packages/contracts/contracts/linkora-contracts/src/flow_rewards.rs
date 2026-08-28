/// flow_rewards.rs — Reward accrual, querying, and claiming for submitters and verifiers.
///
/// Rewards are accumulated in persistent storage keyed by (role, address, token).
/// The contract admin calls `accrue_reward` to credit a user; users call `claim_reward`
/// to transfer the full accrued balance to themselves.
///
/// All arithmetic on balance fields uses Rust's `checked_add` / `checked_sub` to
/// produce named `ContractError` variants on overflow/underflow (CT-022).
use soroban_sdk::{contractevent, contractimpl, panic_with_error, symbol_short, token, Address, Env, Symbol};

use crate::{ContractError, KovaraContract, RewardRole, StorageKey};

// ── Events ────────────────────────────────────────────────────────────────────

#[contractevent]
#[derive(Clone)]
pub struct RewardAccruedEvent {
    #[topic]
    pub role: Symbol,
    #[topic]
    pub recipient: Address,
    pub token: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone)]
pub struct RewardClaimedEvent {
    #[topic]
    pub claimant: Address,
    pub token: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone)]
pub struct RewardFundsDepositedEvent {
    #[topic]
    pub depositor: Address,
    #[topic]
    pub token: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone)]
pub struct RewardFundsRecoveredEvent {
    #[topic]
    pub recipient: Address,
    #[topic]
    pub token: Address,
    pub amount: i128,
}

// ── Implementation ────────────────────────────────────────────────────────────

#[contractimpl]
impl KovaraContract {
    // ── Reward accrual ────────────────────────────────────────────────────────

    /// Credit `amount` tokens of `token` to `recipient` under `role`.
    ///
    /// Admin-only. No tokens are transferred at this point; the on-chain balance
    /// is simply incremented. The actual transfer happens when the recipient
    /// calls [`claim_reward`].
    ///
    /// CT-022: uses `checked_add` so overflow produces `PoolBalanceOverflow`
    /// instead of a generic host trap.
    ///
    /// # Panics
    /// - `NotInitialized` — contract not yet initialized.
    /// - `MustBePositive` — `amount <= 0`.
    /// - `PoolBalanceOverflow` — accrued balance would overflow `i128`.
    pub fn accrue_reward(
        env: Env,
        role: RewardRole,
        recipient: Address,
        token: Address,
        amount: i128,
    ) {
        Self::require_not_paused(&env);
        Self::require_initialized(&env);
        Self::bump_instance(&env);
        Self::require_admin(&env);

        if amount <= 0 {
            panic_with_error!(&env, ContractError::MustBePositive);
        }

        let key = StorageKey::RewardBalance(role.clone(), recipient.clone(), token.clone());
        let current: i128 = env.storage().persistent().get(&key).unwrap_or(0i128);

        // CT-022: checked_add — overflow produces a named contract error.
        let new_balance = current
            .checked_add(amount)
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::PoolBalanceOverflow));

        env.storage().persistent().set(&key, &new_balance);
        Self::bump(&env, &key);

        Self::increase_liability(&env, &token, amount);

        let role_sym = match role {
            RewardRole::Submitter => symbol_short!("submitr"),
            RewardRole::Verifier => symbol_short!("verifir"),
        };
        RewardAccruedEvent {
            role: role_sym,
            recipient,
            token,
            amount,
        }
        .publish(&env);
    }

    /// Deposit reward assets into the contract so there are funds available
    /// when users call `claim_reward`. Admin-only; the depositor must authorize
    /// the transfer.
    pub fn fund_rewards(env: Env, depositor: Address, token: Address, amount: i128) {
        Self::require_initialized(&env);
        Self::bump_instance(&env);
        Self::require_admin(&env);
        depositor.require_auth();
        Self::validate_reward_asset(&env, &token);
        if amount <= 0 {
            panic_with_error!(&env, ContractError::MustBePositive);
        }

        token::Client::new(&env, &token).transfer(
            &depositor,
            &env.current_contract_address(),
            &amount,
        );
        RewardFundsDepositedEvent {
            depositor,
            token,
            amount,
        }
        .publish(&env);
    }

    /// Recover only surplus reward assets. The admin cannot withdraw assets
    /// reserved by outstanding reward liabilities.
    ///
    /// CT-022: uses `checked_sub` on the surplus calculation so an underflow
    /// (liability > on-chain balance) produces `RewardFundsUnavailable`.
    pub fn recover_rewards(env: Env, recipient: Address, token: Address, amount: i128) {
        Self::require_initialized(&env);
        Self::bump_instance(&env);
        Self::require_admin(&env);
        Self::validate_reward_asset(&env, &token);
        if amount <= 0 {
            panic_with_error!(&env, ContractError::MustBePositive);
        }

        let token_client = token::Client::new(&env, &token);
        let balance = token_client.balance(&env.current_contract_address());
        let liability = Self::get_reward_liability_internal(&env, &token);

        // CT-022: checked_sub — if liability > balance the subtraction underflows;
        // treat that as RewardFundsUnavailable.
        let available = balance
            .checked_sub(liability)
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::RewardFundsUnavailable));

        if amount > available {
            panic_with_error!(&env, ContractError::RewardFundsReserved);
        }
        token_client.transfer(&env.current_contract_address(), &recipient, &amount);
        RewardFundsRecoveredEvent {
            recipient,
            token,
            amount,
        }
        .publish(&env);
    }

    pub fn get_reward_liability(env: Env, token: Address) -> i128 {
        Self::require_initialized(&env);
        Self::get_reward_liability_internal(&env, &token)
    }

    // ── Reward query ──────────────────────────────────────────────────────────

    /// Return the unclaimed reward balance for `user` under `role` for `token`.
    /// Returns `0` if no rewards have been accrued yet.
    pub fn get_reward_balance(env: Env, role: RewardRole, user: Address, token: Address) -> i128 {
        Self::require_initialized(&env);
        let key = StorageKey::RewardBalance(role, user, token);
        let balance: i128 = env.storage().persistent().get(&key).unwrap_or(0i128);
        if balance > 0 {
            Self::bump(&env, &key);
        }
        balance
    }

    // ── Reward claiming ───────────────────────────────────────────────────────

    /// Transfer the caller's full accrued reward balance to themselves, then
    /// reset the on-chain balance to `0`.
    ///
    /// The balance is zeroed *before* the token transfer to guard against
    /// re-entrant double-spend (check-effects-interactions pattern).
    ///
    /// CT-022: `decrease_liability` uses `checked_sub` so any accounting
    /// inconsistency surfaces as `PoolBalanceUnderflow` rather than wrapping.
    ///
    /// # Panics
    /// - `NotInitialized` — contract not yet initialized.
    /// - `LowBalance` — caller has no accrued balance for this role/token.
    /// - `RewardFundsUnavailable` — contract holds insufficient tokens to pay.
    pub fn claim_reward(env: Env, claimant: Address, role: RewardRole, token: Address) {
        Self::require_not_paused(&env);
        Self::require_initialized(&env);
        Self::bump_instance(&env);
        claimant.require_auth();
        Self::validate_reward_asset(&env, &token);

        let key = StorageKey::RewardBalance(role, claimant.clone(), token.clone());
        let balance: i128 = env.storage().persistent().get(&key).unwrap_or(0i128);
        if balance <= 0 {
            panic_with_error!(&env, ContractError::LowBalance);
        }

        let token_client = token::Client::new(&env, &token);
        if token_client.balance(&env.current_contract_address()) < balance {
            panic_with_error!(&env, ContractError::RewardFundsUnavailable);
        }

        // Zero out before transferring (re-entrancy guard / check-effects-interactions).
        env.storage().persistent().set(&key, &0i128);
        Self::bump(&env, &key);
        Self::decrease_liability(&env, &token, balance);

        token_client.transfer(
            &env.current_contract_address(),
            &claimant,
            &balance,
        );

        RewardClaimedEvent {
            claimant,
            token,
            amount: balance,
        }
        .publish(&env);
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    fn validate_reward_asset(env: &Env, token: &Address) {
        if *token == env.current_contract_address() {
            panic_with_error!(env, ContractError::InvalidRewardAsset);
        }
        // Verify the token is a valid SEP-41 asset by calling balance().
        token::Client::new(env, token).balance(&env.current_contract_address());
    }

    fn get_reward_liability_internal(env: &Env, token: &Address) -> i128 {
        let key = StorageKey::RewardLiability(token.clone());
        let value: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        if value > 0 {
            Self::bump(env, &key);
        }
        value
    }

    /// Increase the total outstanding reward liability for `token` by `amount`.
    ///
    /// CT-022: uses `checked_add` — overflow produces `PoolBalanceOverflow`.
    fn increase_liability(env: &Env, token: &Address, amount: i128) {
        let key = StorageKey::RewardLiability(token.clone());
        let current = Self::get_reward_liability_internal(env, token);
        let value = current
            .checked_add(amount)
            .unwrap_or_else(|| panic_with_error!(env, ContractError::PoolBalanceOverflow));
        env.storage().persistent().set(&key, &value);
        Self::bump(env, &key);
    }

    /// Decrease the total outstanding reward liability for `token` by `amount`.
    ///
    /// CT-022: uses `checked_sub` — underflow (liability < amount, meaning
    /// accounting is inconsistent) produces `PoolBalanceUnderflow`.
    fn decrease_liability(env: &Env, token: &Address, amount: i128) {
        let key = StorageKey::RewardLiability(token.clone());
        let current = Self::get_reward_liability_internal(env, token);
        let value = current
            .checked_sub(amount)
            .unwrap_or_else(|| panic_with_error!(env, ContractError::PoolBalanceUnderflow));
        env.storage().persistent().set(&key, &value);
        Self::bump(env, &key);
    }
}
