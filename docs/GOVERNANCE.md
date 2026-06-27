# Kovara Governance

This document describes how decisions are made in the Kovara project, how the project is maintained, and how community members can take on greater responsibility.

## Table of Contents

1. [Project Roles](#1-project-roles)
2. [Decision-Making](#2-decision-making)
3. [Becoming a Maintainer](#3-becoming-a-maintainer)
4. [Code of Conduct](#4-code-of-conduct)
5. [Communication Channels](#5-communication-channels)
6. [Issue Labels and Triage](#6-issue-labels-and-triage)

---

## 1. Project Roles

### Contributor

Anyone who submits a bug report, feature request, or pull request. Contributors do not require any formal recognition or invitation — opening an issue or PR immediately makes you a contributor.

**Responsibilities:**

- Follow the contributing guidelines in [CONTRIBUTING.md](../CONTRIBUTING.md)
- Adhere to the [Code of Conduct](#4-code-of-conduct)
- Respond to review feedback on open PRs in a timely manner

### Reviewer

A contributor who has demonstrated sustained, high-quality contributions and is invited to review pull requests. Reviewers can approve PRs but cannot merge without a maintainer's final approval.

**Responsibilities:**

- Provide constructive, timely code reviews
- Flag security concerns or breaking changes before approval
- Help triage issues and answer community questions

### Maintainer

Maintainers have write access to the repository and are responsible for the long-term health of the codebase. They merge pull requests, cut releases, and set the technical direction.

**Current Maintainers:** [@Epta-Node](https://github.com/Epta-Node)

**Responsibilities:**

- Review and merge approved pull requests
- Enforce branch protection and CI requirements
- Manage the release process (see `CONTRIBUTING.md` § Release Process)
- Uphold the Code of Conduct, including enforcement decisions

---

## 2. Decision-Making

### Everyday Decisions

Most decisions — bug fixes, documentation updates, minor features — follow standard GitHub flow:

1. An issue is opened describing the change.
2. A contributor opens a PR referencing the issue.
3. At least one reviewer approves the PR.
4. A maintainer performs a final review and merges.

No formal vote is required for changes that do not affect the public contract interface, storage layout, event schema, or governance structure.

### Significant Changes

The following changes require explicit maintainer consensus (at minimum two maintainer approvals) before merging:

- Changes to the public Soroban contract interface (function signatures, removed functions)
- Changes to the on-chain storage key layout or contracttype definitions
- Changes to the event schema (`#[contractevent]` structs)
- Changes to the fee model or treasury address logic
- Contract upgrade proposals (`upgrade()` function)
- Changes to this governance document

For significant changes, open an issue with the label `proposal` and allow at least **5 business days** for maintainer discussion before proceeding.

### Breaking Changes

Breaking changes (major version bumps per the versioning policy in `CONTRIBUTING.md`) must be announced in the community Telegram channel at least **2 weeks** before the target merge date and must include a migration guide in the PR description.

### Disputes

If contributors cannot reach consensus through normal review, any maintainer may call for a time-boxed discussion (72 hours). If consensus is still not reached, the decision rests with the core maintainers by simple majority.

---

## 3. Becoming a Maintainer

There is no fixed timeline or point system. Maintainers are invited based on demonstrated judgment and consistent positive impact on the project. Typical indicators include:

- Multiple merged PRs of increasing complexity
- High-quality, constructive code reviews
- Active participation in issue triage or community support
- Understanding of Soroban smart contract security and the Kovara data model

**Process:**

1. A current maintainer nominates the candidate in the private maintainer channel.
2. All current maintainers discuss and vote (simple majority, 5-day window).
3. If approved, the candidate is offered write access and added to `CODEOWNERS`.
4. The candidate's name is added to the Maintainers list in this document.

Maintainer status is voluntary. A maintainer who is no longer active may step down at any time by notifying the team. After 6 months of inactivity with no response to pings, maintainer access may be revoked by the remaining maintainers.

---

## 4. Code of Conduct

All participants in the Kovara community — including contributors, reviewers, maintainers, and anyone engaging in the project's issue tracker, pull requests, or communication channels — are expected to follow the project Code of Conduct.

The full Code of Conduct is available at [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md) (if not yet present, the [Contributor Covenant v2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/) applies by default).

**Enforcement:** Violations should be reported to the maintainer team via a private message on Telegram (see below) or by emailing a maintainer directly. Reports are treated confidentially. Maintainers who are the subject of a report recuse themselves from the decision.

---

## 5. Communication Channels

| Channel                                                               | Purpose                                                          |
| --------------------------------------------------------------------- | ---------------------------------------------------------------- |
| [GitHub Issues](https://github.com/Epta-Node/Kovara/issues)           | Bug reports, feature requests, and formal proposals              |
| [GitHub Discussions](https://github.com/Epta-Node/Kovara/discussions) | Open-ended questions and community conversation                  |
| [Telegram Community](https://t.me/+13csp8G4ccRhY2Zk)                  | Real-time discussion, announcements, and breaking-change notices |

For security disclosures, see [SECURITY.md](../SECURITY.md) — do not use public channels for vulnerability reports.

---

## 6. Issue Labels and Triage

To maintain a healthy and organized repository, we use a specific set of labels and follow a structured triage process for all incoming issues.

### Label Meaning

- **bug**: Indicates an unexpected problem or unintended behavior.
- **enhancement**: New feature or request.
- **documentation**: Improvements or additions to documentation.
- **governance**: Matters related to project governance, process, and community.
- **good first issue**: Good for newcomers.
- **help wanted**: Extra attention is needed.
- **wontfix**: This will not be worked on.
- **duplicate**: This issue or pull request already exists.

### Issue Assignment Practice

1. **Triage**: All new issues are reviewed by a maintainer within 48 hours. They will be tagged with appropriate labels (e.g., `bug`, `enhancement`).
2. **Assignment**: 
   - Issues are generally self-assigned. If you want to work on an issue, please comment on it.
   - Maintainers may assign issues to specific contributors based on their expertise.
3. **Stale Issues**: If an assigned issue has no activity for 14 days, the assignee will be pinged. If there is no response in another 7 days, the issue will be unassigned to allow others to pick it up.
