# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows semantic versioning for contract releases.

## [Unreleased]

### Added
- Web application documentation and architecture diagrams
- Unit tests for `useWallet` and `useFeed` hooks
- Content Security Policy (CSP) headers for web application

### Changed
- Web application now includes security headers

### Security
- Content Security Policy headers mitigate XSS vulnerabilities

## [0.2.0] - 2026-05-30

### Added
- `StorageKey::UsernameIndex(String)` variant — typed persistent key for the username → owner reverse index, replacing the raw `(UNAMES, String)` tuple key (closes #184, #143).
- `StorageKey::TipCooldown(u64, Address)` variant — typed temporary key for the per-tipper-per-post cooldown tracker, replacing the raw `(TIP_CD, Address, u64)` tuple key (closes #184, #134).
- `get_address_by_username(username)` documented in the README API table.
- `set_tip_cooldown_window` and `get_tip_cooldown_window` documented in the README API table.

### Changed
- `get_profile_count()` now documents that `PROF_CT` tracks **total profiles ever created** and is never decremented, settling the design decision from issue #132.
- All raw `Symbol`-tuple storage keys for the username index and tip cooldown have been removed from `lib.rs`; every storage access now uses a typed `StorageKey` variant (closes #184).
- Borrow-lifetime bug in `test_delete_post_emits_event` test fixed (pre-existing compile-time error corrected).
- README Storage Layout section updated to reflect the full `StorageKey` enum and accurate key mapping table.

## [0.1.0] - 2026-04-27

### Added
- `LinkoraContract` initial public interface for profile registration, follow graph, post publishing, tipping, and pools.
- Admin-controlled protocol fee configuration via `set_fee`, `set_treasury`, `get_fee_bps`, and `get_treasury`.
- Blocking and post-like primitives (`block_user`, `unblock_user`, `is_blocked`, `like_post`, `get_like_count`, `has_liked`).
- Safer error messages for missing entities in `tip`, `delete_post`, and `pool_withdraw`.
- Project documentation structure with design and indexer specifications

### Changed
- `tip` now supports protocol fee split between author and treasury.
- Contract crate version aligned to `0.1.0` in `packages/contracts/contracts/linkora-contracts/Cargo.toml`.
