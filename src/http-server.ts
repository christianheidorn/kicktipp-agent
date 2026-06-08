#!/usr/bin/env node

import http from 'http';
import { randomUUID } from 'crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.js';
import { requestContext, type RequestContext } from './request-context.js';

const PORT = Number(process.env.PORT || 8080);
const MCP_PATH = process.env.MCP_PATH || '/mcp';

function headerString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

// Token format: "community,player,email,password". Password goes last so it
// can contain commas without breaking parsing. Player may be empty (use ",,"
// if you don't want to set one). Provided via Authorization: Bearer.
function parseAuthToken(req: http.IncomingMessage): RequestContext | null {
  const auth = headerString(req.headers['authorization']) || '';
  const raw = auth.startsWith('Bearer ') ? auth.slice(7).trim() : auth.trim();
  if (!raw) return null;
  const c1 = raw.indexOf(',');
  const c2 = c1 >= 0 ? raw.indexOf(',', c1 + 1) : -1;
  const c3 = c2 >= 0 ? raw.indexOf(',', c2 + 1) : -1;
  if (c1 === -1 || c2 === -1 || c3 === -1) return null;
  const community = raw.slice(0, c1).trim();
  const player = raw.slice(c1 + 1, c2).trim();
  const email = raw.slice(c2 + 1, c3).trim();
  const password = raw.slice(c3 + 1); // not trimmed — passwords may have leading/trailing spaces
  if (!email || !community || !password) return null;
  return { email, password, community, player: player || undefined };
}

async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });
  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  await server.connect(transport);

  let body: unknown = undefined;
  if (req.method === 'POST') {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }));
      return;
    }
  }
  await transport.handleRequest(req, res, body);
}

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  if (url.pathname !== MCP_PATH) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }

  const ctx = parseAuthToken(req);
  if (!ctx) {
    res.writeHead(401, {
      'Content-Type': 'application/json',
      'WWW-Authenticate': 'Bearer realm="kicktipp", error="invalid_token"',
    });
    res.end(JSON.stringify({
      error: 'invalid_or_missing_token',
      hint: 'Authorization: Bearer community,player,email,password (player may be empty)',
    }));
    return;
  }

  try {
    await requestContext.run(ctx, () => handleMcp(req, res));
  } catch (err) {
    console.error('MCP request failed:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }));
    }
  }
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.error(`kicktipp MCP HTTP server listening on :${PORT}${MCP_PATH} (request-id ${randomUUID()})`);
});
