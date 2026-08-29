import {
  ConfigError,
  DEFAULT_START_LEDGER,
  DEFAULT_STELLAR_RPC_URL,
  isValidContractId,
  loadConfig,
  parseContractId,
  parseDatabaseUrl,
  parseStartLedger,
  parseStellarRpcUrl,
} from "../config";

/**
 * Real Stellar contract addresses (mainnet asset contracts). Used as fixtures
 * because they carry genuine strkey checksums, which a hand-written string of
 * the right length would not.
 */
const VALID_CONTRACT_ID = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const OTHER_VALID_CONTRACT_ID = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";

const VALID_DATABASE_URL = "postgresql://kovara:kovara@localhost:5432/kovara";

/** A fully valid environment, used as the baseline for negative cases. */
function validEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    DATABASE_URL: VALID_DATABASE_URL,
    STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
    CONTRACT_ID: VALID_CONTRACT_ID,
    START_LEDGER: "1234",
    ...overrides,
  };
}

describe("parseDatabaseUrl", () => {
  it("accepts a configured PostgreSQL connection string", () => {
    expect(parseDatabaseUrl(VALID_DATABASE_URL)).toBe(VALID_DATABASE_URL);
  });

  it("accepts the postgres:// scheme alias and the docker-compose host form", () => {
    const compose = "postgres://Kovara:Kovara@postgres:5432/Kovara";
    expect(parseDatabaseUrl(compose)).toBe(compose);
  });

  it.each([undefined, "", "   "])("fails when DATABASE_URL is %p", (raw) => {
    expect(() => parseDatabaseUrl(raw)).toThrow(ConfigError);
    expect(() => parseDatabaseUrl(raw)).toThrow(/DATABASE_URL is required/);
  });

  it("rejects the sqlite::memory: fallback the indexer cannot actually use", () => {
    expect(() => parseDatabaseUrl("sqlite::memory:")).toThrow(
      /must be a PostgreSQL connection string/
    );
  });

  it("rejects a non-PostgreSQL database URL", () => {
    expect(() => parseDatabaseUrl("mysql://user:pw@localhost:3306/kovara")).toThrow(
      /must be a PostgreSQL connection string/
    );
  });

  it("rejects a value that is not a URL at all", () => {
    expect(() => parseDatabaseUrl("just-a-host-name")).toThrow(/not a valid connection URL/);
  });

  it("does not leak credentials when reporting a malformed URL", () => {
    // A bare "//" is a URL parse failure but still carries userinfo.
    const err = captureConfigError(() => parseDatabaseUrl("//kovara:hunter2@localhost/db"));
    expect(err.message).not.toContain("hunter2");
  });

  it("trims surrounding whitespace from an otherwise valid value", () => {
    expect(parseDatabaseUrl(`  ${VALID_DATABASE_URL}  `)).toBe(VALID_DATABASE_URL);
  });
});

describe("isValidContractId", () => {
  it("accepts real contract addresses", () => {
    expect(isValidContractId(VALID_CONTRACT_ID)).toBe(true);
    expect(isValidContractId(OTHER_VALID_CONTRACT_ID)).toBe(true);
  });

  it("rejects an address whose checksum does not match", () => {
    // Flip one character in the payload; length and alphabet stay valid.
    const mutated = `CDW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75`;
    expect(mutated).toHaveLength(VALID_CONTRACT_ID.length);
    expect(isValidContractId(mutated)).toBe(false);
  });

  it("rejects an account address, which is a different strkey type", () => {
    expect(isValidContractId("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF5")).toBe(
      false
    );
  });

  it("rejects wrong lengths and non-base32 characters", () => {
    expect(isValidContractId(VALID_CONTRACT_ID.slice(0, 55))).toBe(false);
    expect(isValidContractId(`${VALID_CONTRACT_ID}A`)).toBe(false);
    expect(isValidContractId(`C1${VALID_CONTRACT_ID.slice(2)}`)).toBe(false);
    expect(isValidContractId(VALID_CONTRACT_ID.toLowerCase())).toBe(false);
  });
});

describe("parseContractId", () => {
  it("accepts a configured contract address", () => {
    expect(parseContractId(VALID_CONTRACT_ID)).toBe(VALID_CONTRACT_ID);
  });

  it.each([undefined, "", "   "])("fails when CONTRACT_ID is %p", (raw) => {
    expect(() => parseContractId(raw)).toThrow(/CONTRACT_ID is required/);
  });

  it("rejects the PLACEHOLDER_CONTRACT_ID fallback", () => {
    expect(() => parseContractId("PLACEHOLDER_CONTRACT_ID")).toThrow(
      /not a valid Stellar contract address/
    );
  });

  it("rejects the .env.example placeholder shape", () => {
    expect(() => parseContractId("CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX")).toThrow(
      /not a valid Stellar contract address/
    );
  });

  it("rejects a malformed address that is the right length", () => {
    expect(() => parseContractId("C".repeat(56))).toThrow(/not a valid Stellar contract address/);
  });
});

describe("parseStartLedger", () => {
  it("accepts finite non-negative integers", () => {
    expect(parseStartLedger("0")).toBe(0);
    expect(parseStartLedger("1")).toBe(1);
    expect(parseStartLedger("52340987")).toBe(52340987);
  });

  it("defaults to the genesis ledger when unset", () => {
    expect(parseStartLedger(undefined)).toBe(DEFAULT_START_LEDGER);
    expect(parseStartLedger("")).toBe(DEFAULT_START_LEDGER);
    expect(parseStartLedger("  ")).toBe(DEFAULT_START_LEDGER);
  });

  // Regression: parseInt(value, 10) returned NaN or a silently truncated
  // number for every one of these, and the stream config accepted it.
  it.each(["abc", "NaN", "", " ", "1e3", "0x10", "Infinity", "1.5", "1_000"])(
    "rejects the malformed value %p rather than producing NaN",
    (raw) => {
      if (raw.trim() === "") return; // covered by the default case above
      expect(() => parseStartLedger(raw)).toThrow(ConfigError);
      expect(() => parseStartLedger(raw)).toThrow(/must be a non-negative integer/);
    }
  );

  it("rejects a value parseInt would silently truncate", () => {
    expect(() => parseStartLedger("12abc")).toThrow(/must be a non-negative integer/);
    expect(() => parseStartLedger("42 ledgers")).toThrow(/must be a non-negative integer/);
  });

  it.each(["-1", "-100", "+5"])("rejects the negative or signed value %p", (raw) => {
    expect(() => parseStartLedger(raw)).toThrow(/must be a non-negative integer/);
  });

  it("rejects integers beyond the safe range", () => {
    expect(() => parseStartLedger("9".repeat(40))).toThrow(/outside the supported range/);
  });

  it("names the variable it was given, for reuse on replay bounds", () => {
    expect(() => parseStartLedger("abc", "REPLAY_START_LEDGER")).toThrow(/REPLAY_START_LEDGER/);
  });
});

describe("parseStellarRpcUrl", () => {
  it("accepts an http(s) endpoint and defaults to testnet", () => {
    expect(parseStellarRpcUrl("https://rpc.example.org")).toBe("https://rpc.example.org");
    expect(parseStellarRpcUrl(undefined)).toBe(DEFAULT_STELLAR_RPC_URL);
  });

  it("rejects a non-http endpoint", () => {
    expect(() => parseStellarRpcUrl("ftp://rpc.example.org")).toThrow(/http or https/);
    expect(() => parseStellarRpcUrl("not a url")).toThrow(/not a valid URL/);
  });
});

describe("loadConfig", () => {
  it("returns the parsed configuration for a valid PostgreSQL deployment", () => {
    expect(loadConfig(validEnv())).toEqual({
      databaseUrl: VALID_DATABASE_URL,
      stellarRpcUrl: "https://soroban-testnet.stellar.org",
      contractId: VALID_CONTRACT_ID,
      startLedger: 1234,
    });
  });

  it("applies defaults only where a default is genuinely safe", () => {
    const config = loadConfig({
      DATABASE_URL: VALID_DATABASE_URL,
      CONTRACT_ID: VALID_CONTRACT_ID,
    });
    expect(config.stellarRpcUrl).toBe(DEFAULT_STELLAR_RPC_URL);
    expect(config.startLedger).toBe(DEFAULT_START_LEDGER);
  });

  it("fails when DATABASE_URL is missing", () => {
    expect(() => loadConfig(validEnv({ DATABASE_URL: undefined }))).toThrow(
      /DATABASE_URL is required/
    );
  });

  it("fails when CONTRACT_ID is missing", () => {
    expect(() => loadConfig(validEnv({ CONTRACT_ID: undefined }))).toThrow(
      /CONTRACT_ID is required/
    );
  });

  it("fails when START_LEDGER is malformed", () => {
    expect(() => loadConfig(validEnv({ START_LEDGER: "abc" }))).toThrow(
      /START_LEDGER must be a non-negative integer/
    );
  });

  it("reports every problem at once instead of one per restart", () => {
    const err = captureConfigError(() =>
      loadConfig({ DATABASE_URL: "sqlite::memory:", CONTRACT_ID: "PLACEHOLDER_CONTRACT_ID", START_LEDGER: "-1" })
    );
    expect(err.problems).toHaveLength(3);
    expect(err.message).toMatch(/DATABASE_URL/);
    expect(err.message).toMatch(/CONTRACT_ID/);
    expect(err.message).toMatch(/START_LEDGER/);
  });

  it("reads process.env by default", () => {
    const previous = { ...process.env };
    try {
      Object.assign(process.env, validEnv({ CONTRACT_ID: OTHER_VALID_CONTRACT_ID }));
      expect(loadConfig().contractId).toBe(OTHER_VALID_CONTRACT_ID);
    } finally {
      process.env = previous as NodeJS.ProcessEnv;
    }
  });
});

/** Run `fn`, asserting it threw a ConfigError, and return it for inspection. */
function captureConfigError(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ConfigError) return err;
    throw err;
  }
  throw new Error("Expected a ConfigError to be thrown");
}
