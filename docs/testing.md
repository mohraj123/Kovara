# Kovara Testing Guide

This guide details how to run the unit, integration, and end-to-end (E2E) tests for each component of the Kovara workspace.

## Running All Tests

To run every test suite across all packages at once, use the root-level `pnpm test` command from the repository root:

```bash
pnpm test
```

This invokes `turbo run test`, which runs each package's `test` script in dependency order (packages with `^build` dependencies are built first). Turborepo caches results and only re-runs suites whose inputs have changed.

> **What `turbo run test` does:**
>
> 1. Resolves the workspace dependency graph.
> 2. Builds any packages that are prerequisites (`"dependsOn": ["^build"]`).
> 3. Runs the `test` script in each package in parallel where possible.
> 4. Caches passing runs — repeated `pnpm test` with no source changes exits immediately with cached results.

To bypass the cache (e.g. when debugging flaky tests):

```bash
pnpm test -- --force
```

---

## Workspace Test Command Overview

You can also run tests for a single package using `pnpm --filter`, or navigate to the package directory and run the commands locally.

| Package       | Testing Domain         | Target Directory     | Root-scoped Command                 | Local Command            |
| ------------- | ---------------------- | -------------------- | ----------------------------------- | ------------------------ |
| **Contracts** | Smart Contracts (Rust) | `packages/contracts` | `pnpm --filter contracts test`      | `cargo test`             |
| **Web**       | Web Frontend (Next.js) | `packages/web`       | `pnpm --filter web test`            | `pnpm test`              |
| **Web (E2E)** | Playwright E2E Tests   | `packages/web`       | `pnpm --filter web test:e2e`        | `pnpm test:e2e`          |
| **Mobile**    | Mobile App (Expo)      | `apps/mobile`        | `pnpm --filter @Kovara/mobile test` | `npm test` / `pnpm test` |

### Running a single package's tests

Scope any Turborepo task to one package with `--filter`:

```bash
# Smart contracts only
pnpm turbo test --filter=contracts

# Web unit tests only
pnpm turbo test --filter=web

# Mobile only
pnpm turbo test --filter=@Kovara/mobile
```

`--filter` accepts the package `name` field from its `package.json`, a directory glob, or a `[git-ref]` diff expression — see the [Turborepo filter docs](https://turbo.build/repo/docs/crafting-your-repository/running-tasks#using-filters) for advanced patterns.

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
