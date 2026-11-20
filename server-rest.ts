"use strict";

import { IncomingMessage, ServerResponse } from 'node:http';
import { InMemoryStore, getTimestamp } from './store.ts';
import type { Repository, Issue, PullRequest, Label, Comment } from './store.ts';
import { viewerLogin } from './scenario.ts';
import { parseTree } from './git.ts';

let requestIdCounter = 0;

export async function handleRest(store: InMemoryStore, req: IncomingMessage, res: ServerResponse) {
  const requestId = `req-${++requestIdCounter}`;
  res.setHeader('X-GitHub-Request-Id', requestId);
  res.setHeader('Content-Type', 'application/json');

  if (req.url === '/healthz') {
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  const token = process.env.MAKEFUN_SHOP_TOKEN;
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${token}`) {
    res.statusCode = 401;
    res.end(JSON.stringify({ message: 'Bad credentials' }));
    return;
  }

  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method;
  const viewer = viewerLogin();

  try {
    // GET /api/v3/
    if (path === '/api/v3/' && method === 'GET') {
      res.setHeader('X-OAuth-Scopes', 'repo, read:org');
      res.statusCode = 200;
      res.end(JSON.stringify({
        current_user_url: 'http://localhost/api/v3/user',
        repository_url: 'http://localhost/api/v3/repos/{owner}/{repo}',
      }));
      return;
    }

    // GET /api/v3/meta
    if (path === '/api/v3/meta' && method === 'GET') {
      res.statusCode = 200;
      res.end(JSON.stringify({ installed_version: '1.0' }));
      return;
    }

    // GET /api/v3/user
    if (path === '/api/v3/user' && method === 'GET') {
      res.statusCode = 200;
      res.end(JSON.stringify(store.createUser(viewer)));
      return;
    }

    // GET /api/v3/user/repos
    if (path === '/api/v3/user/repos' && method === 'GET') {
      const allRepos = Array.from(store.repositories.values()).filter(r => r.owner === viewer);
      const perPage = Math.max(1, parseInt(url.searchParams.get('per_page') || '30', 10) || 30);
      const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
      const start = (page - 1) * perPage;
      const slice = allRepos.slice(start, start + perPage);
      if (start + perPage < allRepos.length) {
        const nextUrl = new URL(req.url || '/', `http://${req.headers.host}`);
        nextUrl.searchParams.set('page', String(page + 1));
        nextUrl.searchParams.set('per_page', String(perPage));
        res.setHeader('Link', `<${nextUrl.toString()}>; rel="next"`);
      }
      res.statusCode = 200;
      res.end(JSON.stringify(slice));
      return;
    }

    // POST /api/v3/user/repos
    if (path === '/api/v3/user/repos' && method === 'POST') {
      const body = await readJson(req);
      const repo = store.addRepository(viewer, body.name, body.private || false, body.description || '');
      res.statusCode = 201;
      res.end(JSON.stringify(repo));
      return;
    }

    // GET /api/v3/rate_limit
    if (path === '/api/v3/rate_limit' && method === 'GET') {
      res.statusCode = 200;
      res.end(JSON.stringify({
        resources: {
          core: { limit: 5000, remaining: 4999, reset: getTimestamp() + 3600 },
          graphql: { limit: 5000, remaining: 5000, reset: getTimestamp() + 3600 },
        }
      }));
      return;
    }

    // Repo routes: /api/v3/repos/{owner}/{repo}/...
    const repoMatch = path.match(/^\/api\/v3\/repos\/([^\/]+)\/([^\/]+)(.*)$/);
    if (repoMatch) {
      const owner = repoMatch[1];
      const repoName = repoMatch[2];
      const subPath = repoMatch[3];
      const repo = store.getRepository(owner, repoName);

      if (!repo) {
        res.statusCode = 404;
        res.end(JSON.stringify({ message: 'Not Found' }));
        return;
      }

      // GET /api/v3/repos/{o}/{r}
      if (subPath === '' && method === 'GET') {
        res.statusCode = 200;
        res.end(JSON.stringify(repo));
        return;
      }

      // PATCH /api/v3/repos/{o}/{r}
      if (subPath === '' && method === 'PATCH') {
        const body = await readJson(req);
        if (body.description !== undefined) repo.description = body.description;
        res.statusCode = 200;
        res.end(JSON.stringify(repo));
        return;
      }

      // DELETE /api/v3/repos/{o}/{r}
      if (subPath === '' && method === 'DELETE') {
        store.deleteRepository(owner, repoName);
        res.statusCode = 204;
        res.end();
        return;
      }

      // GET /api/v3/repos/{o}/{r}/branches
      if (subPath === '/branches' && method === 'GET') {
        const refs = store.listRefs(owner, repoName).filter(r => r.ref.startsWith('refs/heads/'));
        const branches = refs.map(r => ({
          name: r.ref.substring(11),
          commit: { sha: r.sha, url: `http://localhost/api/v3/repos/${owner}/${repoName}/commits/${r.sha}` }
        }));
        res.statusCode = 200;
        res.end(JSON.stringify(branches));
        return;
      }

      // POST /api/v3/repos/{o}/{r}/git/refs
      if (subPath === '/git/refs' && method === 'POST') {
        const body = await readJson(req);
        // body.ref = "refs/heads/branchname", body.sha = "sha"
        store.setRef(owner, repoName, body.ref, body.sha);
        res.statusCode = 201;
        res.end(JSON.stringify({ ref: body.ref, object: { sha: body.sha, type: 'commit' } }));
        return;
      }

      // GET /api/v3/repos/{o}/{r}/commits
      if (subPath === '/commits' && method === 'GET') {
        const sha = url.searchParams.get('sha') || repo.default_branch;
        const isSha = /^[0-9a-f]{40}$/.test(sha);
        const headSha = isSha ? sha : (store.getRef(owner, repoName, sha.startsWith('refs/') ? sha : `refs/heads/${sha}`) || sha);
        if (!headSha) {
           res.statusCode = 200; res.end('[]'); return;
        }
        const commits = [];
        let curr = headSha;
        while (curr) {
          const obj = store.getObject(curr);
          if (!obj || obj.type !== 'commit') break;
          const text = obj.data.toString();
          const treeMatch = text.match(/^tree ([0-9a-f]{40})/m);
          const parentMatch = text.match(/^parent ([0-9a-f]{40})/m);
          const authorMatch = text.match(/^author (.*?) <(.*?)> (\d+) (.*)$/m);
          const msg = text.split('\n\n')[1]?.trim() || '';
          
          commits.push({
            sha: curr,
            commit: {
              message: msg,
              tree: { sha: treeMatch ? treeMatch[1] : '' },
              author: { name: authorMatch ? authorMatch[1] : '', email: authorMatch ? authorMatch[2] : '', date: authorMatch ? new Date(parseInt(authorMatch[3])*1000).toISOString() : '' },
            }
          });
          if (parentMatch) curr = parentMatch[1]; else break;
          if (commits.length > 30) break; // limit
        }
        res.statusCode = 200;
        res.end(JSON.stringify(commits));
        return;
      }

      // GET /api/v3/repos/{o}/{r}/contents/{path}
      const contentsMatch = subPath.match(/^\/contents\/(.*)$/);
      if (contentsMatch) {
        const filePath = decodeURIComponent(contentsMatch[1]);
        if (method === 'GET') {
           const ref = url.searchParams.get('ref') || repo.default_branch;
           const headSha = store.getRef(owner, repoName, ref.startsWith('refs/') ? ref : `refs/heads/${ref}`) || ref;
           const commitObj = store.getObject(headSha);
           if (!commitObj || commitObj.type !== 'commit') { res.statusCode = 404; res.end(JSON.stringify({message: 'Not Found'})); return; }
           const treeMatch = commitObj.data.toString().match(/^tree ([0-9a-f]{40})/m);
           const treeSha = treeMatch![1];
           // Walk the path through nested trees.
           const segments = filePath.split('/').filter((s) => s !== '');
           let currentTreeSha = treeSha;
           let resolved: { mode: string; name: string; oid: string } | null = null;
           let walkOk = true;
           for (let i = 0; i < segments.length; i++) {
             const treeObj = store.getObject(currentTreeSha);
             if (!treeObj || treeObj.type !== 'tree') { walkOk = false; break; }
             const entry = parseTree(treeObj.data).find((e) => e.name === segments[i]);
             if (!entry) { walkOk = false; break; }
             resolved = entry;
             if (i < segments.length - 1) {
               if (entry.mode === '040000' || entry.mode === '40000') currentTreeSha = entry.oid;
               else { walkOk = false; break; }
             }
           }
           if (!walkOk || !resolved) { res.statusCode = 404; res.end(JSON.stringify({message: 'Not Found'})); return; }
           if (resolved.mode === '040000' || resolved.mode === '40000') {
             // Directory: list its entries.
             const dirObj = store.getObject(resolved.oid);
             if (!dirObj || dirObj.type !== 'tree') { res.statusCode = 404; res.end(JSON.stringify({message: 'Not Found'})); return; }
             const entries = parseTree(dirObj.data).map((e) => {
               const isDir = e.mode === '040000' || e.mode === '40000';
               const out: Record<string, unknown> = { name: e.name, path: `${filePath}/${e.name}`, sha: e.oid, type: isDir ? 'dir' : 'file' };
               if (!isDir) { const b = store.getObject(e.oid); if (b) out.size = b.data.length; }
               return out;
             });
             res.statusCode = 200;
             res.end(JSON.stringify(entries));
             return;
           }
           const blob = store.getObject(resolved.oid);
           if (!blob) { res.statusCode = 404; res.end(JSON.stringify({message: 'Not Found'})); return; }
           res.statusCode = 200;
           res.end(JSON.stringify({
             name: resolved.name, path: filePath, sha: resolved.oid, size: blob.data.length,
             content: blob.data.toString('base64'),
             encoding: 'base64',
             type: 'file'
           }));
           return;
        }
        if (method === 'PUT') {
          const body = await readJson(req);
          const content = Buffer.from(body.content, 'base64');
          try {
            const { commitSha, blobSha } = await store.updateContent(owner, repoName, filePath, content, body.message, body.branch || repo.default_branch, viewer, body.sha);
            res.statusCode = body.sha ? 200 : 201;
            res.end(JSON.stringify({ commit: { sha: commitSha }, content: { sha: blobSha, encoding: 'base64', name: filePath.split('/').pop(), path: filePath, size: content.length, type: 'file' } }));
          } catch (e: any) {
            res.statusCode = e.status || 500;
            res.end(JSON.stringify({ message: e.message }));
          }
          return;
        }
        if (method === 'DELETE') {
          const body = await readJson(req);
          try {
            const { commitSha } = await store.deleteContent(owner, repoName, filePath, body.message, body.branch || repo.default_branch, viewer, body.sha);
            res.statusCode = 200;
            res.end(JSON.stringify({ commit: { sha: commitSha } }));
          } catch (e: any) {
            res.statusCode = e.status || 500;
            res.end(JSON.stringify({ message: e.message }));
          }
          return;
        }
      }

      // POST/GET /api/v3/repos/{o}/{r}/labels
      if (subPath === '/labels' && method === 'GET') {
        res.statusCode = 200;
        res.end(JSON.stringify(store.getLabels(owner, repoName)));
        return;
      }
      if (subPath === '/labels' && method === 'POST') {
        const body = await readJson(req);
        const label = store.addLabel(owner, repoName, body.name, body.color);
        res.statusCode = 201;
        res.end(JSON.stringify(label));
        return;
      }

      // POST/GET /api/v3/repos/{o}/{r}/issues
      if (subPath === '/issues' && method === 'GET') {
        let issues = store.getIssues(owner, repoName);
        const state = url.searchParams.get('state');
        if (state && state !== 'all') issues = issues.filter(i => i.state === state);
        // Creation order is the issue number; sort=created honours direction.
        if (url.searchParams.get('sort') === 'created') {
          const desc = url.searchParams.get('direction') === 'desc';
          issues = [...issues].sort((a, b) => desc ? b.number - a.number : a.number - b.number);
        }
        res.statusCode = 200;
        res.end(JSON.stringify(issues));
        return;
      }
      if (subPath === '/issues' && method === 'POST') {
        const body = await readJson(req);
        try {
          const issue = store.addIssue(owner, repoName, body.title, body.body, body.labels || [], viewer);
          res.statusCode = 201;
          res.end(JSON.stringify(issue));
        } catch (e) {
          res.statusCode = 422; res.end(JSON.stringify({message: 'Unprocessable Entity'}));
        }
        return;
      }

      // GET/PATCH /api/v3/repos/{o}/{r}/issues/{n}
      const issueNumMatch = subPath.match(/^\/issues\/(\d+)$/);
      if (issueNumMatch) {
        const num = parseInt(issueNumMatch[1]);
        const issue = store.getIssue(owner, repoName, num);
        if (!issue) { res.statusCode = 404; res.end(JSON.stringify({message: 'Not Found'})); return; }
        if (method === 'GET') {
          res.statusCode = 200; res.end(JSON.stringify(issue)); return;
        }
        if (method === 'PATCH') {
          const body = await readJson(req);
          if (body.state === 'closed') store.closeIssue(owner, repoName, num);
          if (body.title) issue.title = body.title;
          if (body.body) issue.body = body.body;
          res.statusCode = 200; res.end(JSON.stringify(issue)); return;
        }
      }

      // POST/GET /api/v3/repos/{o}/{r}/issues/{n}/comments
      const issueCommentsMatch = subPath.match(/^\/issues\/(\d+)\/comments$/);
      if (issueCommentsMatch) {
        const num = parseInt(issueCommentsMatch[1]);
        if (method === 'GET') {
          res.statusCode = 200; res.end(JSON.stringify(store.getComments(owner, repoName, num))); return;
        }
        if (method === 'POST') {
          const body = await readJson(req);
          const comment = store.addComment(owner, repoName, num, body.body, viewer);
          res.statusCode = 201; res.end(JSON.stringify(comment)); return;
        }
      }

      // POST/GET /api/v3/repos/{o}/{r}/pulls
      if (subPath === '/pulls' && method === 'GET') {
        const state = url.searchParams.get('state') || 'open';
        let pulls = store.getPulls(owner, repoName);
        if (state !== 'all') {
          pulls = pulls.filter(p => restPullState(p) === state);
        }
        res.statusCode = 200;
        res.end(JSON.stringify(pulls.map(serializePull)));
        return;
      }
      if (subPath === '/pulls' && method === 'POST') {
        const body = await readJson(req);
        const pr = store.addPullRequest(owner, repoName, body.title, body.body, body.head, body.base, viewer);
        res.statusCode = 201;
        res.end(JSON.stringify(pr));
        return;
      }

      // GET /api/v3/repos/{o}/{r}/pulls/{n}/files
      const prFilesMatch = subPath.match(/^\/pulls\/(\d+)\/files$/);
      if (prFilesMatch) {
        const num = parseInt(prFilesMatch[1]);
        const pr = store.getPull(owner, repoName, num);
        if (!pr) { res.statusCode = 404; res.end(JSON.stringify({message: 'Not Found'})); return; }
        if (method === 'GET') {
          res.statusCode = 200;
          res.end(JSON.stringify(store.diffCommits(pr.base.sha, pr.head.sha)));
          return;
        }
      }

      // GET /api/v3/repos/{o}/{r}/pulls/{n}
      const prNumMatch = subPath.match(/^\/pulls\/(\d+)$/);
      if (prNumMatch) {
        const num = parseInt(prNumMatch[1]);
        const pr = store.getPull(owner, repoName, num);
        if (!pr) { res.statusCode = 404; res.end(JSON.stringify({message: 'Not Found'})); return; }
        if (method === 'GET') {
          res.statusCode = 200; res.end(JSON.stringify(serializePull(pr))); return;
        }
      }

      // PUT /api/v3/repos/{o}/{r}/pulls/{n}/merge
      const prMergeMatch = subPath.match(/^\/pulls\/(\d+)\/merge$/);
      if (prMergeMatch) {
        const num = parseInt(prMergeMatch[1]);
        if (method === 'PUT') {
           try {
             const result = await store.mergePullRequest(owner, repoName, num, viewer);
             if (!result) { res.statusCode = 404; res.end(JSON.stringify({message: 'Not Found'})); return; }
             res.statusCode = 200; res.end(JSON.stringify(result));
           } catch (e: any) {
             res.statusCode = e.status || 500; res.end(JSON.stringify({message: e.message}));
           }
           return;
        }
      }
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ message: 'Not Found' }));
  } catch (e: any) {
    res.statusCode = e.status || 500;
    res.end(JSON.stringify({ message: e.message || 'Internal Server Error' }));
  }
}

/** GitHub's REST view of a merged pull request: state "closed", merged:true. */
function restPullState(pr: PullRequest): 'open' | 'closed' {
  return pr.state === 'open' ? 'open' : 'closed';
}

function serializePull(pr: PullRequest): PullRequest {
  return { ...pr, state: restPullState(pr) };
}

async function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        const err = new Error('Invalid JSON');
        (err as any).status = 400;
        reject(err);
      }
    });
  });
}
