import "dotenv/config";
import { Pool as PgPool } from "pg";
import { createPgPoolFromEnv, insertRawEvent } from "./db";
import { routeFollowGraphEvent } from "./handlers/follow";
import { streamSorobanEvents } from "./stream";

const rpcUrl = process.env.SOROBAN_RPC_URL;
const contractAddress = process.env.LINKORA_CONTRACT_ADDRESS;
const pollIntervalMs = Number(process.env.SOROBAN_POLL_INTERVAL_MS ?? "3000");
const startCursor = process.env.SOROBAN_START_CURSOR;

if (!rpcUrl) {
  throw new Error("SOROBAN_RPC_URL is required");
}
if (!contractAddress) {
  throw new Error("LINKORA_CONTRACT_ADDRESS is required");
}

function getEventType(event: { type: string; topic: unknown }): string {
  const normalize = (value: string): string => {
    const cleaned = value.replace(/^symbol:/i, "");
    if (cleaned.toLowerCase() === "follow") {
      return "FollowEvent";
    }
    if (cleaned.toLowerCase() === "unfollow") {
      return "UnfollowEvent";
    }
    return cleaned;
  };

  if (event.type && event.type !== "unknown") {
    return normalize(event.type);
  }

  if (Array.isArray(event.topic) && event.topic.length > 0) {
    return normalize(String(event.topic[0]));
  }

  return "unknown";
}

async function start(): Promise<void> {
  const pool = createPgPoolFromEnv();
  const shutdownController = new AbortController();
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`Received ${signal}. Shutting down indexer...`);
    shutdownController.abort();
    await pool.end();
    console.log("Indexer shutdown complete.");
  };

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  await streamSorobanEvents({
    rpcUrl,
    contractAddress,
    startCursor,
    pollIntervalMs,
    signal: shutdownController.signal,
    onEvent: async (event) => {
      const eventType = getEventType(event);
      await insertRawEvent(pool, {
        contractAddress,
        eventType,
        txHash: event.txHash,
        ledger: event.ledger,
        topic: event.topic,
        value: event.value,
        rawEvent: event.raw,
      });
      await routeFollowGraphEvent(pool as unknown as PgPool, eventType, event.value);
    },
    onCursor: ({ cursor }) => {
      console.log(`Advanced event cursor to ${cursor}`);
    },
  });
}

void start();
