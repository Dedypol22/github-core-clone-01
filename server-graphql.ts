"use strict";

import { IncomingMessage, ServerResponse } from 'node:http';
import { InMemoryStore } from './store.ts';
import { viewerLogin } from './scenario.ts';

export async function handleGraphQL(store: InMemoryStore, req: IncomingMessage, res: ServerResponse) {
  res.setHeader('Content-Type', 'application/json');
  
  const token = process.env.MAKEFUN_SHOP_TOKEN;
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${token}`) {
    res.statusCode = 401;
    res.end(JSON.stringify({ message: 'Bad credentials' }));
    return;
  }

  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end(JSON.stringify({ message: 'Method Not Allowed' }));
    return;
  }

  const body = await readJson(req);
  const requests = Array.isArray(body) ? body : [body];
  const results = [];

  for (const r of requests) {
    results.push(await executeQuery(store, r.query, r.variables || {}));
  }

  res.statusCode = 200;
  res.end(JSON.stringify(Array.isArray(body) ? results : results[0]));
}

async function executeQuery(store: InMemoryStore, query: string, vars: any): Promise<any> {
  const viewer = viewerLogin();

  // Basic query detection
  if (query.includes('query ViewerLogin')) {
    return { data: { viewer: { login: viewer } } };
  }

  if (query.includes('query RepositoryFields')) {
    const repo = store.getRepository(vars.owner, vars.name);
    if (!repo) return { data: { repository: null } };
    return {
      data: {
        repository: {
          id: repo.node_id,
          databaseId: repo.id,
          name: repo.name,
          owner: { login: repo.owner },
          defaultBranchRef: { name: repo.default_branch },
          viewerPermission: 'ADMIN',
          hasIssuesEnabled: true
        }
      }
    };
  }

  if (query.includes('query Issue_fields')) {
     return {
       data: {
         Issue: {
           fields: [
             { name: 'id' }, { name: 'number' }, { name: 'title' }, { name: 'state' }, { name: 'body' }
           ]
         }
       }
     };
  }

  if (query.includes('query PullRequestAndRepositoryFields')) {
    return {
      data: {
        PullRequest: {
          fields: [
            { name: 'id' }, { name: 'number' }, { name: 'headRefName' }, { name: 'baseRefName' },
            { name: 'mergeable' }, { name: 'state' }, { name: 'merged' }, { name: 'files' }
          ]
        },
        Repository: {
          fields: [
            { name: 'id' }, { name: 'databaseId' }, { name: 'name' }, { name: 'nameWithOwner' },
            { name: 'owner' }, { name: 'defaultBranchRef' }, { name: 'viewerPermission' },
            { name: 'hasIssuesEnabled' }, { name: 'issue' }, { name: 'issues' },
            { name: 'pullRequests' }, { name: 'pullRequest' }
          ]
        }
      }
    };
  }

  if (query.includes('query SearchType_enumValues')) {
    return {
      data: {
        SearchType: {
          enumValues: [
            { name: 'ISSUE' }, { name: 'PULL_REQUEST' }, { name: 'REPOSITORY' }, { name: 'USER' }, { name: 'ORGANIZATION' }
          ]
        }
      }
    };
  }

  if (query.includes('query OpenIssues')) {
    const repo = store.getRepository(vars.owner, vars.name);
    if (!repo) return { data: { repository: null } };
    const issues = store.getIssues(vars.owner, vars.name)
      .filter(i => i.state === 'open')
      .sort((a, b) => b.number - a.number)
      .slice(0, vars.first || 100);
    return {
      data: {
        repository: {
          issues: {
            nodes: issues.map(i => ({
              number: i.number,
              title: i.title,
              state: 'OPEN',
              id: i.node_id
            }))
          }
        }
      }
    };
  }

  if (query.includes('query IssueByNumber')) {
    const repo = store.getRepository(vars.owner, vars.name);
    if (!repo) return { data: { repository: null } };
    const issue = store.getIssue(vars.owner, vars.name, vars.number);
    if (!issue) return { data: { repository: { issue: null } } };
    return {
      data: {
        repository: {
          issue: {
            number: issue.number,
            title: issue.title,
            state: issue.state.toUpperCase(),
            id: issue.node_id,
            body: issue.body
          }
        }
      }
    };
  }

  if (query.includes('mutation IssueCreate')) {
    const repoId = vars.input.repositoryId;
    const decoded = Buffer.from(repoId, 'base64').toString().split(':');
    const fullName = decoded[1];
    const [owner, name] = fullName.split('/');
    const issue = store.addIssue(owner, name, vars.input.title, vars.input.body || '', [], viewer);
    return {
      data: {
        createIssue: {
          issue: {
            number: issue.number,
            id: issue.node_id
          }
        }
      }
    };
  }

  if (query.includes('mutation IssueClose')) {
    const id = vars.input.issueId;
    const decoded = Buffer.from(id, 'base64').toString().split(':');
    const fullName = decoded[1];
    const [owner, name] = fullName.split('/');
    const num = parseInt(decoded[2]);
    const issue = store.closeIssue(owner, name, num);
    if (!issue) return { errors: [{ message: 'Not Found' }] };
    return {
      data: {
        closeIssue: {
          issue: {
            number: issue.number,
            id: issue.node_id,
            state: 'CLOSED'
          }
        }
      }
    };
  }

  if (query.includes('query PullRequests')) {
    const repo = store.getRepository(vars.owner, vars.name);
    if (!repo) return { data: { repository: null } };
    const pulls = store.getPulls(vars.owner, vars.name).slice(0, vars.first || 100);
    return {
      data: {
        repository: {
          pullRequests: {
            nodes: pulls.map(p => ({
              number: p.number,
              headRefName: p.head.ref,
              baseRefName: p.base.ref,
              mergeable: 'MERGEABLE',
              state: p.state.toUpperCase()
            }))
          }
        }
      }
    };
  }

  if (query.includes('query PullRequestFiles')) {
    const repo = store.getRepository(vars.owner, vars.name);
    if (!repo) return { data: { repository: null } };
    const pr = store.getPull(vars.owner, vars.name, vars.number);
    if (!pr) return { data: { repository: { pullRequest: null } } };
    
    // Diff the base and head trees for the changed paths.
    const files = store.diffCommits(pr.base.sha, pr.head.sha).map((f) => ({ path: f.filename }));

    return {
      data: {
        repository: {
          pullRequest: {
            number: pr.number,
            files: {
              nodes: files
            }
          }
        }
      }
    };
  }

  if (query.includes('query PullRequestId')) {
    const repo = store.getRepository(vars.owner, vars.name);
    if (!repo) return { data: { repository: null } };
    const pr = store.getPull(vars.owner, vars.name, vars.number);
    if (!pr) return { data: { repository: { pullRequest: null } } };
    return {
      data: {
        repository: {
          pullRequest: {
            id: pr.node_id,
            number: pr.number
          }
        }
      }
    };
  }

  if (query.includes('mutation PullRequestCreate')) {
    const repoId = vars.input.repositoryId;
    const decoded = Buffer.from(repoId, 'base64').toString().split(':');
    const fullName = decoded[1];
    const [owner, name] = fullName.split('/');
    const pr = store.addPullRequest(owner, name, vars.input.title, vars.input.body || '', vars.input.headRefName, vars.input.baseRefName, viewer);
    return {
      data: {
        createPullRequest: {
          pullRequest: {
            number: pr.number,
            id: pr.node_id,
            state: 'OPEN',
            headRefName: pr.head.ref,
            baseRefName: pr.base.ref
          }
        }
      }
    };
  }

  if (query.includes('mutation MergePullRequest')) {
    const id = vars.input.pullRequestId;
    const decoded = Buffer.from(id, 'base64').toString().split(':');
    const fullName = decoded[1];
    const [owner, name] = fullName.split('/');
    const num = parseInt(decoded[2]);
    const res = await store.mergePullRequest(owner, name, num, viewer);
    const pr = store.getPull(owner, name, num)!;
    return {
      data: {
        mergePullRequest: {
          pullRequest: {
            number: pr.number,
            merged: true,
            state: 'MERGED'
          }
        }
      }
    };
  }

  if (query.includes('mutation AddComment')) {
    const id = vars.input.subjectId;
    const decoded = Buffer.from(id, 'base64').toString().split(':');
    let owner, name, num;
    if (decoded[0] === 'Issue' || decoded[0] === 'PullRequest') {
      const fullName = decoded[1];
      [owner, name] = fullName.split('/');
      num = parseInt(decoded[2]);
    } else {
       return { errors: [{ message: 'Invalid subjectId' }] };
    }
    const comment = store.addComment(owner, name, num, vars.input.body, viewer);
    return {
      data: {
        addComment: {
          commentEdge: {
            node: {
              id: comment.node_id,
              body: comment.body
            }
          }
        }
      }
    };
  }

  if (query.includes('query NodeRepository')) {
    const id = vars.id;
    const decoded = Buffer.from(id, 'base64').toString().split(':');
    if (decoded[0] === 'Repository') {
      const fullName = decoded[1];
      const [owner, name] = fullName.split('/');
      const repo = store.getRepository(owner, name);
      if (repo) {
        return {
          data: {
            node: {
              id: repo.node_id,
              name: repo.name,
              nameWithOwner: repo.full_name,
              __typename: 'Repository'
            }
          }
        };
      }
    }
    return { data: { node: null } };
  }

  if (query.includes('query IssuesPage')) {
    const repo = store.getRepository(vars.owner, vars.name);
    if (!repo) return { data: { repository: null } };
    const allIssues = store.getIssues(vars.owner, vars.name);
    let issues = allIssues;
    if (vars.after) {
      const afterNum = parseInt(Buffer.from(vars.after, 'base64').toString());
      issues = allIssues.filter(i => i.number > afterNum);
    }
    const sliced = issues.slice(0, vars.first || 10);
    const hasNextPage = issues.length > sliced.length;
    const endCursor = sliced.length > 0 ? Buffer.from(sliced[sliced.length - 1].number.toString()).toString('base64') : null;
    
    return {
      data: {
        repository: {
          issues: {
            nodes: sliced.map(i => ({ number: i.number })),
            pageInfo: {
              hasNextPage,
              endCursor
            }
          }
        }
      }
    };
  }

  // Fallback for unknown field check
  if (query.includes('noSuchFieldOnViewer')) {
     return {
       data: {
         viewer: {
           login: viewer
         }
       },
       errors: [
         { message: 'Cannot query field "noSuchFieldOnViewer" on type "User".' }
       ]
     };
  }

  return { errors: [{ message: 'Unknown query' }] };
}

async function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        resolve({});
      }
    });
  });
}
