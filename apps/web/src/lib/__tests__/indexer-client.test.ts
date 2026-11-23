import {
  DEFAULT_TIMEOUT_MS,
  INDEXER_TIMEOUT_STATUS,
  IndexerClient,
  IndexerClientError,
} from '../indexer-client';

/**
 * Build a `Response`-shaped fake.
 *
 * The client reads the body with `.text()` and parses it itself, so a fake that
 * only exposes `.json()` would make every assertion here test a path the client
 * no longer takes.
 */
function fakeResponse(options: {
  ok: boolean;
  status?: number;
  body?: string;
}): { ok: boolean; status: number; text: () => Promise<string> } {
  return {
    ok: options.ok,
    status: options.status ?? 200,
    text: async () => options.body ?? '',
  };
}

function jsonBody(value: unknown): string {
  return JSON.stringify(value);
}
describe('IndexerClient', () => {
  const client = new IndexerClient('https://api.test.com');

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should serialize query parameters correctly on GET requests', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(fakeResponse({ ok: true, body: jsonBody({ success: true, data: [] }) }));

    await client.request({
      endpoint: 'search',
      params: { q: 'stellar', limit: 10 },
    });

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.test.com/search?q=stellar&limit=10',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('should attach Authorization header when token is provided', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      fakeResponse({ ok: true, body: jsonBody({}) })
    );

    await client.request({
      endpoint: 'protected',
      token: 'secret-token-123',
    });

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.test.com/protected',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer secret-token-123',
        }),
      })
    );
  });

  it('should throw IndexerClientError on non-ok responses', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(fakeResponse({ ok: false, status: 400, body: jsonBody({ message: 'Bad Request' }) }));

    await expect(client.request({ endpoint: 'bad' })).rejects.toThrow(
      new IndexerClientError(400, 'Bad Request')
    );
  });

  it('should handle spaces in query parameters', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(fakeResponse({ ok: true, body: jsonBody({ success: true }) }));

    await client.request({
      endpoint: 'search',
      params: { q: 'hello world', tag: 'foo bar' },
    });

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.test.com/search?q=hello+world&tag=foo+bar',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('should handle reserved characters in query parameters', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(fakeResponse({ ok: true, body: jsonBody({ success: true }) }));

    await client.request({
      endpoint: 'search',
      params: { q: 'a&b=c+d', filter: '100%' },
    });

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.test.com/search?q=a%26b%3Dc%2Bd&filter=100%25',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('should handle repeated keys for array values', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(fakeResponse({ ok: true, body: jsonBody({ success: true }) }));

    await client.request({
      endpoint: 'filter',
      params: { tags: ['crypto', 'defi', 'stellar'] },
    });

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.test.com/filter?tags=crypto&tags=defi&tags=stellar',
      expect.objectContaining({ method: 'GET' })
    );
  });
});
describe('IndexerClient — non-JSON error bodies (FE-26)', () => {
  const client = new IndexerClient('https://api.test.com');

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('preserves the status when the error body is HTML', async () => {
    // A proxy or gateway returns an HTML error page. The status is the only
    // reliable signal and it must survive.
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      fakeResponse({
        ok: false,
        status: 502,
        body: '<html><body><h1>502 Bad Gateway</h1></body></html>',
      })
    );

    await expect(client.request({ endpoint: 'search' })).rejects.toMatchObject({
      statusCode: 502,
    });
  });

  it('surfaces a plain-text error body in the message', async () => {
    // `.json()` would have thrown here and thrown the body away, leaving the
    // caller with a bare "failed with status 502".
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      fakeResponse({ ok: false, status: 502, body: 'upstream connect error' })
    );

    await expect(client.request({ endpoint: 'search' })).rejects.toThrow(/upstream connect error/);
  });

  it('truncates a very long error body', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      fakeResponse({ ok: false, status: 500, body: 'x'.repeat(5000) })
    );

    const error = await client.request({ endpoint: 'search' }).catch((err) => err as Error);
    expect((error as Error).message.length).toBeLessThan(400);
  });

  it('falls back to the status alone when the body is empty', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(fakeResponse({ ok: false, status: 401 }));

    await expect(client.request({ endpoint: 'search' })).rejects.toThrow(
      'Indexer request failed with status 401'
    );
  });

  it('prefers a JSON message field over the raw body', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      fakeResponse({ ok: false, status: 400, body: jsonBody({ message: 'Bad Request' }) })
    );

    await expect(client.request({ endpoint: 'bad' })).rejects.toThrow(
      new IndexerClientError(400, 'Bad Request')
    );
  });

  it('ignores a JSON error body with no usable message', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      fakeResponse({ ok: false, status: 400, body: jsonBody({ error: 'nope' }) })
    );

    const error = await client.request({ endpoint: 'bad' }).catch((err) => err as Error);
    expect((error as Error).message).toContain('400');
    expect((error as Error).message).toContain('nope');
  });

  it('reports a success response that is not valid JSON', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      fakeResponse({ ok: true, body: 'not json at all' })
    );

    await expect(client.request({ endpoint: 'search' })).rejects.toThrow(
      /not valid JSON/
    );
  });

  it('returns undefined for an empty success body', async () => {
    // A 204 must not surface as a SyntaxError from `.json()`.
    (global.fetch as jest.Mock).mockResolvedValueOnce(fakeResponse({ ok: true, body: '' }));

    await expect(client.request({ endpoint: 'ack' })).resolves.toBeUndefined();
  });
});

describe('IndexerClient — request timeout (FE-27)', () => {
  const client = new IndexerClient('https://api.test.com');

  beforeEach(() => {
    global.fetch = jest.fn();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  it('aborts the request after the timeout and maps it to a timeout error', async () => {
    (global.fetch as jest.Mock).mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            const error = new Error('The operation was aborted');
            error.name = 'AbortError';
            reject(error);
          });
        })
    );

    const pending = client.request({ endpoint: 'slow', timeoutMs: 50 });
    const assertion = expect(pending).rejects.toMatchObject({
      statusCode: INDEXER_TIMEOUT_STATUS,
      isTimeout: true,
    });

    jest.advanceTimersByTime(50);
    await assertion;
  });

  it('sends an AbortSignal with every request', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(fakeResponse({ ok: true, body: '{}' }));

    await client.request({ endpoint: 'ok' });

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.test.com/ok',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it('does not time out a request that resolves in time', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(fakeResponse({ ok: true, body: '{"a":1}' }));

    await expect(client.request({ endpoint: 'ok', timeoutMs: 1000 })).resolves.toEqual({ a: 1 });
  });

  it('can disable the timeout entirely', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(fakeResponse({ ok: true, body: '{"a":1}' }));

    // timeoutMs: 0 must not arm a zero-delay timer that aborts immediately.
    await expect(client.request({ endpoint: 'ok', timeoutMs: 0 })).resolves.toEqual({ a: 1 });
  });

  it('reports a network failure distinctly from a timeout', async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce(new TypeError('fetch failed'));

    const error = await client.request({ endpoint: 'down' }).catch((err) => err as IndexerClientError);
    expect(error).toBeInstanceOf(IndexerClientError);
    expect((error as IndexerClientError).statusCode).toBe(0);
    expect((error as IndexerClientError).isTimeout).toBe(false);
  });

  it('exports a sane default timeout', () => {
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('does not produce a double slash when the base URL has a trailing one', async () => {
    const trailing = new IndexerClient('https://api.test.com/');
    (global.fetch as jest.Mock).mockResolvedValueOnce(fakeResponse({ ok: true, body: '{}' }));

    await trailing.request({ endpoint: 'ping' });

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.test.com/ping',
      expect.objectContaining({ method: 'GET' })
    );
  });
});