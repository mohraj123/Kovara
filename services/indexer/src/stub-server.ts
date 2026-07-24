/**
 * Stub HTTP server for Kovara indexer
 * Minimal implementation without external dependencies
 */

const http = require('http');
const url = require('url');

const PORT = process.env.PORT || 3002;
const HOST = process.env.HOST || '0.0.0.0';

// Mock database responses
const mockDb = {
  searchPosts: async ({ query, limit, offset }) => ({
    posts: [],
    total: 0
  }),
  query: async () => ({ rows: [] })
};

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Health check
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    return;
  }

  // Search endpoint
  if (pathname === '/api/search/posts' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const result = await mockDb.searchPosts({
          query: data.query || '',
          limit: data.limit || 20,
          offset: data.offset || 0
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          posts: result.posts,
          total: result.total,
          has_more: false
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error', code: 'INTERNAL_ERROR' }));
      }
    });
    return;
  }

  // Mock API routes
  if (pathname.startsWith('/api/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [] }));
    return;
  }

  // 404 for unknown routes
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found', code: 'NOT_FOUND' }));
});

server.listen(PORT, HOST, () => {
  console.log(`[indexer] Stub server running at http://${HOST}:${PORT}`);
  console.log('[indexer] Database and event streaming disabled for stub mode');
});

process.on('SIGTERM', () => {
  console.log('[indexer] Received SIGTERM, shutting down...');
  server.close(() => {
    console.log('[indexer] Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('[indexer] Received SIGINT, shutting down...');
  server.close(() => {
    console.log('[indexer] Server closed');
    process.exit(0);
  });
});
