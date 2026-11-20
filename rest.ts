"use strict";

import { GitProtocolError } from './git.ts';
import type { GitClient } from './git.ts';
import { InMemoryStore } from './store.ts';
import { createHash } from 'node:crypto';

export interface RestResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  text: string;
}

export class RestClient {
  private store: InMemoryStore;
  private token: string;
  private timeoutMs: number;

  constructor(token: string, timeoutMs: number = 5000) {
    this.store = new InMemoryStore();
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  async get(path: string, options: { signal?: AbortSignal; query?: Record<string, string> } = {}): Promise<RestResponse> {
    const url = this.buildUrl(path, options.query);
    const headers = this.buildHeaders();
    
    const controller = new AbortController();
    const signal = options.signal || AbortSignal.timeout(this.timeoutMs);
    signal.addEventListener('abort', () => controller.abort());
    
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      
      const text = await response.text();
      let body = null;
      if (text.trim()) {
        try {
          body = JSON.parse(text);
        } catch {}
      }
      
      return {
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body,
        text,
      };
    } catch (error) {
      throw new Error(`GET ${path} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async post(path: string, body: unknown, options: { signal?: AbortSignal } = {}): Promise<RestResponse> {
    const url = `${process.env.MAKEFUN_ENV_URL || 'http://localhost:8080'}${path}`;
    const headers = this.buildHeaders();
    
    const controller = new AbortController();
    const signal = options.signal || AbortSignal.timeout(this.timeoutMs);
    signal.addEventListener('abort', () => controller.abort());
    
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      
      const text = await response.text();
      let parsedBody = null;
      if (text.trim()) {
        try {
          parsedBody = JSON.parse(text);
        } catch {}
      }
      
      return {
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: parsedBody,
        text,
      };
    } catch (error) {
      throw new Error(`POST ${path} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async patch(path: string, body: unknown, options: { signal?: AbortSignal } = {}): Promise<RestResponse> {
    const url = `${process.env.MAKEFUN_ENV_URL || 'http://localhost:8080'}${path}`;
    const headers = this.buildHeaders();
    
    const controller = new AbortController();
    const signal = options.signal || AbortSignal.timeout(this.timeoutMs);
    signal.addEventListener('abort', () => controller.abort());
    
    try {
      const response = await fetch(url, {
        method: 'PATCH',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      
      const text = await response.text();
      let parsedBody = null;
      if (text.trim()) {
        try {
          parsedBody = JSON.parse(text);
        } catch {}
      }
      
      return {
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: parsedBody,
        text,
      };
    } catch (error) {
      throw new Error(`PATCH ${path} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async put(path: string, body: unknown, options: { signal?: AbortSignal } = {}): Promise<RestResponse> {
    const url = `${process.env.MAKEFUN_ENV_URL || 'http://localhost:8080'}${path}`;
    const headers = this.buildHeaders();
    
    const controller = new AbortController();
    const signal = options.signal || AbortSignal.timeout(this.timeoutMs);
    signal.addEventListener('abort', () => controller.abort());
    
    try {
      const response = await fetch(url, {
        method: 'PUT',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      
      const text = await response.text();
      let parsedBody = null;
      if (text.trim()) {
        try {
          parsedBody = JSON.parse(text);
        } catch {}
      }
      
      return {
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: parsedBody,
        text,
      };
    } catch (error) {
      throw new Error(`PUT ${path} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async delete(path: string, options: { signal?: AbortSignal; body?: unknown } = {}): Promise<RestResponse> {
    const url = `${process.env.MAKEFUN_ENV_URL || 'http://localhost:8080'}${path}`;
    const headers = this.buildHeaders();
    
    const controller = new AbortController();
    const signal = options.signal || AbortSignal.timeout(this.timeoutMs);
    signal.addEventListener('abort', () => controller.abort());
    
    try {
      const response = await fetch(url, {
        method: 'DELETE',
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
      
      const text = await response.text();
      let parsedBody = null;
      if (text.trim()) {
        try {
          parsedBody = JSON.parse(text);
        } catch {}
      }
      
      return {
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: parsedBody,
        text,
      };
    } catch (error) {
      throw new Error(`DELETE ${path} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private buildUrl(path: string, query?: Record<string, string>): string {
    let url = `${process.env.MAKEFUN_ENV_URL || 'http://localhost:8080'}${path}`;
    if (query && Object.keys(query).length > 0) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        params.append(key, value);
      }
      url += `?${params.toString()}`;
    }
    return url;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'accept': 'application/vnd.github+json',
      'user-agent': 'makefun-rest-client/1.0',
      'content-type': 'application/json',
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

  async generateRequestId(): string {
    return `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  async getUserInfo(): Promise<{ login: string; id: number; avatar_url: string }> {
    const response = await this.get('/api/v3/user');
    if (response.status !== 200) {
      throw new Error(`Failed to get user info: ${response.status}`);
    }
    return response.body as { login: string; id: number; avatar_url: string };
  }

  async createRepository(owner: string, name: string, private: boolean, description: string): Promise<RestResponse> {
    const body = { name, private, description };
    return this.post('/api/v3/user/repos', body);
  }

  async getRepository(owner: string, name: string): Promise<RestResponse> {
    return this.get(`/api/v3/repos/${owner}/${name}`);
  }

  async updateRepository(owner: string, name: string, description: string): Promise<RestResponse> {
    const body = { description };
    return this.patch(`/api/v3/repos/${owner}/${name}`, body);
  }

  async deleteRepository(owner: string, name: string): Promise<RestResponse> {
    return this.delete(`/api/v3/repos/${owner}/${name}`);
  }

  async putContent(owner: string, name: string, path: string, content: string, message: string, sha?: string, branch?: string): Promise<RestResponse> {
    const body: any = {
      message,
      content,
    };
    if (sha) body.sha = sha;
    if (branch) body.branch = branch;
    
    return this.put(`/api/v3/repos/${owner}/${name}/contents/${encodeURIComponent(path)}`, body);
  }

  async getContent(owner: string, name: string, path: string, ref?: string): Promise<RestResponse> {
    let url = `/api/v3/repos/${owner}/${name}/contents/${encodeURIComponent(path)}`;
    if (ref) {
      const params = new URLSearchParams();
      params.append('ref', ref);
      url += `?${params.toString()}`;
    }
    return this.get(url);
  }

  async deleteContent(owner: string, name: string, path: string, message: string, sha: string): Promise<RestResponse> {
    const body = { message, sha };
    return this.delete(`/api/v3/repos/${owner}/${name}/contents/${encodeURIComponent(path)}`, { body });
  }

  async createLabel(owner: string, name: string, color: string): Promise<RestResponse> {
    const body = { name, color };
    return this.post(`/api/v3/repos/${owner}/${name}/labels`, body);
  }

  async createIssue(owner: string, name: string, title: string, body: string, labels: string[]): Promise<RestResponse> {
    const body = { title, body, labels };
    return this.post(`/api/v3/repos/${owner}/${name}/issues`, body);
  }

  async getIssues(owner: string, name: string, state?: string, sort?: string, direction?: string, per_page?: number): Promise<RestResponse> {
    let url = `/api/v3/repos/${owner}/${name}/issues`;
    const params = new URLSearchParams();
    if (state) params.append('state', state);
    if (sort) params.append('sort', sort);
    if (direction) params.append('direction', direction);
    if (per_page) params.append('per_page', per_page.toString());
    if (params.toString()) url += `?${params.toString()}`;
    return this.get(url);
  }

  async getIssue(owner: string, name: string, number: number): Promise<RestResponse> {
    return this.get(`/api/v3/repos/${owner}/${name}/issues/${number}`);
  }

  async updateIssue(owner: string, name: string, number: number, state: 'open' | 'closed'): Promise<RestResponse> {
    const body = { state };
    return this.patch(`/api/v3/repos/${owner}/${name}/issues/${number}`, body);
  }

  async createPullRequest(owner: string, name: string, title: string, body: string, head: string, base: string): Promise<RestResponse> {
    const body = { title, body, head, base };
    return this.post(`/api/v3/repos/${owner}/${name}/pulls`, body);
  }

  async getPullRequest(owner: string, name: string, number: number): Promise<RestResponse> {
    return this.get(`/api/v3/repos/${owner}/${name}/pulls/${number}`);
  }

  async getPullRequestFiles(owner: string, name: string, number: number): Promise<RestResponse> {
    return this.get(`/api/v3/repos/${owner}/${name}/pulls/${number}/files`);
  }

  async mergePullRequest(owner: string, name: string, number: number, merge_method: string = 'squash'): Promise<RestResponse> {
    const body = { merge_method };
    return this.put(`/api/v3/repos/${owner}/${name}/pulls/${number}/merge`, body);
  }

  async getMeta(): Promise<RestResponse> {
    return this.get('/api/v3/meta');
  }

  async rateLimit(): Promise<RestResponse> {
    return this.get('/api/v3/rate_limit');
  }

  async createGitRef(owner: string, name: string, ref: string, sha: string): Promise<RestResponse> {
    const body = { ref, sha };
    return this.post(`/api/v3/repos/${owner}/${name}/git/refs`, body);
  }

  async getBranches(owner: string, name: string): Promise<RestResponse> {
    return this.get(`/api/v3/repos/${owner}/${name}/branches`);
  }

  async getCommits(owner: string, name: string, sha?: string): Promise<RestResponse> {
    let url = `/api/v3/repos/${owner}/${name}/commits`;
    if (sha) {
      const params = new URLSearchParams();
      params.append('sha', sha);
      url += `?${params.toString()}`;
    }
    return this.get(url);
  }

  async getRepositoryTree(owner: string, name: string, path: string, sha?: string): Promise<RestResponse> {
    let url = `/api/v3/repos/${owner}/${name}/contents/${encodeURIComponent(path)}`;
    if (sha) {
      const params = new URLSearchParams();
      params.append('ref', sha);
      url += `?${params.toString()}`;
    }
    return this.get(url);
  }

  getLinkHeader(response: RestResponse): string | null {
    const linkHeader = response.headers?.link || response.headers?.Link;
    return linkHeader || null;
  }
}
