// The server: one process, one in-memory store, four surfaces. A request is
// read whole, handed to each surface in turn (git smart HTTP, REST v3,
// GraphQL v4, MCP), and the first surface that claims the path answers it.
// Anything unclaimed is a JSON 404. Every reply carries a non-empty
// X-GitHub-Request-Id, and the connection is left open for keep-alive, which
// the read workload depends on.

import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit, type GitRequest, type GitResponse } from './githttp.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { Store } from './store.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** The request-id prefix is random per process; the counter makes each id unique. */
const REQUEST_ID_PREFIX = randomBytes(4).toString('hex');
let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `${REQUEST_ID_PREFIX}-${requestCounter}`;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name);
}

/** Write a handler's answer, filling in the request id and content type. */
function sendResponse(res: ServerResponse, response: GitResponse): void {
  const headers: Record<string, string> = { ...response.headers };
  if (!hasHeader(headers, 'x-github-request-id')) headers['x-github-request-id'] = nextRequestId();
  if (!hasHeader(headers, 'content-type')) headers['content-type'] = 'application/json';
  headers['content-length'] = String(response.body.length);
  res.writeHead(response.status, headers);
  res.end(response.body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  sendResponse(res, {
    status,
    headers: { 'Content-Type': 'application/json' },
    body: Buffer.from(JSON.stringify(body), 'utf8'),
  });
}

/** Read a request body whole, up to MAX_BODY_BYTES. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** The path and query of a request URL, or '/' when it does not parse. */
function parseUrl(req: IncomingMessage): { pathname: string; query: URLSearchParams } {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    return { pathname: url.pathname, query: url.searchParams };
  } catch {
    return { pathname: '/', query: new URLSearchParams() };
  }
}

/** Build the server. It binds nothing until the caller listens on a port. */
export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const { pathname, query } = parseUrl(req);
      const method = req.method ?? 'GET';

      // The env's boot check calls this twice: 200 {"ok":true}.
      if (method === 'GET' && pathname === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      let body: Buffer = Buffer.alloc(0);
      if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
        try {
          body = await readBody(req);
        } catch {
          sendJson(res, 413, { message: 'request body is too large' });
          return;
        }
      }

      const request: GitRequest = {
        method,
        pathname,
        query,
        headers: req.headers as Record<string, string | string[] | undefined>,
        body,
      };

      try {
        const answer =
          handleGit(store, request) ??
          handleRest(store, request) ??
          handleGraphql(store, request) ??
          handleMcp(store, request);
        if (answer !== null) {
          sendResponse(res, answer);
          return;
        }
      } catch (error) {
        // No surface may take the server down with it.
        const message = error instanceof Error ? error.message : 'internal error';
        sendJson(res, 500, { message });
        return;
      }

      sendJson(res, 404, { message: 'Not Found' });
    })();
  });
}
