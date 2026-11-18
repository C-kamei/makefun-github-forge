// store.ts — the forge's in-memory store: repositories, git objects, issues, pull requests.
// All state lives in Maps; every id/number is a deterministic counter (no wall clock, so two
// runs that receive the same requests in the same order leave identical state).

import { createHash } from 'node:crypto';
import {
  ZERO_OID,
  buildCommit,
  buildTag,
  buildTree,
  collectReachable,
  hashObject,
  isAncestor,
  makeObject,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './git.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const DEFAULT_BRANCH = 'main';

// The trial's fixed "now" for created_at fields: deterministic across live and replay runs.
const TRIAL_NOW = process.env.MAKEFUN_TRIAL_NOW ?? '2026-11-14T06:30:00Z';
const EPOCH_SEC = 1735689600; // 2025-01-01T00:00:00Z, the fixed timestamp of server-made commits.

let seq = 0;
export function stamp(): string {
  seq += 1;
  const d = new Date((EPOCH_SEC + seq) * 1000);
  return d.toISOString().replace('.000Z', 'Z');
}

export function globalId(kind: string, ...parts: Array<string | number>): string {
  const raw = `${kind}:${parts.join(':')}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const raw = Buffer.from(id, 'base64url').toString('utf8');
    const [kind, ...parts] = raw.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  id: number;
  nodeId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: Comment[];
}

export interface Comment {
  id: number;
  nodeId: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

export interface PullRequest {
  id: number;
  nodeId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
  files: PullFile[];
}

export class Repo {
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch = DEFAULT_BRANCH;
  id: number;
  nodeId: string;
  createdAt: string;
  updatedAt: string;
  objects = new Map<string, GitObject>();
  refs = new Map<string, string>();
  issues: Issue[] = [];
  labels = new Map<string, Label>();
  pulls: PullRequest[] = [];
  nextIssueNumber = 1;
  nextPullNumber = 1;
  /** Bumped on every mutation; fetch-pack caches key on it so a stale pack can never be served. */
  generation = 0;

  constructor(name: string, owner: string, description: string, isPrivate: boolean, id: number) {
    this.name = name;
    this.owner = owner;
    this.description = description;
    this.isPrivate = isPrivate;
    this.id = id;
    this.nodeId = globalId('Repository', id);
    this.createdAt = stamp();
    this.updatedAt = this.createdAt;
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  refTip(ref: string): string | undefined {
    return this.refs.get(ref);
  }

  branchTip(branch: string): string | undefined {
    return this.refs.get(`refs/heads/${branch}`);
  }

  lookup = (oid: string): GitObject | undefined => this.objects.get(oid);

  storeObject(type: GitObjectType, data: Buffer): string {
    const { oid, object } = makeObject(type, data);
    this.objects.set(oid, object);
    return oid;
  }

  bumpGeneration(): void {
    this.generation += 1;
  }

  /** The commit a ref (branch name or sha) resolves to, or null. */
  resolveRef(ref: string): string | null {
    if (/^[0-9a-f]{40}$/.test(ref)) return this.objects.has(ref) ? ref : null;
    const tip = this.branchTip(ref) ?? this.refs.get(ref);
    if (!tip) return null;
    return peelToCommit(tip, this.lookup);
  }

  /** Flatten the tree at `commitOid` into path -> {oid, mode}. */
  fileMap(commitOid: string | null): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    if (!commitOid) return out;
    const obj = this.objects.get(commitOid);
    if (!obj || obj.type !== 'commit') return out;
    const walk = (treeOid: string, prefix: string): void => {
      const tree = this.objects.get(treeOid);
      if (!tree || tree.type !== 'tree') return;
      for (const e of parseTree(tree.data)) {
        const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
        if (e.mode === '40000') walk(e.oid, path);
        else out.set(path, { oid: e.oid, mode: e.mode });
      }
    };
    walk(parseCommit(obj.data).tree, '');
    return out;
  }

  /** Build nested trees from a file map; returns the root tree oid. */
  buildTrees(files: Map<string, { oid: string; mode: string }>): string {
    const buildDir = (prefix: string): string => {
      const entries: TreeEntry[] = [];
      const subdirs = new Map<string, Map<string, { oid: string; mode: string }>>();
      for (const [path, file] of files) {
        if (prefix !== '' && !path.startsWith(`${prefix}/`)) continue;
        const rest = prefix === '' ? path : path.slice(prefix.length + 1);
        const slash = rest.indexOf('/');
        if (slash < 0) {
          entries.push({ mode: file.mode, name: rest, oid: file.oid });
        } else {
          const dir = rest.slice(0, slash);
          let sub = subdirs.get(dir);
          if (!sub) { sub = new Map(); subdirs.set(dir, sub); }
          sub.set(path, file);
        }
      }
      for (const [dir, sub] of [...subdirs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        const subPrefix = prefix === '' ? dir : `${prefix}/${dir}`;
        entries.push({ mode: '40000', name: dir, oid: buildDir(subPrefix) });
      }
      return this.storeObject('tree', buildTree(entries));
    };
    return buildDir('');
  }

  /** Create a commit on `branch` (creating the branch from the default tip when missing). */
  commitOnBranch(opts: { branch: string; files: Map<string, { oid: string; mode: string }>; message: string }): string {
    const treeOid = this.buildTrees(opts.files);
    const parent = this.branchTip(opts.branch);
    const parents = parent ? [parent] : [];
    const ident = `${VIEWER_LOGIN} <${VIEWER_EMAIL}> ${EPOCH_SEC} +0000`;
    const data = buildCommit({ tree: treeOid, parents, author: ident, committer: ident, message: opts.message });
    const oid = this.storeObject('commit', data);
    this.refs.set(`refs/heads/${opts.branch}`, oid);
    this.bumpGeneration();
    return oid;
  }

  /** Diff two file maps: changed paths with line counts. */
  diffFiles(base: Map<string, { oid: string; mode: string }>, head: Map<string, { oid: string; mode: string }>): PullFile[] {
    const out: PullFile[] = [];
    const paths = new Set([...base.keys(), ...head.keys()]);
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b && h && b.oid === h.oid) continue;
      if (!b && h) {
        const lines = this.blobLines(h.oid);
        out.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines });
      } else if (b && !h) {
        const lines = this.blobLines(b.oid);
        out.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines });
      } else if (b && h) {
        const { additions, deletions } = this.lineDiff(b.oid, h.oid);
        out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return out;
  }

  blobLines(oid: string): number {
    const obj = this.objects.get(oid);
    if (!obj) return 0;
    const text = obj.data.toString('utf8');
    if (text === '') return 0;
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  }

  lineDiff(oldOid: string, newOid: string): { additions: number; deletions: number } {
    const oldObj = this.objects.get(oldOid);
    const newObj = this.objects.get(newOid);
    if (!oldObj || !newObj) return { additions: 1, deletions: 0 };
    const oldLines = oldObj.data.toString('utf8').split('\n');
    const newLines = newObj.data.toString('utf8').split('\n');
    const oldCount = new Map<string, number>();
    for (const l of oldLines) oldCount.set(l, (oldCount.get(l) ?? 0) + 1);
    let additions = 0;
    for (const l of newLines) {
      const c = oldCount.get(l) ?? 0;
      if (c > 0) oldCount.set(l, c - 1);
      else additions += 1;
    }
    let deletions = 0;
    for (const c of oldCount.values()) deletions += c;
    if (additions === 0 && deletions === 0) return { additions: 1, deletions: 0 };
    return { additions, deletions };
  }

  /** Whether merging `pr` would conflict with the current base tip. */
  mergeConflicts(pr: PullRequest): boolean {
    const baseTip = this.branchTip(pr.baseRef);
    if (!baseTip) return false;
    const baseMap = this.fileMap(baseTip);
    const prBaseMap = this.fileMap(pr.baseSha);
    const headMap = this.fileMap(pr.headSha);
    for (const file of pr.files) {
      const baseNow = baseMap.get(file.filename);
      const baseThen = prBaseMap.get(file.filename);
      const head = headMap.get(file.filename);
      if (file.status === 'removed') {
        if (baseNow && baseThen && baseNow.oid !== baseThen.oid) return true;
        continue;
      }
      if (!baseThen && baseNow) {
        // file added on head, but base added a different version meanwhile
        if (!head || baseNow.oid !== head.oid) return true;
        continue;
      }
      if (baseThen && baseNow && baseNow.oid !== baseThen.oid && head && head.oid !== baseThen.oid) return true;
      if (baseThen && !baseNow && head && head.oid !== baseThen.oid) return true;
    }
    return false;
  }

  /** Squash-merge `pr` onto its base branch; returns the merge commit oid, or null on conflict. */
  squashMerge(pr: PullRequest): string | null {
    if (pr.merged || pr.state !== 'open') return null;
    if (this.mergeConflicts(pr)) return null;
    const baseTip = this.branchTip(pr.baseRef);
    if (!baseTip) return null;
    const baseMap = this.fileMap(baseTip);
    const headMap = this.fileMap(pr.headSha);
    for (const file of pr.files) {
      if (file.status === 'removed') baseMap.delete(file.filename);
      else {
        const h = headMap.get(file.filename);
        if (h) baseMap.set(file.filename, h);
      }
    }
    const treeOid = this.buildTrees(baseMap);
    const ident = `${VIEWER_LOGIN} <${VIEWER_EMAIL}> ${EPOCH_SEC} +0000`;
    const message = `Merge pull request #${pr.number} from ${this.owner}/${pr.headRef}\n\n${pr.title}`;
    const data = buildCommit({ tree: treeOid, parents: [baseTip], author: ident, committer: ident, message });
    const oid = this.storeObject('commit', data);
    this.refs.set(`refs/heads/${pr.baseRef}`, oid);
    this.bumpGeneration();
    pr.state = 'closed';
    pr.merged = true;
    pr.mergedAt = stamp();
    pr.mergeCommitSha = oid;
    pr.updatedAt = pr.mergedAt;
    return oid;
  }

  /** The refs to advertise, sorted: HEAD first is not required; sorted by name is fine. */
  advertisedRefs(): Array<{ oid: string; name: string; peeled?: string }> {
    const out: Array<{ oid: string; name: string; peeled?: string }> = [];
    for (const name of [...this.refs.keys()].sort()) {
      const oid = this.refs.get(name)!;
      const entry: { oid: string; name: string; peeled?: string } = { oid, name };
      const obj = this.objects.get(oid);
      if (obj && obj.type === 'tag') entry.peeled = peelToCommit(oid, this.lookup);
      out.push(entry);
    }
    return out;
  }
}

export class Store {
  repos = new Map<string, Repo>(); // key: `${owner}/${name}`
  nextRepoId = 5000;
  nextIssueId = 1;
  nextCommentId = 1;
  nextPullId = 1;
  nextLabelId = 1;

  createRepo(name: string, description: string, isPrivate: boolean): Repo | null {
    const key = `${VIEWER_LOGIN}/${name}`;
    if (this.repos.has(key)) return null;
    const repo = new Repo(name, VIEWER_LOGIN, description, isPrivate, this.nextRepoId);
    this.nextRepoId += 1;
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | null {
    if (owner !== VIEWER_LOGIN) return null;
    return this.repos.get(`${owner}/${name}`) ?? null;
  }

  /** All repos of the viewer, in creation order. */
  listRepos(): Repo[] {
    return [...this.repos.values()];
  }

  findRepoById(id: number): Repo | null {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return null;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(repo.fullName);
  }
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function makeTagObject(repo: Repo, tagName: string, targetOid: string, message: string): string {
  const target = repo.objects.get(targetOid);
  const type = target ? target.type : 'commit';
  const ident = `${VIEWER_LOGIN} <${VIEWER_EMAIL}> ${EPOCH_SEC} +0000`;
  const data = buildTag({ object: targetOid, type, tag: tagName, tagger: ident, message });
  return repo.storeObject('tag', data);
}

export { ZERO_OID, collectReachable, isAncestor, parseCommit, parseTag, parseTree };
