"use strict";

import { InMemoryStore } from './store.ts';
import { createHash } from 'node:crypto';

export interface McpRequest {
  jsonrpc: "2.0";
  id?: unknown;
  method: string;
  params?: unknown;
}

export interface McpResponse {
  jsonrpc: "2.0";
  id?: unknown;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, any>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

export interface McpConnectionInfo {
  era: 'modern' | 'legacy';
  protocolVersion: string;
  supportedVersions?: string[];
  serverInfo?: {
    name: string;
    version: string;
  };
  capabilities?: {
    tools?: boolean;
  };
}

export interface McpDiscoverAttempt {
  status: number;
  errorCode?: number;
  errorMessage?: string;
}

export interface McpToolCallOutcome {
  isError?: boolean;
  content?: {
    type: string;
    text?: string;
    structuredContent?: unknown;
  }[];
  toolResult?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export class McpServer {
  private store: InMemoryStore;
  private viewer: string;
  private timeoutMs: number;
  private connections: Map<string, McpConnectionInfo>;
  private sessionCounter = 0;

  constructor(store: InMemoryStore, viewer: string, timeoutMs: number = 3000) {
    this.store = store;
    this.viewer = viewer;
    this.timeoutMs = timeoutMs;
    this.connections = new Map();
  }

  async handleRequest(request: McpRequest, options: { signal?: AbortSignal; sessionId?: string } = {}): Promise<McpResponse> {
    const controller = new AbortController();
    const signal = options.signal || AbortSignal.timeout(this.timeoutMs);
    signal.addEventListener('abort', () => controller.abort());
    
    try {
      if (request.method === 'initialize') {
        return await this.handleInitialize(request, options);
      } else if (request.method === 'notifications/initialized') {
        return await this.handleInitialized(request, options);
      } else if (request.method === 'server/discover') {
        return await this.handleDiscover(request, options);
      } else if (request.method === 'tools/list') {
        return await this.handleToolsList(request, options);
      } else if (request.method === 'tools/call') {
        return await this.handleToolCall(request, options);
      } else {
        return {
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32601,
            message: `Method not found: ${request.method}`,
          },
        };
      }
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32603,
          message: `Internal error: ${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }
  }

  private async handleInitialize(request: McpRequest, options: { signal?: AbortSignal; sessionId?: string } = {}): Promise<McpResponse> {
    const sessionId = options.sessionId || `session-${++this.sessionCounter}`;
    
    const connectionInfo: McpConnectionInfo = {
      era: 'legacy',
      protocolVersion: '2025-11-25',
      serverInfo: {
        name: 'makefun-github-core-clone-01',
        version: '0.1.0',
      },
      capabilities: {
        tools: {},
      },
    };
    
    this.connections.set(sessionId, connectionInfo);
    
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: connectionInfo,
    };
  }

  private async handleInitialized(request: McpRequest, options: { signal?: AbortSignal; sessionId?: string } = {}): Promise<McpResponse> {
    // Notifications carry no session: accept unconditionally, no session gate.
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: null,
    };
  }

  private async handleDiscover(request: McpRequest, options: { signal?: AbortSignal; sessionId?: string } = {}): Promise<McpResponse> {
    // No session-id gate: answer from the stored connection when present, else a default.
    const connectionInfo: McpConnectionInfo = (options.sessionId && this.connections.get(options.sessionId)) || {
      era: 'legacy',
      protocolVersion: '2025-11-25',
      serverInfo: { name: 'makefun-github-core-clone-01', version: '0.1.0' },
      capabilities: { tools: {} },
    };

    if (connectionInfo.era !== 'modern') {
      connectionInfo.era = 'modern';
    }
    
    connectionInfo.supportedVersions = ['2026-07-28', '2025-11-25'];
    
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: connectionInfo,
    };
  }

  private async handleToolsList(request: McpRequest, options: { signal?: AbortSignal; sessionId?: string } = {}): Promise<McpResponse> {
    // No session-id gate: tools/list answers identically on every call.
    const tools: McpTool[] = [
      {
        name: 'create_repo',
        description: 'Create a new repository',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Repository name' },
            description: { type: 'string', description: 'Repository description' },
            private: { type: 'boolean', description: 'Whether the repository should be private' },
          },
          required: ['name'],
        },
      },
      {
        name: 'get_repo',
        description: 'Get repository information',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
          },
          required: ['owner', 'repo'],
        },
      },
      {
        name: 'create_issue',
        description: 'Create an issue in a repository',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            title: { type: 'string', description: 'Issue title' },
            body: { type: 'string', description: 'Issue body' },
          },
          required: ['owner', 'repo', 'title'],
        },
      },
      {
        name: 'list_issues',
        description: 'List issues in a repository',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            state: { type: 'string', description: 'Issue state' },
          },
          required: ['owner', 'repo'],
        },
      },
      {
        name: 'create_pull_request',
        description: 'Create a pull request',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            title: { type: 'string', description: 'Pull request title' },
            head: { type: 'string', description: 'Head branch' },
            base: { type: 'string', description: 'Base branch' },
          },
          required: ['owner', 'repo', 'title', 'head', 'base'],
        },
      },
      {
        name: 'merge_pull_request',
        description: 'Merge a pull request',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            pull_number: { type: 'number', description: 'Pull request number' },
          },
          required: ['owner', 'repo', 'pull_number'],
        },
      },
    ];
    
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: { tools },
    };
  }

  private async handleToolCall(request: McpRequest, options: { signal?: AbortSignal; sessionId?: string } = {}): Promise<McpResponse> {
    // No session-id gate: tools/call is stateless.
    const sessionId = options.sessionId || 'stateless';
    const params = (request.params as Record<string, any>) || {};
    const toolName = typeof params.name === 'string' ? params.name : '';
    const tool = toolName ? this.getToolByName(toolName) : null;
    if (!tool) {
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32602,
          message: `Tool not found: ${toolName}`,
        },
      };
    }

    const rawArgs = (params.arguments && typeof params.arguments === 'object') ? params.arguments : params;
    const { args, missing } = this.mapArguments(tool, rawArgs);
    
    if (missing.length > 0) {
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32602,
          message: `Missing required arguments: ${missing.join(', ')}`,
        },
      };
    }
    
    try {
      const result = await this.executeTool(tool.name, args, sessionId);
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
        },
      };
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32603,
          message: `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }
  }

  private getToolByName(name: string): McpTool | null {
    const tools: McpTool[] = [
      {
        name: 'create_repo',
        description: 'Create a new repository',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Repository name' },
            description: { type: 'string', description: 'Repository description' },
            private: { type: 'boolean', description: 'Whether the repository should be private' },
          },
          required: ['name'],
        },
      },
      {
        name: 'get_repo',
        description: 'Get repository information',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
          },
          required: ['owner', 'repo'],
        },
      },
      {
        name: 'create_issue',
        description: 'Create an issue in a repository',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            title: { type: 'string', description: 'Issue title' },
            body: { type: 'string', description: 'Issue body' },
          },
          required: ['owner', 'repo', 'title'],
        },
      },
      {
        name: 'list_issues',
        description: 'List issues in a repository',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            state: { type: 'string', description: 'Issue state' },
          },
          required: ['owner', 'repo'],
        },
      },
      {
        name: 'create_pull_request',
        description: 'Create a pull request',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            title: { type: 'string', description: 'Pull request title' },
            head: { type: 'string', description: 'Head branch' },
            base: { type: 'string', description: 'Base branch' },
          },
          required: ['owner', 'repo', 'title', 'head', 'base'],
        },
      },
      {
        name: 'merge_pull_request',
        description: 'Merge a pull request',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            pull_number: { type: 'number', description: 'Pull request number' },
          },
          required: ['owner', 'repo', 'pull_number'],
        },
      },
    ];
    
    // Match tool names as a case-insensitive suffix (e.g. 'github.create_repo' matches 'create_repo').
    const lower = name.toLowerCase();
    return tools.find(tool => tool.name === name || tool.name.toLowerCase() === lower || lower.endsWith(tool.name.toLowerCase())) || null;
  }

  private mapArguments(tool: McpTool, params: Record<string, any>): { args: Record<string, any>; missing: string[] } {
    const properties = tool.inputSchema.properties || {};
    const required = tool.inputSchema.required || [];
    
    const args: Record<string, any> = {};
    const missing: string[] = [];
    
    for (const [key, schema] of Object.entries(properties)) {
      if (params[key] !== undefined) {
        args[key] = params[key];
      } else if (required.includes(key)) {
        missing.push(key);
      }
    }
    
    return { args, missing };
  }

  private async executeTool(toolName: string, args: Record<string, any>, sessionId: string): Promise<any> {
    switch (toolName) {
      case 'create_repo':
        return await this.executeCreateRepo(args, sessionId);
      case 'get_repo':
        return await this.executeGetRepo(args, sessionId);
      case 'create_issue':
        return await this.executeCreateIssue(args, sessionId);
      case 'list_issues':
        return await this.executeListIssues(args, sessionId);
      case 'create_pull_request':
        return await this.executeCreatePullRequest(args, sessionId);
      case 'merge_pull_request':
        return await this.executeMergePullRequest(args, sessionId);
      default:
        throw new Error(`Tool not implemented: ${toolName}`);
    }
  }

  private async executeCreateRepo(args: Record<string, any>, sessionId: string): Promise<any> {
    const { name, description, private: isPrivate = true } = args;
    
    const owner = this.viewer;
    const repoName = name;
    
    const repo = this.store.addRepository(owner, repoName, isPrivate, description || '');
    
    return {
      id: repo.id,
      name: repo.name,
      full_name: repo.full_name,
      private: repo.private,
      description: repo.description,
      default_branch: repo.default_branch,
    };
  }

  private async executeGetRepo(args: Record<string, any>, sessionId: string): Promise<any> {
    const { owner, repo } = args;
    
    const repository = this.store.getRepository(owner, repo);
    if (!repository) {
      throw new Error(`Repository not found: ${owner}/${repo}`);
    }
    
    return {
      id: repository.id,
      name: repository.name,
      full_name: repository.full_name,
      private: repository.private,
      description: repository.description,
      default_branch: repository.default_branch,
    };
  }

  private async executeCreateIssue(args: Record<string, any>, sessionId: string): Promise<any> {
    const { owner, repo, title, body } = args;
    
    const issue = this.store.addIssue(owner, repo, title, body, [], this.viewer);
    
    return {
      id: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
    };
  }

  private async executeListIssues(args: Record<string, any>, sessionId: string): Promise<any> {
    const { owner, repo, state } = args;
    const issues = this.store.getIssues(owner, repo)
      .filter((issue: any) => !state || state === 'all' || issue.state === state);
    return issues.map((issue: any) => ({
      id: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
    }));
  }

  private async executeCreatePullRequest(args: Record<string, any>, sessionId: string): Promise<any> {
    const { owner, repo, title, head, base } = args;
    
    const pullRequest = this.store.addPullRequest(owner, repo, title, '', head, base, this.viewer);
    
    return {
      id: pullRequest.id,
      number: pullRequest.number,
      title: pullRequest.title,
      state: pullRequest.state,
      head: pullRequest.head,
      base: pullRequest.base,
    };
  }

  private async executeMergePullRequest(args: Record<string, any>, sessionId: string): Promise<any> {
    const { owner, repo, pull_number } = args;
    
    const pullRequest = await this.store.mergePullRequest(owner, repo, pull_number, this.viewer);
    if (!pullRequest) {
      throw new Error(`Pull request not found: ${owner}/${repo}#${pull_number}`);
    }
    
    return {
      id: pullRequest.id,
      number: pullRequest.number,
      merged: pullRequest.merged,
      state: pullRequest.state,
    };
  }

  async getConnectionInfo(sessionId: string): Promise<McpConnectionInfo | null> {
    return this.connections.get(sessionId) || null;
  }
}

export const mcpServer = new McpServer(process.env.MAKEFUN_SHOP_TOKEN || '', 3000);
