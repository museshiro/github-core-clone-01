// The git transport: smart HTTP. Two services, both under /{owner}/{repo}.git:
//   GET  info/refs?service=git-upload-pack | git-receive-pack
//   POST git-upload-pack    (protocol v2; v0 is kept for older clients)
//   POST git-receive-pack   (protocol v0 only)
// The pack protocol is pkt-lines over the body; the pack itself follows the
// command flush in a receive-pack request. No git binary anywhere: objects
// are read and written by gitcore.ts, and the store owns the refs.

import {
  ZERO_OID,
  collectReachable,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  parseTag,
  pktFlush,
  readPack,
  verifyPackChecksum,
  writePack,
} from './gitcore.ts';
import { Store, type Repo } from './store.ts';

export interface GitRequest {
  method: string;
  pathname: string;
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export interface GitResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

const UPLOAD_V0_CAPS =
  'multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not deepen-relative no-progress include-tag multi_ack_detailed allow-tip-sha1-in-want allow-reachable-sha1-in-want no-done object-format=sha1 agent=github-core-clone/1.0';
const RECEIVE_V0_CAPS = 'report-status side-band-64k delete-refs agent=github-core-clone/1.0';

/** A sideband packet: one pkt-line holding a band byte plus its payload. */
function sideband(band: number, payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  return encodePktLine(Buffer.concat([Buffer.from([band]), data]));
}

/** Split a pack into sideband band-1 packets (each pkt-line at most 65520 bytes). */
function packSideband(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let offset = 0;
  while (offset < pack.length) {
    const chunk = pack.subarray(offset, offset + 65515);
    offset += chunk.length;
    parts.push(sideband(1, chunk));
  }
  return parts;
}

/** Follow tags down to the commit they point at, or null when it is not one. */
function peelToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return null;
    seen.add(current);
    const object = repo.objects.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
}

function jsonResponse(status: number, value: unknown): GitResponse {
  return {
    status,
    headers: { 'Content-Type': 'application/json' },
    body: Buffer.from(JSON.stringify(value), 'utf8'),
  };
}

/**
 * The v0 advertisement: a service preamble, then the refs. Upload-pack lists
 * HEAD first (carrying the capabilities); receive-pack lists only the refs,
 * capabilities on the first one. When the repository has no refs at all, a
 * `capabilities^{}` pseudo-ref carries the capabilities instead — without it
 * the client cannot learn the server speaks report-status and side-band, so
 * it sends no capabilities and cannot read the answer.
 */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): GitResponse {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const lines: (string | 'flush')[] = [];
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}`);
  } else if (service === 'git-upload-pack') {
    const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (headOid !== undefined) lines.push(`${headOid} HEAD\0${caps}`);
    for (const [name, oid] of refs) {
      lines.push(`${oid} ${name}`);
    }
  } else {
    refs.forEach(([name, oid], index) => {
      lines.push(index === 0 ? `${oid} ${name}\0${caps}` : `${oid} ${name}`);
    });
  }
  lines.push('flush');
  const body = Buffer.concat([
    encodePktLine(`# service=${service}\n`),
    pktFlush(),
    encodePktLines(lines),
  ]);
  return {
    status: 200,
    headers: { 'Content-Type': `application/x-${service}-advertisement` },
    body,
  };
}

/** The v2 capability advertisement: it opens with `version 2`, no preamble. */
function v2Advertisement(): GitResponse {
  const body = encodePktLines([
    'version 2\n',
    'agent=github-core-clone/1.0\n',
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
    'flush',
  ]);
  return {
    status: 200,
    headers: { 'Content-Type': 'application/x-git-upload-pack-advertisement' },
    body,
  };
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string {
  const raw = headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0] ?? '';
  return raw ?? '';
}

function handleInfoRefs(store: Store, repo: Repo, req: GitRequest): GitResponse {
  const service = req.query.get('service');
  if (service === 'git-upload-pack') {
    if (headerValue(req.headers, 'git-protocol').trim() === 'version=2') return v2Advertisement();
    return v0Advertisement(repo, 'git-upload-pack');
  }
  if (service === 'git-receive-pack') return v0Advertisement(repo, 'git-receive-pack');
  return jsonResponse(400, { message: 'unknown service' });
}

/** Parse a v2 request body into its command and the arguments after the delim. */
function parseV2Request(body: Buffer): { command: string; args: string[] } {
  const { packets } = decodePktLines(body);
  const lines: string[] = [];
  let afterDelim = false;
  const args: string[] = [];
  let command = '';
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').trim();
    if (!afterDelim) {
      if (command === '' && text.startsWith('command=')) command = text.slice('command='.length);
      lines.push(text);
    } else {
      args.push(text);
    }
  }
  return { command, args };
}

/** The acknowledgment lines for a fetch: NAK, or one ACK per held have plus ready. */
function ackLines(repo: Repo, wants: readonly string[], haves: readonly string[]): string[] {
  if (haves.length === 0) return ['NAK'];
  const reachable = collectReachable(wants, (oid) => repo.objects.get(oid), { allowMissing: true }).objects;
  const lines: string[] = [];
  for (const have of haves) {
    const object = repo.objects.get(have);
    if (object?.type === 'commit' && reachable.has(have)) lines.push(`ACK ${have}`);
  }
  if (lines.length === 0) return ['NAK'];
  lines.push('ready');
  return lines;
}

function handleLsRefs(store: Store, repo: Repo, args: readonly string[]): GitResponse {
  const prefixes: string[] = [];
  let wantPeel = false;
  let wantSymrefs = false;
  let wantUnborn = false;
  for (const arg of args) {
    if (arg === 'peel') wantPeel = true;
    else if (arg === 'symrefs') wantSymrefs = true;
    else if (arg === 'unborn') wantUnborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
    else if (arg.startsWith('ref-prefix=')) prefixes.push(arg.slice('ref-prefix='.length));
  }
  const matches = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef);
  const lines: string[] = [];
  if (headOid !== undefined) {
    if (matches('HEAD')) {
      let line = `${headOid} HEAD`;
      if (wantSymrefs) line += ` symref-target:${headRef}`;
      lines.push(line);
    }
  } else if (wantUnborn && matches('HEAD')) {
    lines.push(`unborn HEAD symref-target:${headRef}`);
  }
  for (const ref of store.listRefs(repo)) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (wantPeel) {
      const peeled = peelToCommit(repo, ref.oid);
      if (peeled !== null && peeled !== ref.oid) line += ` peeled:${peeled}`;
    }
    lines.push(line);
  }
  return {
    status: 200,
    headers: { 'Content-Type': 'application/x-git-upload-pack-result' },
    body: encodePktLines([...lines, 'flush']),
  };
}

function handleFetchV2(store: Store, repo: Repo, args: readonly string[]): GitResponse {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const value = Number(arg.slice(7).trim());
      if (Number.isFinite(value) && value >= 0) depth = value;
    }
  }
  const { objects, boundaries, unshallow } = store.objectsToSend(repo, wants, haves, depth, shallow);
  const pack = writePack(objects);
  const parts: Buffer[] = [];
  // Each section opens with a header line naming it, terminated by a newline
  // (the wire format's section headers carry one; a client that compares the
  // header exactly rejects a bare name). The acknowledgments section only
  // exists when the client sent haves (a clone sends none and goes straight
  // to the packfile); the shallow-info section only exists when a depth was
  // asked for or the client sent shallow boundaries. The packfile section is
  // always present.
  if (haves.length > 0) {
    parts.push(encodePktLines(['acknowledgments\n', ...ackLines(repo, wants, haves), 'delim']));
  }
  if (depth !== undefined || shallow.length > 0) {
    const shallowLines: string[] = ['shallow-info\n'];
    for (const oid of boundaries) shallowLines.push(`shallow ${oid}`);
    for (const oid of unshallow) shallowLines.push(`unshallow ${oid}`);
    shallowLines.push('delim');
    parts.push(encodePktLines(shallowLines));
  }
  parts.push(encodePktLine('packfile\n'));
  parts.push(Buffer.concat([...packSideband(pack), pktFlush()]));
  return {
    status: 200,
    headers: { 'Content-Type': 'application/x-git-upload-pack-result' },
    body: Buffer.concat(parts),
  };
}

function handleUploadPack(store: Store, repo: Repo, req: GitRequest): GitResponse {
  if (headerValue(req.headers, 'git-protocol').trim() === 'version=2') {
    const { command, args } = parseV2Request(req.body);
    if (command === 'ls-refs') return handleLsRefs(store, repo, args);
    if (command === 'fetch') return handleFetchV2(store, repo, args);
    return jsonResponse(400, { message: `unknown command ${command}` });
  }
  // Protocol v0: want/have/done lines. On the first want line the capabilities
  // follow the oid separated by spaces (not by a NUL, which the advertisement
  // and the receive-pack request use instead).
  const { packets } = decodePktLines(req.body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  let sideBand = false;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').trim();
    if (line.startsWith('want ')) {
      const [oid, ...caps] = line.slice(5).trim().split(/\s+/);
      if (oid !== undefined && oid !== '') wants.push(oid);
      if (caps.join(' ').includes('side-band-64k')) sideBand = true;
    } else if (line.startsWith('have ')) {
      haves.push(line.slice(5).trim().split(/\s+/)[0] ?? '');
    } else if (line.startsWith('shallow ')) {
      shallow.push(line.slice(8).trim());
    } else if (line.startsWith('deepen ')) {
      const value = Number(line.slice(7).trim());
      if (Number.isFinite(value) && value >= 0) depth = value;
    } else if (line === 'done') {
      break;
    }
  }
  const { objects, boundaries, unshallow } = store.objectsToSend(repo, wants, haves, depth, shallow);
  const pack = writePack(objects);
  const parts: Buffer[] = [encodePktLines(ackLines(repo, wants, haves))];
  if (depth !== undefined || shallow.length > 0) {
    const shallowLines: string[] = [];
    for (const oid of boundaries) shallowLines.push(`shallow ${oid}`);
    for (const oid of unshallow) shallowLines.push(`unshallow ${oid}`);
    parts.push(encodePktLines(shallowLines));
  }
  if (sideBand) {
    parts.push(Buffer.concat([...packSideband(pack), pktFlush()]));
  } else {
    parts.push(pack);
  }
  return {
    status: 200,
    headers: { 'Content-Type': 'application/x-git-upload-pack-result' },
    body: Buffer.concat(parts),
  };
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(store: Store, repo: Repo, req: GitRequest): GitResponse {
  const { packets, offset } = decodePktLines(req.body);
  const commands: PushCommand[] = [];
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)\s*$/.exec(line.trim());
    if (match !== null) {
      commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
    }
  }
  // The pack follows the command flush; a delete-only push carries none.
  const packBytes = req.body.subarray(offset);
  let unpackOk = true;
  let unpackError = '';
  if (packBytes.length > 0) {
    try {
      if (!verifyPackChecksum(packBytes)) throw new Error('pack checksum mismatch');
      const objects = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (error) {
      unpackOk = false;
      unpackError = error instanceof Error ? error.message : 'unpack failed';
    }
  }
  const results: { ref: string; ok: boolean; reason?: string }[] = [];
  for (const command of commands) {
    if (!unpackOk) {
      results.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      if (current === undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
      } else if (command.oldOid !== ZERO_OID && current !== command.oldOid) {
        results.push({ ref: command.ref, ok: false, reason: 'remote ref has changed' });
      } else {
        repo.refs.delete(command.ref);
        results.push({ ref: command.ref, ok: true });
      }
      continue;
    }
    const target = repo.objects.get(command.newOid);
    if (target === undefined || (target.type !== 'commit' && target.type !== 'tag')) {
      results.push({ ref: command.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      if (current !== undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'remote ref already exists' });
      } else {
        repo.refs.set(command.ref, command.newOid);
        results.push({ ref: command.ref, ok: true });
      }
      continue;
    }
    if (current === undefined) {
      results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
    } else if (current !== command.oldOid) {
      results.push({ ref: command.ref, ok: false, reason: 'remote ref has changed' });
    } else if (!store.isFastForward(repo, command.oldOid, command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
    } else {
      repo.refs.set(command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true });
    }
  }
  // report-status: the whole stream — the lines, each pkt-lined, plus the
  // flush that ends it — rides inside sideband band-1 packets, and the
  // response ends with an outer flush. A client that reads the stream
  // expects that inner flush; without it the remote end looks hung up.
  const reportLines: string[] = [unpackOk ? 'unpack ok\n' : `unpack ${unpackError}\n`];
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason ?? 'failed'}\n`);
  }
  const innerStream = Buffer.concat([...reportLines.map((line) => encodePktLine(line)), pktFlush()]);
  const parts: Buffer[] = [];
  let sent = 0;
  while (sent < innerStream.length) {
    const chunk = innerStream.subarray(sent, sent + 65515);
    sent += chunk.length;
    parts.push(sideband(1, chunk));
  }
  parts.push(pktFlush());
  return {
    status: 200,
    headers: { 'Content-Type': 'application/x-git-receive-pack-result' },
    body: Buffer.concat(parts),
  };
}

/** Route a smart-HTTP request. Returns null when the path is not a git route. */
export function handleGit(store: Store, req: GitRequest): GitResponse | null {
  const pathname = req.pathname.replace(/\/+$/, '');
  const match = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
  if (match === null) return null;
  let owner: string;
  let repoName: string;
  try {
    owner = decodeURIComponent(match[1] as string);
    repoName = decodeURIComponent(match[2] as string);
  } catch {
    return jsonResponse(400, { message: 'bad request' });
  }
  const service = match[3] as string;
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return jsonResponse(404, { message: 'Not Found' });
  try {
    if (service === 'info/refs' && req.method === 'GET') return handleInfoRefs(store, repo, req);    if (service === 'git-upload-pack' && req.method === 'POST') return handleUploadPack(store, repo, req);
    if (service === 'git-receive-pack' && req.method === 'POST') return handleReceivePack(store, repo, req);
    return jsonResponse(404, { message: 'Not Found' });
  } catch (error) {
    // A malformed git request must never take the server down.
    const message = error instanceof Error ? error.message : 'bad request';
    return jsonResponse(400, { message });
  }
}
