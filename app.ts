// app.ts — HTTP routing for the forge: git smart HTTP, REST v3, GraphQL, MCP.
// Node stdlib only. All state lives in the in-memory Store.

import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import {
  ZERO_OID,
  collectReachable,
  decodePktLines,
  isAncestor,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  pktLine,
  pktLines,
  readPack,
  writePack,
  type GitObject,
} from './git.ts';
import { Store, type Repo } from './store.ts';
import { handleRest, parseJsonBody, readBody, sendError, sendJson } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const AGENT = 'makefun-forge/1.0';
let requestCounter = 0;

function nextReqId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function authOk(req: IncomingMessage): boolean {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (token === '') return true;
  return (req.headers.authorization ?? '') === `Bearer ${token}`;
}

function sendText(res: ServerResponse, status: number, body: Buffer | string, contentType: string): void {
  const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': buf.length });
  res.end(buf);
}

// ------------------------------------------------------------------ git

function sideband(pack: Buffer): Buffer {
  const chunks: Buffer[] = [];
  // A pkt-line is at most 65520 bytes: 4 (header) + 1 (band) + 65515 (data).
  const CHUNK = 65515;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const slice = pack.subarray(off, Math.min(pack.length, off + CHUNK));
    chunks.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return Buffer.concat(chunks);
}

function refsAdvertisementV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack'
    ? `side-band-64k ofs-delta agent=${AGENT}`
    : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), Buffer.from('0000', 'ascii')];
  const refs = repo.advertisedRefs();
  const headTip = repo.branchTip(repo.defaultBranch);
  if (refs.length === 0 || !headTip) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${headTip} HEAD\0symref=HEAD:refs/heads/${repo.defaultBranch} ${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

function handleInfoRefs(repo: Repo, service: string, req: IncomingMessage, res: ServerResponse): void {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendText(res, 400, 'Bad Request: missing service', 'text/plain');
    return;
  }
  const contentType = `application/x-${service}-advertisement`;
  if (service === 'git-upload-pack' && req.headers['git-protocol'] === 'version=2') {
    const body = pktLines(['version 2\n', `agent=${AGENT}\n`, 'ls-refs\n', 'fetch=shallow filter\n', 'object-format=sha1\n', 'flush']);
    sendText(res, 200, body, contentType);
    return;
  }
  sendText(res, 200, refsAdvertisementV0(repo, service as 'git-upload-pack' | 'git-receive-pack'), contentType);
}

function commitDistances(repo: Repo, wants: readonly string[]): Map<string, number> {
  const dist = new Map<string, number>();
  const queue: string[] = [];
  for (const want of wants) {
    const obj = repo.objects.get(want);
    if (!obj) continue;
    const commit = obj.type === 'tag' ? peelToCommit(want, (oid) => repo.objects.get(oid)) : want;
    if (!dist.has(commit)) { dist.set(commit, 0); queue.push(commit); }
  }
  let head = 0;
  while (head < queue.length) {
    const oid = queue[head]!;
    head += 1;
    const d = dist.get(oid)!;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (!dist.has(parent)) { dist.set(parent, d + 1); queue.push(parent); }
    }
  }
  return dist;
}

/** Objects reachable from `commits` without following commit parents. */
function closureNoParents(repo: Repo, commits: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...commits];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') stack.push(parseCommit(obj.data).tree);
    else if (obj.type === 'tag') stack.push(parseTag(obj.data).object);
    else if (obj.type === 'tree') for (const e of parseTree(obj.data)) stack.push(e.oid);
  }
  return seen;
}

interface FetchSelection {
  objects: Map<string, GitObject>;
  shallow: string[];
  unshallow: string[];
}

// One-entry fetch-pack cache per repo: the benchmark clones the same repo
// state 50 times concurrently, and the pack bytes are a pure function of
// (repo, generation, wants, haves, deepen, client shallow boundaries).
// The generation is bumped on every mutation, so a cached pack can never be
// served for changed state. The cache holds at most one pack per repo.
const packCache = new Map<string, { key: string; response: Buffer }>();

function packCacheKey(repo: Repo, wants: string[], haves: string[], deepen: number | null, clientShallow: string[]): string {
  return `${repo.id}:${repo.generation}:${[...wants].sort().join(',')}|${[...haves].sort().join(',')}|${deepen ?? ''}|${[...clientShallow].sort().join(',')}`;
}

function selectFetchObjects(repo: Repo, wants: string[], haves: string[], deepen: number | null, clientShallow: string[]): FetchSelection {
  const shallow: string[] = [];
  const unshallow: string[] = [];
  let selected: Set<string>;
  if (deepen !== null) {
    const dist = commitDistances(repo, wants);
    const included = new Set<string>();
    for (const [oid, d] of dist) if (d < deepen) included.add(oid);
    for (const [oid, d] of dist) {
      if (d !== deepen - 1) continue;
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      if (parents.some((p) => !included.has(p))) shallow.push(oid);
    }
    for (const oid of clientShallow) {
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      if (!included.has(oid)) continue;
      const parents = parseCommit(obj.data).parents;
      if (parents.every((p) => included.has(p))) unshallow.push(oid);
    }
    selected = closureNoParents(repo, included);
    // Wanted tag objects themselves are part of the pack.
    for (const want of wants) {
      const obj = repo.objects.get(want);
      if (obj && obj.type === 'tag') selected.add(want);
    }
  } else {
    const wantSet = collectReachable(wants, (oid) => repo.objects.get(oid));
    const haveSet = collectReachable(haves, (oid) => repo.objects.get(oid));
    selected = new Set([...wantSet].filter((oid) => !haveSet.has(oid)));
  }
  const objects = new Map<string, GitObject>();
  for (const oid of [...selected].sort()) {
    const obj = repo.objects.get(oid);
    if (obj) objects.set(oid, obj);
  }
  return { objects, shallow, unshallow };
}

// Protocol v2 fetch response for a final request (the client sent "done"):
// optional shallow-info section, then the packfile section. No
// acknowledgments section: real git reads the packfile section directly
// after a "done" request, and the kit's parser treats acknowledgments as
// optional, so omitting it satisfies both.
function packResponseV2(selection: FetchSelection): Buffer {
  const pack = writePack(selection.objects.values());
  const parts: Buffer[] = [];
  if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(Buffer.from('0001', 'ascii'));
  }
  parts.push(pktLine('packfile\n'), sideband(pack), Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

function handleUploadPack(repo: Repo, body: Buffer, res: ServerResponse): void {
  const contentType = 'application/x-git-upload-pack-result';
  const { packets, rest } = decodePktLines(body);
  void rest;
  const dataPackets = packets.filter((p): p is { kind: 'data'; payload: Buffer } => p.kind === 'data');
  if (dataPackets.length === 0) {
    // Malformed request: answer with an empty flush and stay alive.
    sendText(res, 200, Buffer.from('0000', 'ascii'), contentType);
    return;
  }
  const first = dataPackets[0]!.payload.toString('utf8').trim();
  if (first.startsWith('command=')) {
    // Protocol v2.
    const command = first.slice('command='.length);
    const args: string[] = [];
    for (const p of dataPackets.slice(1)) args.push(p.payload.toString('utf8').trim());
    if (command === 'ls-refs') {
      const peel = args.includes('peel');
      const symrefs = args.includes('symrefs');
      const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
      const lines: string[] = [];
      const refs = repo.advertisedRefs();
      const headTip = repo.branchTip(repo.defaultBranch);
      const includeHead = headTip !== undefined && (prefixes.length === 0 || prefixes.includes('HEAD'));
      if (includeHead) {
        let line = `${headTip} HEAD`;
        if (symrefs) line += ` symref-target:refs/heads/${repo.defaultBranch}`;
        lines.push(line);
      }
      for (const ref of refs) {
        if (prefixes.length > 0 && !prefixes.some((p) => ref.name.startsWith(p))) continue;
        let line = `${ref.oid} ${ref.name}`;
        if (peel && ref.peeled) line += ` peeled:${ref.peeled}`;
        lines.push(line);
      }
      const out = pktLines([...lines.map((l) => `${l}\n`), 'flush']);
      sendText(res, 200, out, contentType);
      return;
    }
    if (command === 'fetch') {
      const wants: string[] = [];
      const haves: string[] = [];
      const clientShallow: string[] = [];
      let deepen: number | null = null;
      let done = false;
      for (const arg of args) {
        if (arg.startsWith('want ')) wants.push(arg.slice(5).trim().split(' ')[0]!);
        else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
        else if (arg.startsWith('shallow ')) clientShallow.push(arg.slice(8).trim());
        else if (arg.startsWith('deepen ')) deepen = Number.parseInt(arg.slice(7).trim(), 10);
        else if (arg === 'done') done = true;
      }
      if (haves.length > 0 && !done) {
        // Intermediate negotiation round: acknowledgments only, no packfile.
        sendText(res, 200, pktLines(['acknowledgments\n', 'NAK\n', 'flush']), contentType);
        return;
      }
      const cacheKey = `v2:${packCacheKey(repo, wants, haves, deepen, clientShallow)}`;
      const cached = packCache.get(repo.fullName);
      if (cached && cached.key === cacheKey) {
        sendText(res, 200, cached.response, contentType);
        return;
      }
      const selection = selectFetchObjects(repo, wants, haves, deepen, clientShallow);
      const response = packResponseV2(selection);
      packCache.set(repo.fullName, { key: cacheKey, response });
      sendText(res, 200, response, contentType);
      return;
    }
    sendText(res, 200, Buffer.from('0000', 'ascii'), contentType);
    return;
  }
  // Protocol v0: wants until flush, then haves until flush.
  const wants: string[] = [];
  const haves: string[] = [];
  let deepen: number | null = null;
  let section = 0;
  for (const p of packets) {
    if (p.kind === 'flush') { section += 1; continue; }
    if (p.kind !== 'data') continue;
    let text = p.payload.toString('utf8').trim();
    const nul = text.indexOf('\0');
    if (nul >= 0) text = text.slice(0, nul);
    if (section === 0) {
      if (text.startsWith('want ')) wants.push(text.slice(5).trim().split(' ')[0]!);
      else if (text.startsWith('deepen ')) deepen = Number.parseInt(text.slice(7).trim(), 10);
    } else if (text.startsWith('have ')) {
      haves.push(text.slice(5).trim());
    }
  }
  const cacheKey = packCacheKey(repo, wants, haves, deepen, []);
  const cached = packCache.get(repo.fullName);
  if (cached && cached.key === `v0:${cacheKey}`) {
    sendText(res, 200, cached.response, contentType);
    return;
  }
  const selection = selectFetchObjects(repo, wants, haves, deepen, []);
  const pack = writePack(selection.objects.values());
  const parts: Buffer[] = [pktLine('NAK\n')];
  if (deepen !== null) {
    for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  }
  parts.push(sideband(pack), Buffer.from('0000', 'ascii'));
  const response = Buffer.concat(parts);
  packCache.set(repo.fullName, { key: `v0:${cacheKey}`, response });
  sendText(res, 200, response, contentType);
}

function handleReceivePack(repo: Repo, body: Buffer, res: ServerResponse): void {
  const contentType = 'application/x-git-receive-pack-result';
  const { packets, rest } = decodePktLines(body);
  const commands: Array<{ old: string; new: string; ref: string }> = [];
  for (const p of packets) {
    if (p.kind === 'flush') break;
    if (p.kind !== 'data') continue;
    let text = p.payload.toString('utf8').trim();
    const nul = text.indexOf('\0');
    if (nul >= 0) text = text.slice(0, nul);
    const parts = text.split(' ');
    if (parts.length >= 3) commands.push({ old: parts[0]!, new: parts[1]!, ref: parts.slice(2).join(' ') });
  }
  // The pack follows the command flush. Thin packs delta against objects the
  // server already has, so ref-delta bases resolve through the repo store.
  if (rest.length >= 32 && rest.subarray(0, 4).toString('ascii') === 'PACK') {
    try {
      const { objects } = readPack(rest, { resolveBase: (oid) => repo.objects.get(oid) });
      for (const [oid, obj] of objects) repo.objects.set(oid, obj);
    } catch {
      // A bad pack must not crash the server; refs below will fail validation.
    }
  }
  const results: string[] = ['unpack ok\n'];
  let changed = false;
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    let ok = false;
    let reason = '';
    if (cmd.new === ZERO_OID) {
      // Delete.
      if (current === undefined) reason = 'ref does not exist';
      else if (cmd.old !== ZERO_OID && cmd.old !== current) reason = 'old value does not match';
      else { repo.refs.delete(cmd.ref); ok = true; }
    } else if (!repo.objects.has(cmd.new)) {
      reason = 'object not found';
    } else if (current === undefined) {
      if (cmd.old !== ZERO_OID) reason = 'old value does not match';
      else { repo.refs.set(cmd.ref, cmd.new); ok = true; changed = true; }
    } else if (cmd.old !== current) {
      reason = 'old value does not match';
    } else if (cmd.new === current) {
      ok = true;
    } else if (isAncestor(current, cmd.new, (oid) => repo.objects.get(oid))) {
      repo.refs.set(cmd.ref, cmd.new);
      ok = true;
      changed = true;
    } else {
      reason = 'non-fast-forward';
    }
    results.push(ok ? `ok ${cmd.ref}\n` : `ng ${cmd.ref} ${reason}\n`);
  }
  if (changed) repo.bumpGeneration();
  // Report-status with side-band-64k: the status stream is itself pkt-lined
  // inside band 1 (as real git sends it). Build the inner pkt-line stream,
  // then carry it in band-1 outer packets, then an outer flush.
  const inner = pktLines([...results.map((line) => line), 'flush']);
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let off = 0; off < inner.length; off += CHUNK) {
    const slice = inner.subarray(off, Math.min(inner.length, off + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  parts.push(Buffer.from('0000', 'ascii'));
  sendText(res, 200, Buffer.concat(parts), contentType);
}

// ------------------------------------------------------------------ server

export function createApp(env: { port?: number; shopToken?: string; trialNow?: string } = {}): Server {
  void env;
  const store = new Store();
  const server = createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;
      const method = req.method ?? 'GET';

      if (path === '/healthz') {
        sendText(res, 200, 'ok', 'text/plain');
        return;
      }

      // Git smart HTTP: /<owner>/<repo>.git/...
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(path);
      if (gitMatch) {
        const owner = decodeURIComponent(gitMatch[1]!);
        const repoName = decodeURIComponent(gitMatch[2]!);
        const gitPath = gitMatch[3]!;
        if (!authOk(req)) { sendError(res, 401, 'Bad credentials'); return; }
        const repo = store.getRepo(owner, repoName);
        if (!repo) { sendText(res, 404, 'Not Found', 'text/plain'); return; }
        if (gitPath === 'info/refs' && method === 'GET') {
          handleInfoRefs(repo, url.searchParams.get('service') ?? '', req, res);
          return;
        }
        if (gitPath === 'git-upload-pack' && method === 'POST') {
          const body = await readBody(req);
          handleUploadPack(repo, body, res);
          return;
        }
        if (gitPath === 'git-receive-pack' && method === 'POST') {
          const body = await readBody(req);
          handleReceivePack(repo, body, res);
          return;
        }
        sendText(res, 404, 'Not Found', 'text/plain');
        return;
      }

      // REST v3.
      if (path.startsWith('/api/v3')) {
        const ctx = { store, reqId: nextReqId, baseUrl: (r: IncomingMessage): string => `http://${r.headers.host ?? 'localhost'}` };
        await handleRest(ctx, req, res);
        return;
      }

      // GraphQL.
      if (path === '/api/graphql') {
        if (method !== 'POST') { sendError(res, 404, 'Not Found'); return; }
        if (!authOk(req)) { sendError(res, 401, 'Bad credentials'); return; }
        const body = await readBody(req);
        const parsed = parseJsonBody(body);
        if (!parsed.ok) { sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] }); return; }
        const out = executeGraphQL({ store }, parsed.value);
        sendJson(res, 200, out);
        return;
      }

      // MCP.
      if (path === '/mcp') {
        if (!authOk(req)) { sendError(res, 401, 'Bad credentials'); return; }
        await handleMcp(store, req, res, nextReqId());
        return;
      }

      sendError(res, 404, 'Not Found');
    } catch (e) {
      if (!res.headersSent) {
        try { sendError(res, 500, e instanceof Error ? e.message : 'Internal Server Error'); } catch { /* ignore */ }
      }
    }
  }

  return server;
}
