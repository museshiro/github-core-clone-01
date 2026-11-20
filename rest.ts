// REST v3 under /api/v3: repositories, issues, pull requests, contents, and the
// git refs the other surfaces lean on. Every reply is JSON with a non-empty
// X-GitHub-Request-Id (added centrally in app.ts). Errors carry a JSON body
// with a string `message`. A repository belongs to the token's login, so the
// same name under another owner is a 404, never a 403.

import { mergeBase } from './gitcore.ts';
import { Store, StoreError, type Repo } from './store.ts';
import type { GitRequest, GitResponse } from './githttp.ts';

function jsonResponse(status: number, value: unknown, extraHeaders: Record<string, string> = {}): GitResponse {
  return {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: Buffer.from(JSON.stringify(value), 'utf8'),
  };
}

/** Parse a request body as JSON; an empty body is an empty object, a broken one is a 400. */
function parseBody(req: GitRequest): Record<string, unknown> {
  if (req.body.length === 0) return {};
  try {
    const value: unknown = JSON.parse(req.body.toString('utf8'));
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    return {};
  } catch {
    throw new StoreError(400, 'malformed JSON body');
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Split "Name <email> 1700000000 +0000" into its parts, for commit authors. */
function parseIdentity(text: string): { name: string; email: string; date: string } {
  const match = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(text);
  if (match === null) return { name: text, email: '', date: new Date(0).toISOString() };
  const stamp = Number(match[3]);
  return {
    name: match[1] as string,
    email: match[2] as string,
    date: new Date(stamp * 1000).toISOString(),
  };
}

interface RepoParams {
  owner: string;
  repoName: string;
}

/** Match /api/v3/repos/{owner}/{repo} plus an optional suffix pattern. */
function matchRepoRoute(pathname: string, suffix: RegExp): (RepoParams & { rest: string[] }) | null {
  const match = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)(.*)$/.exec(pathname);
  if (match === null) return null;
  const rest = match[3] as string;
  const suffixMatch = suffix.exec(rest);
  if (suffixMatch === null) return null;
  return {
    owner: decodeSegment(match[1] as string),
    repoName: decodeSegment(match[2] as string),
    rest: suffixMatch.slice(1).map((part) => decodeSegment(part)),
  };
}

export function handleRest(store: Store, req: GitRequest): GitResponse | null {
  if (!req.pathname.startsWith('/api/v3')) return null;
  try {
    return dispatchRest(store, req);
  } catch (error) {
    if (error instanceof StoreError) return jsonResponse(error.status, { message: error.message });
    const message = error instanceof Error ? error.message : 'internal error';
    return jsonResponse(500, { message });
  }
}

function dispatchRest(store: Store, req: GitRequest): GitResponse {
  const pathname = req.pathname.replace(/\/+$/, '') || '/';
  const method = req.method;

  // The root and meta need no token.
  if (pathname === '/api/v3' && method === 'GET') {
    return jsonResponse(
      200,
      {
        current_user_url: 'https://api.github.com/user',
        current_user_authorizations_html_url: 'https://github.com/settings/applications',
        authorizations_url: 'https://api.github.com/authorizations',
        rate_limit_url: 'https://api.github.com/rate_limit',
        repository_url: 'https://api.github.com/repos/{owner}/{repo}',
      },
      { 'X-OAuth-Scopes': 'repo, read:org' },
    );
  }
  if (pathname === '/api/v3/meta' && method === 'GET') {
    return jsonResponse(200, {
      verifiable_password_authentication: true,
      installed_version: '1.0.0',
      ssh_key_fingerprints: {},
      hooks: [],
      git: [],
      pages: [],
      importer: [],
      actions: [],
      dependabot: [],
    });
  }

  // Everything else under /api/v3 needs the token.
  if (!store.isAuthorized(req)) return jsonResponse(401, { message: 'Requires authentication' });

  if (pathname === '/api/v3/user' && method === 'GET') {
    return jsonResponse(200, store.userJson());
  }

  if (pathname === '/api/v3/user/repos' && method === 'GET') {
    const perPage = Math.max(1, Math.min(100, Number(req.query.get('per_page') ?? 30) || 30));
    const page = Math.max(1, Number(req.query.get('page') ?? 1) || 1);
    const all = store.listRepos();
    const start = (page - 1) * perPage;
    const slice = all.slice(start, start + perPage);
    const headers: Record<string, string> = {};
    const host = ((): string => {
      const raw = req.headers.host;
      const value = Array.isArray(raw) ? raw[0] : raw;
      return typeof value === 'string' && value !== '' ? value : 'localhost';
    })();
    const base = `http://${host}/api/v3/user/repos`;
    const links: string[] = [];
    const lastPage = Math.max(1, Math.ceil(all.length / perPage));
    if (page < lastPage) links.push(`<${base}?per_page=${perPage}&page=${page + 1}>; rel="next"`);
    if (lastPage > 1) links.push(`<${base}?per_page=${perPage}&page=${lastPage}>; rel="last"`);
    if (page > 1) links.push(`<${base}?per_page=${perPage}&page=1>; rel="first"`);
    if (links.length > 0) headers.Link = links.join(', ');
    return jsonResponse(200, slice.map((repo) => store.repoJson(repo)), headers);
  }

  if (pathname === '/api/v3/user/repos' && method === 'POST') {
    const body = parseBody(req);
    const name = asString(body.name);
    if (name === undefined || name === '') throw new StoreError(422, 'name is required');
    const description = asString(body.description) ?? '';
    const isPrivate = body.private === true;
    const repo = store.createRepo(name, description, isPrivate);
    if (repo === null) throw new StoreError(422, 'Repository creation failed. name already exists on this account');
    return jsonResponse(201, store.repoJson(repo));
  }

  // ---- /api/v3/repos/{owner}/{repo}/... ----
  const route = (suffix: RegExp): (RepoParams & { rest: string[] }) | null => matchRepoRoute(pathname, suffix);
  const needRepo = (params: RepoParams): Repo => {
    const repo = store.getRepo(params.owner, params.repoName);
    if (repo === undefined) throw new StoreError(404, 'Not Found');
    return repo;
  };

  let match = route(/^$/);
  if (match !== null && method === 'GET') return jsonResponse(200, store.repoJson(needRepo(match)));
  if (match !== null && method === 'PATCH') {
    const repo = needRepo(match);
    const body = parseBody(req);
    const description = asString(body.description);
    if (description !== undefined) repo.description = description;
    if (typeof body.private === 'boolean') repo.private = body.private;
    return jsonResponse(200, store.repoJson(repo));
  }
  if (match !== null && method === 'DELETE') {
    if (!store.deleteRepo(match.owner, match.repoName)) throw new StoreError(404, 'Not Found');
    return { status: 204, headers: {}, body: Buffer.alloc(0) };
  }

  match = route(/^\/git\/refs$/);
  if (match !== null && method === 'POST') {
    const repo = needRepo(match);
    const body = parseBody(req);
    const ref = asString(body.ref);
    const sha = asString(body.sha);
    if (ref === undefined || !ref.startsWith('refs/')) throw new StoreError(422, 'ref must start with refs/');
    if (sha === undefined || !/^[0-9a-f]{40}$/i.test(sha)) throw new StoreError(422, 'sha is not a valid object id');
    if (store.getRef(repo, ref) !== undefined) throw new StoreError(422, 'Reference already exists');
    const object = store.getObject(repo, sha.toLowerCase());
    if (object === undefined || object.type !== 'commit') throw new StoreError(422, 'the sha does not name a commit');
    store.setRef(repo, ref, sha.toLowerCase());
    return jsonResponse(201, {
      ref,
      node_id: '',
      object: { sha: sha.toLowerCase(), type: 'commit', url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha.toLowerCase()}` },
    });
  }

  match = route(/^\/git\/refs\/heads\/(.+)$/);
  if (match !== null && method === 'GET') {
    const repo = needRepo(match);
    const branch = match.rest[0] as string;
    const sha = store.getRef(repo, `refs/heads/${branch}`);
    if (sha === undefined) throw new StoreError(404, 'Not Found');
    return jsonResponse(200, {
      ref: `refs/heads/${branch}`,
      node_id: '',
      object: { sha, type: 'commit', url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}` },
    });
  }

  match = route(/^\/branches$/);
  if (match !== null && method === 'GET') {
    const repo = needRepo(match);
    const branches = store
      .listRefs(repo)
      .filter((ref) => ref.name.startsWith('refs/heads/'))
      .map((ref) => ({
        name: ref.name.slice('refs/heads/'.length),
        commit: { sha: ref.oid, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${ref.oid}` },
        protected: false,
      }));
    return jsonResponse(200, branches);
  }

  match = route(/^\/branches\/(.+)$/);
  if (match !== null && method === 'GET') {
    const repo = needRepo(match);
    const branch = match.rest[0] as string;
    const sha = store.getRef(repo, `refs/heads/${branch}`);
    if (sha === undefined) throw new StoreError(404, 'Not Found');
    return jsonResponse(200, {
      name: branch,
      commit: { sha, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` },
      protected: false,
    });
  }

  match = route(/^\/commits$/);
  if (match !== null && method === 'GET') {
    const repo = needRepo(match);
    const ref = req.query.get('sha') ?? repo.defaultBranch;
    const tip = store.resolveRef(repo, ref);
    if (tip === undefined) throw new StoreError(404, 'Not Found');
    const commits = store.walkCommits(repo, tip).map((commit) => {
      const author = parseIdentity(commit.author);
      const committer = parseIdentity(commit.committer);
      return {
        sha: commit.oid,
        node_id: '',
        commit: {
          // A stored commit object ends its message with a newline, as git
          // writes it; the API reports the message without that newline.
          message: commit.message.endsWith('\n') ? commit.message.slice(0, -1) : commit.message,
          author: { name: author.name, email: author.email, date: author.date },
          committer: { name: committer.name, email: committer.email, date: committer.date },
          tree: { sha: commit.tree },
        },
        parents: commit.parents.map((parent) => ({ sha: parent })),
        html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${commit.oid}`,
        url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${commit.oid}`,
      };
    });
    return jsonResponse(200, commits);
  }

  match = route(/^\/contents$/);
  if (match !== null && method === 'GET') {
    const repo = needRepo(match);
    return contentsGet(store, repo, '', req.query.get('ref') ?? repo.defaultBranch);
  }

  match = route(/^\/contents\/(.+)$/);
  if (match !== null && method === 'PUT') {
    const repo = needRepo(match);
    const path = match.rest[0] as string;
    const body = parseBody(req);
    const message = asString(body.message) ?? `Update ${path}`;
    const content = asString(body.content);
    if (content === undefined) throw new StoreError(422, 'content is required');
    const branch = asString(body.branch);
    const sha = asString(body.sha);
    const buffer = Buffer.from(content, 'base64');
    const result = store.putFile(repo, { path, content: buffer, message, branch, sha });
    return jsonResponse(result.created ? 201 : 200, {
      content: {
        name: path.split('/').pop() ?? path,
        path,
        sha: result.contentSha,
        size: buffer.length,
        type: 'file',
        encoding: 'base64',
        content: buffer.toString('base64'),
        url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
        html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${branch ?? repo.defaultBranch}/${path}`,
        download_url: `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${branch ?? repo.defaultBranch}/${path}`,
      },
      commit: { sha: result.commitSha, message },
    });
  }
  if (match !== null && method === 'GET') {
    const repo = needRepo(match);
    return contentsGet(store, repo, match.rest[0] as string, req.query.get('ref') ?? repo.defaultBranch);
  }
  if (match !== null && method === 'DELETE') {
    const repo = needRepo(match);
    const path = match.rest[0] as string;
    const body = parseBody(req);
    const message = asString(body.message) ?? `Delete ${path}`;
    const branch = asString(body.branch);
    const sha = asString(body.sha);
    const commitSha = store.deleteFile(repo, { path, message, branch, sha });
    return jsonResponse(200, { commit: { sha: commitSha, message } });
  }

  match = route(/^\/labels$/);
  if (match !== null && method === 'POST') {
    const repo = needRepo(match);
    const body = parseBody(req);
    const name = asString(body.name);
    if (name === undefined || name === '') throw new StoreError(422, 'name is required');
    const color = asString(body.color) ?? 'ededed';
    const label = store.createLabel(repo, name, color);
    if (label === null) throw new StoreError(422, 'label already exists');
    return jsonResponse(201, store.labelJson(label));
  }

  match = route(/^\/issues$/);
  if (match !== null && method === 'POST') {
    const repo = needRepo(match);
    const body = parseBody(req);
    const title = asString(body.title);
    if (title === undefined || title === '') throw new StoreError(422, 'title is required');
    const issue = store.createIssue(repo, title, asString(body.body) ?? '', asStringArray(body.labels));
    return jsonResponse(201, store.issueJson(repo, issue));
  }
  if (match !== null && method === 'GET') {
    const repo = needRepo(match);
    const state = req.query.get('state') ?? 'open';
    const sort = req.query.get('sort') ?? 'created';
    const direction = req.query.get('direction') ?? 'desc';
    let issues = [...repo.issues];
    if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
    if (sort === 'created') {
      issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
    }
    return jsonResponse(200, issues.map((issue) => store.issueJson(repo, issue)));
  }

  match = route(/^\/issues\/(\d+)$/);
  if (match !== null && method === 'GET') {
    const repo = needRepo(match);
    const issue = store.getIssue(repo, Number(match.rest[0]));
    if (issue === undefined) throw new StoreError(404, 'Not Found');
    return jsonResponse(200, store.issueJson(repo, issue));
  }
  if (match !== null && method === 'PATCH') {
    const repo = needRepo(match);
    const issue = store.getIssue(repo, Number(match.rest[0]));
    if (issue === undefined) throw new StoreError(404, 'Not Found');
    const body = parseBody(req);
    const title = asString(body.title);
    if (title !== undefined) issue.title = title;
    const text = asString(body.body);
    if (text !== undefined) issue.body = text;
    const state = asString(body.state);
    if (state === 'open' || state === 'closed') issue.state = state;
    if (Array.isArray(body.labels)) {
      const labels = asStringArray(body.labels).map((name) => {
        const label = repo.labels.get(name);
        if (label === undefined) throw new StoreError(422, `label ${name} does not exist`);
        return label;
      });
      issue.labels = labels;
    }
    return jsonResponse(200, store.issueJson(repo, issue));
  }

  match = route(/^\/issues\/(\d+)\/comments$/);
  if (match !== null && method === 'POST') {
    const repo = needRepo(match);
    const issue = store.getIssue(repo, Number(match.rest[0]));
    if (issue === undefined) throw new StoreError(404, 'Not Found');
    const body = parseBody(req);
    const text = asString(body.body);
    if (text === undefined || text === '') throw new StoreError(422, 'body is required');
    const comment = store.addComment(repo, issue, text);
    return jsonResponse(201, store.commentJson(repo, issue, comment));
  }
  if (match !== null && method === 'GET') {
    const repo = needRepo(match);
    const issue = store.getIssue(repo, Number(match.rest[0]));
    if (issue === undefined) throw new StoreError(404, 'Not Found');
    return jsonResponse(200, issue.comments.map((comment) => store.commentJson(repo, issue, comment)));
  }

  match = route(/^\/pulls$/);
  if (match !== null && method === 'GET') {
    const repo = needRepo(match);
    const state = req.query.get('state') ?? 'open';
    const sort = req.query.get('sort') ?? 'created';
    const direction = req.query.get('direction') ?? 'desc';
    let pulls = [...repo.pulls];
    if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
    if (sort === 'created') {
      pulls.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
    }
    return jsonResponse(200, pulls.map((pull) => store.pullJson(repo, pull)));
  }
  if (match !== null && method === 'POST') {
    const repo = needRepo(match);
    const body = parseBody(req);
    const title = asString(body.title);
    const head = asString(body.head);
    const base = asString(body.base);
    if (title === undefined || title === '') throw new StoreError(422, 'title is required');
    if (head === undefined || head === '') throw new StoreError(422, 'head is required');
    if (base === undefined || base === '') throw new StoreError(422, 'base is required');
    const pull = store.createPull(repo, title, asString(body.body) ?? '', head, base);
    if (pull === null) throw new StoreError(422, 'a pull request already exists for this head and base');
    return jsonResponse(201, store.pullJson(repo, pull));
  }

  match = route(/^\/pulls\/(\d+)$/);
  if (match !== null && method === 'GET') {
    const repo = needRepo(match);
    const pull = store.getPull(repo, Number(match.rest[0]));
    if (pull === undefined) throw new StoreError(404, 'Not Found');
    return jsonResponse(200, store.pullJson(repo, pull));
  }

  match = route(/^\/pulls\/(\d+)\/files$/);
  if (match !== null && method === 'GET') {
    const repo = needRepo(match);
    const pull = store.getPull(repo, Number(match.rest[0]));
    if (pull === undefined) throw new StoreError(404, 'Not Found');
    const headTip = store.getRef(repo, `refs/heads/${pull.head}`);
    const baseTip = store.getRef(repo, `refs/heads/${pull.base}`);
    if (headTip === undefined || baseTip === undefined) throw new StoreError(404, 'Not Found');
    const base = mergeBase(headTip, baseTip, (oid) => repo.objects.get(oid));
    const baseTree = base === null ? null : store.treeOf(repo, base);
    const headTree = store.treeOf(repo, headTip);
    if (headTree === null) throw new StoreError(404, 'Not Found');
    const files = store.diffTrees(repo, baseTree, headTree).map((change) => ({
      filename: change.path,
      status: change.status,
      additions: change.additions,
      deletions: change.deletions,
      changes: change.additions + change.deletions,
      blob_url: `https://github.com/${repo.owner}/${repo.name}/blob/${headTip}/${change.path}`,
      raw_url: `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${headTip}/${change.path}`,
      contents_url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${change.path}`,
    }));
    return jsonResponse(200, files);
  }

  match = route(/^\/pulls\/(\d+)\/merge$/);
  if (match !== null && method === 'PUT') {
    const repo = needRepo(match);
    const pull = store.getPull(repo, Number(match.rest[0]));
    if (pull === undefined) throw new StoreError(404, 'Not Found');
    if (pull.state !== 'open') throw new StoreError(405, 'pull request is already closed');
    const merged = store.mergePull(repo, pull);
    if (!merged) throw new StoreError(405, 'merge conflict');
    return jsonResponse(200, {
      sha: pull.mergeCommitSha,
      merged: true,
      message: 'Pull request successfully merged',
    });
  }

  return jsonResponse(404, { message: 'Not Found' });
}

/** GET a file or a directory listing through the contents API. */
function contentsGet(store: Store, repo: Repo, path: string, ref: string): GitResponse {
  const tree = store.treeOf(repo, ref);
  if (tree === null) throw new StoreError(404, 'Not Found');
  if (path === '') {
    const entries = store.dirAt(repo, tree, '');
    if (entries === null) throw new StoreError(404, 'Not Found');
    return jsonResponse(
      200,
      entries.map((entry) => ({
        type: entry.mode === '40000' ? 'dir' : 'file',
        name: entry.name,
        path: entry.name,
        sha: entry.oid,
        size: entry.mode === '40000' ? 0 : (store.getObject(repo, entry.oid)?.data.length ?? 0),
        url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${entry.name}`,
        html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${ref}/${entry.name}`,
        download_url: entry.mode === '40000' ? null : `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${ref}/${entry.name}`,
      })),
    );
  }
  const entry = store.entryAt(repo, tree, path);
  if (entry === null) throw new StoreError(404, 'Not Found');
  if (entry.mode === '40000') {
    const entries = store.dirAt(repo, tree, path);
    if (entries === null) throw new StoreError(404, 'Not Found');
    return jsonResponse(
      200,
      entries.map((child) => ({
        type: child.mode === '40000' ? 'dir' : 'file',
        name: child.name,
        path: `${path}/${child.name}`,
        sha: child.oid,
        size: child.mode === '40000' ? 0 : (store.getObject(repo, child.oid)?.data.length ?? 0),
        url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}/${child.name}`,
        html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${ref}/${path}/${child.name}`,
        download_url: child.mode === '40000' ? null : `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${ref}/${path}/${child.name}`,
      })),
    );
  }
  const blob = store.blobAt(repo, tree, path);
  if (blob === null) throw new StoreError(404, 'Not Found');
  return jsonResponse(200, {
    type: 'file',
    encoding: 'base64',
    size: blob.data.length,
    name: path.split('/').pop() ?? path,
    path,
    content: blob.data.toString('base64'),
    sha: blob.oid,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${ref}/${path}`,
    download_url: `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${ref}/${path}`,
  });
}
