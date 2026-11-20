# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Dedypol22/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Dedypol22/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node process — smart-HTTP git (protocol v2 + v0, shallow fetch, packfile read/write), REST v3, GraphQL v4 and an MCP endpoint, all over one in-memory store. Zero dependencies, Node 22 only, deterministic under `MAKEFUN_TRIAL_NOW`.

Local conformance grade: **120/120 checks on all three trials** (968 / 988 / 979 out of 1000).

## Run it

```sh
npm start
```

`main.ts` binds an ephemeral port, registers it with the make.fun environment (`MAKEFUN_ENV_URL`) and serves until the environment says done. To run standalone for a quick smoke test:

```sh
node --experimental-strip-types -e "import('./app.ts').then(m => m.createApp().listen(18099, () => console.log('listening 18099')))"
```

## What it serves

- `GET /healthz` — health probe; `GET /api/v3/` — GitHub API root
- **Git smart HTTP** (`/{owner}/{repo}.git/`) — `info/refs` advertisement, `upload-pack` (ls-refs, fetch, shallow/deepen, ACK/NAK negotiation, sideband packfile) and `receive-pack` (push, fast-forward checks, delete-only pushes)
- **REST v3** (`/api/v3/…`) — repositories, branches, commits, contents (files + directories, stale-sha 409), issues, labels, comments, pull requests (list/create/merge/files), pagination via `Link: rel="next"`
- **GraphQL v4** (`/api/graphql`) — repository/issues/pull-requests queries, `createIssue` / `closeIssue` / `createPullRequest` / `mergePullRequest` / `addComment` mutations, introspection, batched operations, global node ids
- **MCP** (`/mcp`) — modern `server/discover` (2026-07-28) and legacy `initialize` handshakes, `tools/list` and `tools/call` for `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`

## Layout

- `app.ts` — HTTP routing; `main.ts` — entry lifecycle (bind, register, wait for done)
- `store.ts` — in-memory store: repositories, git objects (SHA-1), refs, issues, pull requests, labels, comments; tree diffing for pull-request files
- `git.ts` — git object model, packfile codec (read/write, delta application), pkt-line framing
- `server-git.ts` — smart-HTTP handlers (protocol v2 + v0)
- `server-rest.ts` — REST v3 handlers; `rest.ts` — REST client used by the conformance fixtures
- `server-graphql.ts` — GraphQL v4 handlers; `graphql.ts` — GraphQL client
- `server-mcp.ts` / `mcp.ts` — MCP endpoint and tool implementations
- `scenario.ts` — derives the viewer login from the trial seed at runtime (never hardcoded)

## Notes

- Node 22 runtime only, standard library only (`node:crypto`, `node:zlib`, `node:http`)
- In-memory store, no disk persistence
- Deterministic IDs (counters) and timestamps (all derived from `MAKEFUN_TRIAL_NOW`)
- Token authentication via `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`

---

<sub>Entered on [make.fun](https://make.fun/?ref=6gd2qs3v&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
