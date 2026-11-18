// mcp.ts — Model Context Protocol over Streamable HTTP (JSON-RPC 2.0).
// Modern era: server/discover; legacy initialize is kept as a fallback.
// Tools share the REST store, so MCP and REST see the same objects and ids.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER_LOGIN, stamp, type Store } from './store.ts';
import { repoObject, issueObject, pullObject, readBody, parseJsonBody } from './rest.ts';

const SERVER_NAME = 'makefun-github-forge';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2026-07-28';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the viewer.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Repository name' }, description: { type: 'string', description: 'Repository description' }, private: { type: 'boolean', description: 'Whether the repository is private' }, owner: { type: 'string', description: 'Owner login (defaults to the viewer)' } }, required: ['name'] },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Owner login' }, repo: { type: 'string', description: 'Repository name' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Owner login' }, repo: { type: 'string', description: 'Repository name' }, title: { type: 'string', description: 'Issue title' }, body: { type: 'string', description: 'Issue body' } }, required: ['owner', 'repo', 'title'] },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Owner login' }, repo: { type: 'string', description: 'Repository name' }, state: { type: 'string', description: 'Issue state: open, closed or all' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'get_issue',
    description: 'Get a single issue by number.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Owner login' }, repo: { type: 'string', description: 'Repository name' }, issue_number: { type: 'integer', description: 'Issue number' } }, required: ['owner', 'repo', 'issue_number'] },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Owner login' }, repo: { type: 'string', description: 'Repository name' }, title: { type: 'string', description: 'Pull request title' }, head: { type: 'string', description: 'Head branch name' }, base: { type: 'string', description: 'Base branch name' }, body: { type: 'string', description: 'Pull request body' } }, required: ['owner', 'repo', 'title', 'head', 'base'] },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Owner login' }, repo: { type: 'string', description: 'Repository name' }, pull_number: { type: 'integer', description: 'Pull request number' } }, required: ['owner', 'repo', 'pull_number'] },
  },
];

function textResult(obj: unknown, isError = false): Record<string, unknown> {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
  const out: Record<string, unknown> = { content: [{ type: 'text', text }], structuredContent: typeof obj === 'object' && obj !== null ? obj : { result: obj } };
  if (isError) out.isError = true;
  return out;
}

function findTool(name: string): ToolDef | undefined {
  const lower = name.toLowerCase();
  return TOOLS.find((t) => t.name === lower || lower.endsWith(t.name) || lower.endsWith(`_${t.name}`) || lower === t.name.replace(/_/g, ''));
}

export async function handleMcp(store: Store, req: IncomingMessage, res: ServerResponse, reqId: string): Promise<boolean> {
  const method = req.method ?? 'GET';
  const send = (status: number, value: unknown): boolean => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'X-GitHub-Request-Id': reqId });
    res.end(JSON.stringify(value));
    return true;
  };

  if (method === 'DELETE') {
    res.writeHead(200, { 'X-GitHub-Request-Id': reqId });
    res.end();
    return true;
  }
  if (method === 'GET') {
    // Streamable HTTP GET is the SSE stream; the suite never uses it.
    res.writeHead(405, { 'Content-Type': 'application/json', 'X-GitHub-Request-Id': reqId });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return true;
  }
  if (method !== 'POST') return false;

  const raw = await readBody(req);
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) {
    return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  const rpc = (parsed.value ?? {}) as Record<string, unknown>;
  const id = rpc.id ?? null;
  const rpcMethod = typeof rpc.method === 'string' ? rpc.method : '';
  const params = (rpc.params ?? {}) as Record<string, unknown>;

  const result = (value: unknown): boolean => send(200, { jsonrpc: '2.0', id, result: value });
  const rpcError = (code: number, message: string): boolean => send(200, { jsonrpc: '2.0', id, error: { code, message } });

  if (rpcMethod === 'server/discover') {
    return result({
      protocolVersion: PROTOCOL_VERSION,
      supportedVersions: [PROTOCOL_VERSION, '2025-11-25'],
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: { tools: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }
  if (rpcMethod === 'initialize') {
    return result({
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (rpcMethod === 'notifications/initialized' || rpcMethod.startsWith('notifications/')) {
    res.writeHead(202, { 'X-GitHub-Request-Id': reqId });
    res.end();
    return true;
  }
  if (rpcMethod === 'ping') {
    return result({});
  }
  if (rpcMethod === 'tools/list') {
    return result({ tools: TOOLS });
  }
  if (rpcMethod === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const tool = findTool(name);
    if (!tool) return rpcError(-32602, `Unknown tool: ${name}`);
    for (const required of tool.inputSchema.required) {
      if (args[required] === undefined || args[required] === null) {
        return result(textResult({ error: `Missing required argument: ${required}` }, true));
      }
    }
    try {
      const out = callTool(store, req, tool.name, args);
      return result(out);
    } catch (e) {
      return result(textResult({ error: e instanceof Error ? e.message : String(e) }, true));
    }
  }
  return rpcError(-32601, `Method not found: ${rpcMethod}`);
}

function callTool(store: Store, req: IncomingMessage, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const ctx = { store, reqId: () => 'req-mcp', baseUrl: () => 'http://localhost' };
  const owner = typeof args.owner === 'string' ? args.owner : VIEWER_LOGIN;
  const repoName = typeof args.repo === 'string' ? args.repo : '';
  const needRepo = (): ReturnType<Store['getRepo']> => {
    const repo = store.getRepo(owner, repoName);
    if (!repo) throw new Error(`Repository not found: ${owner}/${repoName}`);
    return repo;
  };
  switch (name) {
    case 'create_repo': {
      const repoNameArg = typeof args.name === 'string' ? args.name : '';
      if (repoNameArg === '') throw new Error('name is required');
      const existing = store.getRepo(VIEWER_LOGIN, repoNameArg);
      if (existing) throw new Error('Repository already exists');
      const repo = store.createRepo(repoNameArg, typeof args.description === 'string' ? args.description : '', args.private === true);
      return textResult(repoObject(ctx, req, repo!));
    }
    case 'get_repo': {
      const repo = needRepo();
      return textResult(repoObject(ctx, req, repo!));
    }
    case 'create_issue': {
      const repo = needRepo();
      const title = typeof args.title === 'string' ? args.title : '';
      const number = repo.nextIssueNumber;
      repo.nextIssueNumber += 1;
      const id = store.nextIssueId;
      store.nextIssueId += 1;
      const issue = {
        id,
        nodeId: Buffer.from(`Issue:${repo.id}:${number}`, 'utf8').toString('base64url'),
        number,
        title,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open' as const,
        labels: [],
        createdAt: stamp(),
        updatedAt: stamp(),
        closedAt: null,
        comments: [],
      };
      repo.issues.push(issue);
      return textResult(issueObject(repo, issue));
    }
    case 'list_issues': {
      const repo = needRepo();
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = repo.issues.filter((i) => state === 'all' || i.state === state);
      return textResult({ issues: list.map((i) => issueObject(repo, i)) });
    }
    case 'get_issue': {
      const repo = needRepo();
      const number = typeof args.issue_number === 'number' ? args.issue_number : -1;
      const issue = repo.issues.find((i) => i.number === number);
      if (!issue) throw new Error(`Issue not found: #${number}`);
      return textResult(issueObject(repo, issue));
    }
    case 'create_pull_request': {
      const repo = needRepo();
      const title = typeof args.title === 'string' ? args.title : '';
      const head = typeof args.head === 'string' ? args.head : '';
      const base = typeof args.base === 'string' ? args.base : '';
      const headSha = repo.branchTip(head);
      const baseSha = repo.branchTip(base);
      if (!headSha || !baseSha) throw new Error('Head or base branch not found');
      const dup = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
      if (dup) throw new Error('A pull request already exists for this head branch');
      const number = repo.nextPullNumber;
      repo.nextPullNumber += 1;
      const id = store.nextPullId;
      store.nextPullId += 1;
      const pr = {
        id,
        nodeId: Buffer.from(`PullRequest:${repo.id}:${number}`, 'utf8').toString('base64url'),
        number,
        title,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open' as const,
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        createdAt: stamp(),
        updatedAt: stamp(),
        files: repo.diffFiles(repo.fileMap(baseSha), repo.fileMap(headSha)),
      };
      repo.pulls.push(pr);
      return textResult(pullObject(ctx, req, repo, pr));
    }
    case 'merge_pull_request': {
      const repo = needRepo();
      const number = typeof args.pull_number === 'number' ? args.pull_number : -1;
      const pr = repo.pulls.find((p) => p.number === number);
      if (!pr) throw new Error(`Pull request not found: #${number}`);
      if (pr.merged) throw new Error('Pull request is already merged');
      if (repo.mergeConflicts(pr)) throw new Error('Merge conflict: this pull request cannot be merged');
      const sha = repo.squashMerge(pr);
      if (!sha) throw new Error('Merge failed');
      return textResult({ sha, merged: true, message: 'Pull Request successfully merged' });
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
