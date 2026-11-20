// MCP at /mcp: JSON-RPC 2.0 over Streamable HTTP, answered as plain JSON.
// Two eras are supported. Modern (2026-07-28): `server/discover` first, every
// request declares its revision in `_meta` and mirrors it in the
// `MCP-Protocol-Version` header; no handshake, no session. Legacy (2025-11-25
// or earlier): `initialize` plus `notifications/initialized`, with an optional
// Mcp-Session-Id. The tools act on the same store as REST, so a repository
// made over MCP reads back over /api/v3 as the same object, ids unchanged.

import { randomBytes } from 'node:crypto';
import { Store, StoreError } from './store.ts';
import type { GitRequest, GitResponse } from './githttp.ts';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const SESSION_ID = randomBytes(16).toString('hex');

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string; enum?: string[] }>;
    required?: string[];
  };
}

/** The tool list is one frozen constant, so two tools/list calls answer identically. */
const TOOLS: readonly ToolDef[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    }),
  }),
  Object.freeze({
    name: 'get_issue',
    description: 'Get one issue by number.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    }),
  }),
  Object.freeze({
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    }),
  }),
]);

/** Synonyms a caller may use for an argument, beyond its canonical name. */
const ARG_SYNONYMS: Record<string, string[]> = {
  owner: ['owner_login', 'login', 'repository_owner'],
  repo: ['repository', 'repository_name', 'name'],
  issue_number: ['number', 'issueNumber', 'issue'],
  pull_number: ['number', 'pullNumber', 'pr_number'],
  body: ['description'],
  head: ['head_branch', 'headRefName', 'head_ref'],
  base: ['base_branch', 'baseRefName', 'base_ref'],
  description: ['body'],
};

function resolveArg(args: Record<string, unknown>, field: string): unknown {
  if (args[field] !== undefined) return args[field];
  for (const synonym of ARG_SYNONYMS[field] ?? []) {
    if (args[synonym] !== undefined) return args[synonym];
  }
  // `full_name` is "owner/repo": it supplies both at once.
  if ((field === 'owner' || field === 'repo') && typeof args.full_name === 'string') {
    const [owner, repo] = (args.full_name as string).split('/');
    return field === 'owner' ? owner : repo;
  }
  return undefined;
}

function resolveString(args: Record<string, unknown>, field: string): string | undefined {
  const value = resolveArg(args, field);
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

function resolveNumber(args: Record<string, unknown>, field: string): number | undefined {
  const value = resolveArg(args, field);
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}

function executeTool(store: Store, toolName: string, args: Record<string, unknown>): unknown {
  switch (toolName) {
    case 'create_repo': {
      const name = resolveString(args, 'name');
      const description = resolveString(args, 'description') ?? '';
      const isPrivate = args.private === true;
      if (name === undefined || name === '') throw new StoreError(422, 'name is required');
      const repo = store.createRepo(name, description, isPrivate);
      if (repo === null) throw new StoreError(422, 'Repository creation failed. name already exists on this account');
      return store.repoJson(repo);
    }
    case 'get_repo': {
      const owner = resolveString(args, 'owner');
      const repo = resolveString(args, 'repo');
      if (owner === undefined || repo === undefined) throw new StoreError(422, 'owner and repo are required');
      const found = store.getRepo(owner, repo);
      if (found === undefined) throw new StoreError(404, 'Not Found');
      return store.repoJson(found);
    }
    case 'create_issue': {
      const owner = resolveString(args, 'owner');
      const repo = resolveString(args, 'repo');
      const title = resolveString(args, 'title');
      const body = resolveString(args, 'body') ?? '';
      if (owner === undefined || repo === undefined || title === undefined) throw new StoreError(422, 'owner, repo, and title are required');
      const found = store.getRepo(owner, repo);
      if (found === undefined) throw new StoreError(404, 'Not Found');
      const issue = store.createIssue(found, title, body, []);
      return store.issueJson(found, issue);
    }
    case 'list_issues': {
      const owner = resolveString(args, 'owner');
      const repo = resolveString(args, 'repo');
      const state = resolveString(args, 'state') ?? 'open';
      if (owner === undefined || repo === undefined) throw new StoreError(422, 'owner and repo are required');
      const found = store.getRepo(owner, repo);
      if (found === undefined) throw new StoreError(404, 'Not Found');
      let issues = [...found.issues];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => b.createdSeq - a.createdSeq);
      return { issues: issues.map((issue) => store.issueJson(found, issue)) };
    }
    case 'get_issue': {
      const owner = resolveString(args, 'owner');
      const repo = resolveString(args, 'repo');
      const number = resolveNumber(args, 'issue_number');
      if (owner === undefined || repo === undefined || number === undefined) throw new StoreError(422, 'owner, repo, and issue_number are required');
      const found = store.getRepo(owner, repo);
      const issue = found === undefined ? undefined : store.getIssue(found, number);
      if (issue === undefined || found === undefined) throw new StoreError(404, 'Not Found');
      return store.issueJson(found, issue);
    }
    case 'create_pull_request': {
      const owner = resolveString(args, 'owner');
      const repo = resolveString(args, 'repo');
      const title = resolveString(args, 'title');
      const head = resolveString(args, 'head');
      const base = resolveString(args, 'base');
      const body = resolveString(args, 'body') ?? '';
      if (owner === undefined || repo === undefined || title === undefined || head === undefined || base === undefined) {
        throw new StoreError(422, 'owner, repo, title, head, and base are required');
      }
      const found = store.getRepo(owner, repo);
      if (found === undefined) throw new StoreError(404, 'Not Found');
      const pull = store.createPull(found, title, body, head, base);
      if (pull === null) throw new StoreError(422, 'a pull request already exists for this head and base');
      return store.pullJson(found, pull);
    }
    case 'merge_pull_request': {
      const owner = resolveString(args, 'owner');
      const repo = resolveString(args, 'repo');
      const number = resolveNumber(args, 'pull_number');
      if (owner === undefined || repo === undefined || number === undefined) throw new StoreError(422, 'owner, repo, and pull_number are required');
      const found = store.getRepo(owner, repo);
      const pull = found === undefined ? undefined : store.getPull(found, number);
      if (pull === undefined || found === undefined) throw new StoreError(404, 'Not Found');
      const merged = store.mergePull(found, pull);
      if (!merged) throw new StoreError(405, 'merge conflict');
      return { sha: pull.mergeCommitSha, merged: true, message: 'Pull request successfully merged', number: pull.number };
    }
    case 'list_pull_requests': {
      const owner = resolveString(args, 'owner');
      const repo = resolveString(args, 'repo');
      const state = resolveString(args, 'state') ?? 'open';
      if (owner === undefined || repo === undefined) throw new StoreError(422, 'owner and repo are required');
      const found = store.getRepo(owner, repo);
      if (found === undefined) throw new StoreError(404, 'Not Found');
      let pulls = [...found.pulls];
      if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
      pulls.sort((a, b) => b.createdSeq - a.createdSeq);
      return { pull_requests: pulls.map((pull) => store.pullJson(found, pull)) };
    }
    default:
      throw new Error(`unknown tool ${toolName}`);
  }
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * Handle one JSON-RPC message. Returns null for a notification (no reply is
 * ever sent for one); `sessionId` is set when the reply is an initialize
 * answer, so the caller can put it in the Mcp-Session-Id header.
 */
function handleRpc(store: Store, message: unknown): { response: Record<string, unknown> | null; sessionId?: string } {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    return { response: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const request = message as Record<string, unknown>;
  if (!('id' in request)) return { response: null };
  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params ?? {}) as Record<string, unknown>;

  if (method === 'server/discover') {
    return {
      response: rpcResult(id, {
        name: SERVER_NAME,
        version: SERVER_VERSION,
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        capabilities: { tools: {} },
        supportedVersions: [...SUPPORTED_VERSIONS],
        protocolVersion: SUPPORTED_VERSIONS[0],
      }),
    };
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? (params.protocolVersion as string) : '';
    const version = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
    return {
      response: rpcResult(id, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      }),
      sessionId: SESSION_ID,
    };
  }
  if (method === 'ping') return { response: rpcResult(id, {}) };
  if (method === 'tools/list') return { response: rpcResult(id, { tools: TOOLS }) };
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? (params.name as string) : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const tool = TOOLS.find((candidate) => name.toLowerCase().endsWith(candidate.name.toLowerCase()));
    if (tool === undefined) return { response: rpcError(id, -32601, `Unknown tool: ${name}`) };
    for (const field of tool.inputSchema.required ?? []) {
      if (resolveArg(args, field) === undefined) {
        return { response: rpcError(id, -32602, `Missing required argument: ${field}`) };
      }
    }
    try {
      const result = executeTool(store, tool.name, args);
      return {
        response: rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
          isError: false,
        }),
      };
    } catch (error) {
      if (error instanceof StoreError) {
        return {
          response: rpcResult(id, {
            content: [{ type: 'text', text: error.message }],
            structuredContent: { error: error.message },
            isError: true,
          }),
        };
      }
      return { response: rpcError(id, -32603, error instanceof Error ? error.message : 'internal error') };
    }
  }
  if (method === 'resources/list') return { response: rpcResult(id, { resources: [] }) };
  if (method === 'prompts/list') return { response: rpcResult(id, { prompts: [] }) };
  if (method === 'resources/templates/list') return { response: rpcResult(id, { resourceTemplates: [] }) };
  return { response: rpcError(id, -32601, `Method not found: ${method}`) };
}

function jsonResponse(status: number, value: unknown, extraHeaders: Record<string, string> = {}): GitResponse {
  return {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: Buffer.from(JSON.stringify(value), 'utf8'),
  };
}

function protocolVersionOf(req: GitRequest): string | undefined {
  const raw = req.headers['mcp-protocol-version'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export function handleMcp(store: Store, req: GitRequest): GitResponse | null {
  if (req.pathname !== '/mcp') return null;
  if (req.method !== 'POST') return jsonResponse(405, { message: 'Method Not Allowed' });
  // Authorization is checked before dispatch, for every /mcp method.
  if (!store.isAuthorized(req)) return jsonResponse(401, { message: 'Requires authentication' });
  let body: unknown;
  try {
    body = JSON.parse(req.body.toString('utf8'));
  } catch {
    // A non-JSON body is a 400 carrying a JSON-RPC parse error.
    return jsonResponse(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  const protocolVersion = protocolVersionOf(req);
  const headers: Record<string, string> = {};
  if (protocolVersion !== undefined) headers['MCP-Protocol-Version'] = protocolVersion;
  if (Array.isArray(body)) {
    const responses: Record<string, unknown>[] = [];
    let sessionId: string | undefined;
    for (const message of body) {
      const handled = handleRpc(store, message);
      if (handled.response !== null) responses.push(handled.response);
      if (handled.sessionId !== undefined) sessionId = handled.sessionId;
    }
    if (sessionId !== undefined) headers['Mcp-Session-Id'] = sessionId;
    return jsonResponse(200, responses, headers);
  }
  const handled = handleRpc(store, body);
  if (handled.response === null) {
    // A notification: accepted, no body.
    return { status: 202, headers: {}, body: Buffer.alloc(0) };
  }
  if (handled.sessionId !== undefined) headers['Mcp-Session-Id'] = handled.sessionId;
  return jsonResponse(200, handled.response, headers);
}
