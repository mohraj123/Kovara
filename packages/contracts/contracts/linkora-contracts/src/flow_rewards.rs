use soroban_sdk::{contractevent, contractimpl, panic_with_error, symbol_short, token, Address, Env, Symbol};

use crate::{ContractError, KovaraContract, RewardRole, StorageKey};

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

#[contracterror]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VoteError {
    AlreadyVoted = 0,
}

#[contractimpl]
impl KovaraContract {
    pub fn accrue_reward(
        env: Env,
        role: RewardRole,
        recipient: Address,
        token: Address,
        amount: i128,
    ) {
        Self::require_initialized(&env);
        Self::require_not_paused(&env);
        Self::bump_instance(&env);
        Self::require_admin(&env);

        if amount <= 0 {
            panic_with_error!(&env, ContractError::MustBePositive);
        }

        let key = StorageKey::RewardBalance(role.clone(), recipient.clone(), token.clone());
        let current: i128 = env.storage().persistent().get(&key).unwrap_or(0i128);
        let new_balance = current
            .checked_add(amount)
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::PoolBalanceOverflow));

        env.storage().persistent().set(&key, &new_balance);
        Self::bump(&env, &key);
        Self::increase_liability(&env, &token, amount);

        let role_sym = match role {
            RewardRole::Submitter => symbol_short!("submitter"),
            RewardRole::Verifier => symbol_short!("verifier"),
        };

        RewardAccruedEvent {
            role: role_sym,
            recipient,
            token,
            amount,
        }
        .publish(&env);
    }

    pub fn fund_rewards(env: Env, depositor: Address, token: Address, amount: i128) {
        Self::require_initialized(&env);
        Self::require_not_paused(&env);
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

    pub fn recover_rewards(env: Env, recipient: Address, token: Address, amount: i128) {
        Self::require_initialized(&env);
        Self::require_not_paused(&env);
        Self::bump_instance(&env);
        Self::require_admin(&env);

        Self::validate_reward_asset(&env, &token);

        if amount <= 0 {
            panic_with_error!(&env, ContractError::MustBePositive);
        }

        let available = token::Client::new(&env, &token).balance(&env.current_contract_address())
            - Self::get_reward_liability_internal(&env, &token);

        if amount > available {
            panic_with_error!(&env, ContractError::RewardFundsReserved);
        }

        token::Client::new(&env, &token).transfer(
            &env.current_contract_address(),
            &recipient,
            &amount,
        );

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

    pub fn get_reward_balance(
        env: Env,
        role: RewardRole,
        user: Address,
        token: Address,
    ) -> i128 {
        Self::require_initialized(&env);
        let key = StorageKey::RewardBalance(role, user, token);
        let balance: i128 = env.storage().persistent().get(&key).unwrap_or(0i128);
        if balance > 0 {
            Self::bump(&env, &key);
        }
        balance
    }

    pub fn claim_reward(env: Env, claimant: Address, role: RewardRole, token: Address) {
        Self::require_initialized(&env);
        Self::require_not_paused(&env);
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

        env.storage().persistent().set(&key, &0i128);
        Self::bump(&env, &key);
        Self::decrease_liability(&env, &token, balance);

        token_client.transfer(&env.current_contract_address(), &claimant, &balance);

        RewardClaimedEvent {
            claimant,
            token,
            amount: balance,
        }
        .publish(&env);
    }

    pub fn vote(env: Env, submission_id: u64, verifier: Address, vote: bool) {
        Self::require_initialized(&env);
        Self::bump_instance(&env);
        verifier.require_auth();

        let key = StorageKey::HasVoted(submission_id, verifier.clone());
        if env.storage().persistent().has(&key) {
            panic_with_error!(&env, VoteError::AlreadyVoted);
        }

        env.storage().persistent().set(&key, &vote);
        Self::bump(&env, &key);
    }

    fn validate_reward_asset(env: &Env, token: &Address) {
        if *token == env.current_contract_address() {
            panic_with_error!(env, ContractError::InvalidRewardAsset);
        }
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

    fn increase_liability(env: &Env, token: &Address, amount: i128) {
        let key = StorageKey::RewardLiability(token.clone());
        let current = Self::get_reward_liability_internal(env, token);
        let value = current
            .checked_add(amount)
            .unwrap_or_else(|| panic_with_error!(env, ContractError::PoolBalanceOverflow));
        env.storage().persistent().set(&key, &value);
        Self::bump(env, &key);
    }

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
