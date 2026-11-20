// GraphQL v4 at /api/graphql. A small hand-written parser and executor: no
// outside library, no code generation. It covers the documents the suite
// sends — queries, mutations, variables, aliases, inline and named fragments,
// batched bodies — plus the introspection (`__type` / `__schema`) the checks
// read. Unknown fields are a 200 with an errors array naming the field;
// an unknown repository is `data.repository = null` with no errors.

import { mergeBase } from './gitcore.ts';
import { Store, gid, parseGid, type Issue, type Pull, type Repo } from './store.ts';
import type { GitRequest, GitResponse } from './githttp.ts';

// -------------------------------------------------------------------------------------------
// schema
// -------------------------------------------------------------------------------------------

interface FieldDef {
  name: string;
  type: string;
  args?: { name: string; type: string; defaultValue?: unknown }[];
  description?: string;
}

interface TypeDef {
  /** The name is the key in SCHEMA; a `name` field is only set on built views. */
  name?: string;
  kind: 'OBJECT' | 'ENUM' | 'INPUT_OBJECT' | 'SCALAR' | 'INTERFACE';
  description?: string;
  fields?: FieldDef[];
  enumValues?: string[];
  inputFields?: { name: string; type: string; defaultValue?: unknown }[];
}

const ISSUE_FIELDS: FieldDef[] = [
  { name: 'id', type: 'ID!' },
  { name: 'databaseId', type: 'Int' },
  { name: 'number', type: 'Int!' },
  { name: 'title', type: 'String!' },
  { name: 'body', type: 'String' },
  { name: 'state', type: 'IssueState!' },
  { name: 'author', type: 'User' },
  { name: 'createdAt', type: 'DateTime!' },
  { name: 'updatedAt', type: 'DateTime!' },
  { name: 'comments', type: 'IssueCommentConnection', args: [{ name: 'first', type: 'Int' }] },
  { name: 'labels', type: 'LabelConnection', args: [{ name: 'first', type: 'Int' }] },
];

const PULL_REQUEST_FIELDS: FieldDef[] = [
  { name: 'id', type: 'ID!' },
  { name: 'databaseId', type: 'Int' },
  { name: 'number', type: 'Int!' },
  { name: 'title', type: 'String!' },
  { name: 'body', type: 'String' },
  { name: 'state', type: 'PullRequestState!' },
  { name: 'merged', type: 'Boolean!' },
  { name: 'mergeable', type: 'MergeableState!' },
  { name: 'headRefName', type: 'String!' },
  { name: 'baseRefName', type: 'String!' },
  { name: 'headRefOid', type: 'String' },
  { name: 'baseRefOid', type: 'String' },
  { name: 'author', type: 'User' },
  { name: 'createdAt', type: 'DateTime!' },
  { name: 'updatedAt', type: 'DateTime!' },
  { name: 'mergedAt', type: 'DateTime' },
  { name: 'files', type: 'PullRequestChangedFileConnection', args: [{ name: 'first', type: 'Int' }] },
];

const REPOSITORY_FIELDS: FieldDef[] = [
  { name: 'id', type: 'ID!' },
  { name: 'databaseId', type: 'Int' },
  { name: 'name', type: 'String!' },
  { name: 'nameWithOwner', type: 'String!' },
  { name: 'owner', type: 'User' },
  { name: 'defaultBranchRef', type: 'Ref' },
  { name: 'viewerPermission', type: 'RepositoryPermission' },
  { name: 'hasIssuesEnabled', type: 'Boolean!' },
  { name: 'issue', type: 'Issue', args: [{ name: 'number', type: 'Int!' }] },
  {
    name: 'issues',
    type: 'IssueConnection',
    args: [
      { name: 'first', type: 'Int' },
      { name: 'after', type: 'String' },
      { name: 'states', type: '[IssueState!]' },
      { name: 'orderBy', type: 'IssueOrder' },
    ],
  },
  {
    name: 'pullRequests',
    type: 'PullRequestConnection',
    args: [
      { name: 'first', type: 'Int' },
      { name: 'after', type: 'String' },
      { name: 'states', type: '[PullRequestState!]' },
    ],
  },
  { name: 'pullRequest', type: 'PullRequest', args: [{ name: 'number', type: 'Int!' }] },
];

const SCHEMA: Record<string, TypeDef> = {
  Query: {
    kind: 'OBJECT',
    fields: [
      { name: 'viewer', type: 'User' },
      {
        name: 'repository',
        type: 'Repository',
        args: [
          { name: 'owner', type: 'String!' },
          { name: 'name', type: 'String!' },
        ],
      },
      { name: 'node', type: 'Node', args: [{ name: 'id', type: 'ID!' }] },
      { name: '__type', type: '__Type', args: [{ name: 'name', type: 'String!' }] },
      { name: '__schema', type: '__Schema' },
    ],
  },
  Mutation: {
    kind: 'OBJECT',
    fields: [
      { name: 'createIssue', type: 'CreateIssuePayload', args: [{ name: 'input', type: 'CreateIssueInput!' }] },
      { name: 'closeIssue', type: 'CloseIssuePayload', args: [{ name: 'input', type: 'CloseIssueInput!' }] },
      { name: 'createPullRequest', type: 'CreatePullRequestPayload', args: [{ name: 'input', type: 'CreatePullRequestInput!' }] },
      { name: 'mergePullRequest', type: 'MergePullRequestPayload', args: [{ name: 'input', type: 'MergePullRequestInput!' }] },
      { name: 'addComment', type: 'AddCommentPayload', args: [{ name: 'input', type: 'AddCommentInput!' }] },
    ],
  },
  Node: { kind: 'INTERFACE', fields: [{ name: 'id', type: 'ID!' }] },
  User: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID!' },
      { name: 'databaseId', type: 'Int' },
      { name: 'login', type: 'String!' },
      { name: 'name', type: 'String' },
      { name: 'email', type: 'String' },
    ],
  },
  Repository: { kind: 'OBJECT', fields: REPOSITORY_FIELDS },
  Issue: { kind: 'OBJECT', fields: ISSUE_FIELDS },
  PullRequest: { kind: 'OBJECT', fields: PULL_REQUEST_FIELDS },
  Ref: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID!' },
      { name: 'name', type: 'String!' },
      { name: 'prefix', type: 'String!' },
    ],
  },
  IssueConnection: {
    kind: 'OBJECT',
    fields: [
      { name: 'edges', type: '[IssueEdge]' },
      { name: 'nodes', type: '[Issue]' },
      { name: 'pageInfo', type: 'PageInfo!' },
      { name: 'totalCount', type: 'Int!' },
    ],
  },
  IssueEdge: {
    kind: 'OBJECT',
    fields: [
      { name: 'node', type: 'Issue' },
      { name: 'cursor', type: 'String!' },
    ],
  },
  PullRequestConnection: {
    kind: 'OBJECT',
    fields: [
      { name: 'edges', type: '[PullRequestEdge]' },
      { name: 'nodes', type: '[PullRequest]' },
      { name: 'pageInfo', type: 'PageInfo!' },
      { name: 'totalCount', type: 'Int!' },
    ],
  },
  PullRequestEdge: {
    kind: 'OBJECT',
    fields: [
      { name: 'node', type: 'PullRequest' },
      { name: 'cursor', type: 'String!' },
    ],
  },
  IssueCommentConnection: {
    kind: 'OBJECT',
    fields: [
      { name: 'edges', type: '[IssueCommentEdge]' },
      { name: 'nodes', type: '[IssueComment]' },
      { name: 'pageInfo', type: 'PageInfo!' },
      { name: 'totalCount', type: 'Int!' },
    ],
  },
  IssueCommentEdge: {
    kind: 'OBJECT',
    fields: [
      { name: 'node', type: 'IssueComment' },
      { name: 'cursor', type: 'String!' },
    ],
  },
  IssueComment: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID!' },
      { name: 'databaseId', type: 'Int' },
      { name: 'body', type: 'String!' },
      { name: 'author', type: 'User' },
      { name: 'createdAt', type: 'DateTime!' },
      { name: 'updatedAt', type: 'DateTime!' },
    ],
  },
  LabelConnection: {
    kind: 'OBJECT',
    fields: [
      { name: 'edges', type: '[LabelEdge]' },
      { name: 'nodes', type: '[Label]' },
      { name: 'pageInfo', type: 'PageInfo!' },
      { name: 'totalCount', type: 'Int!' },
    ],
  },
  LabelEdge: {
    kind: 'OBJECT',
    fields: [
      { name: 'node', type: 'Label' },
      { name: 'cursor', type: 'String!' },
    ],
  },
  Label: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID!' },
      { name: 'name', type: 'String!' },
      { name: 'color', type: 'String!' },
      { name: 'description', type: 'String' },
    ],
  },
  PullRequestChangedFileConnection: {
    kind: 'OBJECT',
    fields: [
      { name: 'edges', type: '[PullRequestChangedFileEdge]' },
      { name: 'nodes', type: '[PullRequestChangedFile]' },
      { name: 'pageInfo', type: 'PageInfo!' },
      { name: 'totalCount', type: 'Int!' },
    ],
  },
  PullRequestChangedFileEdge: {
    kind: 'OBJECT',
    fields: [
      { name: 'node', type: 'PullRequestChangedFile' },
      { name: 'cursor', type: 'String!' },
    ],
  },
  PullRequestChangedFile: {
    kind: 'OBJECT',
    fields: [
      { name: 'path', type: 'String!' },
      { name: 'additions', type: 'Int!' },
      { name: 'deletions', type: 'Int!' },
      { name: 'changeType', type: 'PullRequestChangeType!' },
    ],
  },
  PageInfo: {
    kind: 'OBJECT',
    fields: [
      { name: 'hasNextPage', type: 'Boolean!' },
      { name: 'hasPreviousPage', type: 'Boolean!' },
      { name: 'startCursor', type: 'String' },
      { name: 'endCursor', type: 'String' },
    ],
  },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  PullRequestChangeType: { kind: 'ENUM', enumValues: ['ADDED', 'MODIFIED', 'REMOVED', 'RENAMED'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'] },
  IssueOrder: {
    kind: 'INPUT_OBJECT',
    inputFields: [
      { name: 'field', type: 'IssueOrderField!' },
      { name: 'direction', type: 'OrderDirection!' },
    ],
  },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  CreateIssueInput: {
    kind: 'INPUT_OBJECT',
    inputFields: [
      { name: 'repositoryId', type: 'ID!' },
      { name: 'title', type: 'String!' },
      { name: 'body', type: 'String' },
      { name: 'clientMutationId', type: 'String' },
    ],
  },
  CloseIssueInput: {
    kind: 'INPUT_OBJECT',
    inputFields: [
      { name: 'issueId', type: 'ID!' },
      { name: 'clientMutationId', type: 'String' },
    ],
  },
  CreatePullRequestInput: {
    kind: 'INPUT_OBJECT',
    inputFields: [
      { name: 'repositoryId', type: 'ID!' },
      { name: 'title', type: 'String!' },
      { name: 'headRefName', type: 'String!' },
      { name: 'baseRefName', type: 'String!' },
      { name: 'body', type: 'String' },
      { name: 'clientMutationId', type: 'String' },
    ],
  },
  MergePullRequestInput: {
    kind: 'INPUT_OBJECT',
    inputFields: [
      { name: 'pullRequestId', type: 'ID!' },
      { name: 'mergeMethod', type: 'PullRequestMergeMethod' },
      { name: 'clientMutationId', type: 'String' },
    ],
  },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  AddCommentInput: {
    kind: 'INPUT_OBJECT',
    inputFields: [
      { name: 'subjectId', type: 'ID!' },
      { name: 'body', type: 'String!' },
      { name: 'clientMutationId', type: 'String' },
    ],
  },
  CreateIssuePayload: {
    kind: 'OBJECT',
    fields: [
      { name: 'issue', type: 'Issue' },
      { name: 'clientMutationId', type: 'String' },
    ],
  },
  CloseIssuePayload: {
    kind: 'OBJECT',
    fields: [
      { name: 'issue', type: 'Issue' },
      { name: 'clientMutationId', type: 'String' },
    ],
  },
  CreatePullRequestPayload: {
    kind: 'OBJECT',
    fields: [
      { name: 'pullRequest', type: 'PullRequest' },
      { name: 'clientMutationId', type: 'String' },
    ],
  },
  MergePullRequestPayload: {
    kind: 'OBJECT',
    fields: [
      { name: 'pullRequest', type: 'PullRequest' },
      { name: 'clientMutationId', type: 'String' },
    ],
  },
  AddCommentPayload: {
    kind: 'OBJECT',
    fields: [
      { name: 'commentEdge', type: 'IssueCommentEdge' },
      { name: 'subject', type: 'Issue' },
      { name: 'clientMutationId', type: 'String' },
    ],
  },
  __Schema: {
    kind: 'OBJECT',
    fields: [
      { name: 'description', type: 'String' },
      { name: 'types', type: '[__Type!]!' },
      { name: 'queryType', type: '__Type' },
      { name: 'mutationType', type: '__Type' },
      { name: 'directives', type: '[__Directive!]!' },
    ],
  },
  __Type: {
    kind: 'OBJECT',
    fields: [
      { name: 'kind', type: '__TypeKind!' },
      { name: 'name', type: 'String' },
      { name: 'description', type: 'String' },
      { name: 'fields', type: '[__Field!]', args: [{ name: 'includeDeprecated', type: 'Boolean', defaultValue: false }] },
      { name: 'interfaces', type: '[__Type!]' },
      { name: 'possibleTypes', type: '[__Type!]' },
      { name: 'enumValues', type: '[__EnumValue!]', args: [{ name: 'includeDeprecated', type: 'Boolean', defaultValue: false }] },
      { name: 'inputFields', type: '[__InputValue!]' },
      { name: 'ofType', type: '__Type' },
    ],
  },
  __TypeKind: { kind: 'ENUM', enumValues: ['SCALAR', 'OBJECT', 'INTERFACE', 'UNION', 'ENUM', 'INPUT_OBJECT', 'LIST', 'NON_NULL'] },
  __Field: {
    kind: 'OBJECT',
    fields: [
      { name: 'name', type: 'String!' },
      { name: 'description', type: 'String' },
      { name: 'args', type: '[__InputValue!]!' },
      { name: 'type', type: '__Type!' },
      { name: 'isDeprecated', type: 'Boolean!' },
      { name: 'deprecationReason', type: 'String' },
    ],
  },
  __InputValue: {
    kind: 'OBJECT',
    fields: [
      { name: 'name', type: 'String!' },
      { name: 'description', type: 'String' },
      { name: 'type', type: '__Type!' },
      { name: 'defaultValue', type: 'String' },
    ],
  },
  __EnumValue: {
    kind: 'OBJECT',
    fields: [
      { name: 'name', type: 'String!' },
      { name: 'description', type: 'String' },
      { name: 'isDeprecated', type: 'Boolean!' },
      { name: 'deprecationReason', type: 'String' },
    ],
  },
  __Directive: {
    kind: 'OBJECT',
    fields: [
      { name: 'name', type: 'String!' },
      { name: 'description', type: 'String' },
      { name: 'locations', type: '[__DirectiveLocation!]!' },
      { name: 'args', type: '[__InputValue!]!' },
    ],
  },
  __DirectiveLocation: { kind: 'ENUM', enumValues: ['QUERY', 'MUTATION', 'FIELD', 'FRAGMENT_DEFINITION', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT'] },
  String: { kind: 'SCALAR' },
  Int: { kind: 'SCALAR' },
  Float: { kind: 'SCALAR' },
  Boolean: { kind: 'SCALAR' },
  ID: { kind: 'SCALAR' },
  DateTime: { kind: 'SCALAR' },
};

// -------------------------------------------------------------------------------------------
// tokenizer and parser
// -------------------------------------------------------------------------------------------

type TokenKind = 'Name' | 'Int' | 'Float' | 'String' | 'Punct' | 'EOF';
interface Token {
  kind: TokenKind;
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const char = source[i] as string;
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === ',') {
      i += 1;
      continue;
    }
    if (char === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (char === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'String', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const escaped = source[j + 1] as string;
          const table: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (escaped === 'u') {
            value += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            value += table[escaped] ?? escaped;
            j += 2;
          }
        } else {
          value += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'String', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(char)) {
      const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(source.slice(i));
      if (match === null) throw new Error(`bad number at ${i}`);
      const text = match[0];
      tokens.push({ kind: text.includes('.') || /[eE]/.test(text) ? 'Float' : 'Int', value: text });
      i += text.length;
      continue;
    }
    if (/[_A-Za-z]/.test(char)) {
      const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(i));
      const text = (match as RegExpExecArray)[0];
      tokens.push({ kind: 'Name', value: text });
      i += text.length;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'Punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(char)) {
      tokens.push({ kind: 'Punct', value: char });
      i += 1;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(char)}`);
  }
  tokens.push({ kind: 'EOF', value: '' });
  return tokens;
}

type ValueNode =
  | { kind: 'Variable'; name: string }
  | { kind: 'Int'; value: number }
  | { kind: 'Float'; value: number }
  | { kind: 'String'; value: string }
  | { kind: 'Boolean'; value: boolean }
  | { kind: 'Null' }
  | { kind: 'Enum'; value: string }
  | { kind: 'List'; values: ValueNode[] }
  | { kind: 'Object'; fields: { name: string; value: ValueNode }[] };

interface ArgumentNode {
  name: string;
  value: ValueNode;
}

interface DirectiveNode {
  name: string;
  arguments: ArgumentNode[];
}

type SelectionNode =
  | { kind: 'Field'; alias?: string; name: string; arguments: ArgumentNode[]; directives: DirectiveNode[]; selectionSet?: SelectionNode[] }
  | { kind: 'FragmentSpread'; name: string; directives: DirectiveNode[] }
  | { kind: 'InlineFragment'; typeCondition?: string; directives: DirectiveNode[]; selectionSet: SelectionNode[] };

interface VariableDefinition {
  name: string;
  type: string;
  defaultValue?: ValueNode;
}

interface OperationNode {
  operation: 'query' | 'mutation' | 'subscription';
  name?: string;
  variableDefinitions: VariableDefinition[];
  selectionSet: SelectionNode[];
}

interface FragmentNode {
  name: string;
  typeCondition: string;
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

class Parser {
  private tokens: Token[];
  private position = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token {
    return this.tokens[this.position] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.position] as Token;
    if (this.position < this.tokens.length - 1) this.position += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'Punct' || token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'Name') throw new Error(`expected a name, got ${token.value}`);
    if (value !== undefined && token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
    return token.value;
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'Punct' && token.value === value) {
      this.next();
      return true;
    }
    return false;
  }

  parseDocument(): DocumentNode {
    const document: DocumentNode = { operations: [], fragments: new Map() };
    while (this.peek().kind !== 'EOF') {
      if (this.peek().kind === 'Punct' && this.peek().value === '{') {
        document.operations.push({ operation: 'query', variableDefinitions: [], selectionSet: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.expectName();
      if (keyword === 'query' || keyword === 'mutation' || keyword === 'subscription') {
        document.operations.push(this.parseOperation(keyword));
      } else if (keyword === 'fragment') {
        const fragment = this.parseFragment();
        document.fragments.set(fragment.name, fragment);
      } else {
        throw new Error(`unexpected keyword ${keyword}`);
      }
    }
    return document;
  }

  private parseOperation(operation: 'query' | 'mutation' | 'subscription'): OperationNode {
    let name: string | undefined;
    if (this.peek().kind === 'Name') name = this.next().value;
    const variableDefinitions: VariableDefinition[] = [];
    if (this.skipPunct('(')) {
      while (!this.skipPunct(')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        const type = this.parseType();
        let defaultValue: ValueNode | undefined;
        if (this.skipPunct('=')) defaultValue = this.parseValue(true);
        variableDefinitions.push({ name: varName, type, defaultValue });
      }
    }
    this.parseDirectives();
    return { operation, name, variableDefinitions, selectionSet: this.parseSelectionSet() };
  }

  private parseFragment(): FragmentNode {
    const name = this.expectName();
    this.expectName('on');
    const typeCondition = this.expectName();
    this.parseDirectives();
    return { name, typeCondition, selectionSet: this.parseSelectionSet() };
  }

  private parseType(): string {
    if (this.skipPunct('[')) {
      const inner = this.parseType();
      this.expectPunct(']');
      return this.skipPunct('!') ? `[${inner}]!` : `[${inner}]`;
    }
    const name = this.expectName();
    return this.skipPunct('!') ? `${name}!` : name;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.skipPunct('}')) {
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'Punct' && this.peek().value === '...') {
      this.next();
      if (this.peek().kind === 'Name' && this.peek().value !== 'on') {
        const name = this.next().value;
        const directives = this.parseDirectives();
        return { kind: 'FragmentSpread', name, directives };
      }
      let typeCondition: string | undefined;
      if (this.peek().kind === 'Name' && this.peek().value === 'on') {
        this.next();
        typeCondition = this.expectName();
      }
      const directives = this.parseDirectives();
      return { kind: 'InlineFragment', typeCondition, directives, selectionSet: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | undefined;
    let name = first;
    if (this.skipPunct(':')) {
      alias = first;
      name = this.expectName();
    }
    const args = this.parseArguments();
    const directives = this.parseDirectives();
    let selectionSet: SelectionNode[] | undefined;
    if (this.peek().kind === 'Punct' && this.peek().value === '{') selectionSet = this.parseSelectionSet();
    return { kind: 'Field', alias, name, arguments: args, directives, selectionSet };
  }

  private parseArguments(): ArgumentNode[] {
    const args: ArgumentNode[] = [];
    if (!this.skipPunct('(')) return args;
    while (!this.skipPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue(false) });
    }
    return args;
  }

  private parseDirectives(): DirectiveNode[] {
    const directives: DirectiveNode[] = [];
    while (this.skipPunct('@')) {
      const name = this.expectName();
      directives.push({ name, arguments: this.parseArguments() });
    }
    return directives;
  }

  private parseValue(isConst: boolean): ValueNode {
    const token = this.next();
    if (token.kind === 'Punct' && token.value === '$') {
      if (isConst) throw new Error('a variable is not allowed here');
      return { kind: 'Variable', name: this.expectName() };
    }
    if (token.kind === 'Punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'Punct' && this.peek().value === ']')) values.push(this.parseValue(isConst));
      this.next();
      return { kind: 'List', values };
    }
    if (token.kind === 'Punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!(this.peek().kind === 'Punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue(isConst) });
      }
      this.next();
      return { kind: 'Object', fields };
    }
    if (token.kind === 'Int') return { kind: 'Int', value: Number(token.value) };
    if (token.kind === 'Float') return { kind: 'Float', value: Number(token.value) };
    if (token.kind === 'String') return { kind: 'String', value: token.value };
    if (token.kind === 'Name') {
      if (token.value === 'true') return { kind: 'Boolean', value: true };
      if (token.value === 'false') return { kind: 'Boolean', value: false };
      if (token.value === 'null') return { kind: 'Null' };
      return { kind: 'Enum', value: token.value };
    }
    throw new Error(`unexpected value ${token.value}`);
  }
}

// -------------------------------------------------------------------------------------------
// executor
// -------------------------------------------------------------------------------------------

/** A view object handed to the resolvers; `__typename` is the GraphQL type name. */
interface View {
  __typename: string;
  [key: string]: unknown;
}

interface ExecContext {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: { message: string }[];
  validationFailed: boolean;
}

function valueFromAst(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'Variable':
      return variables[node.name];
    case 'Int':
    case 'Float':
    case 'String':
    case 'Boolean':
    case 'Enum':
      return node.value;
    case 'Null':
      return null;
    case 'List':
      return node.values.map((child) => valueFromAst(child, variables));
    case 'Object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueFromAst(field.value, variables);
      return out;
    }
  }
}

function argumentsOf(field: { arguments: ArgumentNode[] }, ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.arguments) out[arg.name] = valueFromAst(arg.value, ctx.variables);
  return out;
}

/** Whether a field or fragment survives its @skip/@include directives. */
function directivesAllow(directives: DirectiveNode[], ctx: ExecContext): boolean {
  for (const directive of directives) {
    const args = argumentsOf(directive, ctx);
    if (directive.name === 'skip' && args.if === true) return false;
    if (directive.name === 'include' && args.if === false) return false;
  }
  return true;
}

/** The named type inside a possibly wrapped type string, e.g. "[Issue!]!" -> "Issue". */
function namedTypeOf(type: string): string {
  let text = type;
  while (text.endsWith('!')) text = text.slice(0, -1);
  while (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  while (text.endsWith('!')) text = text.slice(0, -1);
  return text;
}

function isListType(type: string): boolean {
  let text = type;
  while (text.endsWith('!')) text = text.slice(0, -1);
  return text.startsWith('[');
}

function fieldDefOf(typeName: string, fieldName: string): FieldDef | undefined {
  const def = SCHEMA[typeName];
  if (def?.fields === undefined) return undefined;
  return def.fields.find((field) => field.name === fieldName);
}

function encodeCursor(number: number): string {
  return Buffer.from(String(number), 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const value = Number(text);
    return Number.isInteger(value) ? value : null;
  } catch {
    return null;
  }
}

function pageInfoFor<T extends { number: number }>(all: readonly T[], start: number, end: number): View {
  const first = all[start];
  const last = all[end - 1];
  return {
    __typename: 'PageInfo',
    hasNextPage: end < all.length,
    hasPreviousPage: start > 0,
    startCursor: first === undefined ? null : encodeCursor(first.number),
    endCursor: last === undefined ? null : encodeCursor(last.number),
  };
}

function stampOf(seq: number): string {
  return new Date((1_700_000_000 + seq) * 1000).toISOString();
}

function userView(store: Store): View {
  return { __typename: 'User', store, identity: store.viewer };
}

function repoView(store: Store, repo: Repo): View {
  return { __typename: 'Repository', store, repo };
}

function issueView(store: Store, repo: Repo, issue: Issue): View {
  return { __typename: 'Issue', store, repo, issue };
}

function pullView(store: Store, repo: Repo, pull: Pull): View {
  return { __typename: 'PullRequest', store, repo, pull };
}

function issueConnection(store: Store, repo: Repo, args: Record<string, unknown>): View {
  let issues = [...repo.issues];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
  const direction = (orderBy.direction ?? 'DESC') as string;
  issues.sort((a, b) => (direction === 'ASC' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
  const after = decodeCursor(args.after);
  let start = 0;
  if (after !== null) {
    const index = issues.findIndex((issue) => issue.number === after);
    if (index >= 0) start = index + 1;
  }
  const first = typeof args.first === 'number' ? args.first : issues.length;
  const end = Math.min(issues.length, start + Math.max(0, first));
  const page = issues.slice(start, end);
  return {
    __typename: 'IssueConnection',
    edges: page.map((issue) => ({ __typename: 'IssueEdge', node: issueView(store, repo, issue), cursor: encodeCursor(issue.number) })),
    nodes: page.map((issue) => issueView(store, repo, issue)),
    pageInfo: pageInfoFor(issues, start, end),
    totalCount: issues.length,
  };
}

function pullStateOf(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullConnection(store: Store, repo: Repo, args: Record<string, unknown>): View {
  let pulls = [...repo.pulls];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state)));
    pulls = pulls.filter((pull) => wanted.has(pullStateOf(pull)));
  }
  pulls.sort((a, b) => b.createdSeq - a.createdSeq);
  const after = decodeCursor(args.after);
  let start = 0;
  if (after !== null) {
    const index = pulls.findIndex((pull) => pull.number === after);
    if (index >= 0) start = index + 1;
  }
  const first = typeof args.first === 'number' ? args.first : pulls.length;
  const end = Math.min(pulls.length, start + Math.max(0, first));
  const page = pulls.slice(start, end);
  return {
    __typename: 'PullRequestConnection',
    edges: page.map((pull) => ({ __typename: 'PullRequestEdge', node: pullView(store, repo, pull), cursor: encodeCursor(pull.number) })),
    nodes: page.map((pull) => pullView(store, repo, pull)),
    pageInfo: pageInfoFor(pulls, start, end),
    totalCount: pulls.length,
  };
}

function fileConnection(store: Store, repo: Repo, pull: Pull, args: Record<string, unknown>): View {
  const headTip = store.getRef(repo, `refs/heads/${pull.head}`);
  const baseTip = store.getRef(repo, `refs/heads/${pull.base}`);
  let files: { path: string; additions: number; deletions: number; changeType: string }[] = [];
  if (headTip !== undefined && baseTip !== undefined) {
    const base = mergeBase(headTip, baseTip, (oid) => repo.objects.get(oid));
    const baseTree = base === null ? null : store.treeOf(repo, base);
    const headTree = store.treeOf(repo, headTip);
    if (headTree !== null) {
      files = store.diffTrees(repo, baseTree, headTree).map((change) => ({
        path: change.path,
        additions: change.additions,
        deletions: change.deletions,
        changeType: change.status === 'added' ? 'ADDED' : change.status === 'removed' ? 'REMOVED' : 'MODIFIED',
      }));
    }
  }
  const first = typeof args.first === 'number' ? args.first : files.length;
  const page = files.slice(0, Math.max(0, first));
  return {
    __typename: 'PullRequestChangedFileConnection',
    edges: page.map((file, index) => ({
      __typename: 'PullRequestChangedFileEdge',
      node: { __typename: 'PullRequestChangedFile', ...file },
      cursor: encodeCursor(index + 1),
    })),
    nodes: page.map((file) => ({ __typename: 'PullRequestChangedFile', ...file })),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: page.length < files.length,
      hasPreviousPage: false,
      startCursor: page.length > 0 ? encodeCursor(1) : null,
      endCursor: page.length > 0 ? encodeCursor(page.length) : null,
    },
    totalCount: files.length,
  };
}

/** A nested __Type value for a type string like "[Issue!]!" (for introspection). */
function typeRefView(type: string): View {
  const parse = (text: string): View => {
    if (text.endsWith('!')) {
      return { __typename: '__Type', kind: 'NON_NULL', name: null, ofType: parse(text.slice(0, -1)) };
    }
    if (text.startsWith('[') && text.endsWith(']')) {
      return { __typename: '__Type', kind: 'LIST', name: null, ofType: parse(text.slice(1, -1)) };
    }
    const def = SCHEMA[text];
    return { __typename: '__Type', kind: def?.kind ?? 'SCALAR', name: text, def };
  };
  return parse(type);
}

function fieldView(field: FieldDef): View {
  return {
    __typename: '__Field',
    name: field.name,
    description: field.description ?? null,
    args: (field.args ?? []).map((arg) => ({
      __typename: '__InputValue',
      name: arg.name,
      description: null,
      type: typeRefView(arg.type),
      defaultValue: arg.defaultValue === undefined ? null : JSON.stringify(arg.defaultValue),
    })),
    type: typeRefView(field.type),
    isDeprecated: false,
    deprecationReason: null,
  };
}

/** Resolve one field on a view, or throw when the value cannot be produced. */
function resolveField(parentType: string, parent: View, fieldName: string, args: Record<string, unknown>, ctx: ExecContext): unknown {
  const store = ctx.store;
  switch (parentType) {
    case 'Query': {
      if (fieldName === 'viewer') return userView(store);
      if (fieldName === 'repository') {
        const owner = String(args.owner ?? '');
        const name = String(args.name ?? '');
        const repo = store.getRepo(owner, name);
        return repo === undefined ? null : repoView(store, repo);
      }
      if (fieldName === 'node') {
        const parsed = parseGid(String(args.id ?? ''));
        if (parsed === null) return null;
        if (parsed.type === 'Repository') {
          const [owner, name] = parsed.key.split('/');
          const repo = owner !== undefined && name !== undefined ? store.getRepo(owner, name) : undefined;
          return repo === undefined ? null : repoView(store, repo);
        }
        if (parsed.type === 'Issue') {
          const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(parsed.key);
          if (match === null) return null;
          const repo = store.getRepo(match[1] as string, match[2] as string);
          const issue = repo === undefined ? undefined : store.getIssue(repo, Number(match[3]));
          return issue === undefined || repo === undefined ? null : issueView(store, repo, issue);
        }
        if (parsed.type === 'PullRequest') {
          const match = /^([^/]+)\/([^!]+)!(\d+)$/.exec(parsed.key);
          if (match === null) return null;
          const repo = store.getRepo(match[1] as string, match[2] as string);
          const pull = repo === undefined ? undefined : store.getPull(repo, Number(match[3]));
          return pull === undefined || repo === undefined ? null : pullView(store, repo, pull);
        }
        return null;
      }
      if (fieldName === '__type') {
        const typeName = String(args.name ?? '');
        const def = SCHEMA[typeName];
        return def === undefined ? null : { __typename: '__Type', kind: def.kind, name: typeName, def };
      }
      if (fieldName === '__schema') return { __typename: '__Schema' };
      break;
    }
    case 'Mutation': {
      if (fieldName === 'createIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = parseGid(String(input.repositoryId ?? ''));
        if (parsed === null || parsed.type !== 'Repository') throw new Error('repositoryId does not name a repository');
        const [owner, name] = parsed.key.split('/');
        const repo = owner !== undefined && name !== undefined ? store.getRepo(owner, name) : undefined;
        if (repo === undefined) throw new Error('repository not found');
        const issue = store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
        return { __typename: 'CreateIssuePayload', issue: issueView(store, repo, issue), clientMutationId: (input.clientMutationId as string) ?? null };
      }
      if (fieldName === 'closeIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = parseGid(String(input.issueId ?? ''));
        if (parsed === null || parsed.type !== 'Issue') throw new Error('issueId does not name an issue');
        const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(parsed.key);
        if (match === null) throw new Error('issueId does not name an issue');
        const repo = store.getRepo(match[1] as string, match[2] as string);
        const issue = repo === undefined ? undefined : store.getIssue(repo, Number(match[3]));
        if (issue === undefined || repo === undefined) throw new Error('issue not found');
        issue.state = 'closed';
        return { __typename: 'CloseIssuePayload', issue: issueView(store, repo, issue), clientMutationId: (input.clientMutationId as string) ?? null };
      }
      if (fieldName === 'createPullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = parseGid(String(input.repositoryId ?? ''));
        if (parsed === null || parsed.type !== 'Repository') throw new Error('repositoryId does not name a repository');
        const [owner, name] = parsed.key.split('/');
        const repo = owner !== undefined && name !== undefined ? store.getRepo(owner, name) : undefined;
        if (repo === undefined) throw new Error('repository not found');
        const pull = store.createPull(repo, String(input.title ?? ''), String(input.body ?? ''), String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
        if (pull === null) throw new Error('a pull request already exists for this head and base');
        return { __typename: 'CreatePullRequestPayload', pullRequest: pullView(store, repo, pull), clientMutationId: (input.clientMutationId as string) ?? null };
      }
      if (fieldName === 'mergePullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = parseGid(String(input.pullRequestId ?? ''));
        if (parsed === null || parsed.type !== 'PullRequest') throw new Error('pullRequestId does not name a pull request');
        const match = /^([^/]+)\/([^!]+)!(\d+)$/.exec(parsed.key);
        if (match === null) throw new Error('pullRequestId does not name a pull request');
        const repo = store.getRepo(match[1] as string, match[2] as string);
        const pull = repo === undefined ? undefined : store.getPull(repo, Number(match[3]));
        if (pull === undefined || repo === undefined) throw new Error('pull request not found');
        store.mergePull(repo, pull);
        return { __typename: 'MergePullRequestPayload', pullRequest: pullView(store, repo, pull), clientMutationId: (input.clientMutationId as string) ?? null };
      }
      if (fieldName === 'addComment') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = parseGid(String(input.subjectId ?? ''));
        if (parsed === null || parsed.type !== 'Issue') throw new Error('subjectId does not name an issue');
        const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(parsed.key);
        if (match === null) throw new Error('subjectId does not name an issue');
        const repo = store.getRepo(match[1] as string, match[2] as string);
        const issue = repo === undefined ? undefined : store.getIssue(repo, Number(match[3]));
        if (issue === undefined || repo === undefined) throw new Error('issue not found');
        const comment = store.addComment(repo, issue, String(input.body ?? ''));
        const commentView: View = {
          __typename: 'IssueComment',
          store,
          repo,
          issue,
          comment,
          id: gid('IssueComment', `${repo.owner}/${repo.name}#${issue.number}/${comment.id}`),
        };
        return {
          __typename: 'AddCommentPayload',
          commentEdge: { __typename: 'IssueCommentEdge', node: commentView, cursor: encodeCursor(comment.id) },
          subject: issueView(store, repo, issue),
          clientMutationId: (input.clientMutationId as string) ?? null,
        };
      }
      break;
    }
    case 'User': {
      const identity = parent.identity as { login: string; id: number; name: string; email: string };
      if (fieldName === 'id') return gid('User', identity.login);
      if (fieldName === 'databaseId') return identity.id;
      if (fieldName === 'login') return identity.login;
      if (fieldName === 'name') return identity.name;
      if (fieldName === 'email') return identity.email;
      break;
    }
    case 'Repository': {
      const repo = parent.repo as Repo;
      if (fieldName === 'id') return gid('Repository', `${repo.owner}/${repo.name}`);
      if (fieldName === 'databaseId') return repo.id;
      if (fieldName === 'name') return repo.name;
      if (fieldName === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (fieldName === 'owner') return userView(store);
      if (fieldName === 'defaultBranchRef') return { __typename: 'Ref', name: repo.defaultBranch, prefix: 'refs/heads/' };
      if (fieldName === 'viewerPermission') return 'ADMIN';
      if (fieldName === 'hasIssuesEnabled') return true;
      if (fieldName === 'issue') {
        const issue = store.getIssue(repo, Number(args.number));
        return issue === undefined ? null : issueView(store, repo, issue);
      }
      if (fieldName === 'issues') return issueConnection(store, repo, args);
      if (fieldName === 'pullRequests') return pullConnection(store, repo, args);
      if (fieldName === 'pullRequest') {
        const pull = store.getPull(repo, Number(args.number));
        return pull === undefined ? null : pullView(store, repo, pull);
      }
      break;
    }
    case 'Issue': {
      const repo = parent.repo as Repo;
      const issue = parent.issue as Issue;
      if (fieldName === 'id') return gid('Issue', `${repo.owner}/${repo.name}#${issue.number}`);
      if (fieldName === 'databaseId') return issue.id;
      if (fieldName === 'number') return issue.number;
      if (fieldName === 'title') return issue.title;
      if (fieldName === 'body') return issue.body;
      if (fieldName === 'state') return issue.state.toUpperCase();
      if (fieldName === 'author') return userView(store);
      if (fieldName === 'createdAt') return stampOf(issue.createdSeq);
      if (fieldName === 'updatedAt') return stampOf(issue.createdSeq);
      if (fieldName === 'comments') {
        const first = typeof args.first === 'number' ? args.first : issue.comments.length;
        const page = issue.comments.slice(0, Math.max(0, first));
        return {
          __typename: 'IssueCommentConnection',
          edges: page.map((comment) => ({
            __typename: 'IssueCommentEdge',
            node: { __typename: 'IssueComment', store, repo, issue, comment, id: gid('IssueComment', `${repo.owner}/${repo.name}#${issue.number}/${comment.id}`) },
            cursor: encodeCursor(comment.id),
          })),
          nodes: page.map((comment) => ({ __typename: 'IssueComment', store, repo, issue, comment, id: gid('IssueComment', `${repo.owner}/${repo.name}#${issue.number}/${comment.id}`) })),
          pageInfo: {
            __typename: 'PageInfo',
            hasNextPage: page.length < issue.comments.length,
            hasPreviousPage: false,
            startCursor: page.length > 0 ? encodeCursor(page[0]?.id ?? 0) : null,
            endCursor: page.length > 0 ? encodeCursor(page[page.length - 1]?.id ?? 0) : null,
          },
          totalCount: issue.comments.length,
        };
      }
      if (fieldName === 'labels') {
        const first = typeof args.first === 'number' ? args.first : issue.labels.length;
        const page = issue.labels.slice(0, Math.max(0, first));
        return {
          __typename: 'LabelConnection',
          edges: page.map((label) => ({
            __typename: 'LabelEdge',
            node: { __typename: 'Label', id: gid('Label', `${repo.owner}/${repo.name}/${label.name}`), name: label.name, color: label.color, description: '' },
            cursor: encodeCursor(label.id),
          })),
          nodes: page.map((label) => ({ __typename: 'Label', id: gid('Label', `${repo.owner}/${repo.name}/${label.name}`), name: label.name, color: label.color, description: '' })),
          pageInfo: {
            __typename: 'PageInfo',
            hasNextPage: page.length < issue.labels.length,
            hasPreviousPage: false,
            startCursor: page.length > 0 ? encodeCursor(page[0]?.id ?? 0) : null,
            endCursor: page.length > 0 ? encodeCursor(page[page.length - 1]?.id ?? 0) : null,
          },
          totalCount: issue.labels.length,
        };
      }
      break;
    }
    case 'PullRequest': {
      const repo = parent.repo as Repo;
      const pull = parent.pull as Pull;
      if (fieldName === 'id') return gid('PullRequest', `${repo.owner}/${repo.name}!${pull.number}`);
      if (fieldName === 'databaseId') return pull.id;
      if (fieldName === 'number') return pull.number;
      if (fieldName === 'title') return pull.title;
      if (fieldName === 'body') return pull.body;
      if (fieldName === 'state') return pullStateOf(pull);
      if (fieldName === 'merged') return pull.merged;
      if (fieldName === 'mergeable') {
        if (pull.merged) return 'MERGEABLE';
        if (pull.state !== 'open') return 'UNKNOWN';
        return store.pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
      }
      if (fieldName === 'headRefName') return pull.head;
      if (fieldName === 'baseRefName') return pull.base;
      if (fieldName === 'headRefOid') return store.getRef(repo, `refs/heads/${pull.head}`) ?? null;
      if (fieldName === 'baseRefOid') return store.getRef(repo, `refs/heads/${pull.base}`) ?? null;
      if (fieldName === 'author') return userView(store);
      if (fieldName === 'createdAt') return stampOf(pull.createdSeq);
      if (fieldName === 'updatedAt') return stampOf(pull.createdSeq);
      if (fieldName === 'mergedAt') return pull.mergedAt;
      if (fieldName === 'files') return fileConnection(store, repo, pull, args);
      break;
    }
    case 'Ref': {
      if (fieldName === 'id') return gid('Ref', `refs/heads/${String(parent.name ?? '')}`);
      if (fieldName === 'name') return parent.name ?? null;
      if (fieldName === 'prefix') return parent.prefix ?? null;
      break;
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'IssueCommentConnection':
    case 'LabelConnection':
    case 'PullRequestChangedFileConnection': {
      if (fieldName === 'edges') return parent.edges ?? [];
      if (fieldName === 'nodes') return parent.nodes ?? [];
      if (fieldName === 'pageInfo') return parent.pageInfo ?? null;
      if (fieldName === 'totalCount') return parent.totalCount ?? 0;
      break;
    }
    case 'IssueEdge':
    case 'PullRequestEdge':
    case 'IssueCommentEdge':
    case 'LabelEdge':
    case 'PullRequestChangedFileEdge': {
      if (fieldName === 'node') return parent.node ?? null;
      if (fieldName === 'cursor') return parent.cursor ?? null;
      break;
    }
    case 'IssueComment': {
      const repo = parent.repo as Repo;
      const issue = parent.issue as Issue;
      const comment = parent.comment as { id: number; body: string; createdSeq: number };
      if (fieldName === 'id') return parent.id ?? gid('IssueComment', `${repo.owner}/${repo.name}#${issue.number}/${comment.id}`);
      if (fieldName === 'databaseId') return comment.id;
      if (fieldName === 'body') return comment.body;
      if (fieldName === 'author') return userView(store);
      if (fieldName === 'createdAt') return stampOf(comment.createdSeq);
      if (fieldName === 'updatedAt') return stampOf(comment.createdSeq);
      break;
    }
    case 'Label': {
      if (fieldName === 'id') return parent.id ?? null;
      if (fieldName === 'name') return parent.name ?? null;
      if (fieldName === 'color') return parent.color ?? null;
      if (fieldName === 'description') return parent.description ?? null;
      break;
    }
    case 'PullRequestChangedFile': {
      if (fieldName === 'path') return parent.path ?? null;
      if (fieldName === 'additions') return parent.additions ?? 0;
      if (fieldName === 'deletions') return parent.deletions ?? 0;
      if (fieldName === 'changeType') return parent.changeType ?? null;
      break;
    }
    case 'PageInfo': {
      if (fieldName === 'hasNextPage') return parent.hasNextPage ?? false;
      if (fieldName === 'hasPreviousPage') return parent.hasPreviousPage ?? false;
      if (fieldName === 'startCursor') return parent.startCursor ?? null;
      if (fieldName === 'endCursor') return parent.endCursor ?? null;
      break;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (fieldName === 'issue') return parent.issue ?? null;
      if (fieldName === 'clientMutationId') return parent.clientMutationId ?? null;
      break;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (fieldName === 'pullRequest') return parent.pullRequest ?? null;
      if (fieldName === 'clientMutationId') return parent.clientMutationId ?? null;
      break;
    }
    case 'AddCommentPayload': {
      if (fieldName === 'commentEdge') return parent.commentEdge ?? null;
      if (fieldName === 'subject') return parent.subject ?? null;
      if (fieldName === 'clientMutationId') return parent.clientMutationId ?? null;
      break;
    }
    case '__Schema': {
      if (fieldName === 'description') return null;
      if (fieldName === 'types') {
        return Object.entries(SCHEMA).map(([name, def]) => ({ __typename: '__Type', kind: def.kind, name, def }));
      }
      if (fieldName === 'queryType') return { __typename: '__Type', kind: 'OBJECT', name: 'Query', def: SCHEMA.Query };
      if (fieldName === 'mutationType') return { __typename: '__Type', kind: 'OBJECT', name: 'Mutation', def: SCHEMA.Mutation };
      if (fieldName === 'directives') return [];
      break;
    }
    case '__Type': {
      const def = parent.def as TypeDef | undefined;
      const ofType = parent.ofType as View | undefined;
      if (fieldName === 'kind') return parent.kind ?? def?.kind ?? null;
      if (fieldName === 'name') return parent.name ?? def?.name ?? null;
      if (fieldName === 'description') return def?.description ?? null;
      if (fieldName === 'fields') {
        if (def === undefined || def.fields === undefined) return null;
        return def.fields.map((field) => fieldView(field));
      }
      if (fieldName === 'interfaces') return [];
      if (fieldName === 'possibleTypes') return [];
      if (fieldName === 'enumValues') {
        if (def === undefined || def.enumValues === undefined) return null;
        return def.enumValues.map((name) => ({ __typename: '__EnumValue', name, description: null, isDeprecated: false, deprecationReason: null }));
      }
      if (fieldName === 'inputFields') {
        if (def === undefined || def.inputFields === undefined) return null;
        return def.inputFields.map((input) => ({
          __typename: '__InputValue',
          name: input.name,
          description: null,
          type: typeRefView(input.type),
          defaultValue: input.defaultValue === undefined ? null : JSON.stringify(input.defaultValue),
        }));
      }
      if (fieldName === 'ofType') return ofType ?? null;
      break;
    }
    case '__Field': {
      if (fieldName === 'name') return parent.name ?? null;
      if (fieldName === 'description') return parent.description ?? null;
      if (fieldName === 'args') return parent.args ?? [];
      if (fieldName === 'type') return parent.type ?? null;
      if (fieldName === 'isDeprecated') return parent.isDeprecated ?? false;
      if (fieldName === 'deprecationReason') return parent.deprecationReason ?? null;
      break;
    }
    case '__InputValue': {
      if (fieldName === 'name') return parent.name ?? null;
      if (fieldName === 'description') return parent.description ?? null;
      if (fieldName === 'type') return parent.type ?? null;
      if (fieldName === 'defaultValue') return parent.defaultValue ?? null;
      break;
    }
    case '__EnumValue': {
      if (fieldName === 'name') return parent.name ?? null;
      if (fieldName === 'description') return parent.description ?? null;
      if (fieldName === 'isDeprecated') return parent.isDeprecated ?? false;
      if (fieldName === 'deprecationReason') return parent.deprecationReason ?? null;
      break;
    }
    case '__Directive': {
      if (fieldName === 'name') return parent.name ?? null;
      if (fieldName === 'description') return parent.description ?? null;
      if (fieldName === 'locations') return parent.locations ?? [];
      if (fieldName === 'args') return parent.args ?? [];
      break;
    }
    default: {
      // A plain value object (a payload, a connection edge, a type reference):
      // read the property straight off it.
      if (parent !== null && typeof parent === 'object' && fieldName in parent) {
        return (parent as Record<string, unknown>)[fieldName] ?? null;
      }
      break;
    }
  }
  return undefined;
}

/** Resolve a value against a sub-selection, honouring lists and object types. */
function completeValue(value: unknown, fieldType: string, selectionSet: SelectionNode[] | undefined, ctx: ExecContext): unknown {
  if (value === null || value === undefined) return null;
  if (selectionSet === undefined || selectionSet.length === 0) return value;
  const named = namedTypeOf(fieldType);
  if (isListType(fieldType)) {
    if (!Array.isArray(value)) return null;
    return value.map((item) => completeValue(item, fieldType.replace(/^\[/, '').replace(/\]!?$/, ''), selectionSet, ctx));
  }
  const def = SCHEMA[named];
  if (def === undefined || (def.kind !== 'OBJECT' && def.kind !== 'INTERFACE')) return value;
  if (typeof value !== 'object') return null;
  const view = value as View;
  const effectiveType = typeof view.__typename === 'string' ? view.__typename : named;
  return executeSelectionSet(selectionSet, effectiveType, view, ctx);
}

function executeSelectionSet(selections: SelectionNode[], parentType: string, parent: View, ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'FragmentSpread') {
      if (!directivesAllow(selection.directives, ctx)) continue;
      const fragment = ctx.fragments.get(selection.name);
      if (fragment === undefined) {
        ctx.errors.push({ message: `Unknown fragment "${selection.name}".` });
        ctx.validationFailed = true;
        continue;
      }
      // A fragment applies when its type condition is the parent type or the
      // value's own type.
      const condition = fragment.typeCondition;
      const valueType = typeof parent.__typename === 'string' ? parent.__typename : parentType;
      if (condition !== parentType && condition !== valueType) continue;
      Object.assign(out, executeSelectionSet(fragment.selectionSet, condition, parent, ctx));
      continue;
    }
    if (selection.kind === 'InlineFragment') {
      if (!directivesAllow(selection.directives, ctx)) continue;
      const condition = selection.typeCondition;
      const valueType = typeof parent.__typename === 'string' ? parent.__typename : parentType;
      if (condition !== undefined && condition !== parentType && condition !== valueType) continue;
      Object.assign(out, executeSelectionSet(selection.selectionSet, condition ?? parentType, parent, ctx));
      continue;
    }
    // A field.
    if (!directivesAllow(selection.directives, ctx)) continue;
    const responseKey = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[responseKey] = typeof parent.__typename === 'string' ? parent.__typename : parentType;
      continue;
    }
    const def = fieldDefOf(parentType, selection.name);
    if (def === undefined) {
      // The field may live on the value's concrete type (an interface parent).
      const valueType = typeof parent.__typename === 'string' ? parent.__typename : null;
      const concrete = valueType !== null && valueType !== parentType ? fieldDefOf(valueType, selection.name) : undefined;
      if (concrete === undefined) {
        ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${parentType}".` });
        ctx.validationFailed = true;
        out[responseKey] = null;
        continue;
      }
      const args = argumentsOf(selection, ctx);
      let value: unknown;
      try {
        value = resolveField(valueType as string, parent, selection.name, args, ctx);
      } catch (error) {
        ctx.errors.push({ message: error instanceof Error ? error.message : 'field error' });
        out[responseKey] = null;
        continue;
      }
      if (value === undefined) {
        ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${parentType}".` });
        ctx.validationFailed = true;
        out[responseKey] = null;
        continue;
      }
      out[responseKey] = completeValue(value, concrete.type, selection.selectionSet, ctx);
      continue;
    }
    const args = argumentsOf(selection, ctx);
    let value: unknown;
    try {
      value = resolveField(parentType, parent, selection.name, args, ctx);
    } catch (error) {
      ctx.errors.push({ message: error instanceof Error ? error.message : 'field error' });
      out[responseKey] = null;
      continue;
    }
    if (value === undefined) {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${parentType}".` });
      ctx.validationFailed = true;
      out[responseKey] = null;
      continue;
    }
    out[responseKey] = completeValue(value, def.type, selection.selectionSet, ctx);
  }
  return out;
}

function executeOperation(store: Store, body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { errors: [{ message: 'the request body must be a JSON object with a query' }] };
  }
  const request = body as Record<string, unknown>;
  const query = request.query;
  if (typeof query !== 'string' || query === '') {
    return { errors: [{ message: 'the query must be a non-empty string' }] };
  }
  let document: DocumentNode;
  try {
    document = new Parser(query).parseDocument();
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : 'failed to parse the query' }] };
  }
  const operationName = typeof request.operationName === 'string' ? request.operationName : undefined;
  let operation: OperationNode | undefined;
  if (operationName !== undefined) {
    operation = document.operations.find((candidate) => candidate.name === operationName);
  } else if (document.operations.length === 1) {
    operation = document.operations[0];
  } else {
    operation = document.operations.find((candidate) => candidate.name === undefined) ?? document.operations[0];
  }
  if (operation === undefined) {
    return { errors: [{ message: operationName !== undefined ? `unknown operation "${operationName}"` : 'no operation found' }] };
  }
  const supplied = (request.variables ?? {}) as Record<string, unknown>;
  const variables: Record<string, unknown> = {};
  for (const definition of operation.variableDefinitions) {
    if (definition.name in supplied) {
      variables[definition.name] = supplied[definition.name];
    } else if (definition.defaultValue !== undefined) {
      variables[definition.name] = valueFromAst(definition.defaultValue, {});
    }
  }
  for (const [name, value] of Object.entries(supplied)) {
    if (!(name in variables)) variables[name] = value;
  }
  const ctx: ExecContext = { store, variables, fragments: document.fragments, errors: [], validationFailed: false };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const root: View = { __typename: rootType };
  const data = executeSelectionSet(operation.selectionSet, rootType, root, ctx);
  if (ctx.validationFailed) return { data: null, errors: ctx.errors };
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

function jsonResponse(status: number, value: unknown): GitResponse {
  return {
    status,
    headers: { 'Content-Type': 'application/json' },
    body: Buffer.from(JSON.stringify(value), 'utf8'),
  };
}

export function handleGraphql(store: Store, req: GitRequest): GitResponse | null {
  if (req.pathname !== '/api/graphql') return null;
  if (!store.isAuthorized(req)) return jsonResponse(401, { message: 'Requires authentication' });
  let body: unknown;
  try {
    body = JSON.parse(req.body.toString('utf8'));
  } catch {
    return jsonResponse(400, { message: 'malformed JSON body' });
  }
  if (Array.isArray(body)) {
    return jsonResponse(200, body.map((item) => executeOperation(store, item)));
  }
  return jsonResponse(200, executeOperation(store, body));
}
