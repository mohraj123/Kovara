# Kovara SDK

Typed TypeScript client for the Kovara Soroban smart contract on Stellar.

**npm**: [`Kovara-sdk`](https://www.npmjs.com/package/Kovara-sdk)

---

## Installation

```bash
# npm
npm install Kovara-sdk

# pnpm
pnpm add Kovara-sdk

# yarn
yarn add Kovara-sdk
```

---

## Package Structure & Contract Bindings

This SDK is built on top of the auto-generated TypeScript bindings produced by the Stellar CLI from the compiled Kovara Soroban smart contract. 

- **Generated Bindings**: The underlying bindings act as a raw interface to the WASM contract, providing type definitions matching the Rust contract.
- **SDK Wrapper (`src/` index)**: The SDK wraps these bindings to offer a higher-level, more idiomatic TypeScript interface. It handles connection configuration, error mapping (converting raw contract errors into custom `KovaraError` classes), and data transformation (e.g., handling `BigInt`).

This separation ensures that when the contract changes, only the generated layer needs a rebuild, while the SDK wrapper maintains a stable and predictable API for consumer applications (like the web and mobile frontends).

---

## Quick Start

### 1. Instantiate the client

```ts
import { KovaraClient } from "Kovara-sdk";

const client = new KovaraClient({
  contractId: "CABC...XYZ",          // deployed contract address (C...)
  networkPassphrase: "Test SDF Network ; September 2015",
  rpcUrl: "https://soroban-testnet.stellar.org",
});
```

For Mainnet:

```ts
const client = new KovaraClient({
  contractId: "CABC...XYZ",
  networkPassphrase: "Public Global Stellar Network ; September 2015",
  rpcUrl: "https://soroban-mainnet.stellar.org",
});
```

---

---

## Import Semantics: Browser vs Node.js

The SDK ships a single CommonJS bundle (`dist/index.js`) with accompanying TypeScript
declarations (`dist/index.d.ts`). The examples below cover every common environment.

### Browser (ESM via bundler — Vite, webpack, Next.js, etc.)

Modern bundlers resolve the `"exports"` field in `package.json` and tree-shake unused exports automatically.

```ts
// Any modern bundler will resolve this to the correct dist file.
import { KovaraClient } from "Kovara-sdk";

const client = new KovaraClient({
  contractId: "CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
});

const post = await client.get_post({ id: 1n });
console.log(post.result?.content);
```

> **Note on BigInt**: Soroban `u64`/`i128` values are represented as JavaScript `bigint`.
> Ensure your bundler target supports `BigInt` (ES2020+). In Vite set `target: 'es2020'`
> in `vite.config.ts`; in webpack set `target: 'web'` with `experiments.outputModule: true`.

### Browser (CDN / script tag — no bundler)

The SDK does **not** ship a standalone IIFE or UMD bundle. For no-bundler browser usage,
use a CDN that supports ESM, such as esm.sh or jspm:

```html
<script type="module">
  // esm.sh transpiles npm packages to browser-native ES modules on the fly.
  import { KovaraClient } from "https://esm.sh/Kovara-sdk";

  const client = new KovaraClient({
    contractId: "C...",
    rpcUrl: "https://soroban-testnet.stellar.org",
  });
</script>
```

### Node.js — CommonJS (`require`)

The published `dist/index.js` is a CommonJS module, so it works directly with `require`:

```js
// index.js  (Node.js CJS)
const { KovaraClient } = require("Kovara-sdk");

async function main() {
  const client = new KovaraClient({
    contractId: "C...",
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
  });

  const posts = await client.get_posts({ page: 0, limit: 10 });
  console.log(posts.result);
}

main().catch(console.error);
```

### Node.js — ESM (`import`) with TypeScript

When your TypeScript project uses `"module": "ESNext"` or `"module": "NodeNext"` you can use
the standard `import` syntax. The SDK's `"exports"` entry point is resolved automatically.

```ts
// index.ts  (Node.js ESM + TypeScript)
import { KovaraClient, NotFoundError } from "Kovara-sdk";

const client = new KovaraClient({
  contractId: process.env.CONTRACT_ID!,
  rpcUrl: process.env.RPC_URL ?? "https://soroban-testnet.stellar.org",
});

try {
  const profile = await client.get_profile({ address: "G..." });
  console.log(profile.result?.username);
} catch (err) {
  if (err instanceof NotFoundError) {
    console.error("Profile does not exist on-chain yet.");
  } else {
    throw err;
  }
}
```

In `tsconfig.json`, use at least:

```json
{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ES2020",
    "esModuleInterop": true
  }
}
```

### Named exports reference

All public symbols are re-exported from the top-level entry point:

| Symbol | Description |
|---|---|
| `KovaraClient` | Main read/write contract client |
| `ClientConfig` | Constructor options type |
| `Profile`, `Post`, `Pool` | On-chain data types |
| `KovaraError` | Base error class |
| `NotFoundError` | Resource not found on-chain |
| `UnauthorizedError` | Caller lacks permission |
| `InsufficientBalanceError` | Insufficient funds or allowance |
| `CooldownError` | Tip cooldown still active |
| `InvalidInputError` | Input failed pre-flight validation |
| `InvalidManifestError` | Mini-app manifest schema violation |
| `validateManifest` | Validate a mini-app manifest object |
| `MiniAppManifest` | Typed mini-app manifest interface |
| `mapError` | Map raw contract errors to typed errors |

---

## API Reference

### Profiles

```ts
// Fetch a user profile
const profile = await client.getProfile("GABC...XYZ");
// profile: { address, username, creator_token } | null

// Get total profile count
const count = await client.getProfileCount(); // bigint
```

### Posts

```ts
// Fetch a single post by ID
const post = await client.getPost(1n);
// post: { id, author, content, tip_total, timestamp, like_count } | null

// Total posts ever created (never decrements on delete)
const total = await client.getPostCount(); // bigint

// Paginated post IDs for an author (offset/limit, max 50 per page)
const postIds = await client.getPostsByAuthor("GABC...XYZ", 0, 20);
// postIds: bigint[]   — iterate to fetch each post via getPost()

// Like count for a post
const likes = await client.getLikeCount(1n); // bigint

// Check if an address has liked a post
const liked = await client.hasLiked("GABC...XYZ", 1n); // boolean
```

#### Paginating all posts by an author

```ts
const PAGE_SIZE = 20;
let offset = 0;
let page: bigint[];

do {
  page = await client.getPostsByAuthor(authorAddress, offset, PAGE_SIZE);
  for (const id of page) {
    const post = await client.getPost(id);
    console.log(post?.content);
  }
  offset += PAGE_SIZE;
} while (page.length === PAGE_SIZE);
```

### Social Graph

```ts
// Who is this address following? (paginated, max 50)
const following = await client.getFollowing("GABC...XYZ", 0, 50);

// Who follows this address? (paginated, max 50)
const followers = await client.getFollowers("GABC...XYZ", 0, 50);

// Check block status
const blocked = await client.isBlocked("GABC...blocker", "GABC...blocked"); // boolean
```

### Community Pools

```ts
// Fetch a pool by ID
const pool = await client.getPool("pool_a");
// pool: { token, balance, admins, threshold } | null
```

### Fee & Treasury

```ts
// Platform fee in basis points (e.g. 500 = 5%)
const feeBps = await client.getFeeBps(); // number

// Treasury address
const treasury = await client.getTreasury(); // string | null
```

---

## Usage in Web (Next.js / React)

```ts
// lib/kovara.ts
import { KovaraClient } from "Kovara-sdk";

export const kovara = new KovaraClient({
  contractId: process.env.NEXT_PUBLIC_CONTRACT_ID!,
  networkPassphrase: process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE!,
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL!,
});
```

```tsx
// app/profile/[address]/page.tsx
import { kovara } from "@/lib/kovara";

export default async function ProfilePage({ params }: { params: { address: string } }) {
  const profile = await kovara.getProfile(params.address);
  if (!profile) return <p>Profile not found</p>;
  return <h1>@{profile.username}</h1>;
}
```

---

## Usage in React Native / Mobile

```ts
import { KovaraClient } from "Kovara-sdk";

const client = new KovaraClient({
  contractId: "CABC...XYZ",
  networkPassphrase: "Test SDF Network ; September 2015",
  rpcUrl: "https://soroban-testnet.stellar.org",
});

// Inside a hook or effect
const post = await client.getPost(BigInt(postId));
```

---

## Types

```ts
import type { Post, Profile, Pool } from "Kovara-sdk";

// Post
interface Post {
  id: bigint;
  author: string;
  content: string;
  tip_total: bigint;
  timestamp: bigint;
  like_count: bigint;
}

// Profile
interface Profile {
  address: string;
  username: string;
  creator_token: string;
}

// Pool
interface Pool {
  token: string;
  balance: bigint;
  admins: string[];
  threshold: number;
}
```

---

## Regenerating the client

Run after every contract change:

```bash
# 1. Rebuild the contract
pnpm build:contracts

# 2. Regenerate TypeScript bindings
bash packages/sdk/generate.sh

# 3. Build the SDK package
pnpm --filter sdk build
```

---

## Building for distribution

```bash
pnpm --filter sdk build
# Outputs JavaScript + type declarations to dist/
```

Automated on every `sdk/v*` tag push via `.github/workflows/publish-sdk.yml`.

---

## Prerequisites

To regenerate from the compiled contract WASM:

- Stellar CLI: `cargo install --locked stellar-cli`
- Contract built: `pnpm build:contracts`

To build or use the SDK:

- Node.js ≥ 18
- pnpm (or npm/yarn)
