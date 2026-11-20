"use strict";

import type { GitObject } from './types.ts';
import { hashObject, buildTree, buildCommit, parseCommit, parseTree } from './git.ts';
import { viewerLogin } from './scenario.ts';

export interface Repository {
  owner: string;
  name: string;
  full_name: string;
  private: boolean;
  description: string;
  default_branch: string;
  created_at: string;
  updated_at: string;
  pushed_at: string;
  git_url: string;
  clone_url: string;
  html_url: string;
  id: number;
  node_id: string;
}

export interface User {
  login: string;
  id: number;
  node_id: string;
  avatar_url: string;
  gravatar_url: string;
  url: string;
  html_url: string;
  type: string;
  site_admin: boolean;
}

export interface Label {
  id: number;
  node_id: string;
  url: string;
  name: string;
  color: string;
  default: boolean;
  description: string;
}

export interface Issue {
  id: number;
  node_id: string;
  url: string;
  html_url: string;
  number: number;
  state: 'open' | 'closed';
  title: string;
  body: string;
  user: User;
  labels: Label[];
  assignee: User | null;
  assignees: User[];
  comments: number;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
  author_association: string;
}

export interface PullRequest {
  id: number;
  node_id: string;
  url: string;
  html_url: string;
  diff_url: string;
  patch_url: string;
  issue_url: string;
  number: number;
  state: 'open' | 'closed' | 'merged';
  title: string;
  body: string;
  user: User;
  labels: Label[];
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  head: {
    label: string;
    ref: string;
    sha: string;
    user: User;
    repo: Repository;
  };
  base: {
    label: string;
    ref: string;
    sha: string;
    user: User;
    repo: Repository;
  };
  created_at: string;
  updated_at: string;
}

export interface Comment {
  id: number;
  node_id: string;
  url: string;
  html_url: string;
  body: string;
  user: User;
  created_at: string;
  updated_at: string;
}

function getNow(): string {
  return process.env.MAKEFUN_TRIAL_NOW || '2026-10-28T00:00:00.000Z';
}

function getTimestamp(): number {
  return Math.floor(new Date(getNow()).getTime() / 1000);
}

export { getNow, getTimestamp };

/** Number of lines in text (a trailing newline does not add a line). */
function countLines(text: string): number {
  if (text === '') return 0;
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

/** Line additions/deletions between two texts via LCS (files here are tiny). */
function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  if (a.length && a[a.length - 1] === '') a.pop();
  if (b.length && b[b.length - 1] === '') b.pop();
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  let additions = 0;
  let deletions = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { deletions++; i++; }
    else { additions++; j++; }
  }
  deletions += m - i;
  additions += n - j;
  return { additions, deletions };
}

export class InMemoryStore {
  repositories = new Map<string, Repository>();
  gitObjects = new Map<string, GitObject>();
  refs = new Map<string, string>(); // keyed by "owner/name:ref"

  repoIssues = new Map<string, Issue[]>();
  repoPulls = new Map<string, PullRequest[]>();
  repoLabels = new Map<string, Label[]>();
  issueComments = new Map<string, Comment[]>();
  
  // Per-repo counters: "owner/name" -> counters
  repoCounters = new Map<string, { issue: number; pull: number; comment: number; label: number; global: number }>();

  private getCounters(repoKey: string) {
    let c = this.repoCounters.get(repoKey);
    if (!c) {
      c = { issue: 1, pull: 1, comment: 1, label: 1, global: 1 };
      this.repoCounters.set(repoKey, c);
    }
    return c;
  }

  private getGlobalRepoId(repoKey: string) {
    // For id, we need a stable integer. Let's use a hash of repoKey or just another map.
    // Actually, just a simple counter for repositories.
    return Array.from(this.repositories.keys()).indexOf(repoKey) + 1;
  }

  private nextRepoId = 5000;

  addRepository(owner: string, name: string, isPrivate: boolean, description: string): Repository {
    const fullName = `${owner}/${name}`;
    const existing = this.repositories.get(fullName);
    if (existing) return existing;
    const now = getNow();
    const id = this.nextRepoId++;
    const repo: Repository = {
      owner,
      name,
      full_name: fullName,
      private: isPrivate,
      description: description || '',
      default_branch: 'main',
      created_at: now,
      updated_at: now,
      pushed_at: now,
      git_url: `http://localhost/${fullName}.git`,
      clone_url: `http://localhost/${fullName}.git`,
      html_url: `http://localhost/${fullName}`,
      id,
      node_id: Buffer.from(`Repository:${fullName}`).toString('base64'),
    };
    this.repositories.set(fullName, repo);
    return repo;
  }

  getRepository(owner: string, name: string): Repository | undefined {
    return this.repositories.get(`${owner}/${name}`);
  }

  deleteRepository(owner: string, name: string): boolean {
    const fullName = `${owner}/${name}`;
    const deleted = this.repositories.delete(fullName);
    if (deleted) {
      // Clean up refs
      for (const key of this.refs.keys()) {
        if (key.startsWith(`${fullName}:`)) {
          this.refs.delete(key);
        }
      }
      this.repoIssues.delete(fullName);
      this.repoPulls.delete(fullName);
      this.repoLabels.delete(fullName);
      this.repoCounters.delete(fullName);
    }
    return deleted;
  }

  // Refs
  getRef(owner: string, name: string, ref: string): string | undefined {
    return this.refs.get(`${owner}/${name}:${ref}`);
  }

  setRef(owner: string, name: string, ref: string, sha: string) {
    this.refs.set(`${owner}/${name}:${ref}`, sha);
  }

  deleteRef(owner: string, name: string, ref: string) {
    this.refs.delete(`${owner}/${name}:${ref}`);
  }

  listRefs(owner: string, name: string) {
    const prefix = `${owner}/${name}:`;
    const result: { ref: string; sha: string }[] = [];
    for (const [key, sha] of this.refs.entries()) {
      if (key.startsWith(prefix)) {
        result.push({ ref: key.substring(prefix.length), sha });
      }
    }
    return result;
  }

  // Git Objects
  putObject(obj: GitObject): string {
    const sha = hashObject(obj.type, obj.data);
    this.gitObjects.set(sha, obj);
    return sha;
  }

  getObject(sha: string): GitObject | undefined {
    return this.gitObjects.get(sha);
  }

  // Issues
  addLabel(owner: string, name: string, labelName: string, color: string = 'ededed'): Label {
    const fullName = `${owner}/${name}`;
    const counters = this.getCounters(fullName);
    const id = counters.label++;
    const label: Label = {
      id,
      node_id: Buffer.from(`Label:${fullName}:${id}`).toString('base64'),
      url: `http://localhost/api/v3/repos/${fullName}/labels/${encodeURIComponent(labelName)}`,
      name: labelName,
      color,
      default: false,
      description: '',
    };
    let labels = this.repoLabels.get(fullName);
    if (!labels) {
      labels = [];
      this.repoLabels.set(fullName, labels);
    }
    labels.push(label);
    return label;
  }

  getLabels(owner: string, name: string): Label[] {
    return this.repoLabels.get(`${owner}/${name}`) || [];
  }

  addIssue(owner: string, name: string, title: string, body: string, labelNames: string[], creator: string): Issue {
    const fullName = `${owner}/${name}`;
    const counters = this.getCounters(fullName);
    const num = counters.issue++;
    const now = getNow();
    
    const repoLabels = this.getLabels(owner, name);
    const labels: Label[] = [];
    for (const ln of labelNames) {
      const l = repoLabels.find(rl => rl.name === ln);
      if (!l) throw new Error('Label not found');
      labels.push(l);
    }

    const issue: Issue = {
      id: num, // simplified, using number as ID within repo
      node_id: Buffer.from(`Issue:${fullName}:${num}`).toString('base64'),
      url: `http://localhost/api/v3/repos/${fullName}/issues/${num}`,
      html_url: `http://localhost/${fullName}/issues/${num}`,
      number: num,
      state: 'open',
      title,
      body: body || '',
      user: this.createUser(creator),
      labels,
      assignee: null,
      assignees: [],
      comments: 0,
      closed_at: null,
      created_at: now,
      updated_at: now,
      author_association: 'OWNER',
    };

    let issues = this.repoIssues.get(fullName);
    if (!issues) {
      issues = [];
      this.repoIssues.set(fullName, issues);
    }
    issues.push(issue);
    return issue;
  }

  getIssues(owner: string, name: string): Issue[] {
    return this.repoIssues.get(`${owner}/${name}`) || [];
  }

  getIssue(owner: string, name: string, number: number): Issue | undefined {
    return this.getIssues(owner, name).find(i => i.number === number);
  }

  // Pull Requests
  addPullRequest(owner: string, name: string, title: string, body: string, head: string, base: string, creator: string): PullRequest {
    const fullName = `${owner}/${name}`;
    const counters = this.getCounters(fullName);
    const num = counters.pull++;
    const now = getNow();

    const headSha = this.getRef(owner, name, `refs/heads/${head}`) || '0'.repeat(40);
    const baseSha = this.getRef(owner, name, `refs/heads/${base}`) || '0'.repeat(40);

    const pr: PullRequest = {
      id: num,
      node_id: Buffer.from(`PullRequest:${fullName}:${num}`).toString('base64'),
      url: `http://localhost/api/v3/repos/${fullName}/pulls/${num}`,
      html_url: `http://localhost/${fullName}/pull/${num}`,
      diff_url: `http://localhost/${fullName}/pull/${num}.diff`,
      patch_url: `http://localhost/${fullName}/pull/${num}.patch`,
      issue_url: `http://localhost/api/v3/repos/${fullName}/issues/${num}`,
      number: num,
      state: 'open',
      title,
      body: body || '',
      user: this.createUser(creator),
      labels: [],
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      head: {
        label: `${owner}:${head}`,
        ref: head,
        sha: headSha,
        user: this.createUser(owner),
        repo: this.getRepository(owner, name)!,
      },
      base: {
        label: `${owner}:${base}`,
        ref: base,
        sha: baseSha,
        user: this.createUser(owner),
        repo: this.getRepository(owner, name)!,
      },
      created_at: now,
      updated_at: now,
    };

    let pulls = this.repoPulls.get(fullName);
    if (!pulls) {
      pulls = [];
      this.repoPulls.set(fullName, pulls);
    }
    pulls.push(pr);
    return pr;
  }

  getPulls(owner: string, name: string): PullRequest[] {
    return this.repoPulls.get(`${owner}/${name}`) || [];
  }

  /** Flatten a tree (recursively) to path -> blob oid. */
  flattenTree(treeSha: string, prefix = ''): Map<string, string> {
    const out = new Map<string, string>();
    const stack: { sha: string; prefix: string }[] = [{ sha: treeSha, prefix }];
    while (stack.length) {
      const { sha, prefix: pre } = stack.pop()!;
      const obj = this.getObject(sha);
      if (!obj || obj.type !== 'tree') continue;
      for (const e of parseTree(obj.data)) {
        const path = pre ? `${pre}/${e.name}` : e.name;
        if (e.mode === '040000' || e.mode === '40000') stack.push({ sha: e.oid, prefix: path });
        else out.set(path, e.oid);
      }
    }
    return out;
  }

  /** Diff two commits' trees: per-file status and line counts. */
  diffCommits(baseSha: string, headSha: string): { filename: string; status: 'added' | 'removed' | 'modified'; additions: number; deletions: number; changes: number }[] {
    const baseObj = this.getObject(baseSha);
    const headObj = this.getObject(headSha);
    if (!baseObj || baseObj.type !== 'commit' || !headObj || headObj.type !== 'commit') return [];
    const baseTree = parseCommit(baseObj.data).tree;
    const headTree = parseCommit(headObj.data).tree;
    const baseFiles = this.flattenTree(baseTree);
    const headFiles = this.flattenTree(headTree);
    const out: { filename: string; status: 'added' | 'removed' | 'modified'; additions: number; deletions: number; changes: number }[] = [];
    const allPaths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    for (const path of [...allPaths].sort()) {
      const b = baseFiles.get(path);
      const h = headFiles.get(path);
      if (b === h) continue;
      if (b === undefined && h !== undefined) {
        const text = this.getObject(h)?.data.toString('utf8') ?? '';
        const additions = countLines(text);
        out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (h === undefined && b !== undefined) {
        const text = this.getObject(b)?.data.toString('utf8') ?? '';
        const deletions = countLines(text);
        out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
      } else {
        const oldText = this.getObject(b!)?.data.toString('utf8') ?? '';
        const newText = this.getObject(h!)?.data.toString('utf8') ?? '';
        const { additions, deletions } = lineDiff(oldText, newText);
        out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return out;
  }

  getPull(owner: string, name: string, number: number): PullRequest | undefined {
    return this.getPulls(owner, name).find(p => p.number === number);
  }

  // Comments
  addComment(owner: string, name: string, issueNumber: number, body: string, creator: string): Comment {
    const fullName = `${owner}/${name}`;
    const counters = this.getCounters(fullName);
    const id = counters.comment++;
    const now = getNow();

    const comment: Comment = {
      id,
      node_id: Buffer.from(`Comment:${id}`).toString('base64'),
      url: `http://localhost/api/v3/repos/${fullName}/issues/comments/${id}`,
      html_url: `http://localhost/${fullName}/issues/${issueNumber}#issuecomment-${id}`,
      body,
      user: this.createUser(creator),
      created_at: now,
      updated_at: now,
    };

    const key = `${fullName}:${issueNumber}`;
    let comments = this.issueComments.get(key);
    if (!comments) {
      comments = [];
      this.issueComments.set(key, comments);
    }
    comments.push(comment);
    
    // Update issue comment count
    const issue = this.getIssue(owner, name, issueNumber);
    if (issue) issue.comments++;

    return comment;
  }

  getComments(owner: string, name: string, issueNumber: number): Comment[] {
    return this.issueComments.get(`${owner}/${name}:${issueNumber}`) || [];
  }

  createUser(login: string): User {
    return {
      login,
      id: 1000, // Fixed or derived
      node_id: Buffer.from(`User:${login}`).toString('base64'),
      avatar_url: `http://localhost/avatars/${login}`,
      gravatar_url: '',
      url: `http://localhost/api/v3/users/${login}`,
      html_url: `http://localhost/${login}`,
      type: 'User',
      site_admin: false,
    };
  }

  // Git operations helpers
  createBlob(content: Buffer): string {
    return this.putObject({ type: 'blob', data: content });
  }

  createTree(entries: { mode: string; name: string; sha: string }[]): string {
    const data = buildTree(entries.map(e => ({ mode: e.mode, name: e.name, oid: e.sha })));
    return this.putObject({ type: 'tree', data });
  }

  createCommit(tree: string, parents: string[], message: string, author: string): string {
    const now = getTimestamp();
    const data = buildCommit({
      tree,
      parents,
      message,
      author: `${author} <${author}@example.invalid>`,
      committer: `${author} <${author}@example.invalid>`,
      timestamp: now,
    });
    return this.putObject({ type: 'commit', data });
  }

  // Contents
  async updateContent(owner: string, name: string, path: string, content: Buffer, message: string, branch: string, author: string, oldSha?: string) {
    const repo = this.getRepository(owner, name);
    if (!repo) throw new Error('Repo not found');

    const headRef = `refs/heads/${branch}`;
    const headSha = this.getRef(owner, name, headRef);
    
    const blobSha = this.createBlob(content);
    
    let currentTreeSha: string | undefined;
    const parents: string[] = [];
    if (headSha) {
      parents.push(headSha);
      const commitObj = this.getObject(headSha);
      if (commitObj && commitObj.type === 'commit') {
        const commit = parseCommit(commitObj.data);
        currentTreeSha = commit.tree;
      }
    }

    const parts = path.split('/');
    const filename = parts.pop()!;
    
    const updateTree = (treeSha: string | undefined, pathParts: string[]): string => {
      let entries: { mode: string; name: string; oid: string }[] = [];
      if (treeSha) {
        const treeObj = this.getObject(treeSha);
        if (treeObj && treeObj.type === 'tree') {
          entries = parseTree(treeObj.data);
        }
      }

      if (pathParts.length === 0) {
        const existing = entries.find(e => e.name === filename);
        if (existing && oldSha && existing.oid !== oldSha) {
          const err = new Error('Conflict');
          (err as any).status = 409;
          throw err;
        }
        entries = entries.filter(e => e.name !== filename);
        entries.push({ mode: '100644', name: filename, oid: blobSha });
      } else {
        const dirName = pathParts[0];
        const existingDir = entries.find(e => e.name === dirName && (e.mode === '040000' || e.mode === '40000'));
        const newDirSha = updateTree(existingDir?.oid, pathParts.slice(1));
        entries = entries.filter(e => e.name !== dirName);
        entries.push({ mode: '040000', name: dirName, oid: newDirSha });
      }
      
      const data = buildTree(entries);
      return this.putObject({ type: 'tree', data });
    };

    const newRootTreeSha = updateTree(currentTreeSha, parts);
    const newCommitSha = this.createCommit(newRootTreeSha, parents, message, author);
    
    this.setRef(owner, name, headRef, newCommitSha);
    repo.pushed_at = getNow();
    return { commitSha: newCommitSha, blobSha };
  }

  async deleteContent(owner: string, name: string, path: string, message: string, branch: string, author: string, oldSha: string) {
    const repo = this.getRepository(owner, name);
    if (!repo) throw new Error('Repo not found');

    const headRef = `refs/heads/${branch}`;
    const headSha = this.getRef(owner, name, headRef);
    if (!headSha) throw new Error('Branch not found');

    const commitObj = this.getObject(headSha);
    if (!commitObj || commitObj.type !== 'commit') throw new Error('Commit not found');
    const commit = parseCommit(commitObj.data);
    const currentTreeSha = commit.tree;

    const parts = path.split('/');
    const filename = parts.pop()!;

    const deleteFromTree = (treeSha: string | undefined, pathParts: string[]): string => {
      if (!treeSha) throw new Error('Not Found');
      const treeObj = this.getObject(treeSha);
      if (!treeObj || treeObj.type !== 'tree') throw new Error('Not Found');
      let entries = parseTree(treeObj.data);

      if (pathParts.length === 0) {
        const existing = entries.find(e => e.name === filename);
        if (!existing) {
          const err = new Error('Not Found');
          (err as any).status = 404;
          throw err;
        }
        if (oldSha && existing.oid !== oldSha) {
          const err = new Error('Conflict');
          (err as any).status = 409;
          throw err;
        }
        entries = entries.filter(e => e.name !== filename);
      } else {
        const dirName = pathParts[0];
        const existingDir = entries.find(e => e.name === dirName && (e.mode === '040000' || e.mode === '40000'));
        const newDirSha = deleteFromTree(existingDir?.oid, pathParts.slice(1));
        entries = entries.filter(e => e.name !== dirName);
        if (newDirSha !== '') { // if directory is not empty
             entries.push({ mode: '040000', name: dirName, oid: newDirSha });
        }
      }

      if (entries.length === 0 && pathParts.length > 0) return ''; // indicate empty dir

      const data = buildTree(entries);
      return this.putObject({ type: 'tree', data });
    };

    const newRootTreeSha = deleteFromTree(currentTreeSha, parts);
    const newCommitSha = this.createCommit(newRootTreeSha, [headSha], message, author);
    this.setRef(owner, name, headRef, newCommitSha);
    return { commitSha: newCommitSha };
  }

  async mergePullRequest(owner: string, name: string, number: number, author: string) {
    const pr = this.getPull(owner, name, number);
    if (!pr) return undefined;

    const baseBranch = pr.base.ref;
    const headSha = pr.head.sha;
    const baseRef = `refs/heads/${baseBranch}`;
    const baseSha = this.getRef(owner, name, baseRef);
    if (!baseSha) throw new Error('Base branch not found');

    const headCommitObj = this.getObject(headSha);
    if (!headCommitObj || headCommitObj.type !== 'commit') throw new Error('Head commit not found');
    const headCommit = parseCommit(headCommitObj.data);

    if (!this.isDescendant(headSha, baseSha)) {
      const err = new Error('Method Not Allowed');
      (err as any).status = 405;
      throw err;
    }

    const mergeCommitSha = this.createCommit(headCommit.tree, [baseSha, headSha], `Merge pull request #${number} from ${pr.head.label}`, author);
    this.setRef(owner, name, baseRef, mergeCommitSha);

    pr.state = 'merged';
    pr.merged = true;
    pr.merged_at = getNow();
    pr.merge_commit_sha = mergeCommitSha;

    return { sha: mergeCommitSha, merged: true, message: 'Pull Request successfully merged' };
  }

  private isDescendant(headSha: string, baseSha: string): boolean {
    if (headSha === baseSha) return true;
    const visited = new Set<string>();
    const stack = [headSha];
    while (stack.length > 0) {
      const sha = stack.pop()!;
      if (sha === baseSha) return true;
      if (visited.has(sha)) continue;
      visited.add(sha);
      const obj = this.getObject(sha);
      if (obj && obj.type === 'commit') {
        const text = obj.data.toString();
        const parentMatches = text.matchAll(/^parent ([0-9a-f]{40})/gm);
        for (const match of parentMatches) {
          stack.push(match[1]);
        }
      }
    }
    return false;
  }

  closeIssue(owner: string, name: string, number: number) {
    const issue = this.getIssue(owner, name, number);
    if (issue) {
      issue.state = 'closed';
      issue.closed_at = getNow();
      issue.updated_at = getNow();
    }
    return issue;
  }
}
