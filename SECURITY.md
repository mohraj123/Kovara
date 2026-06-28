# Security Policy

## Supported Versions

| Version         | Supported |
| --------------- | --------- |
| 0.1.x (current) | ✅ Yes    |

Security fixes are applied to the latest version only. This project is in prototype stage and has not been audited for production use.

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Use **[GitHub Security Advisories](https://github.com/Epta-Node/Kovara/security/advisories/new)** to report privately. This keeps the disclosure confidential until a fix is ready.

Include in your report:

- Affected function(s) or file(s)
- Steps to reproduce or proof of concept
- Impact assessment (e.g. fund loss, access control bypass, DoS)
- Suggested fix (optional)

## Response Timeline

| Milestone                                | Target                 |
| ---------------------------------------- | ---------------------- |
| Acknowledgement                          | Within 48 hours        |
| Triage & severity classification         | Within 7 days          |
| Fix for **Critical** vulnerabilities     | Within 14 days         |
| Fix for **High** vulnerabilities         | Within 30 days         |
| Fix for **Medium / Low** vulnerabilities | Next scheduled release |

We will keep you informed throughout the process and coordinate disclosure timing with you before publishing a security advisory.

## Severity Definitions

- **Critical** — Direct loss of funds, pool drainage, unauthorized token transfers
- **High** — Access control bypass, contract upgrade abuse
- **Medium** — Denial of service, logic errors without direct fund loss
- **Low** — Information disclosure, minor logic issues

## Out-of-Scope Items

The following are **not** eligible for security reports:

- Frontend UI components and mock data (not yet in this repository)
- Backend services and APIs (not yet in this repository)
- Issues requiring physical access to a user's device
- Social engineering attacks
- Third-party dependencies unless directly exploitable in the contract context
- Network-level attacks on Stellar infrastructure
- Vulnerabilities in already-deprecated or unsupported versions

## Bug Bounty

There is no formal paid bug bounty program at this time. Researchers who responsibly disclose valid vulnerabilities will be:

- Credited in the published security advisory (with permission)
- Acknowledged in release notes and community channels

This may be revisited as the project matures toward production.

## Disclosure Process

1. Reporter submits via GitHub Security Advisories (private)
2. Team acknowledges within 48 hours
3. Team triages severity within 7 days
4. Fix developed and reviewed based on severity timeline above
5. Reporter notified before public disclosure
6. Security advisory published after fix is deployed
7. Reporter credited (with permission)

## Known Security Risks

### Unbounded Follower/Following List Growth

The current implementation stores follower and following lists in `Vec` collections within the contract storage. This design presents a potential denial-of-service (DoS) vector and can lead to unbounded gas costs.

- **Risk**: A malicious actor could repeatedly follow and unfollow a user, causing the `followers` or `following` `Vec` to grow indefinitely.
- **Impact**: As the `Vec` grows, the gas costs for operations that iterate over it (e.g., reading the list, removing a user) will increase. This can make these operations prohibitively expensive, effectively locking the user out of managing their social graph.
- **Mitigation**: This is a known issue that will be addressed in a future release. Potential solutions include implementing pagination, capping the number of followers/following, or using a more gas-efficient data structure.