"use strict";

import { InMemoryStore } from './store.ts';
import { createHash } from 'node:crypto';

export interface GraphQLRequest {
  query: string;
  variables?: Record<string, any>;
}

export interface GraphQLResponse<T = unknown> {
  status: number;
  headers: Record<string, string>;
  errors: { message: string; locations?: { line: number; column: number }[]; path?: (string | number)[] }[];
  data: T | null;
  text: string;
}

export class GraphQLClient {
  private store: InMemoryStore;
  private token: string;
  private timeoutMs: number;

  constructor(token: string, timeoutMs: number = 5000) {
    this.store = new InMemoryStore();
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  async request<T>(request: GraphQLRequest, options: { signal?: AbortSignal } = {}): Promise<GraphQLResponse<T>> {
    const url = `${process.env.MAKEFUN_ENV_URL || 'http://localhost:8080'}/api/graphql`;
    const headers = this.buildHeaders();
    
    const controller = new AbortController();
    const signal = options.signal || AbortSignal.timeout(this.timeoutMs);
    signal.addEventListener('abort', () => controller.abort());
    
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      
      const text = await response.text();
      let parsedBody = null;
      let errors: { message: string; locations?: any[]; path?: (string | number)[] }[] = [];
      
      if (text.trim()) {
        try {
          const body = JSON.parse(text);
          parsedBody = body.data || null;
          errors = body.errors || [];
        } catch (parseError) {
          errors.push({ message: `GraphQL parse error: ${parseError instanceof Error ? parseError.message : String(parseError)}` });
        }
      }
      
      return {
        status: response.status,
        headers: this.extractHeaders(response.headers),
        errors,
        data: parsedBody,
        text,
      };
    } catch (error) {
      throw new Error(`GraphQL request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'accept': 'application/json',
      'content-type': 'application/json',
      'user-agent': 'makefun-graphql-client/1.0',
    };
    
    if (this.token) {
      headers.authorization = `Bearer ${this.token}`;
    }
    
    return headers;
  }

  private extractHeaders(fetchHeaders: Headers): Record<string, string> {
    const headers: Record<string, string> = {};
    fetchHeaders.forEach((value, key) => {
      headers[key] = value;
    });
    return headers;
  }

  encodeGlobalId(type: string, id: number | string): string {
    const payload = `${type}:${id}`;
    return Buffer.from(payload).toString('base64');
  }

  decodeGlobalId(globalId: string): { type: string; id: string } {
    try {
      const decoded = Buffer.from(globalId, 'base64').toString('utf8');
      const [type, ...idParts] = decoded.split(':');
      return { type, id: idParts.join(':') };
    } catch {
      return { type: 'unknown', id: '' };
    }
  }

  async queryViewer<T>(options: { signal?: AbortSignal } = {}): Promise<GraphQLResponse<T>> {
    const request: GraphQLRequest = {
      query: `
        query {
          viewer {
            login
          }
        }
      `,
    };
    return this.request<T>(request, options);
  }

  async queryRepository<T>(owner: string, name: string, options: { signal?: AbortSignal } = {}): Promise<GraphQLResponse<T>> {
    const request: GraphQLRequest = {
      query: `
        query GetRepository($owner: String!, $name: String!) {
          repository(owner: $owner, name: $name) {
            id
            databaseId
            name
            nameWithOwner
            owner {
              login
            }
            defaultBranchRef {
              name
            }
            viewerPermission
            hasIssuesEnabled
            issue(number: 1) {
              id
              number
              title
              state
              body
            }
            issues(first: 10, states: [OPEN], orderBy: {field: CREATED_AT, direction: DESC}) {
              nodes {
                id
                number
                title
                state
                body
              }
            }
            pullRequests(first: 10) {
              nodes {
                id
                number
                headRefName
                baseRefName
                mergeable
                state
                merged
                files(first: 10) {
                  nodes {
                    path
                  }
                }
              }
            }
            pullRequest(number: 1) {
              id
              number
              headRefName
              baseRefName
              mergeable
              state
              merged
              files(first: 10) {
                nodes {
                  path
                }
              }
            }
          }
        }
      `,
      variables: { owner, name },
    };
    return this.request<T>(request, options);
  }

  async queryIssueByNumber<T>(owner: string, name: string, number: number, options: { signal?: AbortSignal } = {}): Promise<GraphQLResponse<T>> {
    const request: GraphQLRequest = {
      query: `
        query GetIssue($owner: String!, $name: String!, $number: Int!) {
          repository(owner: $owner, name: $name) {
            issue(number: $number) {
              id
              number
              title
              state
              body
            }
          }
        }
      `,
      variables: { owner, name, number },
    };
    return this.request<T>(request, options);
  }

  async queryNodeRepository<T>(id: string, options: { signal?: AbortSignal } = {}): Promise<GraphQLResponse<T>> {
    const request: GraphQLRequest = {
      query: `
        query GetNode($id: ID!) {
          node(id: $id) {
            ... on Repository {
              name
              nameWithOwner
            }
          }
        }
      `,
      variables: { id },
    };
    return this.request<T>(request, options);
  }

  async queryIntrospectionTypes<T>(options: { signal?: AbortSignal } = {}): Promise<GraphQLResponse<T>> {
    const request: GraphQLRequest = {
      query: `
        query IntrospectTypes {
          Issue: __type(name: "Issue") {
            fields(includeDeprecated: true) {
              name
            }
          }
          PullRequest: __type(name: "PullRequest") {
            fields(includeDeprecated: true) {
              name
            }
          }
          Repository: __type(name: "Repository") {
            fields(includeDeprecated: true) {
              name
            }
          }
          SearchType: __type(name: "SearchType") {
            enumValues(includeDeprecated: true) {
              name
            }
          }
        }
      `,
    };
    return this.request<T>(request, options);
  }

  async queryIssuesPage<T>(owner: string, name: string, first: number, after?: string, options: { signal?: AbortSignal } = {}): Promise<GraphQLResponse<T>> {
    const variables: Record<string, any> = { owner, name, first };
    if (after !== undefined && after !== null) variables.after = after;
    else variables.after = null;
    
    const request: GraphQLRequest = {
      query: `
        query GetIssuesPage($owner: String!, $name: String!, $first: Int!, $after: String) {
          repository(owner: $owner, name: $name) {
            issues(first: $first, after: $after) {
              nodes {
                number
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        }
      `,
      variables,
    };
    return this.request<T>(request, options);
  }

  async createIssue<T>(repositoryId: string, title: string, body: string, options: { signal?: AbortSignal } = {}): Promise<GraphQLResponse<T>> {
    const request: GraphQLRequest = {
      query: `
        mutation CreateIssue($input: CreateIssueInput!) {
          createIssue(input: $input) {
            issue {
              number
              id
            }
          }
        }
      `,
      variables: {
        input: { repositoryId, title, body },
      },
    };
    return this.request<T>(request, options);
  }

  async closeIssue<T>(issueId: string, options: { signal?: AbortSignal } = {}): Promise<GraphQLResponse<T>> {
    const request: GraphQLRequest = {
      query: `
        mutation CloseIssue($input: CloseIssueInput!) {
          closeIssue(input: $input) {
            issue {
              number
              id
              state
            }
          }
        }
      `,
      variables: {
        input: { issueId },
      },
    };
    return this.request<T>(request, options);
  }

  async createPullRequest<T>(repositoryId: string, baseRefName: string, headRefName: string, title: string, body: string, options: { signal?: AbortSignal } = {}): Promise<GraphQLResponse<T>> {
    const request: GraphQLRequest = {
      query: `
        mutation CreatePullRequest($input: CreatePullRequestInput!) {
          createPullRequest(input: $input) {
            pullRequest {
              number
              id
              state
              headRefName
              baseRefName
            }
          }
        }
      `,
      variables: {
        input: { repositoryId, baseRefName, headRefName, title, body },
      },
    };
    return this.request<T>(request, options);
  }

  async mergePullRequest<T>(pullRequestId: string, mergeMethod: string = 'SQUASH', options: { signal?: AbortSignal } = {}): Promise<GraphQLResponse<T>> {
    const request: GraphQLRequest = {
      query: `
        mutation MergePullRequest($input: MergePullRequestInput!) {
          mergePullRequest(input: $input) {
            pullRequest {
              number
              merged
              state
            }
          }
        }
      `,
      variables: {
        input: { pullRequestId, mergeMethod },
      },
    };
    return this.request<T>(request, options);
  }

  async addComment<T>(subjectId: string, body: string, options: { signal?: AbortSignal } = {}): Promise<GraphQLResponse<T>> {
    const request: GraphQLRequest = {
      query: `
        mutation AddComment($input: AddCommentInput!) {
          addComment(input: $input) {
            commentEdge {
              node {
                id
                body
              }
            }
          }
        }
      `,
      variables: {
        input: { subjectId, body },
      },
    };
    return this.request<T>(request, options);
  }

  async queryInvalidField<T>(options: { signal?: AbortSignal } = {}): Promise<GraphQLResponse<T>> {
    const request: GraphQLRequest = {
      query: `
        query InvalidField {
          viewer {
            login
            noSuchField
          }
        }
      `,
    };
    return this.request<T>(request, options);
  }

  async queryUnauthenticated<T>(options: { signal?: AbortSignal } = {}): Promise<GraphQLResponse<T>> {
    const request: GraphQLRequest = {
      query: `
        query ViewerLogin {
          viewer {
            login
          }
        }
      `,
    };
    return this.request<T>(request, options);
  }

  batchRequests<T>(requests: GraphQLRequest[], options: { signal?: AbortSignal } = {}): Promise<GraphQLResponse<T>[]>
  {
    const promises = requests.map(req => this.request<T>(req, options));
    return Promise.all(promises);
  }
}
