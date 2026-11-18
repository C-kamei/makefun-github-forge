// rest.ts — REST v3 handlers for the forge. All responses are JSON with an
// X-GitHub-Request-Id header; errors are {"message": ...} with GitHub-like codes.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseCommit } from './git.ts';
import { VIEWER_ID, VIEWER_LOGIN, VIEWER_EMAIL, stamp as baseStamp, type Issue, type Label, type PullRequest, type Repo, type Store } from './store.ts';

export interface Ctx {
  store: Store;
  reqId: () => string;
  baseUrl: (req: IncomingMessage) => string;
}

export function userObject(): Record<string, unknown> {
  return {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    node_id: Buffer.from(`User:${VIEWER_ID}`, 'utf8').toString('base64url'),
    avatar_url: '',
    gravatar_id: '',
    url: `/api/v3/users/${VIEWER_LOGIN}`,
    html_url: `https://example.invalid/${VIEWER_LOGIN}`,
    followers_url: `/api/v3/users/${VIEWER_LOGIN}/followers`,
    following_url: `/api/v3/users/${VIEWER_LOGIN}/following{/other_user}`,
    type: 'User',
    site_admin: false,
    name: VIEWER_LOGIN,
    email: VIEWER_EMAIL,
    public_repos: 0,
    followers: 0,
    following: 0,
    created_at: '2026-11-14T06:30:00Z',
    updated_at: '2026-11-14T06:30:00Z',
  };
}

export function repoObject(ctx: Ctx, req: IncomingMessage, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repo.nodeId,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: VIEWER_LOGIN, id: VIEWER_ID, node_id: userObject().node_id, avatar_url: '', gravatar_id: '', url: `/api/v3/users/${VIEWER_LOGIN}`, html_url: `https://example.invalid/${VIEWER_LOGIN}`, type: 'User', site_admin: false },
    private: repo.isPrivate,
    html_url: `https://example.invalid/${repo.fullName}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.fullName}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    topics: [],
  };
}

export function labelObject(label: Label): Record<string, unknown> {
  return { id: label.id, node_id: Buffer.from(`Label:${label.id}`, 'utf8').toString('base64url'), url: '', name: label.name, color: label.color, description: label.description, default: false };
}

export function issueObject(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issue.nodeId,
    url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.fullName}`,
    html_url: `https://example.invalid/${repo.fullName}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User', avatar_url: '', html_url: `https://example.invalid/${VIEWER_LOGIN}` },
    labels: issue.labels.map(labelObject),
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
  };
}

export function commentObject(repo: Repo, issue: Issue, comment: { id: number; nodeId: string; body: string; createdAt: string; updatedAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: comment.nodeId,
    url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}/comments/${comment.id}`,
    html_url: `https://example.invalid/${repo.fullName}/issues/${issue.number}#issuecomment-${comment.id}`,
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User', avatar_url: '', html_url: `https://example.invalid/${VIEWER_LOGIN}` },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    author_association: 'OWNER',
  };
}

export function pullObject(ctx: Ctx, req: IncomingMessage, repo: Repo, pr: PullRequest): Record<string, unknown> {
  const headRepo = repoObject(ctx, req, repo);
  const user = { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User', avatar_url: '', html_url: `https://example.invalid/${VIEWER_LOGIN}` };
  return {
    id: pr.id,
    node_id: pr.nodeId,
    url: `/api/v3/repos/${repo.fullName}/pulls/${pr.number}`,
    html_url: `https://example.invalid/${repo.fullName}/pull/${pr.number}`,
    number: pr.number,
    state: pr.state,
    locked: false,
    title: pr.title,
    body: pr.body,
    user,
    labels: [],
    milestone: null,
    active_lock_reason: null,
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    closed_at: pr.state === 'closed' ? pr.updatedAt : null,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    requested_teams: [],
    draft: false,
    merged: pr.merged,
    mergeable: !repo.mergeConflicts(pr),
    mergeable_state: repo.mergeConflicts(pr) ? 'dirty' : 'clean',
    rebaseable: true,
    head: { label: `${VIEWER_LOGIN}:${pr.headRef}`, ref: pr.headRef, sha: pr.headSha, user, repo: headRepo },
    base: { label: `${VIEWER_LOGIN}:${pr.baseRef}`, ref: pr.baseRef, sha: pr.baseSha, user, repo: headRepo },
    _links: { self: { href: `/api/v3/repos/${repo.fullName}/pulls/${pr.number}` }, html: { href: `https://example.invalid/${repo.fullName}/pull/${pr.number}` } },
    author_association: 'OWNER',
    auto_merge: null,
  };
}

// --- helpers ----------------------------------------------------------------

export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 64 * 1024 * 1024) { req.destroy(); reject(new Error('body too large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function parseJsonBody(buf: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (buf.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(buf.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

export function sendJson(res: ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}): void {
  const body = status === 204 ? '' : JSON.stringify(value);
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extra };
  res.writeHead(status, headers);
  res.end(body);
}

export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function pagination(req: IncomingMessage): { page: number; perPage: number } {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

function paginate<T>(items: readonly T[], page: number, perPage: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

function linkHeader(ctx: Ctx, req: IncomingMessage, total: number, page: number, perPage: number): string {
  const base = ctx.baseUrl(req);
  const url = new URL(req.url ?? '/', base);
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const link = (p: number, rel: string): string => {
    url.searchParams.set('page', String(p));
    url.searchParams.set('per_page', String(perPage));
    return `<${url.toString()}>; rel="${rel}"`;
  };
  const parts: string[] = [];
  if (page < lastPage) parts.push(link(page + 1, 'next'), link(lastPage, 'last'));
  if (page > 1) parts.push(link(page - 1, 'prev'), link(1, 'first'));
  return parts.join(', ');
}

function branchNameFromRef(ref: string): string {
  // Accept "feature-a" or "owner:feature-a".
  const idx = ref.indexOf(':');
  return idx >= 0 ? ref.slice(idx + 1) : ref;
}

function commitList(repo: Repo, branch: string): Array<Record<string, unknown>> {
  const tip = repo.branchTip(branch);
  const out: Array<Record<string, unknown>> = [];
  if (!tip) return out;
  const seen = new Set<string>();
  let cur: string | undefined = tip;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'commit') break;
    const c = parseCommit(obj.data);
    const ident = (line: string): { name: string; email: string; date: string } => {
      const m = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line);
      if (!m) return { name: VIEWER_LOGIN, email: VIEWER_EMAIL, date: '2026-11-14T06:30:00Z' };
      return { name: m[1]!, email: m[2]!, date: new Date(Number(m[3]) * 1000).toISOString().replace('.000Z', 'Z') };
    };
    const author = ident(c.author);
    const committer = ident(c.committer);
    // GitHub returns the commit message without its trailing newline.
    const message = c.message.endsWith('\n') ? c.message.slice(0, -1) : c.message;
    out.push({
      sha: cur,
      node_id: Buffer.from(`Commit:${cur}`, 'utf8').toString('base64url'),
      commit: {
        author,
        committer,
        message,
        tree: { sha: c.tree, url: `/api/v3/repos/${repo.fullName}/git/trees/${c.tree}` },
        url: `/api/v3/repos/${repo.fullName}/git/commits/${cur}`,
        comment_count: 0,
      },
      url: `/api/v3/repos/${repo.fullName}/commits/${cur}`,
      html_url: `https://example.invalid/${repo.fullName}/commit/${cur}`,
      author: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
      committer: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
      parents: c.parents.map((p) => ({ sha: p, url: `/api/v3/repos/${repo.fullName}/commits/${p}` })),
    });
    cur = c.parents[0];
  }
  return out;
}

// --- main REST dispatcher ----------------------------------------------------

export async function handleRest(ctx: Ctx, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = req.method ?? 'GET';
  const store = ctx.store;
  const reqId = ctx.reqId();

  const json = (status: number, value: unknown, extra: Record<string, string> = {}): boolean => {
    sendJson(res, status, value, { 'X-GitHub-Request-Id': reqId, ...extra });
    return true;
  };
  const err = (status: number, message: string): boolean => json(status, { message });
  const needAuth = (): boolean => {
    const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
    if (token === '') return true;
    const auth = req.headers.authorization ?? '';
    if (auth !== `Bearer ${token}`) { err(401, 'Bad credentials'); return false; }
    return true;
  };

  if (!path.startsWith('/api/v3')) return false;
  if (!needAuth()) return true;

  // Root and meta.
  if (path === '/api/v3/' || path === '/api/v3') {
    if (method !== 'GET') return err(404, 'Not Found');
    return json(200, { current_user_url: '/api/v3/user', repository_url: '/api/v3/repos/{owner}/{repo}' }, { 'X-OAuth-Scopes': 'repo, read:org' });
  }
  if (path === '/api/v3/meta') {
    return json(200, { verifiable_password_authentication: true, installed_version: '1.0.0', api: ['2022-11-28'] });
  }
  if (path === '/api/v3/user') {
    if (method !== 'GET') return err(404, 'Not Found');
    return json(200, userObject());
  }

  // POST /user/repos
  if (path === '/api/v3/user/repos') {
    if (method === 'POST') {
      const body = await readBody(req);
      const parsed = parseJsonBody(body);
      if (!parsed.ok) return err(400, 'Problems parsing JSON');
      const b = (parsed.value ?? {}) as Record<string, unknown>;
      const name = typeof b.name === 'string' ? b.name : '';
      if (name === '') return err(422, 'Validation Failed: name is required');
      const existing = store.getRepo(VIEWER_LOGIN, name);
      if (existing) return err(422, 'Repository creation failed. Name already exists on this account.');
      const repo = store.createRepo(name, typeof b.description === 'string' ? b.description : '', b.private === true);
      return json(201, repoObject(ctx, req, repo!));
    }
    if (method === 'GET') {
      const { page, perPage } = pagination(req);
      const all = store.listRepos();
      const link = linkHeader(ctx, req, all.length, page, perPage);
      return json(200, paginate(all, page, perPage).map((r) => repoObject(ctx, req, r)), link ? { Link: link } : {});
    }
    return err(404, 'Not Found');
  }

  // /repos/{owner}/{name}...
  const repoMatch = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(path);
  if (!repoMatch) return err(404, 'Not Found');
  const owner = decodeURIComponent(repoMatch[1]!);
  const repoName = decodeURIComponent(repoMatch[2]!);
  const rest = repoMatch[3] ?? '';
  const repo = store.getRepo(owner, repoName);
  if (!repo) return err(404, 'Not Found');

  // GET/PATCH/DELETE repo itself
  if (rest === '') {
    if (method === 'GET') return json(200, repoObject(ctx, req, repo));
    if (method === 'PATCH') {
      const body = await readBody(req);
      const parsed = parseJsonBody(body);
      if (!parsed.ok) return err(400, 'Problems parsing JSON');
      const b = (parsed.value ?? {}) as Record<string, unknown>;
      if (typeof b.description === 'string') repo.description = b.description;
      if (typeof b.private === 'boolean') repo.isPrivate = b.private;
      repo.updatedAt = baseStamp();
      return json(200, repoObject(ctx, req, repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo);
      res.writeHead(204, { 'X-GitHub-Request-Id': reqId });
      res.end();
      return true;
    }
    return err(404, 'Not Found');
  }

  // Branches
  if (rest === 'branches' && method === 'GET') {
    const list = [...repo.refs.keys()]
      .filter((r) => r.startsWith('refs/heads/'))
      .sort()
      .map((r) => ({ name: r.slice('refs/heads/'.length), commit: { sha: repo.refs.get(r), url: `/api/v3/repos/${repo.fullName}/commits/${repo.refs.get(r)}` }, protected: false }));
    return json(200, list);
  }
  const branchMatch = /^branches\/([^/]+)$/.exec(rest);
  if (branchMatch && method === 'GET') {
    const branch = decodeURIComponent(branchMatch[1]!);
    const tip = repo.branchTip(branch);
    if (!tip) return err(404, 'Branch not found');
    return json(200, { name: branch, commit: { sha: tip, url: `/api/v3/repos/${repo.fullName}/commits/${tip}` }, protected: false });
  }

  // git/refs
  if (rest === 'git/refs' && method === 'POST') {
    const body = await readBody(req);
    const parsed = parseJsonBody(body);
    if (!parsed.ok) return err(400, 'Problems parsing JSON');
    const b = (parsed.value ?? {}) as Record<string, unknown>;
    const ref = typeof b.ref === 'string' ? b.ref : '';
    const sha = typeof b.sha === 'string' ? b.sha : '';
    if (!ref.startsWith('refs/heads/') || !repo.objects.has(sha)) return err(422, 'Validation Failed: ref or sha is invalid');
    if (repo.refs.has(ref)) return err(422, 'Reference already exists');
    repo.refs.set(ref, sha);
    repo.bumpGeneration();
    return json(201, { ref, node_id: Buffer.from(`Ref:${ref}`, 'utf8').toString('base64url'), url: `/api/v3/repos/${repo.fullName}/git/refs/${ref}`, object: { sha, type: 'commit', url: `/api/v3/repos/${repo.fullName}/git/commits/${sha}` } });
  }
  const refMatch = /^git\/refs\/(.+)$/.exec(rest);
  if (refMatch && method === 'GET') {
    const ref = decodeURIComponent(refMatch[1]!);
    const full = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
    const oid = repo.refs.get(full);
    if (!oid) return err(404, 'Not Found');
    const obj = repo.objects.get(oid);
    return json(200, { ref: full, node_id: Buffer.from(`Ref:${full}`, 'utf8').toString('base64url'), url: `/api/v3/repos/${repo.fullName}/git/refs/${full}`, object: { sha: oid, type: obj?.type ?? 'commit', url: `/api/v3/repos/${repo.fullName}/git/commits/${oid}` } });
  }

  // Commits
  if (rest === 'commits' && method === 'GET') {
    const branch = url.searchParams.get('sha') ?? repo.defaultBranch;
    return json(200, commitList(repo, branch));
  }
  const commitMatch = /^commits\/([0-9a-f]{40})$/.exec(rest);
  if (commitMatch && method === 'GET') {
    const list = commitList(repo, repo.defaultBranch);
    const found = list.find((c) => c.sha === commitMatch[1]);
    if (!found) {
      // Search all branches.
      const all = new Set<string>();
      for (const r of repo.refs.keys()) {
        if (!r.startsWith('refs/heads/')) continue;
        for (const c of commitList(repo, r.slice('refs/heads/'.length))) all.add(c.sha as string);
      }
      if (!all.has(commitMatch[1]!)) return err(404, 'Not Found');
      return json(200, commitList(repo, repo.defaultBranch).find((c) => c.sha === commitMatch[1]) ?? {});
    }
    return json(200, found);
  }

  // Contents
  if (rest.startsWith('contents/')) {
    const rawPath = decodeURIComponent(rest.slice('contents/'.length));
    const refParam = url.searchParams.get('ref');
    const baseCommit = refParam ? repo.resolveRef(refParam) : (repo.branchTip(repo.defaultBranch) ?? null);
    if (method === 'GET') {
      if (!baseCommit) return err(404, 'Not Found');
      const files = repo.fileMap(baseCommit);
      const file = files.get(rawPath);
      if (file) {
        const obj = repo.objects.get(file.oid);
        const content = obj ? obj.data.toString('base64') : '';
        return json(200, { type: 'file', encoding: 'base64', size: obj?.data.length ?? 0, name: rawPath.split('/').pop(), path: rawPath, content, sha: file.oid, url: `/api/v3/repos/${repo.fullName}/contents/${rawPath}`, git_url: null, html_url: null, download_url: null, _links: { self: `/api/v3/repos/${repo.fullName}/contents/${rawPath}`, git: null, html: null } });
      }
      // Directory listing: immediate children of rawPath.
      const prefix = rawPath === '' ? '' : `${rawPath}/`;
      const children = new Map<string, { type: 'dir' | 'file'; sha: string; size: number }>();
      for (const [p, f] of files) {
        if (!p.startsWith(prefix)) continue;
        const restPath = p.slice(prefix.length);
        const slash = restPath.indexOf('/');
        if (slash < 0) {
          const obj = repo.objects.get(f.oid);
          children.set(restPath, { type: 'file', sha: f.oid, size: obj?.data.length ?? 0 });
        } else {
          const dir = restPath.slice(0, slash);
          if (!children.has(dir)) children.set(dir, { type: 'dir', sha: '', size: 0 });
        }
      }
      if (children.size === 0) return err(404, 'Not Found');
      const list = [...children.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([name, c]) => ({
        type: c.type, size: c.size, name, path: `${prefix}${name}`, sha: c.sha,
        url: `/api/v3/repos/${repo.fullName}/contents/${prefix}${name}`, git_url: null, html_url: null, download_url: null,
        _links: { self: `/api/v3/repos/${repo.fullName}/contents/${prefix}${name}`, git: null, html: null },
      }));
      return json(200, list);
    }
    if (method === 'PUT') {
      const body = await readBody(req);
      const parsed = parseJsonBody(body);
      if (!parsed.ok) return err(400, 'Problems parsing JSON');
      const b = (parsed.value ?? {}) as Record<string, unknown>;
      const message = typeof b.message === 'string' ? b.message : 'Update file';
      const contentB64 = typeof b.content === 'string' ? b.content : '';
      const branch = typeof b.branch === 'string' ? b.branch : repo.defaultBranch;
      const shaParam = typeof b.sha === 'string' ? b.sha : undefined;
      let tip = repo.branchTip(branch);
      if (!tip) tip = repo.branchTip(repo.defaultBranch) ?? null;
      const files = repo.fileMap(tip);
      const existing = files.get(rawPath);
      if (existing && shaParam && shaParam !== existing.oid) return err(409, 'Conflict: sha does not match the current file');
      const blobData = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
      const blobOid = repo.storeObject('blob', blobData);
      files.set(rawPath, { oid: blobOid, mode: '100644' });
      const commitSha = repo.commitOnBranch({ branch, files, message });
      const status = existing ? 200 : 201;
      return json(status, {
        content: { name: rawPath.split('/').pop(), path: rawPath, sha: blobOid, size: blobData.length, url: `/api/v3/repos/${repo.fullName}/contents/${rawPath}`, git_url: null, html_url: null, download_url: null, type: 'file', encoding: 'base64' },
        commit: { sha: commitSha, message, author: { name: VIEWER_LOGIN, email: VIEWER_EMAIL, date: '2026-11-14T06:30:00Z' }, committer: { name: VIEWER_LOGIN, email: VIEWER_EMAIL, date: '2026-11-14T06:30:00Z' }, tree: { sha: '', url: '' }, parents: [], url: `/api/v3/repos/${repo.fullName}/git/commits/${commitSha}`, html_url: `https://example.invalid/${repo.fullName}/commit/${commitSha}` },
      });
    }
    if (method === 'DELETE') {
      const body = await readBody(req);
      const parsed = parseJsonBody(body);
      if (!parsed.ok) return err(400, 'Problems parsing JSON');
      const b = (parsed.value ?? {}) as Record<string, unknown>;
      const message = typeof b.message === 'string' ? b.message : 'Delete file';
      const shaParam = typeof b.sha === 'string' ? b.sha : '';
      const branch = typeof b.branch === 'string' ? b.branch : repo.defaultBranch;
      const tip = repo.branchTip(branch);
      if (!tip) return err(404, 'Not Found');
      const files = repo.fileMap(tip);
      const existing = files.get(rawPath);
      if (!existing) return err(404, 'Not Found');
      if (shaParam !== '' && shaParam !== existing.oid) return err(409, 'Conflict: sha does not match the current file');
      files.delete(rawPath);
      const commitSha = repo.commitOnBranch({ branch, files, message });
      return json(200, { commit: { sha: commitSha, message, url: `/api/v3/repos/${repo.fullName}/git/commits/${commitSha}` } });
    }
    return err(404, 'Not Found');
  }

  // Labels
  if (rest === 'labels') {
    if (method === 'GET') return json(200, [...repo.labels.values()].map(labelObject));
    if (method === 'POST') {
      const body = await readBody(req);
      const parsed = parseJsonBody(body);
      if (!parsed.ok) return err(400, 'Problems parsing JSON');
      const b = (parsed.value ?? {}) as Record<string, unknown>;
      const name = typeof b.name === 'string' ? b.name : '';
      if (name === '') return err(422, 'Validation Failed: name is required');
      if (repo.labels.has(name)) return err(422, 'Validation Failed: label already exists');
      const label: Label = { id: ctx.store.nextLabelId, name, color: typeof b.color === 'string' ? b.color.replace(/^#/, '') : 'ededed', description: typeof b.description === 'string' ? b.description : '' };
      ctx.store.nextLabelId += 1;
      repo.labels.set(name, label);
      return json(201, labelObject(label));
    }
    return err(404, 'Not Found');
  }

  // Issues
  if (rest === 'issues') {
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const sort = url.searchParams.get('sort') ?? 'created';
      const direction = url.searchParams.get('direction') ?? 'desc';
      let list = repo.issues.filter((i) => state === 'all' || i.state === state);
      list = [...list].sort((a, b) => {
        const byNumber = a.number - b.number;
        const cmp = sort === 'created' ? (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : byNumber) : byNumber;
        return direction === 'asc' ? cmp : -cmp;
      });
      const { page, perPage } = pagination(req);
      const link = linkHeader(ctx, req, list.length, page, perPage);
      return json(200, paginate(list, page, perPage).map((i) => issueObject(repo, i)), link ? { Link: link } : {});
    }
    if (method === 'POST') {
      const body = await readBody(req);
      const parsed = parseJsonBody(body);
      if (!parsed.ok) return err(400, 'Problems parsing JSON');
      const b = (parsed.value ?? {}) as Record<string, unknown>;
      const title = typeof b.title === 'string' ? b.title : '';
      if (title === '') return err(422, 'Validation Failed: title is required');
      const labelNames = Array.isArray(b.labels) ? b.labels.filter((x): x is string => typeof x === 'string') : [];
      const labels: Label[] = [];
      for (const name of labelNames) {
        const label = repo.labels.get(name);
        if (!label) return err(422, `Validation Failed: label "${name}" does not exist`);
        labels.push(label);
      }
      const number = repo.nextIssueNumber;
      repo.nextIssueNumber += 1;
      const id = ctx.store.nextIssueId;
      ctx.store.nextIssueId += 1;
      const issue: Issue = {
        id,
        nodeId: Buffer.from(`Issue:${repo.id}:${number}`, 'utf8').toString('base64url'),
        number,
        title,
        body: typeof b.body === 'string' ? b.body : '',
        state: 'open',
        labels,
        createdAt: stampFor(repo, number),
        updatedAt: stampFor(repo, number),
        closedAt: null,
        comments: [],
      };
      repo.issues.push(issue);
      return json(201, issueObject(repo, issue));
    }
    return err(404, 'Not Found');
  }
  const issueMatch = /^issues\/(\d+)(?:\/(comments))?$/.exec(rest);
  if (issueMatch) {
    const number = Number(issueMatch[1]);
    const issue = repo.issues.find((i) => i.number === number);
    if (!issue) return err(404, 'Not Found');
    const sub = issueMatch[2];
    if (sub === 'comments') {
      if (method === 'GET') return json(200, issue.comments.map((c) => commentObject(repo, issue, c)));
      if (method === 'POST') {
        const body = await readBody(req);
        const parsed = parseJsonBody(body);
        if (!parsed.ok) return err(400, 'Problems parsing JSON');
        const b = (parsed.value ?? {}) as Record<string, unknown>;
        const text = typeof b.body === 'string' ? b.body : '';
        if (text === '') return err(422, 'Validation Failed: body is required');
        const id = ctx.store.nextCommentId;
        ctx.store.nextCommentId += 1;
        const comment = { id, nodeId: Buffer.from(`IssueComment:${repo.id}:${number}:${id}`, 'utf8').toString('base64url'), body: text, createdAt: stampFor(repo, number), updatedAt: stampFor(repo, number) };
        issue.comments.push(comment);
        return json(201, commentObject(repo, issue, comment));
      }
      return err(404, 'Not Found');
    }
    if (method === 'GET') return json(200, issueObject(repo, issue));
    if (method === 'PATCH') {
      const body = await readBody(req);
      const parsed = parseJsonBody(body);
      if (!parsed.ok) return err(400, 'Problems parsing JSON');
      const b = (parsed.value ?? {}) as Record<string, unknown>;
      if (typeof b.title === 'string') issue.title = b.title;
      if (typeof b.body === 'string') issue.body = b.body;
      if (b.state === 'open' || b.state === 'closed') {
        issue.state = b.state;
        issue.closedAt = b.state === 'closed' ? stampFor(repo, number) : null;
      }
      issue.updatedAt = stampFor(repo, number);
      return json(200, issueObject(repo, issue));
    }
    return err(404, 'Not Found');
  }

  // Pulls
  if (rest === 'pulls') {
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const list = repo.pulls.filter((p) => state === 'all' || p.state === state);
      const { page, perPage } = pagination(req);
      return json(200, paginate(list, page, perPage).map((p) => pullObject(ctx, req, repo, p)));
    }
    if (method === 'POST') {
      const body = await readBody(req);
      const parsed = parseJsonBody(body);
      if (!parsed.ok) return err(400, 'Problems parsing JSON');
      const b = (parsed.value ?? {}) as Record<string, unknown>;
      const title = typeof b.title === 'string' ? b.title : '';
      const head = branchNameFromRef(typeof b.head === 'string' ? b.head : '');
      const base = branchNameFromRef(typeof b.base === 'string' ? b.base : '');
      if (title === '' || head === '' || base === '') return err(422, 'Validation Failed: title, head and base are required');
      const headSha = repo.branchTip(head);
      const baseSha = repo.branchTip(base);
      if (!headSha || !baseSha) return err(422, 'Validation Failed: head or base branch does not exist');
      const dup = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
      if (dup) return err(422, 'Validation Failed: a pull request already exists for this head branch');
      const number = repo.nextPullNumber;
      repo.nextPullNumber += 1;
      const id = ctx.store.nextPullId;
      ctx.store.nextPullId += 1;
      const files = repo.diffFiles(repo.fileMap(baseSha), repo.fileMap(headSha));
      const pr: PullRequest = {
        id,
        nodeId: Buffer.from(`PullRequest:${repo.id}:${number}`, 'utf8').toString('base64url'),
        number,
        title,
        body: typeof b.body === 'string' ? b.body : '',
        state: 'open',
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        createdAt: stampFor(repo, number),
        updatedAt: stampFor(repo, number),
        files,
      };
      repo.pulls.push(pr);
      return json(201, pullObject(ctx, req, repo, pr));
    }
    return err(404, 'Not Found');
  }
  const pullMatch = /^pulls\/(\d+)(?:\/(files|merge))?$/.exec(rest);
  if (pullMatch) {
    const number = Number(pullMatch[1]);
    const pr = repo.pulls.find((p) => p.number === number);
    if (!pr) return err(404, 'Not Found');
    const sub = pullMatch[2];
    if (sub === 'files' && method === 'GET') {
      return json(200, pr.files.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.changes, blob_url: '', raw_url: '', contents_url: '' })));
    }
    if (sub === 'merge') {
      if (method === 'GET') {
        if (pr.merged) { res.writeHead(204, { 'X-GitHub-Request-Id': reqId }); res.end(); return true; }
        return err(404, 'Not Found');
      }
      if (method === 'PUT') {
        if (pr.merged) return err(405, 'Pull Request is already merged');
        if (pr.state !== 'open') return err(405, 'Pull Request is not open');
        if (repo.mergeConflicts(pr)) return err(405, 'Merge conflict: this pull request cannot be merged');
        const sha = repo.squashMerge(pr);
        if (!sha) return err(405, 'Merge conflict: this pull request cannot be merged');
        return json(200, { sha, merged: true, message: `Pull Request successfully merged` });
      }
      return err(404, 'Not Found');
    }
    if (method === 'GET') return json(200, pullObject(ctx, req, repo, pr));
    if (method === 'PATCH') {
      const body = await readBody(req);
      const parsed = parseJsonBody(body);
      if (!parsed.ok) return err(400, 'Problems parsing JSON');
      const b = (parsed.value ?? {}) as Record<string, unknown>;
      if (typeof b.title === 'string') pr.title = b.title;
      if (typeof b.body === 'string') pr.body = b.body;
      if (b.state === 'open' || b.state === 'closed') pr.state = b.state;
      pr.updatedAt = stampFor(repo, number);
      return json(200, pullObject(ctx, req, repo, pr));
    }
    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}

// Deterministic timestamp: fixed base plus a sequence offset, not wall clock.
function stampFor(_repo: Repo, _n: number): string {
  return baseStamp();
}
