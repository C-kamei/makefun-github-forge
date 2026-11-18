// graphql.ts — a small hand-written GraphQL executor for the fixed set of
// documents the conformance suite sends. Supports queries and mutations,
// variables, aliases, arguments, nested selections and `... on Type` fragments.

import { VIEWER_ID, VIEWER_LOGIN, decodeGlobalId, stamp, type Issue, type PullRequest, type Repo, type Store } from './store.ts';

// ------------------------------------------------------------------ parser

export type ValueNode =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'variable'; name: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

export interface FieldNode {
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selection: SelectionNode[];
}

export type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'fragment'; name: string }
  | { kind: 'inline'; type: string | null; selection: SelectionNode[] };

export interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: Map<string, ValueNode | undefined>;
  selection: SelectionNode[];
}

export interface Document {
  operations: Operation[];
  fragments: Map<string, SelectionNode[]>;
}

class Lexer {
  pos = 0;
  readonly src: string;
  constructor(src: string) { this.src = src; }
  peek(): string { return this.src[this.pos] ?? ''; }
  next(): string { return this.src[this.pos++] ?? ''; }
  skipWs(): void {
    for (;;) {
      const c = this.peek();
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { this.pos += 1; continue; }
      if (c === '#') { while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos += 1; continue; }
      break;
    }
  }
  readName(): string {
    this.skipWs();
    let out = '';
    while (/[A-Za-z0-9_]/.test(this.peek())) out += this.next();
    return out;
  }
  readString(): string {
    this.skipWs();
    if (this.peek() !== '"') throw new Error('graphql: expected string');
    this.next();
    let out = '';
    for (;;) {
      const c = this.next();
      if (c === '') throw new Error('graphql: unterminated string');
      if (c === '"') break;
      if (c === '\\') {
        const e = this.next();
        if (e === 'n') out += '\n';
        else if (e === 't') out += '\t';
        else if (e === 'r') out += '\r';
        else if (e === 'u') out += String.fromCharCode(Number.parseInt(this.src.slice(this.pos, this.pos + 4), 16)), this.pos += 4;
        else out += e;
      } else out += c;
    }
    return out;
  }
  readNumber(): number {
    this.skipWs();
    let out = '';
    while (/[0-9.+-eE]/.test(this.peek())) out += this.next();
    return Number(out);
  }
  expect(ch: string): void {
    this.skipWs();
    if (this.next() !== ch) throw new Error(`graphql: expected '${ch}'`);
  }
  try(ch: string): boolean {
    this.skipWs();
    if (this.peek() === ch) { this.pos += 1; return true; }
    return false;
  }
  at(ch: string): boolean {
    this.skipWs();
    return this.peek() === ch;
  }
  atEllipsis(): boolean {
    this.skipWs();
    return this.src.startsWith('...', this.pos);
  }
  atEnd(): boolean {
    this.skipWs();
    return this.pos >= this.src.length;
  }
}

function parseValue(lex: Lexer): ValueNode {
  if (lex.at('"')) return { kind: 'string', value: lex.readString() };
  if (lex.at('$')) { lex.expect('$'); return { kind: 'variable', name: lex.readName() }; }
  if (lex.at('[')) {
    lex.expect('[');
    const values: ValueNode[] = [];
    while (!lex.at(']')) values.push(parseValue(lex));
    lex.expect(']');
    return { kind: 'list', values };
  }
  if (lex.at('{')) {
    lex.expect('{');
    const fields: Array<{ name: string; value: ValueNode }> = [];
    while (!lex.at('}')) {
      const name = lex.readName();
      lex.expect(':');
      fields.push({ name, value: parseValue(lex) });
    }
    lex.expect('}');
    return { kind: 'object', fields };
  }
  if (/[0-9-]/.test(lex.peek())) {
    const num = lex.readNumber();
    return Number.isInteger(num) ? { kind: 'int', value: num } : { kind: 'float', value: num };
  }
  const name = lex.readName();
  if (name === 'true') return { kind: 'bool', value: true };
  if (name === 'false') return { kind: 'bool', value: false };
  if (name === 'null') return { kind: 'null' };
  if (name === '') throw new Error('graphql: unexpected value');
  return { kind: 'enum', value: name };
}

function parseSelectionSet(lex: Lexer, doc: Document): SelectionNode[] {
  lex.expect('{');
  const out: SelectionNode[] = [];
  while (!lex.at('}')) {
    if (lex.atEllipsis()) {
      lex.expect('.'); lex.expect('.'); lex.expect('.');
      const name = lex.readName();
      if (name === 'on') {
        const type = lex.readName();
        out.push({ kind: 'inline', type, selection: parseSelectionSet(lex, doc) });
      } else {
        out.push({ kind: 'fragment', name });
      }
      continue;
    }
    const first = lex.readName();
    let alias: string | null = null;
    let name = first;
    if (lex.try(':')) { alias = first; name = lex.readName(); }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (lex.try('(')) {
      while (!lex.at(')')) {
        const argName = lex.readName();
        lex.expect(':');
        args.push({ name: argName, value: parseValue(lex) });
      }
      lex.expect(')');
    }
    // Directives: @include/@skip — skip their argument lists.
    while (lex.at('@')) {
      lex.next();
      lex.readName();
      if (lex.try('(')) {
        let depth = 1;
        while (depth > 0 && !lex.atEnd()) {
          const c = lex.next();
          if (c === '(') depth += 1;
          else if (c === ')') depth -= 1;
        }
      }
    }
    const selection = lex.at('{') ? parseSelectionSet(lex, doc) : [];
    out.push({ kind: 'field', field: { alias, name, args, selection } });
  }
  lex.expect('}');
  return out;
}

export function parseDocument(src: string): Document {
  const lex = new Lexer(src);
  const doc: Document = { operations: [], fragments: new Map() };
  while (!lex.atEnd()) {
    if (lex.at('{')) {
      doc.operations.push({ kind: 'query', name: null, variables: new Map(), selection: parseSelectionSet(lex, doc) });
      continue;
    }
    const keyword = lex.readName();
    if (keyword === 'fragment') {
      const name = lex.readName();
      lex.readName(); // 'on'
      lex.readName(); // type name
      doc.fragments.set(name, parseSelectionSet(lex, doc));
      continue;
    }
    if (keyword === 'query' || keyword === 'mutation') {
      let name: string | null = null;
      if (!lex.at('(') && !lex.at('{')) name = lex.readName();
      const variables = new Map<string, ValueNode | undefined>();
      if (lex.try('(')) {
        while (!lex.at(')')) {
          lex.expect('$');
          const varName = lex.readName();
          lex.expect(':');
          // Type: name, optional [ ], optional ! — skip tokens.
          while (!lex.at('=') && !lex.at(')') && !lex.at(',')) lex.next();
          let defaultValue: ValueNode | undefined;
          if (lex.try('=')) defaultValue = parseValue(lex);
          variables.set(varName, defaultValue);
        }
        lex.expect(')');
      }
      doc.operations.push({ kind: keyword, name, variables, selection: parseSelectionSet(lex, doc) });
      continue;
    }
    throw new Error(`graphql: unexpected token '${keyword}'`);
  }
  return doc;
}

// ------------------------------------------------------------------ execution

export interface GqlContext {
  store: Store;
}

type AnyObj = Record<string, unknown>;

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'string': case 'int': case 'float': case 'bool': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'variable': return variables[node.name];
    case 'list': return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: AnyObj = {};
      for (const f of node.fields) out[f.name] = resolveValue(f.value, variables);
      return out;
    }
  }
}

function argMap(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of field.args) out[a.name] = resolveValue(a.value, variables);
  return out;
}

const ISSUE_FIELDS = new Set(['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'closedAt', 'url', 'author', 'labels', 'comments']);
const PR_FIELDS = new Set(['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'title', 'body', 'files', 'url', 'author', 'createdAt', 'updatedAt']);
const REPO_FIELDS = new Set(['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'description', 'isPrivate', 'createdAt']);
const USER_FIELDS = new Set(['login', 'id', 'name', 'email', 'avatarUrl', 'url']);
const ISSUE_CONN_FIELDS = new Set(['nodes', 'edges', 'totalCount', 'pageInfo']);
const PR_CONN_FIELDS = new Set(['nodes', 'edges', 'totalCount', 'pageInfo']);
const PR_FILE_CONN_FIELDS = new Set(['nodes', 'edges', 'totalCount', 'pageInfo']);
const TYPE_FIELDS = new Set(['name', 'kind', 'description', 'fields', 'enumValues', 'ofType', 'inputFields', 'interfaces', 'possibleTypes', 'specifiedByURL']);

interface ExecState {
  errors: Array<{ message: string }>;
}

function fieldError(state: ExecState, message: string): void {
  state.errors.push({ message });
}

function selectFields(
  state: ExecState,
  parent: unknown,
  selection: SelectionNode[],
  doc: Document,
  variables: Record<string, unknown>,
  typeName: string,
  resolve: (field: FieldNode, parent: unknown) => unknown,
  known: Set<string>,
): AnyObj {
  const out: AnyObj = {};
  for (const sel of selection) {
    if (sel.kind === 'fragment') {
      const frag = doc.fragments.get(sel.name);
      if (!frag) { fieldError(state, `Unknown fragment "${sel.name}"`); continue; }
      Object.assign(out, selectFields(state, parent, frag, doc, variables, typeName, resolve, known));
      continue;
    }
    if (sel.kind === 'inline') {
      if (sel.type && sel.type !== typeName) continue;
      Object.assign(out, selectFields(state, parent, sel.selection, doc, variables, typeName, resolve, known));
      continue;
    }
    const field = sel.field;
    if (field.name === '__typename') { out[field.alias ?? '__typename'] = typeName; continue; }
    if (!known.has(field.name)) {
      fieldError(state, `Cannot query field "${field.name}" on type "${typeName}".`);
      continue;
    }
    const value = resolve(field, parent);
    out[field.alias ?? field.name] = value;
  }
  return out;
}

function connectionPage<T>(items: readonly T[], first: number | undefined, after: string | undefined): { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } {
  let start = 0;
  if (after) {
    try {
      const decoded = Buffer.from(after, 'base64').toString('utf8');
      const idx = items.findIndex((i) => String((i as AnyObj).number ?? (i as AnyObj).id) === decoded);
      if (idx >= 0) start = idx + 1;
    } catch { /* ignore bad cursor */ }
  }
  const page = first !== undefined ? items.slice(start, start + first) : items.slice(start);
  const hasNextPage = start + page.length < items.length;
  const endCursor = page.length > 0 ? Buffer.from(String((page[page.length - 1] as AnyObj).number ?? (page[page.length - 1] as AnyObj).id), 'utf8').toString('base64') : null;
  return { nodes: page, pageInfo: { hasNextPage, endCursor } };
}

function issueValue(ctx: GqlContext, repo: Repo, issue: Issue, state: ExecState, doc: Document, variables: Record<string, unknown>, selection: SelectionNode[]): AnyObj {
  return selectFields(state, issue, selection, doc, variables, 'Issue', (field) => {
    switch (field.name) {
      case 'id': return issue.nodeId;
      case 'number': return issue.number;
      case 'title': return issue.title;
      case 'state': return issue.state.toUpperCase();
      case 'body': return issue.body;
      case 'createdAt': return issue.createdAt;
      case 'updatedAt': return issue.updatedAt;
      case 'closedAt': return issue.closedAt;
      case 'url': return `https://example.invalid/${repo.fullName}/issues/${issue.number}`;
      case 'author': return userValue(field.selection, state, doc, variables);
      case 'labels': {
        const nodes = issue.labels.map((l) => ({ name: l.name, color: l.color, description: l.description }));
        return connectionValue(nodes, field, state, doc, variables, 'Label');
      }
      case 'comments': {
        const nodes = issue.comments.map((c) => ({ id: c.nodeId, body: c.body, createdAt: c.createdAt, author: { login: VIEWER_LOGIN } }));
        return connectionValue(nodes, field, state, doc, variables, 'IssueComment');
      }
      default: return null;
    }
  }, ISSUE_FIELDS);
}

function userValue(selection: SelectionNode[], state: ExecState, doc: Document, variables: Record<string, unknown>): AnyObj {
  return selectFields(state, null, selection, doc, variables, 'User', (field) => {
    switch (field.name) {
      case 'login': return VIEWER_LOGIN;
      case 'id': return String(VIEWER_ID);
      case 'name': return VIEWER_LOGIN;
      case 'email': return 'adaiversen@example.invalid';
      case 'avatarUrl': return '';
      case 'url': return `https://example.invalid/${VIEWER_LOGIN}`;
      default: return null;
    }
  }, USER_FIELDS);
}

function connectionValue<T extends AnyObj>(nodes: T[], field: FieldNode, state: ExecState, doc: Document, variables: Record<string, unknown>, itemType: string): AnyObj {
  const args = argMap(field, variables);
  const first = typeof args.first === 'number' ? args.first : undefined;
  const after = typeof args.after === 'string' ? args.after : undefined;
  const page = connectionPage(nodes, first, after);
  return selectFields(state, page, field.selection, doc, variables, `${itemType}Connection`, (f) => {
    if (f.name === 'nodes') return page.nodes.map((n) => resolveNodeValue(n, itemType, f, state, doc, variables));
    if (f.name === 'edges') {
      const nodeSel = f.selection.find((x) => x.kind === 'field' && x.field.name === 'node');
      return page.nodes.map((n) => ({ node: nodeSel?.kind === 'field' ? resolveNodeValue(n, itemType, { ...f, selection: nodeSel.field.selection }, state, doc, variables) : null, cursor: Buffer.from(String(n.number ?? n.id), 'utf8').toString('base64') }));
    }
    if (f.name === 'totalCount') return nodes.length;
    if (f.name === 'pageInfo') return selectFields(state, page.pageInfo, f.selection, doc, variables, 'PageInfo', (pf) => (pf.name === 'hasNextPage' ? page.pageInfo.hasNextPage : pf.name === 'endCursor' ? page.pageInfo.endCursor : pf.name === 'hasPreviousPage' ? false : pf.name === 'startCursor' ? (page.nodes.length > 0 ? Buffer.from(String(page.nodes[0]!.number ?? page.nodes[0]!.id), 'utf8').toString('base64') : null) : null), new Set(['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor']));
    return null;
  }, ISSUE_CONN_FIELDS);
}

function resolveNodeValue(node: AnyObj, itemType: string, field: FieldNode, state: ExecState, doc: Document, variables: Record<string, unknown>): AnyObj {
  if (itemType === 'Label') {
    return selectFields(state, node, field.selection, doc, variables, 'Label', (f) => (f.name === 'name' ? node.name : f.name === 'color' ? node.color : f.name === 'description' ? node.description : f.name === 'id' ? node.name : null), new Set(['id', 'name', 'color', 'description']));
  }
  if (itemType === 'IssueComment') {
    return selectFields(state, node, field.selection, doc, variables, 'IssueComment', (f) => (f.name === 'id' ? node.id : f.name === 'body' ? node.body : f.name === 'createdAt' ? node.createdAt : f.name === 'author' ? userValue(f.selection, state, doc, variables) : null), new Set(['id', 'body', 'createdAt', 'author']));
  }
  return node;
}

function prValue(ctx: GqlContext, repo: Repo, pr: PullRequest, state: ExecState, doc: Document, variables: Record<string, unknown>, selection: SelectionNode[]): AnyObj {
  return selectFields(state, pr, selection, doc, variables, 'PullRequest', (field) => {
    switch (field.name) {
      case 'id': return pr.nodeId;
      case 'number': return pr.number;
      case 'title': return pr.title;
      case 'body': return pr.body;
      case 'headRefName': return pr.headRef;
      case 'baseRefName': return pr.baseRef;
      case 'mergeable': return repo.mergeConflicts(pr) ? 'CONFLICTING' : 'MERGEABLE';
      case 'state': return pr.merged ? 'MERGED' : pr.state.toUpperCase();
      case 'merged': return pr.merged;
      case 'createdAt': return pr.createdAt;
      case 'updatedAt': return pr.updatedAt;
      case 'url': return `https://example.invalid/${repo.fullName}/pull/${pr.number}`;
      case 'author': return userValue(field.selection, state, doc, variables);
      case 'files': {
        const nodes = pr.files.map((f) => ({ path: f.filename, additions: f.additions, deletions: f.deletions, changeType: f.status.toUpperCase() }));
        const args = argMap(field, variables);
        const first = typeof args.first === 'number' ? args.first : undefined;
        const page = connectionPage(nodes, first, undefined);
        return selectFields(state, page, field.selection, doc, variables, 'PullRequestChangedFileConnection', (f) => {
          if (f.name === 'nodes') return page.nodes.map((n) => selectFields(state, n, f.selection, doc, variables, 'PullRequestChangedFile', (pf) => (pf.name === 'path' ? n.path : pf.name === 'additions' ? n.additions : pf.name === 'deletions' ? n.deletions : pf.name === 'changeType' ? n.changeType : null), new Set(['path', 'additions', 'deletions', 'changeType'])));
          if (f.name === 'totalCount') return nodes.length;
          if (f.name === 'pageInfo') return selectFields(state, page.pageInfo, f.selection, doc, variables, 'PageInfo', (pf) => (pf.name === 'hasNextPage' ? page.pageInfo.hasNextPage : pf.name === 'endCursor' ? page.pageInfo.endCursor : null), new Set(['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor']));
          return null;
        }, PR_FILE_CONN_FIELDS);
      }
      default: return null;
    }
  }, PR_FIELDS);
}

function repoValue(ctx: GqlContext, repo: Repo, state: ExecState, doc: Document, variables: Record<string, unknown>, selection: SelectionNode[]): AnyObj {
  return selectFields(state, repo, selection, doc, variables, 'Repository', (field) => {
    const args = argMap(field, variables);
    switch (field.name) {
      case 'id': return repo.nodeId;
      case 'databaseId': return repo.id;
      case 'name': return repo.name;
      case 'nameWithOwner': return repo.fullName;
      case 'owner': return userValue(field.selection, state, doc, variables);
      case 'url': return `https://example.invalid/${repo.fullName}`;
      case 'description': return repo.description;
      case 'isPrivate': return repo.isPrivate;
      case 'createdAt': return repo.createdAt;
      case 'defaultBranchRef': {
        const tip = repo.branchTip(repo.defaultBranch);
        if (!tip) return null;
        return selectFields(state, { name: repo.defaultBranch }, field.selection, doc, variables, 'Ref', (f) => (f.name === 'name' ? repo.defaultBranch : f.name === 'prefix' ? 'refs/heads/' : f.name === 'target' ? { oid: tip } : null), new Set(['name', 'prefix', 'target', 'id']));
      }
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return true;
      case 'issue': {
        const number = typeof args.number === 'number' ? args.number : -1;
        const issue = repo.issues.find((i) => i.number === number);
        if (!issue) return null;
        return issueValue(ctx, repo, issue, state, doc, variables, field.selection);
      }
      case 'issues': {
        let list = [...repo.issues];
        const states = Array.isArray(args.states) ? args.states as string[] : [];
        if (states.length > 0) list = list.filter((i) => states.includes(i.state.toUpperCase()));
        const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
        const dir = orderBy?.direction === 'ASC' ? 1 : -1;
        list.sort((a, b) => (a.number - b.number) * dir);
        const first = typeof args.first === 'number' ? args.first : undefined;
        const after = typeof args.after === 'string' ? args.after : undefined;
        const page = connectionPage(list, first, after);
        return selectFields(state, page, field.selection, doc, variables, 'IssueConnection', (f) => {
          if (f.name === 'nodes') return page.nodes.map((n) => issueValue(ctx, repo, n, state, doc, variables, f.selection));
          if (f.name === 'edges') {
            const nodeSel = f.selection.find((x) => x.kind === 'field' && x.field.name === 'node');
            return page.nodes.map((n) => ({ node: nodeSel?.kind === 'field' ? issueValue(ctx, repo, n, state, doc, variables, nodeSel.field.selection) : null, cursor: Buffer.from(String(n.number), 'utf8').toString('base64') }));
          }
          if (f.name === 'totalCount') return list.length;
          if (f.name === 'pageInfo') return selectFields(state, page.pageInfo, f.selection, doc, variables, 'PageInfo', (pf) => (pf.name === 'hasNextPage' ? page.pageInfo.hasNextPage : pf.name === 'endCursor' ? page.pageInfo.endCursor : pf.name === 'hasPreviousPage' ? false : pf.name === 'startCursor' ? (page.nodes.length > 0 ? Buffer.from(String(page.nodes[0]!.number), 'utf8').toString('base64') : null) : null), new Set(['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor']));
          return null;
        }, ISSUE_CONN_FIELDS);
      }
      case 'pullRequests': {
        let list = [...repo.pulls];
        const states = Array.isArray(args.states) ? args.states as string[] : [];
        if (states.length > 0) list = list.filter((p) => states.includes(p.merged ? 'MERGED' : p.state.toUpperCase()));
        const first = typeof args.first === 'number' ? args.first : undefined;
        const after = typeof args.after === 'string' ? args.after : undefined;
        const page = connectionPage(list, first, after);
        return selectFields(state, page, field.selection, doc, variables, 'PullRequestConnection', (f) => {
          if (f.name === 'nodes') return page.nodes.map((n) => prValue(ctx, repo, n, state, doc, variables, f.selection));
          if (f.name === 'edges') {
            const nodeSel = f.selection.find((x) => x.kind === 'field' && x.field.name === 'node');
            return page.nodes.map((n) => ({ node: nodeSel?.kind === 'field' ? prValue(ctx, repo, n, state, doc, variables, nodeSel.field.selection) : null, cursor: Buffer.from(String(n.number), 'utf8').toString('base64') }));
          }
          if (f.name === 'totalCount') return list.length;
          if (f.name === 'pageInfo') return selectFields(state, page.pageInfo, f.selection, doc, variables, 'PageInfo', (pf) => (pf.name === 'hasNextPage' ? page.pageInfo.hasNextPage : pf.name === 'endCursor' ? page.pageInfo.endCursor : null), new Set(['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor']));
          return null;
        }, PR_CONN_FIELDS);
      }
      case 'pullRequest': {
        const number = typeof args.number === 'number' ? args.number : -1;
        const pr = repo.pulls.find((p) => p.number === number);
        if (!pr) return null;
        return prValue(ctx, repo, pr, state, doc, variables, field.selection);
      }
      default: return null;
    }
  }, REPO_FIELDS);
}

function typeInfo(name: string): { name: string; kind: string; fields: Array<{ name: string }> | null; enumValues: Array<{ name: string }> | null } {
  const known: Record<string, { kind: string; fields?: string[]; enumValues?: string[] }> = {
    Issue: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'closedAt', 'url', 'author', 'labels', 'comments'] },
    PullRequest: { kind: 'OBJECT', fields: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'title', 'body', 'files', 'url', 'author', 'createdAt', 'updatedAt'] },
    Repository: { kind: 'OBJECT', fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'description', 'isPrivate', 'createdAt'] },
    SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'] },
    IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
    PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
    MergeableState: { kind: 'ENUM', enumValues: ['CONFLICTING', 'MERGEABLE', 'UNKNOWN'] },
    RepositoryVisibility: { kind: 'ENUM', enumValues: ['PRIVATE', 'PUBLIC', 'INTERNAL'] },
  };
  const k = known[name];
  if (!k) return { name, kind: 'OBJECT', fields: [], enumValues: null };
  return {
    name,
    kind: k.kind,
    fields: k.fields ? k.fields.map((f) => ({ name: f })) : null,
    enumValues: k.enumValues ? k.enumValues.map((e) => ({ name: e })) : null,
  };
}

function typeValue(info: { name: string; kind: string; fields: Array<{ name: string }> | null; enumValues: Array<{ name: string }> | null }, state: ExecState, doc: Document, variables: Record<string, unknown>, selection: SelectionNode[]): AnyObj {
  return selectFields(state, info, selection, doc, variables, '__Type', (field) => {
    switch (field.name) {
      case 'name': return info.name;
      case 'kind': return info.kind;
      case 'description': return null;
      case 'fields': return info.fields ? info.fields.map((f) => selectFields(state, f, field.selection, doc, variables, '__Field', (ff) => (ff.name === 'name' ? f.name : ff.name === 'description' ? null : ff.name === 'args' ? [] : ff.name === 'type' ? { name: 'String', kind: 'SCALAR' } : null), new Set(['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason']))) : null;
      case 'enumValues': return info.enumValues ? info.enumValues.map((e) => selectFields(state, e, field.selection, doc, variables, '__EnumValue', (ff) => (ff.name === 'name' ? e.name : ff.name === 'description' ? null : ff.name === 'isDeprecated' ? false : ff.name === 'deprecationReason' ? null : null), new Set(['name', 'description', 'isDeprecated', 'deprecationReason']))) : null;
      case 'ofType': return null;
      case 'inputFields': return null;
      case 'interfaces': return [];
      case 'possibleTypes': return null;
      case 'specifiedByURL': return null;
      default: return null;
    }
  }, TYPE_FIELDS);
}

function executeQuery(ctx: GqlContext, op: Operation, doc: Document, variables: Record<string, unknown>): { data: AnyObj; errors?: Array<{ message: string }> } {
  const state: ExecState = { errors: [] };
  const data = selectFields(state, null, op.selection, doc, variables, 'Query', (field) => {
    const args = argMap(field, variables);
    switch (field.name) {
      case 'viewer': return userValue(field.selection, state, doc, variables);
      case 'repository': {
        const owner = typeof args.owner === 'string' ? args.owner : '';
        const name = typeof args.name === 'string' ? args.name : '';
        const repo = ctx.store.getRepo(owner, name);
        if (!repo) return null;
        return repoValue(ctx, repo, state, doc, variables, field.selection);
      }
      case 'node': {
        const id = typeof args.id === 'string' ? args.id : '';
        const decoded = decodeGlobalId(id);
        if (!decoded) return null;
        if (decoded.kind === 'Repository') {
          const repo = ctx.store.findRepoById(Number(decoded.parts[0]));
          if (!repo) return null;
          return repoValue(ctx, repo, state, doc, variables, field.selection);
        }
        if (decoded.kind === 'Issue') {
          const repo = ctx.store.findRepoById(Number(decoded.parts[0]));
          const issue = repo?.issues.find((i) => i.number === Number(decoded.parts[1]));
          if (!repo || !issue) return null;
          return issueValue(ctx, repo, issue, state, doc, variables, field.selection);
        }
        if (decoded.kind === 'PullRequest') {
          const repo = ctx.store.findRepoById(Number(decoded.parts[0]));
          const pr = repo?.pulls.find((p) => p.number === Number(decoded.parts[1]));
          if (!repo || !pr) return null;
          return prValue(ctx, repo, pr, state, doc, variables, field.selection);
        }
        return null;
      }
      case '__type': {
        const name = typeof args.name === 'string' ? args.name : '';
        return typeValue(typeInfo(name), state, doc, variables, field.selection);
      }
      case '__schema': {
        return selectFields(state, null, field.selection, doc, variables, '__Schema', (f) => {
          if (f.name === 'queryType') return { name: 'Query' };
          if (f.name === 'mutationType') return { name: 'Mutation' };
          if (f.name === 'types') return [];
          return null;
        }, new Set(['queryType', 'mutationType', 'types', 'directives', 'description']));
      }
      default:
        fieldError(state, `Cannot query field "${field.name}" on type "Query".`);
        return null;
    }
  }, new Set(['viewer', 'repository', 'node', '__type', '__schema']));
  const out: { data: AnyObj; errors?: Array<{ message: string }> } = { data };
  if (state.errors.length > 0) out.errors = state.errors;
  return out;
}

function executeMutation(ctx: GqlContext, op: Operation, doc: Document, variables: Record<string, unknown>): { data: AnyObj; errors?: Array<{ message: string }> } {
  const state: ExecState = { errors: [] };
  const data = selectFields(state, null, op.selection, doc, variables, 'Mutation', (field) => {
    const args = argMap(field, variables);
    const input = (args.input ?? {}) as Record<string, unknown>;
    switch (field.name) {
      case 'createIssue': {
        const repoId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
        const repo = ctx.store.findRepoById(Number(decodeGlobalId(repoId)?.parts[0]));
        if (!repo) { fieldError(state, 'Repository not found'); return null; }
        const title = typeof input.title === 'string' ? input.title : '';
        const number = repo.nextIssueNumber;
        repo.nextIssueNumber += 1;
        const id = ctx.store.nextIssueId;
        ctx.store.nextIssueId += 1;
        const issue: Issue = {
          id,
          nodeId: Buffer.from(`Issue:${repo.id}:${number}`, 'utf8').toString('base64url'),
          number,
          title,
          body: typeof input.body === 'string' ? input.body : '',
          state: 'open',
          labels: [],
          createdAt: stamp(),
          updatedAt: stamp(),
          closedAt: null,
          comments: [],
        };
        repo.issues.push(issue);
        const issueData = issueValue(ctx, repo, issue, state, doc, variables, field.selection.find((s) => s.kind === 'field' && s.field.name === 'issue')?.kind === 'field' ? (field.selection.find((s) => s.kind === 'field' && s.field.name === 'issue') as { kind: 'field'; field: FieldNode }).field.selection : []);
        return selectFields(state, { issue: issueData }, field.selection, doc, variables, 'CreateIssuePayload', (f) => (f.name === 'issue' ? issueData : f.name === 'clientMutationId' ? (input.clientMutationId ?? null) : null), new Set(['issue', 'clientMutationId']));
      }
      case 'closeIssue': {
        const issueId = typeof input.issueId === 'string' ? input.issueId : '';
        const decoded = decodeGlobalId(issueId);
        const repo = decoded ? ctx.store.findRepoById(Number(decoded.parts[0])) : null;
        const issue = repo?.issues.find((i) => i.number === Number(decoded?.parts[1]));
        if (!repo || !issue) { fieldError(state, 'Issue not found'); return null; }
        issue.state = 'closed';
        issue.closedAt = stamp();
        const issueData = issueValue(ctx, repo, issue, state, doc, variables, field.selection.find((s) => s.kind === 'field' && s.field.name === 'issue')?.kind === 'field' ? (field.selection.find((s) => s.kind === 'field' && s.field.name === 'issue') as { kind: 'field'; field: FieldNode }).field.selection : []);
        return selectFields(state, { issue: issueData }, field.selection, doc, variables, 'CloseIssuePayload', (f) => (f.name === 'issue' ? issueData : f.name === 'clientMutationId' ? (input.clientMutationId ?? null) : null), new Set(['issue', 'clientMutationId']));
      }
      case 'createPullRequest': {
        const repoId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
        const repo = ctx.store.findRepoById(Number(decodeGlobalId(repoId)?.parts[0]));
        if (!repo) { fieldError(state, 'Repository not found'); return null; }
        const head = typeof input.headRefName === 'string' ? input.headRefName : '';
        const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
        const headSha = repo.branchTip(head);
        const baseSha = repo.branchTip(base);
        if (!headSha || !baseSha) { fieldError(state, 'Head or base branch not found'); return null; }
        const number = repo.nextPullNumber;
        repo.nextPullNumber += 1;
        const id = ctx.store.nextPullId;
        ctx.store.nextPullId += 1;
        const pr: PullRequest = {
          id,
          nodeId: Buffer.from(`PullRequest:${repo.id}:${number}`, 'utf8').toString('base64url'),
          number,
          title: typeof input.title === 'string' ? input.title : '',
          body: typeof input.body === 'string' ? input.body : '',
          state: 'open',
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
        const prData = prValue(ctx, repo, pr, state, doc, variables, field.selection.find((s) => s.kind === 'field' && s.field.name === 'pullRequest')?.kind === 'field' ? (field.selection.find((s) => s.kind === 'field' && s.field.name === 'pullRequest') as { kind: 'field'; field: FieldNode }).field.selection : []);
        return selectFields(state, { pullRequest: prData }, field.selection, doc, variables, 'CreatePullRequestPayload', (f) => (f.name === 'pullRequest' ? prData : f.name === 'clientMutationId' ? (input.clientMutationId ?? null) : null), new Set(['pullRequest', 'clientMutationId']));
      }
      case 'mergePullRequest': {
        const prId = typeof input.pullRequestId === 'string' ? input.pullRequestId : '';
        const decoded = decodeGlobalId(prId);
        const repo = decoded ? ctx.store.findRepoById(Number(decoded.parts[0])) : null;
        const pr = repo?.pulls.find((p) => p.number === Number(decoded?.parts[1]));
        if (!repo || !pr) { fieldError(state, 'Pull request not found'); return null; }
        if (repo.mergeConflicts(pr)) { fieldError(state, 'Merge conflict'); return null; }
        const sha = repo.squashMerge(pr);
        if (!sha) { fieldError(state, 'Merge failed'); return null; }
        const prData = prValue(ctx, repo, pr, state, doc, variables, field.selection.find((s) => s.kind === 'field' && s.field.name === 'pullRequest')?.kind === 'field' ? (field.selection.find((s) => s.kind === 'field' && s.field.name === 'pullRequest') as { kind: 'field'; field: FieldNode }).field.selection : []);
        return selectFields(state, { pullRequest: prData }, field.selection, doc, variables, 'MergePullRequestPayload', (f) => (f.name === 'pullRequest' ? prData : f.name === 'clientMutationId' ? (input.clientMutationId ?? null) : null), new Set(['pullRequest', 'clientMutationId']));
      }
      case 'addComment': {
        const subjectId = typeof input.subjectId === 'string' ? input.subjectId : '';
        const decoded = decodeGlobalId(subjectId);
        const repo = decoded ? ctx.store.findRepoById(Number(decoded.parts[0])) : null;
        const issue = repo?.issues.find((i) => i.number === Number(decoded?.parts[1]));
        if (!repo || !issue) { fieldError(state, 'Subject not found'); return null; }
        const id = ctx.store.nextCommentId;
        ctx.store.nextCommentId += 1;
        const comment = { id, nodeId: Buffer.from(`IssueComment:${repo.id}:${issue.number}:${id}`, 'utf8').toString('base64url'), body: typeof input.body === 'string' ? input.body : '', createdAt: stamp(), updatedAt: stamp() };
        issue.comments.push(comment);
        const edgeSel = field.selection.find((s) => s.kind === 'field' && s.field.name === 'commentEdge');
        const nodeSel = edgeSel?.kind === 'field' ? edgeSel.field.selection.find((s) => s.kind === 'field' && s.field.name === 'node') : undefined;
        const nodeData = nodeSel?.kind === 'field' ? selectFields(state, comment, nodeSel.field.selection, doc, variables, 'IssueComment', (f) => (f.name === 'id' ? comment.nodeId : f.name === 'body' ? comment.body : f.name === 'createdAt' ? comment.createdAt : f.name === 'author' ? userValue(f.selection, state, doc, variables) : null), new Set(['id', 'body', 'createdAt', 'author'])) : { id: comment.nodeId, body: comment.body };
        return selectFields(state, { commentEdge: { node: nodeData } }, field.selection, doc, variables, 'AddCommentPayload', (f) => {
          if (f.name === 'commentEdge') return selectFields(state, { node: nodeData }, f.selection, doc, variables, 'IssueCommentEdge', (ef) => (ef.name === 'node' ? nodeData : ef.name === 'cursor' ? Buffer.from(String(comment.id), 'utf8').toString('base64') : null), new Set(['node', 'cursor']));
          if (f.name === 'clientMutationId') return input.clientMutationId ?? null;
          return null;
        }, new Set(['commentEdge', 'clientMutationId']));
      }
      default:
        fieldError(state, `Cannot query field "${field.name}" on type "Mutation".`);
        return null;
    }
  }, new Set(['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'updateIssue', 'addReaction']));
  const out: { data: AnyObj; errors?: Array<{ message: string }> } = { data };
  if (state.errors.length > 0) out.errors = state.errors;
  return out;
}

/** Execute one GraphQL operation object ({query, variables, operationName}). */
export function executeGraphQL(ctx: GqlContext, body: unknown): unknown {
  if (Array.isArray(body)) return body.map((b) => executeGraphQL(ctx, b));
  const b = (body ?? {}) as Record<string, unknown>;
  const query = typeof b.query === 'string' ? b.query : '';
  const variables = (b.variables ?? {}) as Record<string, unknown>;
  const operationName = typeof b.operationName === 'string' ? b.operationName : undefined;
  let doc: Document;
  try {
    doc = parseDocument(query);
  } catch (e) {
    return { errors: [{ message: e instanceof Error ? e.message : 'GraphQL parse error' }] };
  }
  const op = operationName ? doc.operations.find((o) => o.name === operationName) : doc.operations[0];
  if (!op) return { errors: [{ message: `Unknown operation "${operationName ?? ''}"` }] };
  // Merge variable defaults.
  const vars: Record<string, unknown> = { ...variables };
  for (const [name, def] of op.variables) {
    if (vars[name] === undefined && def !== undefined) vars[name] = resolveValue(def, {});
  }
  if (op.kind === 'mutation') return executeMutation(ctx, op, doc, vars);
  return executeQuery(ctx, op, doc, vars);
}
