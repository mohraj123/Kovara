# Contributing to Kovaras

Thank you for contributing! This document covers everything you need to go from zero to an open pull request.

> ⭐ **Star the repo** — [Epta-Node/Kovara](https://github.com/Epta-Node/Kovara)
> 💬 **Join Telegram** — [t.me/+13csp8G4ccRhY2Zk](https://t.me/+13csp8G4ccRhY2Zk)
>
> Please introduce yourself in Telegram before opening a PR to avoid duplicate work.

---

## Prerequisites

Install the following before working on the project:

| Tool           | Version       | Install                                                           |
| -------------- | ------------- | ----------------------------------------------------------------- |
| Node.js        | 18+           | [nodejs.org](https://nodejs.org)                                  |
| pnpm           | 9+            | `npm install -g pnpm`                                             |
| Rust toolchain | latest stable | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| Stellar CLI    | latest        | `cargo install --locked stellar-cli`                              |

Add the Wasm target required for contract builds:

```bash
rustup target add wasm32-unknown-unknown
```

---

## Repository Structure

```text
.
├── packages/
│   └── contracts/          # Soroban smart contracts (Rust / Cargo workspace)
│       └── contracts/
│           └── Kovara-contracts/
│               └── src/
│                   ├── lib.rs    # Contract implementation
│                   └── test.rs   # Unit tests
├── docs/                   # Architecture, design, and indexer specs
├── scripts/                # Setup, deploy, and release scripts
├── tests/                  # Sandbox-backed integration tests
├── .github/                # CI workflows, issue/PR templates, CODEOWNERS
├── Makefile
├── turbo.json
└── pnpm-workspace.yaml
```

---

## Local Setup

```bash
# 1. Clone your fork
git clone git@github.com:YOUR-USERNAME/Kovara.git
cd Kovara

# 2. Install JS dependencies
pnpm install

# 3. Build contracts
pnpm build:contracts

# 4. Run unit tests
pnpm --filter contracts test

For more details on running web and mobile tests, see the [Testing Guide](docs/testing.md).
```

### Running each workspace package

| Package            | Directory            | Command                                          |
| ------------------ | -------------------- | ------------------------------------------------ |
| Contracts (build)  | `packages/contracts` | `pnpm build` or `pnpm build:contracts` from root |
| Contracts (test)   | `packages/contracts` | `cargo test` or `pnpm --filter contracts test`   |
| Contracts (format) | `packages/contracts` | `cargo fmt`                                      |
| Web (test)         | `packages/web`       | `pnpm --filter web test`                         |
| Web (E2E)          | `packages/web`       | `pnpm --filter web test:e2e`                     |
| Mobile (test)      | `apps/mobile`        | `pnpm --filter @Kovara/mobile test`              |
| Integration tests  | repo root            | `pnpm test:integration`                          |
| Full lint          | repo root            | `pnpm lint`                                      |
| Format all         | repo root            | `pnpm format`                                    |

---

## Branch Naming

| Prefix   | Use for                             |
| -------- | ----------------------------------- |
| `feat/`  | New features                        |
| `fix/`   | Bug fixes                           |
| `docs/`  | Documentation changes               |
| `test/`  | Adding or updating tests            |
| `chore/` | Tooling, config, dependency updates |

Example: `feat/add-repost-function`, `fix/tip-cooldown-overflow`, `docs/update-readme`

Always branch from `main`:

```bash
git checkout main && git pull
git checkout -b feat/your-feature-name
```

---

## Commit Message Format

This project uses [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <short description>

[optional body]

[optional footer: Closes #issue]
```

**Types:** `feat`, `fix`, `docs`, `test`, `chore`, `refactor`, `ci`

**Examples:**

```
feat(contracts): add repost function with author attribution
fix(contracts): prevent tip cooldown bypass on deleted posts
docs: update CONTRIBUTING.md with full workflow
test(contracts): add unit tests for block_user edge cases
```

Rules:

- Use the imperative mood ("add", not "added")
- Keep the subject line under 72 characters
- Reference the issue in the footer: `Closes #123`

---

## Pull Request Checklist

Before opening a PR:

- [ ] All tests pass locally (contracts, web, and/or mobile)
- [ ] New behaviour is covered by tests (unit and/or E2E)
- [ ] If a contract function was added or changed, the storage layout, APIs, and the README API table are updated
- [ ] Commit messages follow Conventional Commits format
- [ ] Branch is up to date with `main`
- [ ] PR is focused — one concern per PR
- [ ] PR description fills out the template and references the issue (`Closes #N`)

---

## Code Review Expectations

**As an author:**

- Keep PRs small and focused — easier to review, faster to merge
- Respond to review comments within a reasonable time
- Don't force-push after a review has started; add new commits instead
- Mark conversations as resolved only after addressing them

**As a reviewer:**

- Review within 2–3 business days where possible
- Be specific and constructive — suggest the fix, not just the problem
- Approve only when you are confident the change is correct and tested
- Use "Request changes" for blocking issues, "Comment" for non-blocking suggestions

**Merge policy:**

- At least one approving review is required
- CI must pass before merge
- Squash or merge commits — no force-pushes to `main`

---

## Adding a New Contract Function

1. Implement the function in `packages/contracts/contracts/Kovara-contracts/src/lib.rs`
2. Add `require_auth()` for any state-changing operation
3. Emit an event for indexer consumers (see [EVENTS.md](packages/contracts/contracts/Kovara-contracts/EVENTS.md))
4. Write unit tests in `src/test.rs`
5. Update the API Reference table in `README.md`
6. Add a changelog entry in `CHANGELOG.md`

---

## Issue Triage and Labels

When opening or triaging an issue, apply the most relevant label(s) from the table below. Correct labelling helps maintainers prioritise work and helps new contributors find good entry points.

| Label              | When to use                                                                                                                                                                                  | Example                                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `bug`              | Something that was working correctly has stopped working, or behaves contrary to its documented behaviour. Include steps to reproduce, expected result, and actual result.                   | `tip()` throws a contract auth error when called by a verified user — regression introduced in #184            |
| `feature`          | A new capability that does not yet exist. Describe the motivation and the proposed behaviour; a rough API sketch is welcome but not required.                                                | Add a `repost()` contract function that records the original author and emits a `Repost` event for the indexer |
| `contracts`        | The issue is scoped to the Soroban smart contracts (`packages/contracts`), whether a bug, feature, or refactor. Often combined with `bug` or `feature`.                                      | `block_user` does not prevent a blocked account from liking posts — fix needed in `lib.rs`                     |
| `good first issue` | Self-contained, well-scoped, and does not require deep knowledge of the codebase. Add this label only when acceptance criteria are clear and a suggested approach exists in the description. | Add a missing unit test for the `follow()` edge case where a user follows themselves                           |

### Tips for good issue reports

- **Bug:** attach any relevant error output, transaction hash, or ledger sequence number.
- **Feature:** link to prior discussion in Telegram or reference a related issue.
- **Contracts:** specify the function name and the file (`lib.rs`, `test.rs`, etc.) if known.
- **Good first issue:** leave a comment describing where in the codebase to start — this dramatically increases the chance someone picks it up.

If you are unsure which label fits, open the issue without one and ask in [Telegram](https://t.me/+13csp8G4ccRhY2Zk) — a maintainer will triage it.

---

## Getting Help

- 💬 **Telegram** — [t.me/+13csp8G4ccRhY2Zk](https://t.me/+13csp8G4ccRhY2Zk) — fastest way to reach the team
- 🐛 **GitHub Issues** — for bugs and feature requests
- 🔒 **Security issues** — see [SECURITY.md](SECURITY.md) for private disclosure

---

## Security

Do not open public issues for security vulnerabilities. Follow the process in [SECURITY.md](SECURITY.md).
