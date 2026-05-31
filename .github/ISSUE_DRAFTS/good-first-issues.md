# Good First Issue Drafts

These drafts are scoped for new contributors while still moving Linkora-social forward. Each issue should include `good first issue` plus the listed labels. Create any missing labels from the label reference at the bottom.

---

## 1. Add tests for duplicate follows

Labels: `good first issue`, `tests`, `contracts`

### Context

`follow` already avoids adding the same followee twice, but the behavior is only covered indirectly. A focused test will help contributors understand the social graph storage path and prevent regressions.

### Scope

- Add a unit test in `packages/contracts/contracts/linkora-contracts/src/test.rs`.
- Follow the same account twice from the same follower.
- Assert `get_following` still returns exactly one address.
- Keep the existing contract API unchanged.

### Acceptance Criteria

- The test fails if duplicate followees are stored.
- `cargo test` passes from `packages/contracts`.
- The test name clearly describes the behavior, for example `test_follow_is_idempotent`.

### Helpful Files

- `packages/contracts/contracts/linkora-contracts/src/lib.rs`
- `packages/contracts/contracts/linkora-contracts/src/test.rs`

---

## 2. Add tests for profile updates

Labels: `good first issue`, `tests`, `contracts`

### Context

`set_profile` is used for both registration and updates. The current tests only verify initial profile creation.

### Scope

- Add a unit test for updating an existing profile.
- Set a profile once, then call `set_profile` again with a new username or creator token.
- Assert `get_profile` returns the updated values.
- Do not change public function names or signatures.

### Acceptance Criteria

- The test verifies update behavior for at least one changed field.
- The test keeps using `env.mock_all_auths()` like the existing tests.
- `cargo test` passes from `packages/contracts`.

### Helpful Files

- `packages/contracts/contracts/linkora-contracts/src/test.rs`

---

## 3. Reject zero or negative tip amounts

Labels: `good first issue`, `bug`, `contracts`, `security`

### Context

`tip` accepts an `i128` amount and adds it to `post.tip_total`. The contract should reject zero or negative amounts before attempting a token transfer.

### Scope

- Add a guard in `tip` requiring `amount > 0`.
- Add tests for invalid tip amounts.
- Keep the successful tipping flow unchanged.

### Acceptance Criteria

- Calling `tip` with `0` or a negative amount fails.
- Existing `test_post_and_tip` still passes.
- New tests document the expected failure behavior.

### Helpful Files

- `packages/contracts/contracts/linkora-contracts/src/lib.rs`
- `packages/contracts/contracts/linkora-contracts/src/test.rs`

---

## 4. Reject zero or negative pool deposit amounts

Labels: `good first issue`, `bug`, `contracts`, `security`

### Context

`pool_deposit` accepts an `i128` amount and increases the stored pool balance. Deposits should only accept positive amounts.

### Scope

- Add a guard in `pool_deposit` requiring `amount > 0`.
- Add tests for zero and negative deposit amounts.
- Ensure the existing deposit and withdrawal test still passes.

### Acceptance Criteria

- Invalid deposits fail before changing pool state.
- Valid deposits still transfer tokens and update the stored balance.
- `cargo test` passes from `packages/contracts`.

### Helpful Files

- `packages/contracts/contracts/linkora-contracts/src/lib.rs`
- `packages/contracts/contracts/linkora-contracts/src/test.rs`

---

## 5. Reject zero or negative pool withdrawal amounts

Labels: `good first issue`, `bug`, `contracts`, `security`

### Context

`pool_withdraw` checks that the pool has enough balance, but it should also reject zero or negative withdrawal amounts explicitly.

### Scope

- Add a guard in `pool_withdraw` requiring `amount > 0`.
- Add tests for zero and negative withdrawal amounts.
- Preserve the current insufficient-balance behavior.

### Acceptance Criteria

- Invalid withdrawals fail without changing pool balance.
- Valid withdrawals still reduce the pool balance and transfer tokens.
- `cargo test` passes from `packages/contracts`.

### Helpful Files

- `packages/contracts/contracts/linkora-contracts/src/lib.rs`
- `packages/contracts/contracts/linkora-contracts/src/test.rs`

---

## 6. Document contract storage keys and data layout

Labels: `good first issue`, `documentation`, `contracts`

### Context

The README explains the public API, but contributors still need to read the contract code to understand how profiles, follows, posts, and pools are stored.

### Scope

- Add a short storage layout section to `README.md` or `packages/contracts/README.md`.
- Explain the purpose of `PROFILES`, `FOLLOWS`, `POSTS`, `POST_CT`, and `POOLS`.
- Mention which storage namespace is used where, such as persistent or instance storage.

### Acceptance Criteria

- The docs help a new contributor find the storage key used by each feature.
- The docs stay concise and do not claim the layout is production-optimized.
- Existing setup and test instructions remain intact.

### Helpful Files

- `README.md`
- `packages/contracts/contracts/linkora-contracts/src/lib.rs`

---

## 7. Add a contract API reference table

Labels: `good first issue`, `documentation`, `developer experience`

### Context

The README lists public functions, but a table with inputs, auth requirements, and return values would make onboarding faster.

### Scope

- Add a contract API table to `README.md` or `packages/contracts/README.md`.
- Include each public function in `LinkoraContract`.
- For each function, document the purpose, required signer, important inputs, and return value.

### Acceptance Criteria

- Every public contract method is represented.
- Auth requirements are explicit for methods that call `require_auth`.
- The table is readable in plain Markdown.

### Helpful Files

- `README.md`
- `packages/contracts/contracts/linkora-contracts/src/lib.rs`

---

## 8. Add a contributor setup troubleshooting section

Labels: `good first issue`, `documentation`, `developer experience`

### Context

New contributors may hit setup issues around pnpm, Rust, Stellar CLI, or running tests from the wrong directory.

### Scope

- Add a troubleshooting section to the README.
- Cover common issues such as missing `pnpm`, missing Stellar CLI, `cargo test` location, and when to run `pnpm install`.
- Keep instructions short and command-oriented.

### Acceptance Criteria

- A new contributor can identify which command to run for dependency install, contract build, and tests.
- The section references the existing repository layout.
- No new tooling is required.

### Helpful Files

- `README.md`
- `package.json`
- `packages/contracts/package.json`

---

## 9. Add tests for sequential post IDs and timestamps

Labels: `good first issue`, `tests`, `contracts`

### Context

`create_post` increments `POST_CT` and stores the ledger timestamp, but the current tests only create one post.

### Scope

- Add a test that creates multiple posts.
- Assert returned post IDs increment as expected.
- Set the ledger timestamp and assert stored posts include the expected timestamp.

### Acceptance Criteria

- The test verifies at least two posts.
- The test checks both ID sequencing and timestamp storage.
- `cargo test` passes from `packages/contracts`.

### Helpful Files

- `packages/contracts/contracts/linkora-contracts/src/lib.rs`
- `packages/contracts/contracts/linkora-contracts/src/test.rs`

---

## 10. Add a minimal pull request checklist

Labels: `good first issue`, `documentation`, `maintainer experience`

### Context

The README has contribution guidance, but a PR template helps keep incoming contributions consistent.

### Scope

- Add `.github/pull_request_template.md`.
- Include a short checklist for tests, docs, focused scope, and contract API changes.
- Keep the template lightweight so first-time contributors are not overwhelmed.

### Acceptance Criteria

- The template appears automatically for new GitHub pull requests.
- The checklist includes testing and documentation prompts.
- The template is under `.github/` and uses Markdown.

### Helpful Files

- `README.md`
- `.github/pull_request_template.md`

---

# Suggested Label Reference

Use these labels if they do not already exist in GitHub:

| Label | Color | Description |
| --- | --- | --- |
| `good first issue` | `7057ff` | Small, well-scoped task suitable for new contributors |
| `help wanted` | `008672` | Maintainers welcome community contribution |
| `documentation` | `0075ca` | Documentation-only improvement |
| `tests` | `d4c5f9` | Adds or improves test coverage |
| `contracts` | `fbca04` | Soroban smart contract work |
| `bug` | `d73a4a` | Fixes incorrect or unsafe behavior |
| `security` | `b60205` | Security or safety hardening |
| `developer experience` | `cfd3d7` | Improves contributor workflow or local setup |
| `maintainer experience` | `bfdadc` | Improves project maintenance workflow |
