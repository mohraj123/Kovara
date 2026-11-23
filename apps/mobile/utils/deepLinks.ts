export type DeepLinkRoute =
  | {
      type: "post";
      path: `/post/${string}`;
    }
  | {
      type: "profile";
      path: `/profile/${string}`;
    }
  | {
      type: "pool";
      path: `/pool/${string}`;
    };

const Kovara_SCHEME = "Kovara:";
const Kovara_PREFIX = "Kovara://";
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const STELLAR_PUBLIC_KEY_PATTERN = /^G[A-Z2-7]{55}$/;

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function getDeepLinkSegments(value: string): Array<string | null> | null {
  if (!value.startsWith(Kovara_PREFIX)) {
    return null;
  }

  const withoutScheme = value.slice(Kovara_PREFIX.length);
  const pathEndIndex = withoutScheme.search(/[?#]/);
  const rawPath = pathEndIndex === -1 ? withoutScheme : withoutScheme.slice(0, pathEndIndex);
  const path = rawPath.startsWith("/") ? rawPath.slice(1) : rawPath;
  const segments = path.split("/");

  if (segments.length !== 2) {
    return null;
  }

  return segments.map(safeDecode);
}

function isValidId(value: string): boolean {
  return ID_PATTERN.test(value);
}

function isValidProfileAddress(value: string): boolean {
  return STELLAR_PUBLIC_KEY_PATTERN.test(value);
}

export function parseDeepLink(value: string): DeepLinkRoute | null {
  if (!value.startsWith(Kovara_SCHEME)) {
    return null;
  }

  const segments = getDeepLinkSegments(value);

  if (!segments || segments.some((segment) => !segment)) {
    return null;
  }

  const [resource, rawId] = segments as [string, string];

  switch (resource) {
    case "post":
      return isValidId(rawId) ? { type: "post", path: `/post/${rawId}` } : null;
    case "profile":
      return isValidProfileAddress(rawId) ? { type: "profile", path: `/profile/${rawId}` } : null;
    case "pool":
      return isValidId(rawId) ? { type: "pool", path: `/pool/${rawId}` } : null;
    default:
      return null;
  }
}

export function isValidDeepLink(value: string): boolean {
  return parseDeepLink(value) !== null;
}

export type PostIdParseResult =
  | { ok: true; id: string }
  | { ok: false; reason: "missing" | "malformed" };

/**
 * Normalises the `id` route param of the post detail screen. Expo Router may
 * hand us `undefined`, an empty string, or an array (repeated segments), and
 * an externally crafted deep link can contain anything, so the screen must be
 * able to tell "no id" apart from "unsupported id" without hitting the indexer.
 */
export function parsePostId(raw: string | string[] | null | undefined): PostIdParseResult {
  if (Array.isArray(raw)) {
    if (raw.length !== 1) {
      return raw.length === 0 ? { ok: false, reason: "missing" } : { ok: false, reason: "malformed" };
    }
    return parsePostId(raw[0]);
  }

  if (typeof raw !== "string" || !raw.trim()) {
    return { ok: false, reason: "missing" };
  }

  const decoded = safeDecode(raw.trim());
  if (decoded === null || !isValidId(decoded)) {
    return { ok: false, reason: "malformed" };
  }

  return { ok: true, id: decoded };
}
