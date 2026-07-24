# Turbo Caching & Monorepo CI Optimization

## Overview

Kovara uses [Turborepo](https://turbo.build/repo) to orchestrate builds and tests across packages. Understanding how Turbo's caching works is key to keeping CI fast and reproducible.

---

## How Turbo caching works

Turbo hashes the **inputs** to each task (source files, env vars, dependencies) and stores the **outputs** (build artifacts, test results, coverage) against that hash. On a subsequent run, if the hash is unchanged, Turbo replays the cached output rather than re-executing the task.

The cache has two layers:

| Layer      | What it is                           | Set by                                |
| ---------- | ------------------------------------ | ------------------------------------- |
| **Local**  | `.turbo/` directory in the repo root | Always active                         |
| **Remote** | Vercel Remote Cache (or self-hosted) | `TURBO_TOKEN` + `TURBO_TEAM` env vars |

---

## CI cache configuration

### Local cache (GitHub Actions)

The workflow saves and restores `.turbo/` via `actions/cache`. The cache key includes the package name, OS, and commit SHA so each commit gets its own slot while still restoring the most recent ancestor's cache:

```yaml
- uses: actions/cache@v4
  with:
    path: .turbo
    key: turbo-web-ubuntu-latest-${{ github.sha }}
    restore-keys: |
      turbo-web-ubuntu-latest-
```

### Remote cache (recommended for teams)

Remote caching shares hit/miss state across all developers and CI runs. Set up:

1. Create a Vercel account and link the repo (or use a [self-hosted cache server](https://turbo.build/repo/docs/core-concepts/remote-caching#self-hosting)).
2. Add the following secrets to the GitHub repository (`Settings → Secrets`):
   - `TURBO_TOKEN` — API token from Vercel dashboard
   - `TURBO_TEAM` — your Vercel team slug (e.g. `mohraj123`)
3. The `CI` workflow already reads these via `env.TURBO_TOKEN` / `env.TURBO_TEAM`.

Once configured, cache hits from a teammate's local machine or a prior CI run will be replayed in your PR run.

---

## Affected-only runs

With `fetch-depth: 2` in checkout, Turbo can determine which packages changed in the most recent commit and skip unaffected tasks:

```bash
# Run only tests for packages affected by changes since main
pnpm turbo test --filter=...[main]
```

In CI this is handled automatically when `TURBO_TOKEN` is set — Turbo sends the git ancestry to the remote cache to compute affected packages.

---

## Debugging cache misses

If a task that should be cached is still running, check:

1. **Environment variable hash** — any env var listed in `turbo.json` under `globalEnv` or per-task `env` that changed will bust the cache.
2. **Input glob changes** — verify `inputs` in `turbo.json` doesn't inadvertently include generated files (e.g. `coverage/**`).
3. **Missing `.turboignore`** — add files/directories that should not affect the task hash.

Run with `--verbosity=2` to see exactly which inputs changed:

```bash
pnpm turbo test --filter=web --verbosity=2
```

---

## Recommended `turbo.json` task configuration

```json
{
  "$schema": "https://turbo.build/schema.json",
  "globalEnv": ["NODE_ENV", "CI"],
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**", ".next/**"]
    },
    "test": {
      "dependsOn": ["^build"],
      "outputs": ["coverage/**"],
      "cache": true
    },
    "lint": {
      "outputs": []
    }
  }
}
```

Key points:

- `"cache": true` on `test` means repeated runs with identical inputs replay instantly.
- `outputs: ["coverage/**"]` ensures coverage reports are stored in and restored from the cache.
- `dependsOn: ["^build"]` runs upstream package builds before tests.

---

## Useful commands

```bash
# Show what would run without executing
pnpm turbo test --dry-run

# Force a fresh run, ignoring cache
pnpm turbo test --force

# Run only packages affected since the merge base
pnpm turbo test --filter=...[origin/main]

# Print cache hit/miss summary
pnpm turbo test --summarize
```
