/**
 * Tenant-safe JSON serialization for API responses.
 *
 * Issue #663. Three requirements, and the third is the one that shapes the
 * design:
 *
 *   1. "Responses avoid unsafe or unexpected field shapes" — `bigint` cannot
 *      survive `JSON.stringify` at all (it throws), and the existing codebase
 *      works around that with a **global** `BigInt.prototype.toJSON` override.
 *      That override is process-wide: it changes how every bigint in the
 *      service serializes, including ones that were never meant to reach a
 *      response, and it is the kind of change that is invisible until something
 *      subtle depends on it.
 *   2. "Data is standardized across services and routes" — one function, used
 *      everywhere, rather than each route hand-rolling its own conversions.
 *   3. "JSON output is stable enough for downstream clients" — deterministic
 *      key order, so a client diffing two responses sees a real change rather
 *      than reshuffling.
 *
 * **Tenant-safe** is the requirement that rules out a plain replacer. A response
 * assembled from a database row or a parsed request body carries whatever
 * columns and keys happened to be there. If the serializer copies fields
 * generically, then:
 *
 *   - a `SELECT *` that gains a column (`creator_token`, `search_vector`, an
 *     internal note) silently starts publishing it;
 *   - a client-supplied `__proto__` or `constructor` key can pollute a merged
 *     object;
 *   - a `toJSON` method on a caller-supplied object can inject fields the
 *     service never chose to expose.
 *
 * So the safe path is a **declared schema**: the service states which fields it
 * intends to publish, and the serializer projects exactly those. An extra column
 * cannot leak, because it was never named.
 *
 * This module has no dependency on the global `BigInt.prototype.toJSON` override
 * and does not install one.
 */

import { Buffer } from "buffer";

/** Why a value could not be serialized. */
export class SerializationError extends Error {
  readonly path: string;

  constructor(message: string, path: string) {
    super(`${message} (at ${path || "<root>"})`);
    this.name = "SerializationError";
    this.path = path;
  }
}

/** Keys that must never be copied from an untrusted object. */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** How deep to walk before giving up, so a pathological graph cannot hang a request. */
const DEFAULT_MAX_DEPTH = 32;

export interface SerializeOptions {
  /**
   * Throw on a circular reference instead of emitting a marker. Default true:
   * a cycle is a programming error, and shipping `"[Circular]"` to a client
   * turns a bug into a silently wrong contract.
   */
  throwOnCircular?: boolean;
  /** Maximum object/array nesting. Default 32. */
  maxDepth?: number;
  /**
   * Honour a `toJSON()` method on a value.
   *
   * Default **false**, and the default is the point. `toJSON` is attacker-
   * reachable on any object that came from a parsed body, and a `toJSON` that
   * adds a field is a field the service did not choose to publish. Types that
   * legitimately need custom serialization (Date, BigInt) are handled
   * explicitly below rather than through this flag.
   */
  allowToJSON?: boolean;
}

/** A field declaration for {@link defineSerializer}. */
export interface FieldRule<T> {
  /** The source property name. Defaults to the output key. */
  from?: string;
  /**
   * Per-field override. A field can narrow what its own value is allowed to do
   * — e.g. refuse a `toJSON` on a nested tenant-supplied object even if the
   * global option allows it.
   */
  serialize?: (value: unknown, path: string) => unknown;
}

/** A projection of an object down to a declared set of fields. */
export type Schema<T> = Record<string, string | FieldRule<T>>;

/**
 * Coerce one value into something `JSON.stringify` can represent.
 *
 * The conversions are explicit rather than delegated to `toJSON`:
 *
 *   - `bigint` → decimal **string**, never `Number`. A bigint beyond 2^53-1
 *     would be silently rounded by a numeric conversion, and this service
 *     counts tips and post ids in the token's smallest unit, so that is a
 *     realistic value rather than a theoretical one.
 *   - `Date` → ISO 8601. Invalid dates become `null` rather than
 *     `"Invalid Date"`, which is not a timestamp any client can parse.
 *   - `Buffer` → base64.
 *   - `NaN`/`Infinity` → `null`, matching `JSON.stringify` (which emits `null`)
 *     rather than producing a payload no JSON parser accepts.
 *   - `undefined`, functions, symbols → `undefined`, so the key is omitted —
 *     the same as `JSON.stringify`. Returning `null` instead would make
 *     "absent" indistinguishable from "present and null".
 */
export function serializeValue(
  value: unknown,
  path: string,
  options: SerializeOptions = {},
  seen: Set<object> = new Set(),
  depth = 0
): unknown {
  const { throwOnCircular = true, maxDepth = DEFAULT_MAX_DEPTH, allowToJSON = false } = options;

  if (value === null) return null;

  switch (typeof value) {
    case "bigint":
      return value.toString();
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : null;
    case "undefined":
    case "function":
    case "symbol":
      return undefined;
    default:
      break;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (Buffer.isBuffer(value)) {
    return value.toString("base64");
  }

  if (depth >= maxDepth) {
    throw new SerializationError("maximum nesting depth exceeded", path);
  }

  const object = value as object;
  if (seen.has(object)) {
    if (throwOnCircular) {
      throw new SerializationError("circular reference", path);
    }
    return "[Circular]";
  }
  seen.add(object);

  try {
    // A typed array or a class instance with its own toJSON is only honoured
    // when explicitly allowed.
    if (allowToJSON) {
      const maybe = object as { toJSON?: () => unknown };
      if (typeof maybe.toJSON === "function") {
        return serializeValue(maybe.toJSON(), path, options, seen, depth + 1);
      }
    }

    if (Array.isArray(object)) {
      return object.map((item, index) => {
        const serialized = serializeValue(item, `${path}[${index}]`, options, seen, depth + 1);
        // JSON.stringify turns a hole or an undefined element into null.
        // Preserving that keeps array length and indices stable for clients.
        return serialized === undefined ? null : serialized;
      });
    }

    // A Map or Set has no meaningful JSON shape; emitting {} would look like a
    // populated object, so it is an error rather than a silent lie.
    if (object instanceof Map || object instanceof Set) {
      throw new SerializationError(
        `${object.constructor.name} has no JSON representation; convert it explicitly`,
        path
      );
    }

    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(object as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(key)) continue;
      const serialized = serializeValue(item, path ? `${path}.${key}` : key, options, seen, depth + 1);
      // Omit rather than emit null, so an absent optional field is absent.
      if (serialized !== undefined) result[key] = serialized;
    }
    return result;
  } finally {
    // Pop on the way out so a value appearing twice in a *sibling* branch is
    // not mistaken for a cycle. Only an ancestor on the current path is a cycle.
    seen.delete(object);
  }
}

/**
 * Serialize an arbitrary value.
 *
 * The general-purpose entry point. For anything derived from a database row or a
 * request body, prefer {@link defineSerializer} — this function copies whatever
 * fields the object happens to have, which is the behaviour the issue asks us
 * to avoid.
 */
export function serialize<T>(value: T, options: SerializeOptions = {}): unknown {
  return serializeValue(value, "", options);
}

/** A serializer bound to a schema. */
export interface BoundSerializer<T> {
  (value: T, options?: SerializeOptions): Record<string, unknown>;
  /** The field names this serializer can emit, in declaration order. */
  readonly fields: readonly string[];
}

/**
 * Build a serializer that emits **only** the declared fields.
 *
 * This is the tenant-safe path. Everything is projected through an allowlist, so
 * a row that gains a column, or a body that carries an extra key, cannot leak
 * through this serializer. Field order follows the declaration, which is what
 * makes the output stable for a client diffing two responses.
 *
 * ```ts
 * const serializeProfile = defineSerializer<ProfileRow>({
 *   address: {},
 *   username: {},
 *   // An internal column, never named, therefore never published.
 *   creator_token: { serialize: () => undefined },
 * });
 * ```
 */
export function defineSerializer<T>(schema: Schema<T>): BoundSerializer<T> {
  const keys = Object.keys(schema);

  const bound = ((value: T, options: SerializeOptions = {}): Record<string, unknown> => {
    if (value === null || value === undefined) {
      throw new SerializationError("cannot serialize a nullish value as an object", "");
    }
    if (typeof value !== "object") {
      throw new SerializationError(
        `expected an object but received ${typeof value}`,
        ""
      );
    }

    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};

    for (const key of keys) {
      if (FORBIDDEN_KEYS.has(key)) continue;
      const rule = schema[key];
      const from = typeof rule === "string" ? rule : (rule?.from ?? key);
      const custom = typeof rule === "object" ? rule.serialize : undefined;
      const raw = Object.prototype.hasOwnProperty.call(source, from) ? source[from] : undefined;

      const path = key;
      const value_ = custom
        ? custom(raw, path)
        : serializeValue(raw, path, options);

      if (value_ !== undefined) out[key] = value_;
    }

    return out;
  }) as BoundSerializer<T>;

  Object.defineProperty(bound, "fields", { value: keys, enumerable: true });
  return bound;
}

/**
 * The standard envelope every list endpoint returns.
 *
 * Centralised so pagination metadata is identical across routes: a client can
 * rely on `has_more` meaning the same thing everywhere, which it cannot when
 * each route invents its own field.
 */
export function paginated<T>(
  items: T[],
  serializeItem: (item: T) => unknown,
  meta: { total: number; limit: number; offset: number }
): Record<string, unknown> {
  const serialized = items.map(serializeItem);
  return {
    items: serialized,
    total: meta.total,
    limit: meta.limit,
    offset: meta.offset,
    // Derived from the returned row count, not from `total`, so the final page
    // reports false even when total is an exact multiple of the page size.
    has_more: meta.offset + serialized.length < meta.total,
  };
}
