# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows semantic versioning for contract and SDK releases.

## [Unreleased]

### Added

- Web application documentation and architecture diagrams
- Unit tests for `useWallet` and `useFeed` hooks
- Content Security Policy (CSP) headers for web application
- `apps/web/README.md` with full env-setup, network and security guidance (closes #121)
- `apps/web/.env.example` documenting every `NEXT_PUBLIC_*` variable consumed by `apps/web/config.ts` (closes #121)
- `apps/web/src/components/RequireWallet.tsx` — reusable client-side wallet guard (closes #122)
- `apps/web/src/app/post/new/page.tsx` — wallet-gated post creation route (closes #122)
- Spec-style tests for `RequireWallet` will be added in a follow-up once Jest + RTL are wired into `apps/web` (parity with `packages/web`)
### Changed

- Web application now includes security headers
- Home page (`apps/web/src/app/page.tsx`) restructured into a landing page that links into the wallet-gated `/post/new` route (resolves #122)
- `PostComposer` now validates content via `apps/web/src/lib/validate.ts` and is only rendered inside a `RequireWallet` guard (defense in depth for #122)
- `NavBar` exposes a contextual "New Post" link that is disabled until the wallet is connected (#122)

### Security

- Content Security Policy headers mitigate XSS vulnerabilities
- `.env.example` ships with explicit warnings that no real secrets belong in `NEXT_PUBLIC_*` variables (#121)
- Route-level wallet gate prevents disconnected users from reaching the post composer, eliminating the unauthenticated-publish attack vector (#122)

## [SDK/0.1.0] - 2026-05-31

### Added

- Initial publication of `Kovara-sdk` to npm (`https://www.npmjs.com/package/Kovara-sdk`).
- TypeScript SDK with complete bindings for `KovaraContract` on Stellar Soroban.
- Automated GitHub Actions workflow for SDK releases triggered by `sdk/v*` tags (closes #311).
- Comprehensive npm package configuration with proper types and exports for TypeScript consumers.
- SDK documentation with quick-start examples, API reference, and regeneration instructions.

### Changed

- SDK `package.json` now properly configured for npm distribution with `Kovara-sdk` package name.
- SDK README updated with npm installation instructions for npm, pnpm, and yarn.
- SDK build script now outputs compiled JavaScript and type declarations to `dist/` for distribution.

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

- `KovaraContract` initial public interface for profile registration, follow graph, post publishing, tipping, and pools.
- Admin-controlled protocol fee configuration via `set_fee`, `set_treasury`, `get_fee_bps`, and `get_treasury`.
- Blocking and post-like primitives (`block_user`, `unblock_user`, `is_blocked`, `like_post`, `get_like_count`, `has_liked`).
- Safer error messages for missing entities in `tip`, `delete_post`, and `pool_withdraw`.
- Project documentation structure with design and indexer specifications

### Changed

- `tip` now supports protocol fee split between author and treasury.
- Contract crate version aligned to `0.1.0` in `packages/contracts/contracts/Kovara-contracts/Cargo.toml`.
