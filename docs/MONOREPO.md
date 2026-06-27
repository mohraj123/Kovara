# Monorepo Developer Notes

This document explains how the Kovara monorepo is structured, how Turborepo orchestrates tasks, and how to use package filters and workspace boundaries effectively day-to-day.

---

## Workspace layout

Workspaces are declared in `pnpm-workspace.yaml`:

```yaml
packages:
  - "packages/*"
  - "apps/*"
  - "services/*"
```

| Glob         | Packages                                      |
| ------------ | --------------------------------------------- |
| `packages/*` | `contracts`, `sdk`, `web` (shared libraries)  |
| `apps/*`     | `apps-web` (Next.js), `@Kovara/mobile` (Expo) |
| `services/*` | `@Kovara/indexer` (Node.js daemon)            |

Each directory under those globs is an independent workspace package identified by the `name` field in its `package.json`. Install once from the root and pnpm hoists shared dependencies automatically:

```bash
pnpm install          # installs everything, all workspaces
```

---

## Turborepo task pipeline

Tasks and their dependencies are defined in `turbo.json`:

```json
{
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**", "target/**", ".next/**", ".expo/**"]
    },
    "dev": { "persistent": true, "cache": false },
    "lint": { "dependsOn": ["^build"] },
    "test": { "dependsOn": ["^build"] },
    "test:integration": { "cache": false },
    "format": { "outputs": [] }
  }
}
```

### `dependsOn` and the `^` prefix

`"dependsOn": ["^build"]` means "run `build` in every upstream dependency first".

- **`^task`** — topological dependency: build all packages that _this_ package depends on before running the task here.
- **`task`** (no caret) — run that task in _the same_ package before this one.

Concretely, if `apps-web` depends on `Kovara-sdk`, running `turbo build` will build `Kovara-sdk` first, then `apps-web`, in parallel with any other unrelated packages.

### Caching

Turbo caches task outputs keyed on source file hashes. On a cache hit the task is skipped and outputs are restored from cache. Outputs to cache are specified by the `outputs` field. Tasks with `"cache": false` (e.g. `dev`, `test:integration`) always re-run.

The local cache lives in `.turbo/cache/`. Remote caching (Vercel Remote Cache) can be enabled with `turbo login && turbo link`.

### Persistent tasks

`"persistent": true` marks long-running processes (dev servers). Turbo keeps them alive and does not wait for them to exit before considering the pipeline done.

---

## Package filters

Pass `--filter` (or `-F`) to any `turbo` or `pnpm` command to scope it to one or more packages.

### Filter by package name

```bash
# Run build only for the SDK
pnpm turbo build --filter=Kovara-sdk

# Run dev server for the web app only
pnpm turbo dev --filter=apps-web

# Run tests in the indexer
pnpm turbo test --filter=@Kovara/indexer
```

### Filter with glob

```bash
# Build every package under packages/
pnpm turbo build --filter="packages/*"

# Lint everything in apps/ and services/
pnpm turbo lint --filter="apps/*" --filter="services/*"
```

### Filter by changed files (useful in CI)

```bash
# Only run tasks for packages changed since branching from main
pnpm turbo build --filter="...[origin/main]"
```

### Include dependents / dependencies

```bash
# Build the SDK and everything that depends on it
pnpm turbo build --filter="...Kovara-sdk"

# Build apps-web and all of its dependencies
pnpm turbo build --filter="apps-web..."
```

### Run a script directly with pnpm (bypassing Turbo)

```bash
# Run a one-off script in a specific package without the pipeline
pnpm --filter @Kovara/indexer run dev
pnpm --filter contracts test:integration
```

---

## Workspace boundaries

Each workspace package is **self-contained**:

- It has its own `package.json`, `tsconfig.json`, and lock-free dependency declarations.
- Cross-workspace imports must be declared as explicit dependencies in `package.json` — implicit path imports are not allowed.
- Packages under `packages/` are intended to be shared libraries consumed by `apps/` and `services/`. The reverse direction (a library importing from an app) is forbidden.

### Adding a cross-workspace dependency

```bash
# Add the SDK as a dependency of the indexer service
pnpm --filter @Kovara/indexer add Kovara-sdk
```

pnpm will link the local workspace copy instead of fetching from the registry.

### TypeScript project references

Packages that are consumed by others at build time should expose a compiled `dist/` output (as declared in `turbo.json` `outputs`). The consuming package's `tsconfig.json` should reference the upstream `tsconfig.json` via `references` so TypeScript type-checks across workspace boundaries correctly:

```json
// apps-web/tsconfig.json (example)
{
  "references": [{ "path": "../../packages/sdk" }]
}
```

---

## Common workflows

### Build everything from scratch

```bash
pnpm turbo build
```

### Develop a single package in watch mode

```bash
pnpm turbo dev --filter=apps-web
```

### Run all tests

```bash
pnpm turbo test
```

### Lint and format the whole repo

```bash
pnpm turbo lint
pnpm turbo format
```

### Add a dependency to a specific package

```bash
pnpm --filter <package-name> add <dependency>
```

### Clean all build outputs and Turbo cache

```bash
find . -name "dist" -not -path "*/node_modules/*" | xargs rm -rf
rm -rf .turbo/cache
```

---

## CI behaviour

The GitHub Actions workflows run `pnpm turbo build` and `pnpm turbo test` at the repo root. Turbo's task graph ensures packages build in the correct order. Only packages whose source files changed (or whose upstream dependencies changed) are rebuilt — everything else is restored from cache, keeping CI fast.

For the integration test workflow, `test:integration` is invoked directly via `pnpm --filter contracts test:integration` because it is marked `"cache": false` and shells out to an external script.
