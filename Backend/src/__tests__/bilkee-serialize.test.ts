import { serialize, serializeValue, defineSerializer, paginated, SerializationError } from "../api/serialize";

describe("serialize (#663)", () => {
  describe("bigint handling", () => {
    it("renders bigints as decimal strings", () => {
      expect(serializeValue(9007199254740993n, "")).toBe("9007199254740993");
    });

    it("does not lose precision on values beyond MAX_SAFE_INTEGER", () => {
      // The whole reason bigints are stringified rather than Number()-ed: a
      // numeric conversion here would silently round to ...992.
      const tipTotal = 1234567890123456789n;
      expect(serializeValue(tipTotal, "")).toBe("1234567890123456789");
    });

    it("works without any BigInt.prototype.toJSON override", () => {
      // Explicit, because the codebase installs a global override elsewhere.
      // This module must not depend on it: a global BigInt.toJSON changes how
      // every bigint in the process serializes, and this is the replacement for
      // depending on that.
      const original = (BigInt.prototype as unknown as Record<string, unknown>).toJSON;
      delete (BigInt.prototype as unknown as Record<string, unknown>).toJSON;
      try {
        expect(serializeValue(42n, "")).toBe("42");
      } finally {
        if (original) {
          (BigInt.prototype as unknown as Record<string, unknown>).toJSON = original;
        }
      }
    });
  });

  describe("primitive coercion", () => {
    it("converts Date to ISO 8601", () => {
      const d = new Date("2026-01-02T03:04:05.000Z");
      expect(serializeValue(d, "")).toBe("2026-01-02T03:04:05.000Z");
    });

    it("renders an invalid Date as null rather than an unparseable string", () => {
      expect(serializeValue(new Date("not a date"), "")).toBeNull();
    });

    it("renders NaN and Infinity as null", () => {
      expect(serializeValue(NaN, "")).toBeNull();
      expect(serializeValue(Infinity, "")).toBeNull();
      expect(serializeValue(-Infinity, "")).toBeNull();
    });

    it("omits undefined, functions, and symbols entirely", () => {
      // Omitted rather than null so "absent" stays distinguishable from
      // "present and null".
      expect(serializeValue({ a: 1, b: undefined, c: () => 1, d: Symbol("x") }, "")).toEqual({ a: 1 });
    });

    it("converts Buffer to base64", () => {
      expect(serializeValue(Buffer.from("hi"), "")).toBe("aGk=");
    });

    it("refuses a Map rather than emitting an empty object", () => {
      // JSON.stringify(new Map([["a",1]])) is "{}" — a populated collection
      // would look like an empty object to a client.
      expect(() => serializeValue(new Map([["a", 1]]), "")).toThrow(SerializationError);
      expect(() => serializeValue(new Set([1]), "")).toThrow(/no JSON representation/);
    });
  });

  describe("cycles and depth", () => {
    it("throws on a circular reference by default", () => {
      const node: Record<string, unknown> = { name: "a" };
      node.self = node;
      expect(() => serialize(node)).toThrow(/circular reference/);
    });

    it("reports the path where the cycle occurred", () => {
      const node: Record<string, unknown> = { child: { name: "a" } };
      (node.child as Record<string, unknown>).parent = node;
      try {
        serialize(node);
        throw new Error("expected a SerializationError");
      } catch (err) {
        expect(err).toBeInstanceOf(SerializationError);
        expect((err as SerializationError).path).toBe("child.parent");
      }
    });

    it("can emit a marker instead of throwing", () => {
      const node: Record<string, unknown> = { name: "a" };
      node.self = node;
      expect(serialize(node, { throwOnCircular: false })).toEqual({ name: "a", self: "[Circular]" });
    });

    it("treats a repeated sibling reference as valid, not a cycle", () => {
      // The same object appearing twice in different branches is not a cycle.
      // Only an ancestor on the current path is.
      const shared = { id: 1 };
      expect(serialize({ a: shared, b: shared })).toEqual({ a: { id: 1 }, b: { id: 1 } });
    });

    it("enforces a maximum depth", () => {
      let deep: Record<string, unknown> = { end: true };
      for (let i = 0; i < 40; i += 1) deep = { next: deep };
      expect(() => serialize(deep, { maxDepth: 10 })).toThrow(/nesting depth/);
    });
  });

  describe("untrusted shapes", () => {
    it("ignores a toJSON by default so it cannot inject fields", () => {
      // A toJSON on a value that came from a parsed body is attacker-reachable,
      // and one that adds a field adds a field the service never chose to
      // publish.
      const hostile = { safe: 1, toJSON: () => ({ safe: 1, injected: "secret" }) };
      expect(serialize(hostile)).toEqual({ safe: 1 });
    });

    it("honours toJSON only when explicitly allowed", () => {
      const value = { safe: 1, toJSON: () => ({ safe: 1, extra: 2 }) };
      expect(serialize(value, { allowToJSON: true })).toEqual({ safe: 1, extra: 2 });
    });

    it("drops __proto__, constructor, and prototype keys", () => {
      const payload = JSON.parse('{"__proto__": {"admin": true}, "ok": 1}') as Record<string, unknown>;
      const out = serialize(payload) as Record<string, unknown>;
      expect(out).toEqual({ ok: 1 });
      // The real check: nothing was written to Object.prototype.
      expect(({} as Record<string, unknown>).admin).toBeUndefined();
    });
  });

  describe("defineSerializer (allowlist)", () => {
    const serializePost = defineSerializer<Record<string, unknown>>({
      id: {},
      author: {},
      // creator_token is an internal column and is never named, so it cannot
      // leak through this serializer even though it is present on the row.
      tip_total: {},
    });

    it("emits exactly the declared fields, in declaration order", () => {
      const out = serializePost({ id: 7n, author: "GABC", tip_total: 5n, created_ledger: 3 });
      expect(Object.keys(out)).toEqual(["id", "author", "tip_total"]);
    });

    it("drops fields that exist on the row but are not declared", () => {
      // This is the tenant-safety property: the exposed field set is a property
      // of the code, not of the data.
      const out = serializePost({
        id: 1n,
        author: "GABC",
        tip_total: 0n,
        creator_token: "SECRET-OPERATOR-TOKEN",
        search_vector: "hidden",
      });
      expect(JSON.stringify(out)).not.toContain("SECRET-OPERATOR-TOKEN");
      expect(out.creator_token).toBeUndefined();
    });

    it("produces stable output for equal input", () => {
      // A client diffing two responses should see only real changes.
      const row = { id: 1n, author: "GABC", tip_total: 2n };
      expect(JSON.stringify(serializePost(row))).toBe(JSON.stringify(serializePost({ ...row })));
    });

    it("renames via from", () => {
      const s = defineSerializer<{ userId: bigint }>({ id: { from: "userId" } });
      expect(s({ userId: 9n })).toEqual({ id: "9" });
    });

    it("omits a field whose custom rule returns undefined", () => {
      const s = defineSerializer<{ secret: string; id: bigint }>({
        secret: { serialize: () => undefined },
        id: {},
      });
      expect(s({ secret: "s", id: 1n })).toEqual({ id: "1" });
    });

    it("exposes its declared field list", () => {
      expect(serializePost.fields).toEqual(["id", "author", "tip_total"]);
    });

    it("rejects a non-object input rather than emitting a confusing shape", () => {
      expect(() => serializePost(42 as unknown as Record<string, unknown>)).toThrow(SerializationError);
      expect(() => serializePost(null as unknown as Record<string, unknown>)).toThrow(/nullish/);
    });
  });

  describe("paginated", () => {
    const identity = (n: number) => ({ id: n });

    it("derives has_more from the returned row count, not total", () => {
      // A total that is an exact multiple of the page size must still report
      // has_more false on the final page.
      const out = paginated([1, 2], identity, { total: 2, limit: 2, offset: 0 });
      expect(out.has_more).toBe(false);
    });

    it("reports has_more when a further page exists", () => {
      const out = paginated([3, 4], identity, { total: 10, limit: 2, offset: 2 });
      expect(out.has_more).toBe(true);
    });

    it("keeps array indices stable when an element serializes to undefined", () => {
      // JSON.stringify turns a hole or an undefined element into null, and
      // preserving that keeps array length and indices aligned for a client
      // zipping results against another list.
      expect(serializeValue([1, undefined, 3], "")).toEqual([1, null, 3]);
      expect(serializeValue([1, () => 1, 3], "")).toEqual([1, null, 3]);
    });
  });
});
