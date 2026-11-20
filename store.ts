// The forge's whole state, held in memory: repositories, their git objects and
// refs, issues, pull requests, labels and comments. One process, no disk, no
// outside service. Every surface (git, REST, GraphQL, MCP) reads and writes
// this one store, so a thing made on one surface is visible on the others.
//
// Identities come from the scenario (scenario.ts); the bearer token comes from
// the environment (MAKEFUN_SHOP_TOKEN). When the token is not set — local
// practice — any non-empty bearer token is accepted, so a practice run can use
// whatever token it passes to the suite.

import {
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isAncestor,
  isObjectId,
  makeObject,
  mergeBase,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitcore.ts';
import { viewerIdentity, type ViewerIdentity } from './scenario.ts';

/** The well-known empty tree, and its id. */
export const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export interface Label {
  id: number;
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
  createdSeq: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: Comment[];
  createdSeq: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: string;
  base: string;
  createdSeq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Issue[];
  pulls: Pull[];
  labels: Map<string, Label>;
  nextNumber: number;
  nextCommentId: number;
}

/** A tree change: a path set to a blob, or removed (null). */
export interface TreeChange {
  path: string;
  blobOid: string | null;
}

/** One file difference between two trees. */
export interface FileDiff {
  path: string;
  status: 'added' | 'removed' | 'modified';
  oldOid: string | null;
  newOid: string | null;
  additions: number;
  deletions: number;
}

/** An error carrying the HTTP status its surface should answer with. */
export class StoreError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** An opaque, stable global id: base64 of `Type:key`. Never the plain number. */
export function gid(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64');
}

/** Decode a global id back to its type and key, or null when it is not one. */
export function parseGid(id: string): { type: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    return { type: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

const COMMIT_EPOCH = 1_700_000_000;

export class Store {
  readonly viewer: ViewerIdentity = viewerIdentity();
  readonly expectedToken: string | null;
  readonly repos = new Map<string, Repo>();
  readonly repoOrder: Repo[] = [];
  private nextId = 1;
  private nextSeq = 1;
  private commitSeq = 0;

  constructor() {
    const token = (process.env.MAKEFUN_SHOP_TOKEN ?? '').trim();
    this.expectedToken = token === '' ? null : token;
  }

  // ---------------------------------------------------------------- auth

  /** True when the request's Authorization header carries the suite's token. */
  isAuthorized(req: { headers: Record<string, string | string[] | undefined> }): boolean {
    const raw = req.headers.authorization;
    const header = Array.isArray(raw) ? raw[0] : raw;
    if (typeof header !== 'string') return false;
    const match = /^Bearer\s+(.+)$/.exec(header.trim());
    if (match === null) return false;
    const token = (match[1] as string).trim();
    if (token === '') return false;
    if (this.expectedToken !== null) return token === this.expectedToken;
    return true;
  }

  /** A creation-order sequence number, for stable ordering and timestamps. */
  private seq(): number {
    return this.nextSeq++;
  }

  /** An ISO timestamp derived from a sequence number (distinct, well-formed). */
  private stamp(seq: number): string {
    return new Date((COMMIT_EPOCH + seq) * 1000).toISOString();
  }

  // ---------------------------------------------------------------- repos

  private repoKey(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name}`;
  }

  /** The viewer login, when `owner` names the token's owner (case-insensitively). */
  private ownerLogin(owner: string): string | null {
    return owner.toLowerCase() === this.viewer.login.toLowerCase() ? this.viewer.login : null;
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo | null {
    const key = this.repoKey(this.viewer.login, name);
    if (this.repos.has(key)) return null;
    const repo: Repo = {
      id: this.nextId++,
      name,
      owner: this.viewer.login,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      createdSeq: this.seq(),
      objects: new Map(),
      refs: new Map(),
      issues: [],
      pulls: [],
      labels: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
    };
    // The empty tree exists in every repository from the start.
    repo.objects.set(EMPTY_TREE_OID, { type: 'tree', data: Buffer.alloc(0) });
    this.repos.set(key, repo);
    this.repoOrder.push(repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    const login = this.ownerLogin(owner);
    if (login === null) return undefined;
    return this.repos.get(this.repoKey(login, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    const login = this.ownerLogin(owner);
    if (login === null) return false;
    const key = this.repoKey(login, name);
    const repo = this.repos.get(key);
    if (repo === undefined) return false;
    this.repos.delete(key);
    const index = this.repoOrder.indexOf(repo);
    if (index >= 0) this.repoOrder.splice(index, 1);
    return true;
  }

  listRepos(): Repo[] {
    return [...this.repoOrder];
  }

  // ---------------------------------------------------------------- git objects and refs

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const { oid } = makeObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  getRef(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  setRef(repo: Repo, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
  }

  deleteRef(repo: Repo, ref: string): boolean {
    return repo.refs.delete(ref);
  }

  /** All refs, HEAD's target first, then the rest sorted by name. */
  listRefs(repo: Repo): { name: string; oid: string }[] {
    const refs = [...repo.refs.entries()].map(([name, oid]) => ({ name, oid }));
    refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return refs;
  }

  /** Resolve a branch name, a full ref, or a commit id to a commit id. */
  resolveRef(repo: Repo, ref: string): string | undefined {
    if (isObjectId(ref)) {
      const object = repo.objects.get(ref);
      if (object?.type === 'commit') return ref;
      if (object?.type === 'tag') return parseTag(object.data).object;
      return undefined;
    }
    const full = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
    return repo.refs.get(full);
  }

  /** The tree id a commit points at, or null when the ref does not exist. */
  treeOf(repo: Repo, ref: string): string | null {
    const commitOid = this.resolveRef(repo, ref);
    if (commitOid === undefined) return null;
    const object = repo.objects.get(commitOid);
    if (object?.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  }

  /** The commit a branch (or ref) points at, as a parsed view, or null. */
  commitOf(repo: Repo, ref: string): { oid: string; tree: string; parents: string[]; author: string; committer: string; message: string } | null {
    const commitOid = this.resolveRef(repo, ref);
    if (commitOid === undefined) return null;
    const object = repo.objects.get(commitOid);
    if (object?.type !== 'commit') return null;
    return { oid: commitOid, ...parseCommit(object.data) };
  }

  /** Every commit reachable from `tip`, newest first by committer timestamp. */
  walkCommits(repo: Repo, tip: string): { oid: string; tree: string; parents: string[]; author: string; committer: string; message: string }[] {
    const found = new Map<string, { oid: string; tree: string; parents: string[]; author: string; committer: string; message: string }>();
    const queue = [tip];
    while (queue.length) {
      const oid = queue.pop() as string;
      if (found.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object?.type !== 'commit') continue;
      const commit = { oid, ...parseCommit(object.data) };
      found.set(oid, commit);
      for (const parent of commit.parents) queue.push(parent);
    }
    const list = [...found.values()];
    const stampOf = (commit: { committer: string }): number => {
      const match = / (\d+) [+-]\d{4}$/.exec(commit.committer);
      return match === null ? 0 : Number(match[1]);
    };
    list.sort((a, b) => stampOf(b) - stampOf(a));
    return list;
  }

  // ---------------------------------------------------------------- trees

  /** The entry at `path` inside the tree `treeOid`, or null when it is absent. */
  entryAt(repo: Repo, treeOid: string, path: string): TreeEntry | null {
    const segments = path.split('/').filter((part) => part !== '');
    let current = treeOid;
    for (let i = 0; i < segments.length; i += 1) {
      const object = repo.objects.get(current);
      if (object?.type !== 'tree') return null;
      const entry = parseTree(object.data).find((candidate) => candidate.name === segments[i]);
      if (entry === undefined) return null;
      if (i === segments.length - 1) return entry;
      if (entry.mode !== '40000') return null;
      current = entry.oid;
    }
    return null;
  }

  /** Apply one path change to a tree, returning the new tree id (null: now empty). */
  private applyOne(repo: Repo, treeOid: string | null, segments: readonly string[], blobOid: string | null): string | null {
    const entries = new Map<string, TreeEntry>();
    if (treeOid !== null) {
      const object = repo.objects.get(treeOid);
      if (object?.type === 'tree') {
        for (const entry of parseTree(object.data)) entries.set(entry.name, entry);
      }
    }
    const [head, ...rest] = segments as [string, ...string[]];
    if (rest.length === 0) {
      if (blobOid === null) entries.delete(head);
      else entries.set(head, { mode: '100644', name: head, oid: blobOid });
    } else {
      const child = entries.get(head);
      const childTree = child !== undefined && child.mode === '40000' ? child.oid : null;
      const next = this.applyOne(repo, childTree, rest, blobOid);
      if (next === null) entries.delete(head);
      else entries.set(head, { mode: '40000', name: head, oid: next });
    }
    if (entries.size === 0) return null;
    return this.putObject(repo, 'tree', buildTree([...entries.values()]));
  }

  /** Apply several path changes to a tree; an empty result is the empty tree. */
  applyTreeChanges(repo: Repo, baseTreeOid: string | null, changes: readonly TreeChange[]): string {
    let tree: string | null = baseTreeOid;
    for (const change of changes) {
      const segments = change.path.split('/').filter((part) => part !== '');
      if (segments.length === 0) continue;
      tree = this.applyOne(repo, tree, segments, change.blobOid);
    }
    if (tree === null) return EMPTY_TREE_OID;
    return tree;
  }

  /** The blob bytes at `path` in the tree `treeOid`, or null when it is not a file. */
  blobAt(repo: Repo, treeOid: string, path: string): { oid: string; data: Buffer } | null {
    const entry = this.entryAt(repo, treeOid, path);
    if (entry === null || entry.mode === '40000') return null;
    const object = repo.objects.get(entry.oid);
    if (object?.type !== 'blob') return null;
    return { oid: entry.oid, data: object.data };
  }

  /** The entries of the directory at `path` in a tree ('' is the root), or null. */
  dirAt(repo: Repo, treeOid: string, path: string): TreeEntry[] | null {
    if (path === '' || path === '/') {
      const object = repo.objects.get(treeOid);
      if (object?.type !== 'tree') return null;
      return parseTree(object.data);
    }
    const entry = this.entryAt(repo, treeOid, path);
    if (entry === null || entry.mode !== '40000') return null;
    const object = repo.objects.get(entry.oid);
    if (object?.type !== 'tree') return null;
    return parseTree(object.data);
  }

  // ---------------------------------------------------------------- commits

  /** The identity a server-made commit carries, with a fresh timestamp. */
  private identity(): string {
    const stamp = COMMIT_EPOCH + this.commitSeq++;
    return `${this.viewer.name} <${this.viewer.email}> ${stamp} +0000`;
  }

  /** Create a commit on `branch` (creating the branch when needed) and return its id. */
  createCommit(repo: Repo, branch: string, message: string, treeOid: string, parents: readonly string[]): string {
    const who = this.identity();
    const data = buildCommit({ tree: treeOid, parents, message, author: who, committer: who });
    const oid = this.putObject(repo, 'commit', data);
    repo.refs.set(`refs/heads/${branch}`, oid);
    return oid;
  }

  // ---------------------------------------------------------------- contents

  /**
   * Write a file through the contents API. `sha`, when given, must name the
   * blob currently at the path, or the write is a 409. Returns the commit and
   * blob ids, and whether the file is new.
   */
  putFile(repo: Repo, options: { path: string; content: Buffer; message: string; branch?: string; sha?: string }): { commitSha: string; contentSha: string; created: boolean } {
    const branch = options.branch ?? repo.defaultBranch;
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref) ?? repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    const baseTree = tip === undefined ? null : this.treeOf(repo, tip);
    const current = baseTree === null ? null : this.blobAt(repo, baseTree, options.path);
    if (options.sha !== undefined && current !== null && current.oid.toLowerCase() !== options.sha.toLowerCase()) {
      throw new StoreError(409, 'the sha does not match the current blob');
    }
    const blobOid = this.putObject(repo, 'blob', options.content);
    const tree = this.applyTreeChanges(repo, baseTree, [{ path: options.path, blobOid }]);
    const parents = tip === undefined ? [] : [tip];
    const commitSha = this.createCommit(repo, branch, options.message.endsWith('\n') ? options.message : `${options.message}\n`, tree, parents);
    return { commitSha, contentSha: blobOid, created: current === null };
  }

  /** Delete a file through the contents API; returns the new commit's id. */
  deleteFile(repo: Repo, options: { path: string; message: string; branch?: string; sha?: string }): string {
    const branch = options.branch ?? repo.defaultBranch;
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    if (tip === undefined) throw new StoreError(404, 'the branch does not exist');
    const baseTree = this.treeOf(repo, tip);
    if (baseTree === null) throw new StoreError(404, 'the branch has no tree');
    const current = this.blobAt(repo, baseTree, options.path);
    if (current === null) throw new StoreError(404, 'the file does not exist');
    if (options.sha !== undefined && current.oid.toLowerCase() !== options.sha.toLowerCase()) {
      throw new StoreError(409, 'the sha does not match the current blob');
    }
    const tree = this.applyTreeChanges(repo, baseTree, [{ path: options.path, blobOid: null }]);
    return this.createCommit(repo, branch, options.message.endsWith('\n') ? options.message : `${options.message}\n`, tree, [tip]);
  }

  // ---------------------------------------------------------------- diff and merge

  /** A line-level diff: additions and deletions between two texts. */
  private lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
    const oldLines = oldText === '' ? [] : oldText.split('\n');
    const newLines = newText === '' ? [] : newText.split('\n');
    // A trailing newline makes the last split element ''; drop it for counting.
    if (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop();
    if (newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop();
    const rows = oldLines.length + 1;
    const cols = newLines.length + 1;
    const table = new Uint32Array(rows * cols);
    for (let i = oldLines.length - 1; i >= 0; i -= 1) {
      for (let j = newLines.length - 1; j >= 0; j -= 1) {
        table[i * cols + j] = oldLines[i] === newLines[j] ? (table[(i + 1) * cols + (j + 1)] as number) + 1 : Math.max(table[(i + 1) * cols + j] as number, table[i * cols + (j + 1)] as number);
      }
    }
    let i = 0;
    let j = 0;
    let additions = 0;
    let deletions = 0;
    while (i < oldLines.length && j < newLines.length) {
      if (oldLines[i] === newLines[j]) {
        i += 1;
        j += 1;
      } else if ((table[(i + 1) * cols + j] as number) >= (table[i * cols + (j + 1)] as number)) {
        deletions += 1;
        i += 1;
      } else {
        additions += 1;
        j += 1;
      }
    }
    deletions += oldLines.length - i;
    additions += newLines.length - j;
    return { additions, deletions };
  }

  /** The file changes between two trees, with line counts. */
  diffTrees(repo: Repo, baseTreeOid: string | null, headTreeOid: string | null): FileDiff[] {
    const out: FileDiff[] = [];
    const walk = (baseOid: string | null, headOid: string | null, prefix: string): void => {
      const baseEntries = new Map<string, TreeEntry>();
      const headEntries = new Map<string, TreeEntry>();
      if (baseOid !== null) {
        const object = repo.objects.get(baseOid);
        if (object?.type === 'tree') for (const entry of parseTree(object.data)) baseEntries.set(entry.name, entry);
      }
      if (headOid !== null) {
        const object = repo.objects.get(headOid);
        if (object?.type === 'tree') for (const entry of parseTree(object.data)) headEntries.set(entry.name, entry);
      }
      const names = new Set([...baseEntries.keys(), ...headEntries.keys()]);
      for (const name of [...names].sort()) {
        const base = baseEntries.get(name);
        const head = headEntries.get(name);
        const path = prefix === '' ? name : `${prefix}/${name}`;
        if (base !== undefined && head !== undefined && base.mode === '40000' && head.mode === '40000') {
          walk(base.oid, head.oid, path);
          continue;
        }
        if (base !== undefined && head !== undefined && base.oid === head.oid) continue;
        if (base === undefined && head !== undefined) {
          if (head.mode === '40000') {
            walk(null, head.oid, path);
          } else {
            const data = repo.objects.get(head.oid)?.data ?? Buffer.alloc(0);
            const counts = this.lineDiff('', data.toString('utf8'));
            out.push({ path, status: 'added', oldOid: null, newOid: head.oid, additions: counts.additions, deletions: 0 });
          }
          continue;
        }
        if (base !== undefined && head === undefined) {
          if (base.mode === '40000') {
            walk(base.oid, null, path);
          } else {
            const data = repo.objects.get(base.oid)?.data ?? Buffer.alloc(0);
            const counts = this.lineDiff(data.toString('utf8'), '');
            out.push({ path, status: 'removed', oldOid: base.oid, newOid: null, additions: 0, deletions: counts.deletions });
          }
          continue;
        }
        if (base !== undefined && head !== undefined) {
          const oldData = repo.objects.get(base.oid)?.data ?? Buffer.alloc(0);
          const newData = repo.objects.get(head.oid)?.data ?? Buffer.alloc(0);
          const counts = this.lineDiff(oldData.toString('utf8'), newData.toString('utf8'));
          out.push({ path, status: 'modified', oldOid: base.oid, newOid: head.oid, additions: counts.additions, deletions: counts.deletions });
        }
      }
    };
    walk(baseTreeOid, headTreeOid, '');
    return out;
  }

  /** True when merging `headTip` into `baseTip` would conflict. */
  mergeConflicts(repo: Repo, headTip: string, baseTip: string): boolean {
    const base = mergeBase(headTip, baseTip, (oid) => repo.objects.get(oid));
    if (base === null) return false;
    const baseTree = this.treeOf(repo, base);
    const headTree = this.treeOf(repo, headTip);
    const targetTree = this.treeOf(repo, baseTip);
    if (baseTree === null || headTree === null || targetTree === null) return false;
    const headChanges = new Map(this.diffTrees(repo, baseTree, headTree).map((change) => [change.path, change.newOid]));
    const baseChanges = new Map(this.diffTrees(repo, baseTree, targetTree).map((change) => [change.path, change.newOid]));
    for (const [path, headOid] of headChanges) {
      if (!baseChanges.has(path)) continue;
      if (baseChanges.get(path) !== headOid) return true;
    }
    return false;
  }

  /**
   * A squash merge of `headTip` into the base branch: one commit on the base
   * carrying the head's changes. Returns the merge commit's id, or null when
   * the merge would conflict.
   */
  squashMerge(repo: Repo, pull: Pull): string | null {
    const headTip = repo.refs.get(`refs/heads/${pull.head}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
    if (headTip === undefined || baseTip === undefined) return null;
    if (this.mergeConflicts(repo, headTip, baseTip)) return null;
    const base = mergeBase(headTip, baseTip, (oid) => repo.objects.get(oid));
    const baseTree = base === null ? this.treeOf(repo, baseTip) : this.treeOf(repo, base);
    const headTree = this.treeOf(repo, headTip);
    const targetTree = this.treeOf(repo, baseTip);
    if (baseTree === null || headTree === null || targetTree === null) return null;
    const changes: TreeChange[] = this.diffTrees(repo, baseTree, headTree).map((change) => ({ path: change.path, blobOid: change.newOid }));
    const tree = this.applyTreeChanges(repo, targetTree, changes);
    return this.createCommit(repo, pull.base, `Merge pull request #${pull.number} from ${pull.head}\n`, tree, [baseTip]);
  }

  // ---------------------------------------------------------------- labels, issues, pulls

  createLabel(repo: Repo, name: string, color: string): Label | null {
    if (repo.labels.has(name)) return null;
    const label: Label = { id: this.nextId++, name, color };
    repo.labels.set(name, label);
    return label;
  }

  createIssue(repo: Repo, title: string, body: string, labelNames: readonly string[]): Issue {
    const labels: Label[] = [];
    for (const name of labelNames) {
      const label = repo.labels.get(name);
      if (label === undefined) throw new StoreError(422, `label ${name} does not exist`);
      labels.push(label);
    }
    const issue: Issue = {
      id: this.nextId++,
      number: repo.nextNumber++,
      title,
      body,
      state: 'open',
      labels,
      comments: [],
      createdSeq: this.seq(),
    };
    repo.issues.push(issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  addComment(repo: Repo, issue: Issue, body: string): Comment {
    const comment: Comment = { id: repo.nextCommentId++, body, createdSeq: this.seq() };
    issue.comments.push(comment);
    return comment;
  }

  createPull(repo: Repo, title: string, body: string, head: string, base: string): Pull | null {
    if (repo.refs.get(`refs/heads/${head}`) === undefined) throw new StoreError(422, `head branch ${head} does not exist`);
    if (repo.refs.get(`refs/heads/${base}`) === undefined) throw new StoreError(422, `base branch ${base} does not exist`);
    const open = repo.pulls.find((pull) => pull.head === head && pull.base === base && pull.state === 'open');
    if (open !== undefined) return null;
    const pull: Pull = {
      id: this.nextId++,
      number: repo.nextNumber++,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      head,
      base,
      createdSeq: this.seq(),
    };
    repo.pulls.push(pull);
    return pull;
  }

  getPull(repo: Repo, number: number): Pull | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }

  /** Merge a pull request (squash). True when merged; false when conflicted. */
  mergePull(repo: Repo, pull: Pull): boolean {
    if (pull.state !== 'open') return false;
    const sha = this.squashMerge(repo, pull);
    if (sha === null) return false;
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = this.stamp(this.seq());
    pull.mergeCommitSha = sha;
    return true;
  }

  /** Whether a pull request would merge cleanly right now. */
  pullMergeable(repo: Repo, pull: Pull): boolean {
    if (pull.state !== 'open') return false;
    const headTip = repo.refs.get(`refs/heads/${pull.head}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
    if (headTip === undefined || baseTip === undefined) return false;
    return !this.mergeConflicts(repo, headTip, baseTip);
  }

  // ---------------------------------------------------------------- reachability helpers

  /**
   * The objects to send for a fetch: reachable from `wants` (depth-limited
   * when `depth` is set), minus what the client already holds. A shallow
   * clone holds its boundaries but not their ancestors, so the ancestors of
   * the client's `oldShallow` boundaries are NOT treated as held — otherwise a
   * deepen fetch would wrongly withhold the very commits it must send.
   * Returns the objects, the new shallow boundaries, and the old boundaries
   * that are now fully included (unshallow).
   */
  objectsToSend(repo: Repo, wants: readonly string[], haves: readonly string[], depth?: number, oldShallow: readonly string[] = []): { objects: GitObject[]; boundaries: string[]; unshallow: string[] } {
    const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
    const haveReachable = collectReachable(haves, lookup, { allowMissing: true }).objects;
    const shallowParents: string[] = [];
    for (const oid of oldShallow) {
      const object = repo.objects.get(oid);
      if (object?.type === 'commit') shallowParents.push(...parseCommit(object.data).parents);
    }
    const shallowAncestors = collectReachable(shallowParents, lookup, { allowMissing: true }).objects;
    const haveSet = new Set([...haveReachable].filter((oid) => !shallowAncestors.has(oid)));
    const wanted = collectReachable(wants, lookup, { maxDepth: depth, allowMissing: true });
    const objects: GitObject[] = [];
    const sentSet = new Set<string>();
    for (const oid of wanted.objects) {
      if (haveSet.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object !== undefined) {
        objects.push(object);
        sentSet.add(oid);
      }
    }
    // A boundary the client already holds in full is not a boundary any more.
    // Likewise a frontier commit whose parents are all sent in this fetch or
    // already held by the client is not cut off below: after the fetch the
    // client holds its whole history, so it must not be marked shallow. A
    // root commit keeps its boundary status (it has no parents to be held).
    const boundaries = [...wanted.boundaries].filter((oid) => {
      if (haveSet.has(oid)) return false;
      const object = repo.objects.get(oid);
      if (object?.type !== 'commit') return true;
      const parents = parseCommit(object.data).parents;
      return parents.length === 0 || parents.some((parent) => !haveSet.has(parent) && !sentSet.has(parent));
    });
    // An old boundary that is now included and is no longer a (final)
    // boundary is unshallowed: after this fetch the client holds its whole
    // history below it.
    const unshallow = oldShallow.filter((oid) => wanted.objects.has(oid) && !boundaries.includes(oid));
    return { objects, boundaries, unshallow };
  }

  /** Whether `oldOid` is an ancestor of (or equal to) `newOid` in this repo. */
  isFastForward(repo: Repo, oldOid: string, newOid: string): boolean {
    return isAncestor(oldOid, newOid, (oid) => repo.objects.get(oid));
  }

  // ---------------------------------------------------------------- serializers

  userJson(): { login: string; id: number; type: string; name: string; email: string } {
    return { login: this.viewer.login, id: this.viewer.id, type: 'User', name: this.viewer.name, email: this.viewer.email };
  }

  repoJson(repo: Repo): Record<string, unknown> {
    return {
      id: repo.id,
      node_id: gid('Repository', `${repo.owner}/${repo.name}`),
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      owner: { login: repo.owner, id: this.viewer.id, type: 'User' },
      private: repo.private,
      description: repo.description,
      default_branch: repo.defaultBranch,
      html_url: `https://github.com/${repo.owner}/${repo.name}`,
      url: `/api/v3/repos/${repo.owner}/${repo.name}`,
      clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
      created_at: this.stamp(repo.createdSeq),
      updated_at: this.stamp(repo.createdSeq),
      pushed_at: this.stamp(repo.createdSeq),
      has_issues: true,
      has_projects: true,
      has_wiki: true,
      has_pages: false,
      has_downloads: true,
      forks_count: 0,
      stargazers_count: 0,
      watchers_count: 0,
      open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    };
  }

  labelJson(label: Label): Record<string, unknown> {
    return { id: label.id, name: label.name, color: label.color, description: '' };
  }

  issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
    return {
      id: issue.id,
      node_id: gid('Issue', `${repo.owner}/${repo.name}#${issue.number}`),
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels.map((label) => this.labelJson(label)),
      user: { login: this.viewer.login, id: this.viewer.id, type: 'User' },
      assignee: null,
      assignees: [],
      comments: issue.comments.length,
      created_at: this.stamp(issue.createdSeq),
      updated_at: this.stamp(issue.createdSeq),
      closed_at: issue.state === 'closed' ? this.stamp(issue.createdSeq) : null,
      html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    };
  }

  commentJson(repo: Repo, issue: Issue, comment: Comment): Record<string, unknown> {
    return {
      id: comment.id,
      node_id: gid('IssueComment', `${repo.owner}/${repo.name}#${issue.number}/${comment.id}`),
      body: comment.body,
      user: { login: this.viewer.login, id: this.viewer.id, type: 'User' },
      created_at: this.stamp(comment.createdSeq),
      updated_at: this.stamp(comment.createdSeq),
      html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${comment.id}`,
    };
  }

  pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
    const headSha = repo.refs.get(`refs/heads/${pull.head}`) ?? '';
    const baseSha = repo.refs.get(`refs/heads/${pull.base}`) ?? '';
    return {
      id: pull.id,
      node_id: gid('PullRequest', `${repo.owner}/${repo.name}!${pull.number}`),
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      merged: pull.merged,
      merged_at: pull.mergedAt,
      merge_commit_sha: pull.mergeCommitSha,
      head: { ref: pull.head, sha: headSha, label: `${repo.owner}:${pull.head}` },
      base: { ref: pull.base, sha: baseSha, label: `${repo.owner}:${pull.base}` },
      user: { login: this.viewer.login, id: this.viewer.id, type: 'User' },
      created_at: this.stamp(pull.createdSeq),
      updated_at: this.stamp(pull.createdSeq),
      closed_at: pull.state === 'closed' ? (pull.mergedAt ?? this.stamp(pull.createdSeq)) : null,
      html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    };
  }
}
