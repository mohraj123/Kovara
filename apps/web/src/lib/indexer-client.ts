export interface IndexerQueryOptions {
  endpoint: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  params?: Record<string, any>;
  body?: any;
  token?: string;
  /**
   * Override the request timeout, in milliseconds. Defaults to
   * {@link DEFAULT_TIMEOUT_MS}. Pass `0` to disable the timeout entirely.
   */
  timeoutMs?: number;
}

/** How long a request may take before it is aborted. */
export const DEFAULT_TIMEOUT_MS = 15_000;

/** Status reported when a request is aborted because it timed out. */
export const INDEXER_TIMEOUT_STATUS = 408;

/** Longest error-body excerpt kept in a message, so a huge HTML page cannot flood the UI. */
const MAX_ERROR_BODY_LENGTH = 200;

export class IndexerClientError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
    this.name = 'IndexerClientError';
  }

  /** True when the request was aborted because it exceeded its timeout (FE-27). */
  get isTimeout(): boolean {
    return this.statusCode === INDEXER_TIMEOUT_STATUS;
  }
}

/** A useful message from an error body, without trusting its shape. */
function messageFromBody(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const message = (body as { message?: unknown }).message;
  return typeof message === 'string' && message.trim() !== '' ? message : undefined;
}

export class IndexerClient {
  private baseUrl: string;
  private defaultTimeoutMs: number;

  constructor(
    baseUrl: string = process.env.NEXT_PUBLIC_INDEXER_API_URL || 'https://indexer.nexafx.com/v1',
    defaultTimeoutMs: number = DEFAULT_TIMEOUT_MS
  ) {
    // A trailing slash would otherwise produce `https://host//endpoint`.
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  public async request<T>(options: IndexerQueryOptions): Promise<T> {
    const { endpoint, method = 'GET', params, body, token } = options;
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;

    let url = `${this.baseUrl}/${endpoint.replace(/^\/+/, '')}`;
    if (params) {
      const searchParams = new URLSearchParams();
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          if (Array.isArray(value)) {
            value.forEach((item) => searchParams.append(key, String(item)));
          } else {
            searchParams.append(key, String(value));
          }
        }
      });
      const queryString = searchParams.toString();
      if (queryString) {
        url += `?${queryString}`;
      }
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    // FE-27: a request with no deadline hangs forever if the indexer accepts the
    // connection and then stalls — the screen's spinner spins indefinitely and
    // the user has no way to tell it apart from a slow request.
    const controller = new AbortController();
    const timer =
      timeoutMs > 0
        ? setTimeout(() => controller.abort(), timeoutMs)
        : undefined;

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (error) {
      // An abort surfaces as a rejection with the fetch implementation's own
      // name, which is the only reliable way to tell it apart from a real
      // network failure.
      if ((error as { name?: string })?.name === 'AbortError') {
        throw new IndexerClientError(
          INDEXER_TIMEOUT_STATUS,
          `Indexer request timed out after ${timeoutMs}ms`
        );
      }
      throw new IndexerClientError(
        0,
        `Could not reach the indexer: ${(error as Error)?.message ?? 'unknown error'}`
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    // FE-26: read the body as text **first**, then parse. `response.json()`
    // throws on a non-JSON body, and everything that can reach this client in
    // the wild can: a proxy's HTML error page, a gateway's plain-text 502, a
    // CDN interstitial. Calling `.json()` in a try/catch throws away the body,
    // so the only thing the caller learns is a status code and a generic string
    // — the actual explanation is discarded precisely when it is most useful.
    // The status is preserved either way; only the message improves.
    let rawBody = '';
    try {
      rawBody = await response.text();
    } catch {
      rawBody = '';
    }

    if (!response.ok) {
      let parsed: unknown;
      try {
        parsed = rawBody ? JSON.parse(rawBody) : undefined;
      } catch {
        parsed = undefined;
      }

      const fromBody = messageFromBody(parsed);
      const fallback = rawBody
        ? `Indexer request failed with status ${response.status}: ${rawBody
            .trim()
            .slice(0, MAX_ERROR_BODY_LENGTH)}`
        : `Indexer request failed with status ${response.status}`;

      throw new IndexerClientError(response.status, fromBody ?? fallback);
    }

    if (!rawBody) {
      // 204 and friends. `.json()` on an empty body rejects with a SyntaxError
      // that says nothing useful about what happened.
      return undefined as T;
    }

    try {
      return JSON.parse(rawBody) as T;
    } catch {
      throw new IndexerClientError(
        response.status,
        'Indexer returned a success response that was not valid JSON'
      );
    }
  }
}

export const indexerClient = new IndexerClient();
