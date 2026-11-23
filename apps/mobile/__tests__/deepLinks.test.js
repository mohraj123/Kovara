const { isValidDeepLink, parseDeepLink, parsePostId } = require("../utils/deepLinks");

const stellarAddress = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("deep link parsing", () => {
  it("parses post links", () => {
    expect(parseDeepLink("Kovara://post/123")).toEqual({
      type: "post",
      path: "/post/123",
    });
  });

  it("parses profile links", () => {
    expect(parseDeepLink(`Kovara://profile/${stellarAddress}`)).toEqual({
      type: "profile",
      path: `/profile/${stellarAddress}`,
    });
  });

  it("parses pool links", () => {
    expect(parseDeepLink("Kovara://pool/main_pool-1")).toEqual({
      type: "pool",
      path: "/pool/main_pool-1",
    });
  });

  it("supports triple-slash deep links", () => {
    expect(parseDeepLink("Kovara:///post/abc_123")).toEqual({
      type: "post",
      path: "/post/abc_123",
    });
  });

  it("rejects invalid or malformed links", () => {
    expect(parseDeepLink("https://Kovara/post/123")).toBeNull();
    expect(parseDeepLink("Kovara://post")).toBeNull();
    expect(parseDeepLink("Kovara://post/123/extra")).toBeNull();
    expect(parseDeepLink("Kovara://profile/not-a-stellar-address")).toBeNull();
    expect(parseDeepLink("Kovara://pool/../../settings")).toBeNull();
    expect(parseDeepLink("not a url")).toBeNull();
  });

  it("exposes a boolean validator", () => {
    expect(isValidDeepLink("Kovara://post/123")).toBe(true);
    expect(isValidDeepLink("Kovara://post/")).toBe(false);
  });
});

describe("post id route param parsing", () => {
  it("accepts ids the deep link parser accepts", () => {
    expect(parsePostId("123")).toEqual({ ok: true, id: "123" });
    expect(parsePostId("abc_123-x")).toEqual({ ok: true, id: "abc_123-x" });
    expect(parsePostId(" 42 ")).toEqual({ ok: true, id: "42" });
    expect(parsePostId("post%5F1")).toEqual({ ok: true, id: "post_1" });
  });

  it("unwraps a single-element array param", () => {
    expect(parsePostId(["77"])).toEqual({ ok: true, id: "77" });
  });

  it("reports missing ids", () => {
    expect(parsePostId(undefined)).toEqual({ ok: false, reason: "missing" });
    expect(parsePostId(null)).toEqual({ ok: false, reason: "missing" });
    expect(parsePostId("")).toEqual({ ok: false, reason: "missing" });
    expect(parsePostId("   ")).toEqual({ ok: false, reason: "missing" });
    expect(parsePostId([])).toEqual({ ok: false, reason: "missing" });
  });

  it("reports malformed ids", () => {
    expect(parsePostId("../settings")).toEqual({ ok: false, reason: "malformed" });
    expect(parsePostId("12 34")).toEqual({ ok: false, reason: "malformed" });
    expect(parsePostId("%E0%A4%A")).toEqual({ ok: false, reason: "malformed" });
    expect(parsePostId("a".repeat(129))).toEqual({ ok: false, reason: "malformed" });
    expect(parsePostId(["1", "2"])).toEqual({ ok: false, reason: "malformed" });
  });
});
