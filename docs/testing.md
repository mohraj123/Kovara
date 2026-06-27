# Kovara Testing Guide

This guide details how to run the unit, integration, and end-to-end (E2E) tests for each component of the Kovara workspace.

## Workspace Test Command Overview

You can run tests for individual workspace packages from the repository root using `pnpm --filter`, or navigate to the package directory and run the commands locally.

| Package       | Testing Domain         | Target Directory     | Root Command                        | Local Command            |
| ------------- | ---------------------- | -------------------- | ----------------------------------- | ------------------------ |
| **Contracts** | Smart Contracts (Rust) | `packages/contracts` | `pnpm --filter contracts test`      | `cargo test`             |
| **Web**       | Web Frontend (Next.js) | `packages/web`       | `pnpm --filter web test`            | `pnpm test`              |
| **Web (E2E)** | Playwright E2E Tests   | `packages/web`       | `pnpm --filter web test:e2e`        | `pnpm test:e2e`          |
| **Mobile**    | Mobile App (Expo)      | `apps/mobile`        | `pnpm --filter @Kovara/mobile test` | `npm test` / `pnpm test` |

---

## 1. Smart Contracts (`packages/contracts`)

Unit tests for Soroban smart contracts are written in Rust using the Soroban SDK.

### Running from the Repository Root

```bash
pnpm --filter contracts test
```

### Running from the Contract Directory

Navigate to `packages/contracts`:

```bash
cargo test
```

For specific contract tests or details, check `packages/contracts/README.md`.

---

## 2. Web Application (`packages/web`)

The Web package has unit tests (Jest and React Testing Library) and E2E tests (Playwright).

### Running Unit Tests

To run Jest unit tests:

- **From repository root:**
  ```bash
  pnpm --filter web test
  ```
- **From `packages/web`:**
  ```bash
  pnpm test
  ```

### Running E2E Tests (Playwright)

Ensure you have the browsers installed before running Playwright tests:

```bash
pnpm exec playwright install
```

- **From repository root:**

  ```bash
  # Run all E2E tests
  pnpm --filter web test:e2e

  # Run in interactive UI mode
  pnpm --filter web test:e2e:ui
  ```

- **From `packages/web`:**
  ```bash
  pnpm test:e2e
  ```

_Note: Playwright tests require a running local Stellar sandbox. See `tests/README.md` for local sandbox setup._

---

## 3. Mobile Application (`apps/mobile`)

The Mobile package is built with React Native and Expo, utilizing Jest for unit and snapshot testing.

### Running Unit & Snapshot Tests

To run unit and snapshot tests:

- **From repository root:**
  ```bash
  pnpm --filter @Kovara/mobile test
  ```
- **From `apps/mobile`:**
  ```bash
  npm test
  # or
  pnpm test
  ```

### Updating Jest Snapshots

If you intentionally modify a component's visual representation, you must update the snapshots:

- **From repository root:**
  ```bash
  pnpm --filter @Kovara/mobile test -- -u
  ```
- **From `apps/mobile`:**
  ```bash
  npm test -- --updateSnapshot
  ```
