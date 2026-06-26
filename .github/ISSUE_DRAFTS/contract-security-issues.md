# Contract Security Issue — Sample Reports

These drafts show what a well-formed security issue looks like for Kovara's Soroban contracts.
Use labels: `contracts`, `security`, plus the applicable severity label.

> ⚠️ These are **Medium / Low** severity examples only.
> Critical and High issues must be reported privately via [GitHub Security Advisories](../../security/advisories/new).
> See [SECURITY.md](../../blob/main/SECURITY.md) for severity definitions.

---

## Sample 1 — `tip`: no guard against zero or negative amounts

**Labels:** `contracts`, `security`, `bug`, `good first issue`
**Severity:** Low

### Affected Function

`tip`

### Description

`tip` accepts an `i128` amount and adds it to `post.tip_total` without validating that `amount > 0`.
Passing `0` or a negative value succeeds silently, leaving the ledger in a misleading state and
potentially enabling a caller to trigger a token transfer call with a nonsensical amount.

### Security Impact

A caller can invoke `tip(env, post_id, token, 0)` without paying anything, incrementing the call
count logged by any off-chain indexer. With a negative amount, the behaviour depends on the token
contract; on some implementations this could reduce the recipient's balance.

### Reproduction

```rust
#[test]
fn test_tip_zero_amount_should_fail() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, KovaraContract);
    let client = KovaraContractClient::new(&env, &contract_id);

    let author = Address::generate(&env);
    let tipper = Address::generate(&env);
    let token = // ... set up a test token

    client.set_profile(&author, &String::from_str(&env, "author"), &false);
    let post_id = client.create_post(&author, &String::from_str(&env, "hello"), &None);

    // This should panic / return an error — currently it does not
    client.tip(&tipper, &post_id, &token, &0i128);
}
```

### Suggested Fix

```rust
pub fn tip(env: Env, tipper: Address, post_id: u64, token: Address, amount: i128) {
    require!(amount > 0, Error::InvalidAmount);
    // ... rest of function
}
```

---

## Sample 2 — `pool_withdraw`: missing guard on zero withdrawal

**Labels:** `contracts`, `security`, `bug`, `good first issue`
**Severity:** Low

### Affected Function

`pool_withdraw`

### Description

`pool_withdraw` checks that the stored pool balance is sufficient, but it does not reject a
withdrawal of `0` or a negative amount before performing the balance check and token transfer call.

### Security Impact

A zero-amount withdrawal consumes ledger resources and emits a misleading transfer event with no
economic effect. A negative amount, if not caught by the token contract, could reverse the flow
of funds.

### Reproduction

```rust
#[test]
fn test_pool_withdraw_zero_should_fail() {
    // ... set up env, contract, token, deposit some balance
    // This should panic — currently succeeds
    client.pool_withdraw(&depositor, &token, &0i128);
}
```

### Suggested Fix

```rust
pub fn pool_withdraw(env: Env, user: Address, token: Address, amount: i128) {
    require!(amount > 0, Error::InvalidAmount);
    // ... existing balance check and transfer
}
```

---

## Sample 3 — `block_user`: blocked user can still tip posts by the blocker

**Labels:** `contracts`, `security`, `Medium`
**Severity:** Medium

### Affected Function

`tip`, `block_user`

### Description

`block_user` prevents the blocker from seeing posts by the blocked address in off-chain feeds,
but the contract's `tip` function does not check the block relationship before executing a token
transfer. A blocked user can therefore still send tips to the blocker's posts.

### Security Impact

A harassing actor can spam micro-tips to a user who has blocked them, keeping a ledger interaction
channel open even after being blocked.

### Reproduction

```rust
#[test]
fn test_blocked_user_cannot_tip() {
    // ... set up env, author, blocked_user
    client.block_user(&author, &blocked_user);

    // Should fail — currently succeeds
    client.tip(&blocked_user, &post_id, &token, &1i128);
}
```

### Suggested Fix

In `tip`, retrieve the block list for the post author and panic if `tipper` is present:

```rust
let blocked = get_blocked_list(&env, &post.author);
require!(!blocked.contains(&tipper), Error::Blocked);
```
