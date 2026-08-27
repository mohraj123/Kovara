#![no_std]
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error,
    symbol_short, token, Address, BytesN, Env, Map, String, Symbol, Vec,
};

// ── Storage Key Enum ──────────────────────────────────────────────────────────

/// Distinguishes the two reward roles tracked on-chain by flow_rewards.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RewardRole {
    Submitter,
    Verifier,
}

#[contracttype]
pub enum StorageKey {
    Post(u64),                 // persistent: post_id -> Post
    Profile(Address),          // persistent: user -> Profile
    Following(Address),        // persistent: user -> Vec<Address> of accounts they follow
    Followers(Address),        // persistent: user -> Vec<Address> of accounts following them
    Pool(Symbol),              // persistent: pool_id -> Pool
    Like(u64, Address),        // persistent: (post_id, user) -> bool
    AuthorPosts(Address),      // persistent: author -> Vec<u64> of post IDs
    Blocks(Address),           // persistent: blocker -> Map<Address, ()>
    UsernameIndex(String), // persistent: username -> owner Address (reverse index for uniqueness)
    TipCooldown(u64, Address), // temporary: (post_id, tipper) -> last-tip ledger sequence number
    PriceObservation(Address, String, u64), // persistent: contributor/item/period -> observation
    PriceRate(Address), // persistent: contributor -> last submission ledger
    PriceStake(Address), // persistent: contributor -> locked stake
    Proposal(u64),              // persistent: proposal_id -> Proposal
    RewardBalance(RewardRole, Address, Address), // persistent: (role, user, token) -> i128
    RewardLiability(Address),     // persistent: token -> total unclaimed rewards
    Verifier(Address),          // persistent: registered verifier marker
  // persistent: (verifier, token) -> i128
    VoteRound(u64),                            // persistent: submission_id -> VoteRound
    HasVoted(u64, Address),                    // persistent: (submission_id, verifier) -> bool
}

// ── Error Codes ────────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ContractError {
    AlreadyInitialized = 1,
    InvalidFee = 2,
    InvalidUsername = 3,
    InvalidCreatorToken = 4,
    UsernameTaken = 5,
    ProfileDoesNotExist = 6,
    Blocked = 7,
    InvalidContent = 8,
    PostDoesNotExist = 9,
    OnlyAuthorCanDeletePost = 10,
    InvalidPaginationLimit = 11,
    TipAmountMustBePositive = 12,
    WrongTokenForTip = 13,
    TipCooldownNotExpired = 14,
    PoolAlreadyExists = 15,
    InvalidThreshold = 16,
    DepositAmountMustBePositive = 17,
    PoolNotFound = 18,
    WrongTokenForPool = 19,
    MustBePositive = 20,
    InsufficientSigners = 21,
    UnauthorizedSigner = 22,
    LowBalance = 23,
    AdminAlreadyExists = 24,
    AdminNotFound = 25,
    ThresholdUnreachable = 26,
    ThresholdMustBePositive = 27,
    ThresholdExceedsAdminCount = 28,
    CooldownMustBePositive = 29,
    NotInitialized = 30,
    TreasuryNotSet = 31,
    FeeCalculationOverflow = 32,
    TipTotalOverflow = 33,
    PoolBalanceOverflow = 34,
    PoolBalanceUnderflow = 35,
    PostNotFound = 36,
    UsernameTooShort = 37,
    UsernameTooLong = 38,
    InvalidUsernameCharacter = 39,
    CreatorTokenCannotBeContract = 40,
    ContentTooShort = 41,
    ContentTooLong = 42,
    TreasuryCannotBeContract = 43,
    NoOpFeeUpdate = 44,
    InvalidWasmHash = 43,
    InvalidRewardAsset = 45,
    RewardFundsReserved = 46,
    RewardFundsUnavailable = 47,
    VerifierAlreadyRegistered = 45,
    VerifierNotRegistered = 46,
    StakeAmountMustBePositive = 47,
    StakeBalanceOverflow = 48,
    MinimumVerifierStakeMustBePositive = 52,
    InsufficientVerifierStake = 53,
    Paused = 45,
    InvalidWasmHash = 45,
    RoundAlreadyExists = 46,
    RoundNotFound = 47,
    RoundClosed = 48,
    RoundAlreadyFinalized = 49,
    AlreadyVoted = 50,
    RoundStillOpen = 51,
}

// ── Instance-storage key constants (small scalars, not contracttype) ──────────

const POST_CT: Symbol = symbol_short!("POST_CT");
const PROFILE_CREATED_CT: Symbol = symbol_short!("PROF_CT");
const ADMIN: Symbol = symbol_short!("ADMIN");
const TREASURY: Symbol = symbol_short!("TREASURY");
const FEE_BPS: Symbol = symbol_short!("FEE_BPS");
const INITIALIZED: Symbol = symbol_short!("INIT");
const TIP_COOLDOWN_WINDOW: Symbol = symbol_short!("TIP_CD_W");
const PRICE_SCALE: i128 = 100;
const PRICE_MAX: i128 = 9_000_000_000_000_000_000;
const PRICE_SUBMISSION_GAP: u32 = 1_728;
const PRICE_MIN_STAKE: i128 = 1;
const PRICE_DEPOSIT: i128 = 1;
const PRICE_EVENT_VERSION: Symbol = symbol_short!("v1");
const PROPOSAL_CT: Symbol = symbol_short!("PROP_CT");    pub(crate) const MIN_VERIFIER_STAKE: Symbol = symbol_short!("MIN_V_STK");
const PAUSED: Symbol = symbol_short!("PAUSED");

// ── TTL Constants ─────────────────────────────────────────────────────────────
//
// LEDGER_BUMP: target TTL (~30 days at 5s/ledger).
// LEDGER_THRESHOLD: extend only when remaining TTL falls below this value.

const LEDGER_BUMP: u32 = 535_000;
const LEDGER_THRESHOLD: u32 = 535_000 - 100;

// ── Tip Cooldown ──────────────────────────────────────────────────────────────
//
// TIP_COOLDOWN_LEDGERS: default per-tipper per-post cooldown (~1 day at 5s/ledger).

const TIP_COOLDOWN_LEDGERS: u32 = 17_280;

// ── Pagination Limit ──────────────────────────────────────────────────────────

const MAX_PAGE_LIMIT: u32 = 50;
const MAX_PAGINATION_LIMIT: u32 = 50;

// ── Validation Constants ──────────────────────────────────────────────────────

const MIN_USERNAME_LEN: u32 = 3;
const MAX_USERNAME_LEN: u32 = 32;
const MIN_CONTENT_LEN: u32 = 1;
const MAX_CONTENT_LEN: u32 = 280;

// ── Data Types ────────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug)]
pub struct Post {
    pub id: u64,
    pub author: Address,
    pub content: String,
    pub tip_total: i128,
    pub timestamp: u64,
    pub like_count: u64,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct Profile {
    pub address: Address,
    pub username: String,
    pub creator_token: Address,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct Pool {
    pub token: Address,
    pub balance: i128,
    pub admins: Vec<Address>,
    pub threshold: u32,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProposalStatus {
    Pending,
    Executed,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct Proposal {
    pub id: u64,
    pub pool_id: Symbol,
    pub proposer: Address,
    pub amount: i128,
    pub recipient: Address,
    pub signers: Vec<Address>,
    pub status: ProposalStatus,
}

// ── Events ────────────────────────────────────────────────────────────────────

#[contractevent]
#[derive(Clone)]
pub struct ProfileSetEvent {
    #[topic]
    pub user: Address,
    pub username: String,
    pub creator_token: Address,
}

#[contractevent]
#[derive(Clone)]
pub struct FollowEvent {
    #[topic]
    pub follower: Address,
    #[topic]
    pub followee: Address,
}

#[contractevent]
#[derive(Clone)]
pub struct UnfollowEvent {
    #[topic]
    pub follower: Address,
    #[topic]
    pub followee: Address,
}

#[contractevent]
#[derive(Clone)]
pub struct BlockEvent {
    #[topic]
    pub blocker: Address,
    #[topic]
    pub blocked: Address,
}

#[contractevent]
#[derive(Clone)]
pub struct UnblockEvent {
    #[topic]
    pub blocker: Address,
    #[topic]
    pub blocked: Address,
}

#[contractevent]
#[derive(Clone)]
pub struct PostCreatedEvent {
    #[topic]
    pub id: u64,
    #[topic]
    pub author: Address,
}

#[contractevent]
#[derive(Clone)]
pub struct PriceSubmittedEvent {
    #[topic]
    pub version: Symbol,
    #[topic]
    pub submitter: Address,
    #[topic]
    pub item: String,
    pub amount: i128,
    pub asset: Address,
    pub period: u64,
    pub timestamp: u64,
}

#[contractevent]
#[derive(Clone)]
pub struct TipEvent {
    #[topic]
    pub tipper: Address,
    #[topic]
    pub post_id: u64,
    pub amount: i128,
    pub fee: i128,
}

#[contractevent]
#[derive(Clone)]
pub struct PoolDepositEvent {
    #[topic]
    pub depositor: Address,
    #[topic]
    pub pool_id: Symbol,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone)]
pub struct PoolWithdrawEvent {
    #[topic]
    pub recipient: Address,
    #[topic]
    pub pool_id: Symbol,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone)]
pub struct PoolCreatedEvent {
    #[topic]
    pub pool_id: Symbol,
    pub token: Address,
    pub admins: Vec<Address>,
    pub threshold: u32,
}

#[contractevent]
#[derive(Clone)]
pub struct LikePostEvent {
    #[topic]
    pub user: Address,
    #[topic]
    pub post_id: u64,
}

#[contractevent]
#[derive(Clone)]
pub struct ContractUpgraded {
    pub new_wasm_hash: BytesN<32>,
}

#[contractevent]
#[derive(Clone)]
pub struct PostDeleted {
    #[topic]
    pub post_id: u64,
    #[topic]
    pub author: Address,
}

#[contractevent]
#[derive(Clone)]
pub struct ProposalCreatedEvent {
    #[topic]
    pub pool_id: Symbol,
    #[topic]
    pub proposal_id: u64,
    pub proposer: Address,
    pub amount: i128,
    pub recipient: Address,
}

#[contractevent]
#[derive(Clone)]
pub struct ProposalSignedEvent {
    #[topic]
    pub pool_id: Symbol,
    #[topic]
    pub proposal_id: u64,
    pub signer: Address,
}

#[contractevent]
#[derive(Clone)]
pub struct ProposalExecutedEvent {
    #[topic]
    pub pool_id: Symbol,
    #[topic]
    pub proposal_id: u64,
    pub amount: i128,
    pub recipient: Address,
}

#[contractevent]
#[derive(Clone)]
pub struct PoolAdminAddedEvent {
    #[topic]
    pub pool_id: Symbol,
    pub new_admin: Address,
}

#[contractevent]
#[derive(Clone)]
pub struct PoolAdminRemovedEvent {
    #[topic]
    pub pool_id: Symbol,
    pub admin: Address,
}

#[contractevent]
#[derive(Clone)]
pub struct PoolThresholdUpdatedEvent {
    #[topic]
    pub pool_id: Symbol,
    pub old_threshold: u32,
    pub new_threshold: u32,
}

#[contractevent]
#[derive(Clone)]
pub struct FeeUpdatedEvent {
    #[topic]
    pub name: Symbol,
    pub old_fee_bps: u32,
    pub new_fee_bps: u32,
}

#[contractevent]
#[derive(Clone)]
pub struct TreasuryUpdatedEvent {
    #[topic]
    pub name: Symbol,
    pub old_treasury: Address,
    pub new_treasury: Address,
}

#[contractevent]
#[derive(Clone)]
pub struct PauseEvent {
    pub admin: Address,
}

#[contractevent]
#[derive(Clone)]
pub struct UnpauseEvent {
    pub admin: Address,
}
// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct KovaraContract;

// ── Validation Helpers ────────────────────────────────────────────────────────

fn validate_username(env: &Env, username: &String) {
    let bytes = username.to_bytes();
    let mut has_non_space = false;
    for i in 0..bytes.len() {
        let c = bytes.get(i).unwrap() as char;
        if !c.is_ascii_alphanumeric() && c != '_' {
            if c == ' ' || c == '\t' || c == '\n' || c == '\r' {
                continue;
            }
            panic_with_error!(env, ContractError::InvalidUsernameCharacter);
        }
        has_non_space = true;
    }
    if !has_non_space || bytes.len() == 0 {
        panic_with_error!(env, ContractError::InvalidUsername);
    }
    if bytes.len() < MIN_USERNAME_LEN {
        panic_with_error!(env, ContractError::UsernameTooShort);
    }
    if bytes.len() > MAX_USERNAME_LEN {
        panic_with_error!(env, ContractError::UsernameTooLong);
    }
}

fn validate_creator_token(env: &Env, token: &Address) {
    if *token == env.current_contract_address() {
        panic_with_error!(env, ContractError::CreatorTokenCannotBeContract);
    }
    let token_client = token::Client::new(env, token);
    token_client.name();
}

fn validate_content(env: &Env, content: &String) {
    let len = content.len();
    if len < MIN_CONTENT_LEN {
        panic_with_error!(env, ContractError::ContentTooShort);
    }
    if len > MAX_CONTENT_LEN {
        panic_with_error!(env, ContractError::ContentTooLong);
    }
}

fn paginate<T>(env: &Env, list: &Vec<T>, offset: u32, limit: u32) -> Vec<T>
where
    T: soroban_sdk::TryFromVal<Env, soroban_sdk::Val>
        + soroban_sdk::IntoVal<Env, soroban_sdk::Val>
        + Clone,
{
    let len = list.len();
    if offset >= len {
        return Vec::new(env);
    }
    let end = (offset + limit).min(len);
    let mut page = Vec::new(env);
    for i in offset..end {
        page.push_back(list.get(i).unwrap());
    }
    page
}

#[contractimpl]
impl KovaraContract {
    // ── Initialization ────────────────────────────────────────────────────────

    /// Initialize the contract. Must be called exactly once before any other
    /// entry point. Sets the contract admin, treasury address, and initial tip
    /// fee in basis points (`fee_bps` where 10 000 = 100%).
    ///
    /// # Panics
    /// - `AlreadyInitialized` if the contract has already been initialized.
    /// - `InvalidFee` if `fee_bps` exceeds 10 000.
    pub fn initialize(env: Env, admin: Address, treasury: Address, fee_bps: u32) {
        Self::bump_instance(&env);
        if env
            .storage()
            .instance()
            .get::<Symbol, bool>(&INITIALIZED)
            .unwrap_or(false)
        {
            panic_with_error!(&env, ContractError::AlreadyInitialized);
        }
        if fee_bps > 10_000 {
            panic_with_error!(&env, ContractError::InvalidFee);
        }
        env.storage().instance().set(&INITIALIZED, &true);
        env.storage().instance().set(&ADMIN, &admin);
        env.storage().instance().set(&TREASURY, &treasury);
        env.storage().instance().set(&FEE_BPS, &fee_bps);
        env.storage()
            .instance()
            .set(&TIP_COOLDOWN_WINDOW, &TIP_COOLDOWN_LEDGERS);
    }

    // ── Profiles ──────────────────────────────────────────────────────────────

    /// Create or update the caller's on-chain profile. The `username` must be
    /// 3–32 ASCII alphanumeric characters or underscores. `creator_token` is the
    /// SEP-41 token accepted for tips to this user.
    ///
    /// On update the reverse-index (username → address) is kept consistent: the
    /// old username is freed before the new one is claimed. The profile-creation
    /// counter is only incremented on first-time registration, never on updates.
    ///
    /// # Panics
    /// - `UsernameTaken` if `username` is already claimed by a different address.
    /// - `InvalidUsername` / `UsernameTooShort` / `UsernameTooLong` / `InvalidUsernameCharacter`
    ///   on malformed input.
    /// - `CreatorTokenCannotBeContract` if `creator_token` is the contract itself.
    pub fn set_profile(env: Env, user: Address, username: String, creator_token: Address) {
        Self::require_initialized(&env);
        Self::bump_instance(&env);
        user.require_auth();
        validate_username(&env, &username);
        validate_creator_token(&env, &creator_token);

        let key = StorageKey::Profile(user.clone());
        let username_index_key = StorageKey::UsernameIndex(username.clone());

        if let Some(existing_owner) = env
            .storage()
            .persistent()
            .get::<_, Address>(&username_index_key)
        {
            if existing_owner != user {
                panic_with_error!(&env, ContractError::UsernameTaken);
            }
        }

        if let Some(existing_profile) = env.storage().persistent().get::<_, Profile>(&key) {
            if existing_profile.username != username {
                env.storage()
                    .persistent()
                    .remove(&StorageKey::UsernameIndex(
                        existing_profile.username.clone(),
                    ));
            }
        }

        if !env.storage().persistent().has(&key) {
            let count: u64 = env
                .storage()
                .instance()
                .get(&PROFILE_CREATED_CT)
                .unwrap_or(0);
            env.storage()
                .instance()
                .set(&PROFILE_CREATED_CT, &(count + 1));
        }

        // Write profile.
        env.storage().persistent().set(
            &key,
            &Profile {
                address: user.clone(),
                username: username.clone(),
                creator_token: creator_token.clone(),
            },
        );
        env.storage().persistent().set(&username_index_key, &user);
        Self::bump(&env, &key);
        Self::bump(&env, &username_index_key);
        ProfileSetEvent { user, username, creator_token }.publish(&env);
    }

    pub fn get_profile(env: Env, user: Address) -> Option<Profile> {
        Self::require_initialized(&env);
        let key = StorageKey::Profile(user);
        let result: Option<Profile> = env.storage().persistent().get(&key);
        if result.is_some() {
            Self::bump(&env, &key);
        }
        result
    }

    /// Returns the total number of unique addresses that have ever called `set_profile`,
    /// i.e. the number of profiles ever created. This counter is never decremented —
    /// updating an existing profile does not increment it again.
    pub fn get_profile_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&PROFILE_CREATED_CT)
            .unwrap_or(0)
    }

    pub fn delete_profile(env: Env, user: Address) {
        Self::require_initialized(&env);
        Self::bump_instance(&env);
        user.require_auth();
        let key = StorageKey::Profile(user.clone());
        let profile: Profile = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| {
                panic_with_error!(&env, ContractError::ProfileDoesNotExist);
            });

        env.storage()
            .persistent()
            .remove(&StorageKey::UsernameIndex(profile.username));
        env.storage().persistent().remove(&key);
    }

    pub fn get_address_by_username(env: Env, username: String) -> Option<Address> {
        Self::require_initialized(&env);
        let key = StorageKey::UsernameIndex(username);
        let result: Option<Address> = env.storage().persistent().get(&key);
        if result.is_some() {
            Self::bump(&env, &key);
        }
        result
    }

    // ── Social Graph ──────────────────────────────────────────────────────────

    /// Follow `followee` from `follower`. Idempotent — following an already-followed
    /// address is a no-op. Updates both the `Following` and `Followers` lists and
    /// emits a `FollowEvent`.
    ///
    /// # Panics
    /// - `Blocked` if either party has blocked the other.
    pub fn follow(env: Env, follower: Address, followee: Address) {
        Self::require_initialized(&env);
        Self::bump_instance(&env);
        follower.require_auth();

        if Self::is_blocked(env.clone(), followee.clone(), follower.clone()) {
            panic_with_error!(&env, ContractError::Blocked);
        }
        if Self::is_blocked(env.clone(), follower.clone(), followee.clone()) {
            panic_with_error!(&env, ContractError::Blocked);
        }

        let following_key = StorageKey::Following(follower.clone());
        let mut following_list: Vec<Address> = env
            .storage()
            .persistent()
            .get(&following_key)
            .unwrap_or(Vec::new(&env));

        if !following_list.iter().any(|x| x == followee) {
            following_list.push_back(followee.clone());
            env.storage()
                .persistent()
                .set(&following_key, &following_list);
            Self::bump(&env, &following_key);

            let followers_key = StorageKey::Followers(followee.clone());
            let mut followers_list: Vec<Address> = env
                .storage()
                .persistent()
                .get(&followers_key)
                .unwrap_or(Vec::new(&env));
            followers_list.push_back(follower.clone());
            env.storage()
                .persistent()
                .set(&followers_key, &followers_list);
            Self::bump(&env, &followers_key);

            FollowEvent { follower, followee }.publish(&env);
        }
    }

    pub fn unfollow(env: Env, follower: Address, followee: Address) {
        Self::require_initialized(&env);
        Self::bump_instance(&env);
        follower.require_auth();

        let following_key = StorageKey::Following(follower.clone());
        let mut following_list: Vec<Address> = env
            .storage()
            .persistent()
            .get(&following_key)
            .unwrap_or(Vec::new(&env));

        if let Some(index) = following_list.iter().position(|addr| addr == followee) {
            following_list.remove(index as u32);
            env.storage()
                .persistent()
                .set(&following_key, &following_list);
            Self::bump(&env, &following_key);

            let followers_key = StorageKey::Followers(followee.clone());
            let mut followers_list: Vec<Address> = env
                .storage()
                .persistent()
                .get(&followers_key)
                .unwrap_or(Vec::new(&env));
            if let Some(f_index) = followers_list.iter().position(|addr| addr == follower) {
                followers_list.remove(f_index as u32);
                env.storage()
                    .persistent()
                    .set(&followers_key, &followers_list);
                Self::bump(&env, &followers_key);
            }

            UnfollowEvent { follower, followee }.publish(&env);
        }
    }

    pub fn get_following(env: Env, user: Address, offset: u32, limit: u32) -> Vec<Address> {
        Self::require_initialized(&env);
        if limit == 0 || limit > MAX_PAGINATION_LIMIT {
            panic_with_error!(&env, ContractError::InvalidPaginationLimit);
        }
        let key = StorageKey::Following(user);
        let list: Vec<Address> = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or(Vec::new(&env));
        if !list.is_empty() {
            Self::bump(&env, &key);
        }
        paginate(&env, &list, offset, limit)
    }

    pub fn get_followers(env: Env, user: Address, offset: u32, limit: u32) -> Vec<Address> {
        Self::require_initialized(&env);
        if limit == 0 || limit > MAX_PAGE_LIMIT {
            panic_with_error!(&env, ContractError::InvalidPaginationLimit);
        }
        let key = StorageKey::Followers(user);
        let list: Vec<Address> = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or(Vec::new(&env));
        if !list.is_empty() {
            Self::bump(&env, &key);
        }
        paginate(&env, &list, offset, limit)
    }

    // ── Block List ────────────────────────────────────────────────────────────

    pub fn block_user(env: Env, blocker: Address, blocked: Address) {
        Self::require_initialized(&env);
        Self::bump_instance(&env);
        blocker.require_auth();
        let key = StorageKey::Blocks(blocker.clone());
        let mut blocks: Map<Address, ()> = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or(Map::new(&env));
        blocks.set(blocked.clone(), ());
        env.storage().persistent().set(&key, &blocks);
        Self::bump(&env, &key);
        BlockEvent { blocker, blocked }.publish(&env);
    }

    pub fn unblock_user(env: Env, blocker: Address, blocked: Address) {
        Self::require_initialized(&env);
        Self::bump_instance(&env);
        blocker.require_auth();
        let key = StorageKey::Blocks(blocker.clone());
        let mut blocks: Map<Address, ()> = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or(Map::new(&env));
        blocks.remove(blocked.clone());
        env.storage().persistent().set(&key, &blocks);
        Self::bump(&env, &key);
        UnblockEvent { blocker, blocked }.publish(&env);
    }

    pub fn is_blocked(env: Env, blocker: Address, blocked: Address) -> bool {
        Self::require_initialized(&env);
        let blocks: Map<Address, ()> = env
            .storage()
            .persistent()
            .get(&StorageKey::Blocks(blocker))
            .unwrap_or(Map::new(&env));
        blocks.contains_key(blocked)
    }

    // ── Posts ─────────────────────────────────────────────────────────────────

    /// Publish a new post. `content` must be 1–280 characters. Returns the new
    /// post ID, which is a monotonically increasing counter stored in instance
    /// storage. Emits a `PostCreatedEvent`.
    ///
    /// # Panics
    /// - `ContentTooShort` / `ContentTooLong` if `content` is outside the allowed range.
    pub fn create_post(env: Env, author: Address, content: String) -> u64 {
        Self::require_initialized(&env);
        Self::bump_instance(&env);
        author.require_auth();
        validate_content(&env, &content);

        let id: u64 = env.storage().instance().get(&POST_CT).unwrap_or(0u64) + 1;
        let key = StorageKey::Post(id);
        env.storage().persistent().set(
            &key,
            &Post {
                id,
                author: author.clone(),
                content,
                tip_total: 0,
                timestamp: env.ledger().timestamp(),
                like_count: 0,
            },
        );
        Self::bump(&env, &key);
        env.storage().instance().set(&POST_CT, &id);

        // Track post ID under author's posts
        let author_key = StorageKey::AuthorPosts(author.clone());
        let mut author_posts: Vec<u64> = env
            .storage()
            .persistent()
            .get(&author_key)
            .unwrap_or(Vec::new(&env));
        author_posts.push_back(id);
        env.storage().persistent().set(&author_key, &author_posts);
        Self::bump(&env, &author_key);

        PostCreatedEvent { id, author }.publish(&env);
        id
    }

    /// Returns the total number of posts ever created, not the current active count.
    /// This counter is never decremented when posts are deleted.
    pub fn get_post_count(env: Env) -> u64 {
        Self::require_initialized(&env);
        env.storage().instance().get(&POST_CT).unwrap_or(0u64)
    }

    pub fn get_post(env: Env, id: u64) -> Option<Post> {
        Self::require_initialized(&env);
        let key = StorageKey::Post(id);
        let result: Option<Post> = env.storage().persistent().get(&key);
        if result.is_some() {
            Self::bump(&env, &key);
        }
        result
    }

    pub fn delete_post(env: Env, author: Address, post_id: u64) {
        Self::require_initialized(&env);
        Self::bump_instance(&env);
        author.require_auth();
        let key = StorageKey::Post(post_id);
        let post: Post = env.storage().persistent().get(&key).unwrap_or_else(|| {
            panic_with_error!(&env, ContractError::PostDoesNotExist);
        });
        if post.author != author {
            panic_with_error!(&env, ContractError::OnlyAuthorCanDeletePost);
        }
        env.storage().persistent().remove(&key);

        // Remove post ID from author's posts list
        let author_key = StorageKey::AuthorPosts(author.clone());
        if let Some(mut author_posts) = env
            .storage()
            .persistent()
            .get::<_, soroban_sdk::Vec<u64>>(&author_key)
        {
            if let Some(index) = author_posts.iter().position(|id| id == post_id) {
                author_posts.remove(index as u32);
                if author_posts.is_empty() {
                    env.storage().persistent().remove(&author_key);
                } else {
                    env.storage().persistent().set(&author_key, &author_posts);
                    Self::bump(&env, &author_key);
                }
            }
        }

        PostDeleted { post_id, author }.publish(&env);
    }

    pub fn get_posts_by_author(env: Env, author: Address, offset: u32, limit: u32) -> Vec<u64> {
        Self::require_initialized(&env);
        if limit == 0 || limit > MAX_PAGINATION_LIMIT {
            panic_with_error!(&env, ContractError::InvalidPaginationLimit);
        }

        let key = StorageKey::AuthorPosts(author);
        let posts: Vec<u64> = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or(Vec::new(&env));

        if posts.is_empty() {
            return Vec::new(&env);
        }

        Self::bump(&env, &key);
        paginate(&env, &posts, offset, limit)
    }

    // ── Reactions ─────────────────────────────────────────────────────────────

    /// Like a post. Idempotent — liking a post the user has already liked is a
    /// no-op. Increments `Post.like_count` in persistent storage and records the
    /// like under `StorageKey::Like(post_id, user)`.
    ///
    /// # Panics
    /// - `PostDoesNotExist` if `post_id` is not found.
    pub fn like_post(env: Env, user: Address, post_id: u64) {
        Self::require_initialized(&env);
        Self::bump_instance(&env);
        user.require_auth();

        let like_key = StorageKey::Like(post_id, user.clone());
        if env.storage().persistent().has(&like_key) {
            return;
        }

        let post_key = StorageKey::Post(post_id);
        if !env.storage().persistent().has(&post_key) {
            panic_with_error!(&env, ContractError::PostDoesNotExist);
        }
        let mut post: Post = env
            .storage()
            .persistent()
            .get(&post_key)
            .unwrap_or_else(|| {
                panic_with_error!(&env, ContractError::PostNotFound);
            });

        if post.author == user {
            panic_with_error!(&env, ContractError::CannotLikeOwnPost);
        }

        post.like_count += 1;
        env.storage().persistent().set(&post_key, &post);
        Self::bump(&env, &post_key);
        env.storage().persistent().set(&like_key, &true);
        Self::bump(&env, &like_key);
        LikePostEvent { user, post_id }.publish(&env);
    }

    pub fn get_like_count(env: Env, post_id: u64) -> u64 {
        Self::require_initialized(&env);
        let key = StorageKey::Post(post_id);
        let result: Option<Post> = env.storage().persistent().get(&key);
        result.map(|p| p.like_count).unwrap_or(0)
    }

    pub fn has_liked(env: Env, user: Address, post_id: u64) -> bool {
        Self::require_initialized(&env);
        let key = StorageKey::Like(post_id, user);
        env.storage().persistent().has(&key)
    }

    // ── Tipping ───────────────────────────────────────────────────────────────

    /// Tip the author of a post. Deducts the configured fee (in basis points) and
    /// transfers the remainder directly to the post author. The tip cooldown
    /// prevents a tipper from tipping the same post again within the configured
    /// ledger window.
    ///
    /// # Panics
    /// - `TipAmountMustBePositive` if `amount <= 0`.
    /// - `PostNotFound` if `post_id` does not exist.
    /// - `Blocked` if either the tipper or the author has blocked the other.
    /// - `WrongTokenForTip` if `token` does not match the author's `creator_token`.
    /// - `TipCooldownNotExpired` if a tip was made within the cooldown window.
    /// - `TreasuryNotSet` if the treasury address has not been configured.
    pub fn tip(env: Env, tipper: Address, post_id: u64, token: Address, amount: i128) {
        Self::require_not_paused(&env);
        Self::require_initialized(&env);
        Self::bump_instance(&env);
        if amount <= 0 {
            panic_with_error!(&env, ContractError::TipAmountMustBePositive);
        }
        tipper.require_auth();

        let key = StorageKey::Post(post_id);
        let mut post: Post = env.storage().persistent().get(&key).unwrap_or_else(|| {
            panic_with_error!(&env, ContractError::PostNotFound);
        });

        if Self::is_blocked(env.clone(), post.author.clone(), tipper.clone()) {
            panic_with_error!(&env, ContractError::Blocked);
        }
        if Self::is_blocked(env.clone(), tipper.clone(), post.author.clone()) {
            panic_with_error!(&env, ContractError::Blocked);
        }

        if let Some(profile) = env
            .storage()
            .persistent()
            .get::<_, Profile>(&StorageKey::Profile(post.author.clone()))
        {
            if profile.creator_token != token {
                panic_with_error!(&env, ContractError::WrongTokenForTip);
            }
        }

        // Check tip cooldown: one tip per tipper per post per cooldown window.
        let cooldown_key = StorageKey::TipCooldown(post_id, tipper.clone());
        let current_ledger = env.ledger().sequence();
        let cooldown_window: u32 = env
            .storage()
            .instance()
            .get(&TIP_COOLDOWN_WINDOW)
            .unwrap_or(1u32);

        if let Some(last_tip_ledger) = env.storage().temporary().get::<_, u32>(&cooldown_key) {
            let ledgers_elapsed = current_ledger.saturating_sub(last_tip_ledger);
            if ledgers_elapsed < cooldown_window {
                panic_with_error!(&env, ContractError::TipCooldownNotExpired);
            }
        }

        // Update last tip ledger
        env.storage()
            .temporary()
            .set(&cooldown_key, &current_ledger);
        Self::bump_temp(&env, &cooldown_key);

        let fee_bps = Self::get_fee_bps(env.clone());
        // Use checked arithmetic to prevent silent overflow on pathological inputs.
        // fee_bps is at most 10_000 (100%), so the multiplication can reach ~i128::MAX.
        let fee_amount = amount
            .checked_mul(fee_bps as i128)
            .unwrap_or_else(|| {
                panic_with_error!(&env, ContractError::FeeCalculationOverflow);
            })
            / 10_000;
        let author_amount = amount - fee_amount; // safe: fee_amount ≤ amount
        let token_client = token::Client::new(&env, &token);

        if fee_amount > 0 {
            let treasury: Address = env
                .storage()
                .instance()
                .get(&TREASURY)
                .unwrap_or_else(|| {
                    panic_with_error!(&env, ContractError::TreasuryNotSet);
                });
            token_client.transfer(&tipper, &treasury, &fee_amount);
        }
        token_client.transfer(&tipper, &post.author, &author_amount);

        post.tip_total = post.tip_total.checked_add(amount).unwrap_or_else(|| {
            panic_with_error!(&env, ContractError::TipTotalOverflow);
        });
        env.storage().persistent().set(&key, &post);
        Self::bump(&env, &key);

        TipEvent {
            tipper,
            post_id,
            amount,
            fee: fee_amount,
        }
        .publish(&env);
    }

    // ── Price observations ─────────────────────────────────────────────────────

    /// Submit a price as integer minor units scaled by 100 (two decimal places).
    /// Each contributor may submit one observation per item and period.
    pub fn submit_price(
        env: Env,
        submitter: Address,
        item: String,
        amount: i128,
        asset: Address,
        period: u64,
        stake: i128,
    ) {
        Self::bump_instance(&env);
        submitter.require_auth();
        assert!(!item.is_empty(), "item is required");
        assert!(amount > 0 && amount <= PRICE_MAX, "price out of range");
        assert!(stake >= PRICE_MIN_STAKE, "insufficient stake");
        assert!(period <= env.ledger().timestamp(), "period is in the future");

        let observation_key = StorageKey::PriceObservation(submitter.clone(), item.clone(), period);
        assert!(!env.storage().persistent().has(&observation_key), "duplicate observation");
        if let Some(last) = env.storage().persistent().get::<_, u32>(&StorageKey::PriceRate(submitter.clone())) {
            assert!(env.ledger().sequence().saturating_sub(last) >= PRICE_SUBMISSION_GAP, "submission rate limited");
        }

        let stake_key = StorageKey::PriceStake(submitter.clone());
        let current_stake: i128 = env.storage().persistent().get(&stake_key).unwrap_or(0);
        let token_client = token::Client::new(&env, &asset);
        token_client.transfer(&submitter, &env.current_contract_address(), &stake);
        token_client.transfer(&submitter, &env.current_contract_address(), &PRICE_DEPOSIT);
        env.storage().persistent().set(&stake_key, &(current_stake + stake));
        env.storage().persistent().set(&observation_key, &amount);
        env.storage().persistent().set(&StorageKey::PriceRate(submitter.clone()), &env.ledger().sequence());
        Self::bump(&env, &stake_key);
        Self::bump(&env, &observation_key);
        Self::bump(&env, &StorageKey::PriceRate(submitter.clone()));
        PriceSubmittedEvent { version: PRICE_EVENT_VERSION, submitter, item, amount, asset, period, timestamp: env.ledger().timestamp() }.publish(&env);
    }

    pub fn get_price(env: Env, submitter: Address, item: String, period: u64) -> Option<i128> {
        let key = StorageKey::PriceObservation(submitter, item, period);
        let result = env.storage().persistent().get(&key);
        if result.is_some() { Self::bump(&env, &key); }
        result
    }

    pub fn price_scale(_env: Env) -> i128 { PRICE_SCALE }

    // ── Community Pool ────────────────────────────────────────────────────────

    /// Create a named community pool identified by `pool_id`. The pool holds a
    /// single `token` type and is governed by `initial_admins` with an M-of-N
    /// `threshold` required for withdrawals, admin changes, and threshold updates.
    ///
    /// # Panics
    /// - `PoolAlreadyExists` if a pool with `pool_id` already exists.
    /// - `InvalidThreshold` if `threshold` is 0 or exceeds the number of initial admins.
    pub fn create_pool(
        env: Env,
        admin: Address,
        pool_id: Symbol,
        token: Address,
        initial_admins: Vec<Address>,
        threshold: u32,
    ) {
        Self::require_initialized(&env);
        Self::bump_instance(&env);
        admin.require_auth();
        Self::require_admin(&env);
        let key = StorageKey::Pool(pool_id.clone());
        if env.storage().persistent().has(&key) {
            panic_with_error!(&env, ContractError::PoolAlreadyExists);
        }
        if threshold == 0 || threshold > initial_admins.len() {
            panic_with_error!(&env, ContractError::InvalidThreshold);
        }

        // Clone admins for event payload before moving into storage
        let admins_for_event = initial_admins.clone();
        let token_copy = token.clone();
        env.storage().persistent().set(
            &key,
            &Pool {
                token,
                balance: 0,
                admins: initial_admins,
                threshold,
            },
        );
        Self::bump(&env, &key);

        PoolCreatedEvent {
            pool_id,
            token: token_copy,
            admins: admins_for_event,
            threshold,
        }
        .publish(&env);
    }

    pub fn pool_deposit(
        env: Env,
        depositor: Address,
        pool_id: Symbol,
        token: Address,
        amount: i128,
    ) {
        Self::require_not_paused(&env);
        Self::require_initialized(&env);
        Self::bump_instance(&env);
        if amount <= 0 {
            panic_with_error!(&env, ContractError::DepositAmountMustBePositive);
        }
        depositor.require_auth();
        let key = StorageKey::Pool(pool_id.clone());
        let mut pool: Pool = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| {
                panic_with_error!(&env, ContractError::PoolNotFound);
            });
        if pool.token != token {
            panic_with_error!(&env, ContractError::WrongTokenForPool);
        }

        token::Client::new(&env, &token).transfer(
            &depositor,
            env.current_contract_address(),
            &amount,
        );
        pool.balance = pool.balance.checked_add(amount).unwrap_or_else(|| {
            panic_with_error!(&env, ContractError::PoolBalanceOverflow);
        });
        env.storage().persistent().set(&key, &pool);
        Self::bump(&env, &key);

        PoolDepositEvent {
            depositor,
            pool_id,
            amount,
        }
        .publish(&env);
    }

    /// Withdraw from a pool. Requires `threshold` valid admin signatures.
    pub fn pool_withdraw(
        env: Env,
        signers: Vec<Address>,
        pool_id: Symbol,
        amount: i128,
        recipient: Address,
    ) {
        Self::require_not_paused(&env);
        Self::require_initialized(&env);
        Self::bump_instance(&env);
        if amount <= 0 {
            panic_with_error!(&env, ContractError::MustBePositive);
        }
        let key = StorageKey::Pool(pool_id.clone());
        let mut pool: Pool = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| {
                panic_with_error!(&env, ContractError::PoolNotFound);
            });

        // Deduplicate signers to count only unique valid signers
        let mut unique_signers = Vec::new(&env);
        for signer in signers.iter() {
            if !unique_signers.iter().any(|x| x == signer) {
                unique_signers.push_back(signer.clone());
            }
        }
        
        if unique_signers.len() < pool.threshold {
            panic_with_error!(&env, ContractError::InsufficientSigners);
        }
        for signer in unique_signers.iter() {
            if !pool.admins.iter().any(|x| x == signer) {
                panic_with_error!(&env, ContractError::UnauthorizedSigner);
            }
            signer.require_auth();
        }
        if pool.balance < amount {
            panic_with_error!(&env, ContractError::LowBalance);
        }

        pool.balance = pool.balance.checked_sub(amount).unwrap_or_else(|| {
            panic_with_error!(&env, ContractError::PoolBalanceUnderflow);
        });
        env.storage().persistent().set(&key, &pool);
        Self::bump(&env, &key);
        token::Client::new(&env, &pool.token).transfer(
            &env.current_contract_address(),
            &recipient,
            &amount,
        );

        PoolWithdrawEvent {
            recipient,
            pool_id,
            amount,
        }
        .publish(&env);
    }

    pub fn get_pool(env: Env, pool_id: Symbol) -> Option<Pool> {
        Self::require_initialized(&env);
        let key = StorageKey::Pool(pool_id);
        let result: Option<Pool> = env.storage().persistent().get(&key);
        if result.is_some() {
            Self::bump(&env, &key);
        }
        result
    }

    pub fn get_pool_admins(env: Env, pool_id: Symbol) -> Vec<Address> {
        Self::require_initialized(&env);
        let key = StorageKey::Pool(pool_id);
        let pool: Pool = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| {
                panic_with_error!(&env, ContractError::PoolNotFound);
            });
        Self::bump(&env, &key);
        pool.admins
    }

    pub fn add_pool_admin(env: Env, signers: Vec<Address>, pool_id: Symbol, new_admin: Address) {
        Self::require_initialized(&env);
        Self::bump_instance(&env);
        let key = StorageKey::Pool(pool_id.clone());
        let mut pool: Pool = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| {
                panic_with_error!(&env, ContractError::PoolNotFound);
            });

        // Deduplicate signers to count only unique valid signers
        let mut unique_signers = Vec::new(&env);
        for signer in signers.iter() {
            if !unique_signers.iter().any(|x| x == signer) {
                unique_signers.push_back(signer.clone());
            }
        }
        
        if unique_signers.len() < pool.threshold {
            panic_with_error!(&env, ContractError::InsufficientSigners);
        }
        for signer in unique_signers.iter() {
            if !pool.admins.iter().any(|x| x == signer) {
                panic_with_error!(&env, ContractError::UnauthorizedSigner);
            }
            signer.require_auth();
        }

        if pool.admins.iter().any(|x| x == new_admin) {
            panic_with_error!(&env, ContractError::AdminAlreadyExists);
        }

        pool.admins.push_back(new_admin.clone());
        env.storage().persistent().set(&key, &pool);
        Self::bump(&env, &key);

        PoolAdminAddedEvent { pool_id, new_admin }.publish(&env);
    }

    pub fn remove_pool_admin(env: Env, signers: Vec<Address>, pool_id: Symbol, admin: Address) {
        Self::require_initialized(&env);
        Self::bump_instance(&env);
        let key = StorageKey::Pool(pool_id.clone());
        let mut pool: Pool = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| {
                panic_with_error!(&env, ContractError::PoolNotFound);
            });

        // Deduplicate signers to count only unique valid signers
        let mut unique_signers = Vec::new(&env);
        for signer in signers.iter() {
            if !unique_signers.iter().any(|x| x == signer) {
                unique_signers.push_back(signer.clone());
            }
        }
        
        if unique_signers.len() < pool.threshold {
            panic_with_error!(&env, ContractError::InsufficientSigners);
        }
        for signer in unique_signers.iter() {
            if !pool.admins.iter().any(|x| x == signer) {
                panic_with_error!(&env, ContractError::UnauthorizedSigner);
            }
            signer.require_auth();
        }

        let initial_len = pool.admins.len();
        let mut new_admins = Vec::new(&env);
        for existing_admin in pool.admins.iter() {
            if existing_admin != admin {
                new_admins.push_back(existing_admin.clone());
            }
        }
        pool.admins = new_admins;

        if pool.admins.len() >= initial_len {
            panic_with_error!(&env, ContractError::AdminNotFound);
        }
        // Prevent removing the last admin to avoid ungovernable state
        if pool.admins.is_empty() {
            panic_with_error!(&env, ContractError::ThresholdUnreachable);
        }
        if pool.threshold > pool.admins.len() {
            panic_with_error!(&env, ContractError::ThresholdUnreachable);
        }

        env.storage().persistent().set(&key, &pool);
        Self::bump(&env, &key);

        PoolAdminRemovedEvent { pool_id, admin }.publish(&env);
    }

    pub fn update_pool_threshold(env: Env, signers: Vec<Address>, pool_id: Symbol, threshold: u32) {
        Self::require_initialized(&env);
        Self::bump_instance(&env);
        if threshold == 0 {
            panic_with_error!(&env, ContractError::ThresholdMustBePositive);
        }
        let key = StorageKey::Pool(pool_id.clone());
        let mut pool: Pool = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| {
                panic_with_error!(&env, ContractError::PoolNotFound);
            });

        // Deduplicate signers to count only unique valid signers
        let mut unique_signers = Vec::new(&env);
        for signer in signers.iter() {
            if !unique_signers.iter().any(|x| x == signer) {
                unique_signers.push_back(signer.clone());
            }
        }
        
        if unique_signers.len() < pool.threshold {
            panic_with_error!(&env, ContractError::InsufficientSigners);
        }
        for signer in unique_signers.iter() {
            if !pool.admins.iter().any(|x| x == signer) {
                panic_with_error!(&env, ContractError::UnauthorizedSigner);
            }
            signer.require_auth();
        }

        if threshold > pool.admins.len() {
            panic_with_error!(&env, ContractError::ThresholdExceedsAdminCount);
        }

        let old_threshold = pool.threshold;
        pool.threshold = threshold;
        env.storage().persistent().set(&key, &pool);
        Self::bump(&env, &key);

        PoolThresholdUpdatedEvent {
            pool_id,
            old_threshold,
            new_threshold: threshold,
        }
        .publish(&env);
    }


    // ── Proposals ─────────────────────────────────────────────────────────────

    /// Create a withdrawal proposal for a pool. The `proposer` must be a pool
    /// admin. They are automatically counted as the first signer. If the pool
    /// threshold is 1 the proposal is executed immediately and `amount` tokens
    /// are transferred to `recipient`.
    pub fn create_proposal(
        env: Env,
        proposer: Address,
        pool_id: Symbol,
        amount: i128,
        recipient: Address,
    ) -> u64 {
        Self::require_initialized(&env);
        Self::bump_instance(&env);
        proposer.require_auth();
        if amount <= 0 {
            panic_with_error!(&env, ContractError::MustBePositive);
        }
        let pool_key = StorageKey::Pool(pool_id.clone());
        let mut pool: Pool = env
            .storage()
            .persistent()
            .get(&pool_key)
            .unwrap_or_else(|| {
                panic_with_error!(&env, ContractError::PoolNotFound);
            });
        if !pool.admins.iter().any(|a| a == proposer) {
            panic_with_error!(&env, ContractError::UnauthorizedSigner);
        }
        if pool.balance < amount {
            panic_with_error!(&env, ContractError::LowBalance);
        }

        let proposal_id: u64 = env
            .storage()
            .instance()
            .get(&PROPOSAL_CT)
            .unwrap_or(0u64);
        env.storage()
            .instance()
            .set(&PROPOSAL_CT, &(proposal_id + 1));

        let mut signers = Vec::new(&env);
        signers.push_back(proposer.clone());

        let auto_execute = signers.len() >= pool.threshold;

        let status = if auto_execute {
            let token_addr = pool.token.clone();
            pool.balance = pool.balance.checked_sub(amount).unwrap_or_else(|| {
                panic_with_error!(&env, ContractError::PoolBalanceUnderflow);
            });
            env.storage().persistent().set(&pool_key, &pool);
            Self::bump(&env, &pool_key);
            token::Client::new(&env, &token_addr).transfer(
                &env.current_contract_address(),
                &recipient,
                &amount,
            );
            ProposalExecutedEvent {
                pool_id: pool_id.clone(),
                proposal_id,
                amount,
                recipient: recipient.clone(),
            }
            .publish(&env);
            ProposalStatus::Executed
        } else {
            ProposalStatus::Pending
        };

        let proposal = Proposal {
            id: proposal_id,
            pool_id: pool_id.clone(),
            proposer: proposer.clone(),
            amount,
            recipient: recipient.clone(),
            signers,
            status,
        };
        let prop_key = StorageKey::Proposal(proposal_id);
        env.storage().persistent().set(&prop_key, &proposal);
        Self::bump(&env, &prop_key);

        ProposalCreatedEvent {
            pool_id,
            proposal_id,
            proposer,
            amount,
            recipient,
        }
        .publish(&env);

        proposal_id
    }

    /// Sign an existing proposal. `signer` must be a pool admin for the
    /// proposal's pool and must not have already signed. Once the number of
    /// unique signers reaches the pool threshold the proposal is executed
    /// automatically and funds are transferred to `recipient`.
    pub fn sign_proposal(env: Env, signer: Address, proposal_id: u64) {
        Self::require_not_paused(&env);
        Self::require_initialized(&env);
        Self::bump_instance(&env);
        signer.require_auth();

        let prop_key = StorageKey::Proposal(proposal_id);
        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&prop_key)
            .unwrap_or_else(|| {
                // Reuse PoolNotFound as the closest semantic error for a missing proposal.
                panic_with_error!(&env, ContractError::PoolNotFound);
            });

        let pool_key = StorageKey::Pool(proposal.pool_id.clone());
        let mut pool: Pool = env
            .storage()
            .persistent()
            .get(&pool_key)
            .unwrap_or_else(|| {
                panic_with_error!(&env, ContractError::PoolNotFound);
            });

        if !pool.admins.iter().any(|a| a == signer) {
            panic_with_error!(&env, ContractError::UnauthorizedSigner);
        }
        if proposal.signers.iter().any(|s| s == signer) {
            // Already signed — idempotent, no-op.
            return;
        }

        proposal.signers.push_back(signer.clone());

        ProposalSignedEvent {
            pool_id: proposal.pool_id.clone(),
            proposal_id,
            signer,
        }
        .publish(&env);

        if proposal.signers.len() >= pool.threshold {
            let token_addr = pool.token.clone();
            pool.balance = pool
                .balance
                .checked_sub(proposal.amount)
                .unwrap_or_else(|| {
                    panic_with_error!(&env, ContractError::PoolBalanceUnderflow);
                });
            env.storage().persistent().set(&pool_key, &pool);
            Self::bump(&env, &pool_key);
            token::Client::new(&env, &token_addr).transfer(
                &env.current_contract_address(),
                &proposal.recipient,
                &proposal.amount,
            );
            proposal.status = ProposalStatus::Executed;
            ProposalExecutedEvent {
                pool_id: proposal.pool_id.clone(),
                proposal_id,
                amount: proposal.amount,
                recipient: proposal.recipient.clone(),
            }
            .publish(&env);
        }

        env.storage().persistent().set(&prop_key, &proposal);
        Self::bump(&env, &prop_key);
    }

    /// Return the proposal with the given `proposal_id`, or `None` if it does
    /// not exist.
    pub fn get_proposal(env: Env, proposal_id: u64) -> Option<Proposal> {
        Self::require_initialized(&env);
        let key = StorageKey::Proposal(proposal_id);
        let result: Option<Proposal> = env.storage().persistent().get(&key);
        if result.is_some() {
            Self::bump(&env, &key);
        }
        result
    }

    // ── Fee & Treasury ────────────────────────────────────────────────────────

    /// Update the protocol tip fee. Only callable by the contract admin.
    /// `fee_bps` is expressed in basis points (10 000 = 100%).
    ///
    /// # Panics
    /// - `InvalidFee` if `fee_bps > 10_000`.
    /// - `NoOpFeeUpdate` if the new value is identical to the current value.
    pub fn set_fee(env: Env, fee_bps: u32) {
        Self::require_initialized(&env);
        Self::bump_instance(&env);
        Self::require_admin(&env);
        if fee_bps > 10_000 {
            panic_with_error!(&env, ContractError::InvalidFee);
        }
        let old_fee_bps = Self::get_fee_bps(env.clone());
        if old_fee_bps == fee_bps {
            panic_with_error!(&env, ContractError::NoOpFeeUpdate);
        }
        env.storage().instance().set(&FEE_BPS, &fee_bps);
        FeeUpdatedEvent {
            name: symbol_short!("fee_upd"),
            old_fee_bps,
            new_fee_bps: fee_bps,
        }
        .publish(&env);
    }

    /// Update the treasury address that receives the protocol fee on each tip.
    /// Only callable by the contract admin.
    ///
    /// # Panics
    /// - `TreasuryCannotBeContract` if `treasury` is the contract address itself.
    /// - `NoOpFeeUpdate` if the new address is identical to the current treasury.
    pub fn set_treasury(env: Env, treasury: Address) {
        Self::require_initialized(&env);
        Self::bump_instance(&env);
        Self::require_admin(&env);
        if treasury == env.current_contract_address() {
            panic_with_error!(&env, ContractError::TreasuryCannotBeContract);
        }
        let old_treasury = Self::get_treasury(env.clone()).unwrap_or_else(|| {
            panic_with_error!(&env, ContractError::TreasuryNotSet);
        });
        if old_treasury == treasury {
            panic_with_error!(&env, ContractError::NoOpFeeUpdate);
        }
        env.storage().instance().set(&TREASURY, &treasury);
        TreasuryUpdatedEvent {
            name: symbol_short!("treas_upd"),
            old_treasury,
            new_treasury: treasury,
        }
        .publish(&env);
    }

    pub fn get_fee_bps(env: Env) -> u32 {
        Self::require_initialized(&env);
        env.storage().instance().get(&FEE_BPS).unwrap_or(0u32)
    }

    pub fn get_treasury(env: Env) -> Option<Address> {
        Self::require_initialized(&env);
        env.storage().instance().get(&TREASURY)
    }

    pub fn set_tip_cooldown_window(env: Env, cooldown_ledgers: u32) {
        Self::require_initialized(&env);
        Self::bump_instance(&env);
        Self::require_admin(&env);
        if cooldown_ledgers == 0 {
            panic_with_error!(&env, ContractError::CooldownMustBePositive);
        }
        env.storage()
            .instance()
            .set(&TIP_COOLDOWN_WINDOW, &cooldown_ledgers);
    }

    pub fn get_tip_cooldown_window(env: Env) -> u32 {
        Self::require_initialized(&env);
        env.storage()
            .instance()
            .get(&TIP_COOLDOWN_WINDOW)
            .unwrap_or(1u32)
    }

    // ── Upgradability ─────────────────────────────────────────────────────────

    /// Upgrade the contract WASM. Only callable by the contract admin.
    /// Emits a `ContractUpgraded` event.
    ///
    /// # Panics
    /// - `InvalidWasmHash` if the hash is not exactly 32 bytes.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        Self::bump_instance(&env);
        Self::require_admin(&env);
        if new_wasm_hash.len() != 32 {
            panic_with_error!(&env, ContractError::InvalidWasmHash);
        }
        env.deployer()
            .update_current_contract_wasm(new_wasm_hash.clone());
        ContractUpgraded { new_wasm_hash }.publish(&env);
    }

    // ── Internal Helpers ──────────────────────────────────────────────────────

    fn require_initialized(env: &Env) {
        if !env
            .storage()
            .instance()
            .get::<Symbol, bool>(&INITIALIZED)
            .unwrap_or(false)
        {
            panic_with_error!(env, ContractError::NotInitialized);
        }
    }

    fn require_admin(env: &Env) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&ADMIN)
            .unwrap_or_else(|| {
                panic_with_error!(env, ContractError::NotInitialized);
            });
        admin.require_auth();
    }

    /// Extend the TTL of a persistent entry after every write and on every
    /// successful read to keep active data alive on-chain.
    fn bump<K: soroban_sdk::IntoVal<Env, soroban_sdk::Val>>(env: &Env, key: &K) {
        env.storage()
            .persistent()
            .extend_ttl(key, LEDGER_THRESHOLD, LEDGER_BUMP);
    }

    /// Extend the TTL of a temporary entry.
    fn bump_temp<K: soroban_sdk::IntoVal<Env, soroban_sdk::Val>>(env: &Env, key: &K) {
        env.storage()
            .temporary()
            .extend_ttl(key, LEDGER_THRESHOLD, LEDGER_BUMP);
    }

    /// Extend the TTL of instance storage entries on every mutating operation.
    fn bump_instance(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(LEDGER_THRESHOLD, LEDGER_BUMP);
    }

    pub fn pause(env: Env) {
        Self::require_initialized(&env);
        Self::bump_instance(&env);
        Self::require_admin(&env);
        env.storage().instance().set(&PAUSED, &true);
        let admin: Address = env.storage().instance().get(&ADMIN).unwrap();
        PauseEvent { admin }.publish(&env);
    }

    pub fn unpause(env: Env) {
        Self::require_initialized(&env);
        Self::bump_instance(&env);
        Self::require_admin(&env);
        env.storage().instance().set(&PAUSED, &false);
        let admin: Address = env.storage().instance().get(&ADMIN).unwrap();
        UnpauseEvent { admin }.publish(&env);
    }

    pub fn is_paused(env: Env) -> bool {
        Self::require_initialized(&env);
        env.storage().instance().get(&PAUSED).unwrap_or(false)
    }

    pub(crate) fn require_not_paused(env: &Env) {
        if env.storage().instance().get(&PAUSED).unwrap_or(false) {
            panic_with_error!(env, ContractError::Paused);
        }
    }
}

mod test;
pub mod flow_rewards;
pub mod sentinel_pool;

#[cfg(test)]
mod sentinel_pool_test;
