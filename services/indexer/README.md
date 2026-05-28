# Linkora Indexer Service

This service streams Linkora Soroban contract events and stores them in PostgreSQL.

## Environment

Set the following variables before running the service:

- `DATABASE_URL` - PostgreSQL connection string
- `SOROBAN_RPC_URL` - Soroban/Horizon endpoint used for event streaming
- `LINKORA_CONTRACT_ADDRESS` - Contract address to index
- `SOROBAN_POLL_INTERVAL_MS` - Optional polling interval in milliseconds (default: `3000`)
- `PGSSLMODE` - Optional; set to `disable` to skip TLS

## Run

```bash
npm install
npm run dev
```

The service will:

1. Connect to PostgreSQL
2. Stream events from the configured contract
3. Insert raw events into the `events` table
4. Apply follow/unfollow events to the `follows` table

## Migrations

Apply SQL files in `migrations/` in order:

- `003_follows.sql`
- `004_events.sql`
- `005_pools.sql`
