// git.ts — git objects, packfiles and pkt-line framing, Node stdlib only.
// Original implementation written for the github-core-clone-01 forge.
// No git binary, no dependencies: sha1 via node:crypto, deflate via node:zlib.

import { createHash, randomUUID } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function makeObject(type: GitObjectType, data: Buffer): { oid: string; object: GitObject } {
  return { oid: hashObject(type, data), object: { type, data } };
}

// ---------------------------------------------------------------- pkt-line

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function pktLines(parts: Array<string | Buffer | 'flush' | 'delim'>): Buffer {
  const out: Buffer[] = [];
  for (const part of parts) {
    if (part === 'flush') out.push(pktFlush());
    else if (part === 'delim') out.push(pktDelim());
    else out.push(pktLine(part));
  }
  return Buffer.concat(out);
}

export type Pkt = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };

/** Decode pkt-lines from the head of `buf`; returns packets and the byte offset where framing stopped. */
export function decodePktLines(buf: Buffer): { packets: Pkt[]; rest: Buffer } {
  const packets: Pkt[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const len = Number.parseInt(head, 16);
    if (len === 0) { packets.push({ kind: 'flush' }); off += 4; continue; }
    if (len === 1) { packets.push({ kind: 'delim' }); off += 4; continue; }
    if (len === 2) { packets.push({ kind: 'response-end' }); off += 4; continue; }
    if (len < 4 || off + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { packets, rest: buf.subarray(off) };
}

// ---------------------------------------------------------------- trees / commits / tags

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp < 0) break;
    const mode = data.subarray(off, sp).toString('ascii');
    const nul = data.indexOf(0, sp);
    if (nul < 0) break;
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const an = a.mode === '40000' ? `${a.name}/` : a.name;
  const bn = b.mode === '40000' ? `${b.name}/` : b.name;
  return an < bn ? -1 : an > bn ? 1 : 0;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  raw: Buffer;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const message = headEnd >= 0 ? text.slice(headEnd + 2) : '';
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message, raw: data };
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const message = headEnd >= 0 ? text.slice(headEnd + 2) : '';
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

export function buildCommit(opts: { tree: string; parents: readonly string[]; author: string; committer: string; message: string }): Buffer {
  const lines = [`tree ${opts.tree}`];
  for (const p of opts.parents) lines.push(`parent ${p}`);
  lines.push(`author ${opts.author}`, `committer ${opts.committer}`, '', opts.message.endsWith('\n') ? opts.message : `${opts.message}\n`);
  return Buffer.from(lines.join('\n'), 'utf8');
}

export function buildTag(opts: { object: string; type: string; tag: string; tagger: string; message: string }): Buffer {
  const lines = [`object ${opts.object}`, `type ${opts.type}`, `tag ${opts.tag}`, `tagger ${opts.tagger}`, '', opts.message.endsWith('\n') ? opts.message : `${opts.message}\n`];
  return Buffer.from(lines.join('\n'), 'utf8');
}

// ---------------------------------------------------------------- reachability

export type ObjectLookup = (oid: string) => GitObject | undefined;

/** All oids reachable from `tips` (commits, tags, trees, blobs). Depth limits commit generations. */
export function collectReachable(
  tips: Iterable<string>,
  lookup: ObjectLookup,
  opts: { depth?: number } = {},
): Set<string> {
  const seen = new Set<string>();
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const tip of tips) queue.push({ oid: tip, depth: 0 });
  while (queue.length > 0) {
    const { oid, depth } = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = lookup(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      if (opts.depth !== undefined && depth >= opts.depth) continue;
      const c = parseCommit(obj.data);
      queue.push({ oid: c.tree, depth: depth + 1 });
      for (const p of c.parents) queue.push({ oid: p, depth: depth + 1 });
    } else if (obj.type === 'tag') {
      const t = parseTag(obj.data);
      queue.push({ oid: t.object, depth: depth + 1 });
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) queue.push({ oid: e.oid, depth: depth + 1 });
    }
  }
  return seen;
}

/** True when `ancestor` is reachable from `tip` (or equal to it) through commit parents. */
export function isAncestor(ancestor: string, tip: string, lookup: ObjectLookup): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = lookup(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) {
      if (p === ancestor) return true;
      stack.push(p);
    }
  }
  return false;
}

/** Peel an annotated tag (following tag objects) to the commit it names. */
export function peelToCommit(oid: string, lookup: ObjectLookup): string {
  let cur = oid;
  for (let i = 0; i < 16; i += 1) {
    const obj = lookup(cur);
    if (!obj) return cur;
    if (obj.type === 'tag') { cur = parseTag(obj.data).object; continue; }
    return cur;
  }
  return cur;
}

// ---------------------------------------------------------------- packfiles

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile v2 from plain objects (no deltas). */
export function writePack(objects: Iterable<{ type: GitObjectType; data: Uint8Array }>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    const data = Buffer.from(object.data);
    parts.push(writePackObjectHeader(object.type, data.length));
    parts.push(deflateSync(data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarint(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let size = buffer[start]! & 0x0f;
  let shift = 4;
  let pos = start;
  let first = buffer[start]!;
  while ((buffer[pos]! & 0x80) !== 0) {
    pos += 1;
    size |= (buffer[pos]! & 0x7f) << shift;
    shift += 7;
  }
  return { size, next: pos + 1, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let pos = start;
  let byte = buffer[pos]!;
  let baseOffset = byte & 0x7f;
  while ((byte & 0x80) !== 0) {
    pos += 1;
    byte = buffer[pos]!;
    baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
  }
  return { baseOffset: baseOffset, next: pos + 1 };
}

function inflateAt(buffer: Buffer, offset: number, expectedSize = 0): { data: Buffer; next: number } {
  // inflateSync cannot tell us the consumed length, and it happily succeeds
  // on a window that overshoots the stream (ignoring trailing bytes), which
  // would misplace every following object. So find the *smallest* end that
  // inflates: a truncated zlib stream always throws, so the minimal success
  // is exactly the stream end. Grow the window, then binary-search it down.
  let lo = offset;
  let hi = Math.min(buffer.length, offset + Math.max(16, expectedSize));
  for (;;) {
    try {
      inflateSync(buffer.subarray(offset, hi));
      break;
    } catch {
      if (hi >= buffer.length) throw new Error('pack: cannot inflate object');
      lo = hi;
      hi = Math.min(buffer.length, hi * 2 + 16);
    }
  }
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(buffer.subarray(offset, mid));
      hi = mid;
    } catch {
      lo = mid;
    }
  }
  return { data: inflateSync(buffer.subarray(offset, hi)), next: hi };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readDeltaVarint = (): number => {
    let out = 0;
    let shift = 0;
    for (;;) {
      const b = delta[pos]!;
      pos += 1;
      out |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) break;
    }
    return out;
  };
  const sourceSize = readDeltaVarint();
  const targetSize = readDeltaVarint();
  if (sourceSize !== base.length) throw new Error('pack: delta base size mismatch');
  const out: Buffer[] = [];
  let total = 0;
  while (pos < delta.length) {
    const op = delta[pos]!;
    pos += 1;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) if ((op & (1 << i)) !== 0) { offset |= delta[pos]! << (8 * i); pos += 1; }
      for (let i = 0; i < 3; i += 1) if ((op & (0x10 << i)) !== 0) { size |= delta[pos]! << (8 * i); pos += 1; }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      total += size;
    } else if (op !== 0) {
      out.push(delta.subarray(pos, pos + op));
      pos += op;
      total += op;
    } else {
      throw new Error('pack: delta opcode 0');
    }
  }
  const result = Buffer.concat(out, total);
  if (result.length !== targetSize) throw new Error('pack: delta target size mismatch');
  return result;
}

export interface PackReadResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/** Parse a packfile (plain, ofs-delta and ref-delta entries) into objects keyed by recomputed oid. */
export function readPack(pack: Buffer, opts: { resolveBase?: (oid: string) => GitObject | undefined } = {}): PackReadResult {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack: bad header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack: version ${version}`);
  const count = pack.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let deltaCount = 0;
  let pos = 12;
  const entries: Array<{ offset: number; type: number; data: Buffer; baseOffset?: number; baseOid?: string }> = [];
  for (let i = 0; i < count; i += 1) {
    const offset = pos;
    const { size, next, first } = readVarint(pack, pos);
    const typeCode = (first >> 4) & 0x7;
    pos = next;
    if (typeCode === 6) {
      const { baseOffset, next: afterBase } = readOfsDeltaBase(pack, pos);
      pos = afterBase;
      const { data, next: afterData } = inflateAt(pack, pos, size);
      pos = afterData;
      entries.push({ offset, type: typeCode, data, baseOffset: offset - baseOffset });
      deltaCount += 1;
      void size;
    } else if (typeCode === 7) {
      const baseOid = pack.subarray(pos, pos + 20).toString('hex');
      pos += 20;
      const { data, next: afterData } = inflateAt(pack, pos, size);
      pos = afterData;
      entries.push({ offset, type: typeCode, data, baseOid });
      deltaCount += 1;
      void size;
    } else {
      const type = CODE_TYPE[typeCode];
      if (!type) throw new Error(`pack: unknown type ${typeCode}`);
      const { data, next: afterData } = inflateAt(pack, pos, size);
      pos = afterData;
      if (data.length !== size) throw new Error('pack: object size mismatch');
      const obj: GitObject = { type, data };
      const oid = hashObject(type, data);
      objects.set(oid, obj);
      byOffset.set(offset, obj);
    }
  }
  // Resolve deltas (possibly chained): iterate until all resolve.
  const unresolved = [...entries.filter((e) => e.type === 6 || e.type === 7)];
  let progress = true;
  while (unresolved.length > 0 && progress) {
    progress = false;
    for (let i = unresolved.length - 1; i >= 0; i -= 1) {
      const e = unresolved[i]!;
      let base: GitObject | undefined;
      if (e.type === 6) base = byOffset.get(e.baseOffset!);
      else base = objects.get(e.baseOid!) ?? opts.resolveBase?.(e.baseOid!);
      if (!base) continue;
      const data = applyDelta(base.data, e.data);
      const obj: GitObject = { type: base.type, data };
      const oid = hashObject(base.type, data);
      objects.set(oid, obj);
      byOffset.set(e.offset, obj);
      unresolved.splice(i, 1);
      progress = true;
    }
  }
  if (unresolved.length > 0) throw new Error('pack: unresolvable delta');
  return { objects, deltaCount };
}

export function verifyPackChecksum(pack: Buffer): boolean {
  if (pack.length < 20) return false;
  const actual = pack.subarray(pack.length - 20).toString('hex');
  const expected = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  return actual === expected;
}

/** A short request id (deterministic counter is kept by the caller; this is a fallback). */
export function newRequestId(): string {
  return `req-${randomUUID().slice(0, 8)}`;
}
