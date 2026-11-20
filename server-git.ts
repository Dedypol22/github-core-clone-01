"use strict";

import { IncomingMessage, ServerResponse } from 'node:http';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { InMemoryStore } from './store.ts';
import {
  hashObject,
  readPack,
  encodePktLine,
  parseCommit,
  parseTree,
  PKT_LINE_MAX_PAYLOAD
} from './git.ts';

const FLUSH = Buffer.from('0000');

export async function handleGit(store: InMemoryStore, req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const path = url.pathname;
  
  // /{owner}/{repo}.git/...
  const gitMatch = path.match(/^\/([^\/]+)\/([^\/]+)\.git\/(.*)$/);
  if (!gitMatch) {
    res.statusCode = 404;
    res.end(JSON.stringify({ message: 'Not Found' }));
    return;
  }

  const owner = gitMatch[1];
  const repoName = gitMatch[2];
  const subPath = gitMatch[3];
  const repo = store.getRepository(owner, repoName);

  if (!repo) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ message: 'Not Found' }));
    return;
  }

  if (subPath === 'info/refs') {
    const service = url.searchParams.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }

    res.setHeader('Content-Type', `application/x-${service}-advertisement`);
    res.setHeader('Cache-Control', 'no-cache');
    
    const protocolHeader = req.headers['git-protocol'] as string;
    const version = (protocolHeader && protocolHeader.includes('version=2')) ? 2 : 0;

    if (version === 2 && service === 'git-upload-pack') {
      res.write(encodePktLine(Buffer.from('# service=git-upload-pack')));
      res.write(FLUSH);
      res.write(encodePktLine(Buffer.from('version 2')));
      res.write(encodePktLine(Buffer.from('ls-refs')));
      res.write(encodePktLine(Buffer.from('fetch=shallow')));
      res.write(encodePktLine(Buffer.from('object-format=sha1')));
      res.write(FLUSH);
      res.end();
      return;
    }

    // v0 advertisement
    res.write(encodePktLine(Buffer.from(`# service=${service}`)));
    res.write(FLUSH);

    const refs = store.listRefs(owner, repoName);
    let capabilities = '';
    if (service === 'git-upload-pack') {
      capabilities = 'multi_ack side-band-64k ofs-delta shallow';
    } else {
      capabilities = 'report-status side-band-64k delete-refs';
    }

    if (refs.length === 0) {
      res.write(encodePktLine(Buffer.from(`0000000000000000000000000000000000000000 capabilities^{}\x00${capabilities}`)));
    } else {
      let first = true;
      for (const r of refs) {
        if (first) {
          res.write(encodePktLine(Buffer.from(`${r.sha} ${r.ref}\x00${capabilities}`)));
          first = false;
        } else {
          res.write(encodePktLine(Buffer.from(`${r.sha} ${r.ref}`)));
        }
      }
    }
    res.write(FLUSH);
    res.end();
    return;
  }

  if (subPath === 'git-upload-pack' && req.method === 'POST') {
    res.setHeader('Content-Type', 'application/x-git-upload-pack-result');
    res.setHeader('Cache-Control', 'no-cache');

    const body = await readBody(req);
    const lines = parsePktLines(body);

    // Protocol v2 is negotiated via the Git-Protocol header (real git and the
    // kit client both send it); some clients also prefix the body with a
    // `version 2` line. v0 bodies start with `want ...`.
    const protocolHeader = req.headers['git-protocol'] as string;
    let v2 = !!(protocolHeader && protocolHeader.includes('version=2'));
    let cmdLines = lines;
    if (lines.length > 0 && lines[0].toString().trim() === 'version 2') {
      v2 = true;
      cmdLines = lines.slice(1);
    }

    if (v2) {
      const rawCommand = cmdLines.length > 0 ? cmdLines[0].toString().trim() : '';
      const command = rawCommand.startsWith('command=') ? rawCommand.slice('command='.length) : rawCommand;
      if (command === 'ls-refs') {
        handleLsRefsV2(store, owner, repoName, cmdLines.slice(1), res);
      } else if (command === 'fetch') {
        handleFetchV2(store, owner, repoName, cmdLines.slice(1), res);
      } else {
        res.statusCode = 400;
        res.end('Unknown command');
      }
      return;
    }

    // Protocol v0 upload-pack
    handleUploadPackV0(store, owner, repoName, lines, res);
    return;
  }

  if (subPath === 'git-receive-pack' && req.method === 'POST') {
    res.setHeader('Content-Type', 'application/x-git-receive-pack-result');
    res.setHeader('Cache-Control', 'no-cache');

    const body = await readBody(req);
    handleReceivePackV0(store, owner, repoName, body, res);
    return;
  }

  res.statusCode = 404;
  res.end('Not Found');
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parsePktLines(data: Buffer): Buffer[] {
  const lines: Buffer[] = [];
  let pos = 0;
  while (pos < data.length) {
    if (data.length - pos < 4) break;
    const lenStr = data.toString('utf8', pos, pos + 4);
    const len = parseInt(lenStr, 16);
    if (len === 0) {
      lines.push(FLUSH);
      pos += 4;
    } else if (len === 1) { // DELIM
      lines.push(Buffer.from('0001'));
      pos += 4;
    } else if (len === 2) { // RESPONSE-END
       lines.push(Buffer.from('0002'));
       pos += 4;
    } else {
      lines.push(data.subarray(pos + 4, pos + len));
      pos += len;
    }
  }
  return lines;
}

function handleLsRefsV2(store: InMemoryStore, owner: string, repoName: string, lines: Buffer[], res: ServerResponse) {
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];

  for (const line of lines) {
    const s = line.toString().trim();
    if (s === 'peel') peel = true;
    else if (s === 'symrefs') symrefs = true;
    else if (s.startsWith('ref-prefix ')) prefixes.push(s.substring(11));
  }

  const refs = store.listRefs(owner, repoName);
  const keep = (name: string) => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));

  // HEAD symref: the default branch is the symref target. A ref-prefix filters
  // HEAD too (the client checks rawRefs against the prefix).
  const repo = store.getRepository(owner, repoName);
  const defaultBranch = repo?.default_branch || 'main';
  const mainRef = refs.find((r) => r.ref === `refs/heads/${defaultBranch}`);
  if (symrefs && mainRef && keep('HEAD')) {
    res.write(encodePktLine(Buffer.from(`${mainRef.sha} HEAD symref-target:refs/heads/${defaultBranch}\n`)));
  }

  for (const r of refs) {
    if (!keep(r.ref)) continue;

    let line = `${r.sha} ${r.ref}`;
    if (peel) {
      const peeled = peelTag(store, r.sha);
      if (peeled) line += ` peeled:${peeled}`;
    }
    res.write(encodePktLine(Buffer.from(line + '\n')));
  }
  res.write(FLUSH);
  res.end();
}

/** Follow an annotated tag to its commit, or null when the object is not a tag. */
function peelTag(store: InMemoryStore, sha: string): string | null {
  let cur = sha;
  const seen = new Set<string>();
  while (!seen.has(cur)) {
    seen.add(cur);
    const obj = store.getObject(cur);
    if (!obj || obj.type !== 'tag') return null;
    const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
    if (!m) return null;
    cur = m[1];
    const target = store.getObject(cur);
    if (target && target.type === 'commit') return cur;
  }
  return null;
}

/** Reachable objects from roots: commits (with trees + blobs), tags (followed),
 *  trees (walked). maxDepth caps commit generations (1 = roots only);
 *  boundary commits are included with their trees but their parents are not
 *  followed (a client's shallow boundary: it holds the commit, not its history). */
function collectReachable(
  roots: string[],
  lookup: (sha: string) => GitObject | undefined,
  opts: { maxDepth?: number; boundary?: Set<string> } = {},
): Set<string> {
  const out = new Set<string>();
  const queue: { sha: string; depth: number }[] = roots.map((sha) => ({ sha, depth: 0 }));
  const seenCommit = new Set<string>();
  const addTree = (treeSha: string) => {
    const stack = [treeSha];
    while (stack.length) {
      const t = stack.pop()!;
      if (out.has(t)) continue;
      const tobj = lookup(t);
      if (!tobj) continue;
      out.add(t);
      if (tobj.type !== 'tree') continue;
      for (const e of parseTree(tobj.data)) {
        if (e.mode === '40000' || e.mode === '040000') stack.push(e.oid);
        else if (lookup(e.oid)) out.add(e.oid);
      }
    }
  };
  while (queue.length) {
    const { sha, depth } = queue.shift()!;
    if (out.has(sha)) continue;
    const obj = lookup(sha);
    if (!obj) continue;
    out.add(sha);
    if (obj.type === 'commit') {
      if (seenCommit.has(sha)) continue;
      seenCommit.add(sha);
      const c = parseCommit(obj.data);
      addTree(c.tree);
      const stop = opts.boundary?.has(sha);
      if (!stop && (opts.maxDepth === undefined || depth + 1 < opts.maxDepth)) {
        for (const p of c.parents) queue.push({ sha: p, depth: depth + 1 });
      }
    } else if (obj.type === 'tree') {
      addTree(sha);
    } else if (obj.type === 'tag') {
      const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
      if (m) queue.push({ sha: m[1], depth });
    }
  }
  return out;
}

/** Shallow-info for a depth-limited fetch: commits whose parents were cut off
 *  are new `shallow` boundaries; old boundaries whose parents are now included
 *  become `unshallow`. */
function shallowInfo(
  store: InMemoryStore,
  wantSet: Set<string>,
  depth: number | undefined,
  shallowBoundaries: string[],
): { shallow: string[]; unshallow: string[] } {
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth === undefined) return { shallow, unshallow };
  for (const sha of wantSet) {
    const obj = store.getObject(sha);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.length > 0 && parents.every((p) => !wantSet.has(p))) shallow.push(sha);
  }
  for (const b of shallowBoundaries) {
    if (!wantSet.has(b)) continue;
    const obj = store.getObject(b);
    if (!obj || obj.type !== 'commit') continue;
    if (parseCommit(obj.data).parents.some((p) => wantSet.has(p))) unshallow.push(b);
  }
  return { shallow, unshallow };
}

interface FetchPlan {
  wants: string[];
  haves: string[];
  depth: number | undefined;
  shallowBoundaries: string[];
  wantSet: Set<string>;
  haveSet: Set<string>;
  acks: string[];
  info: { shallow: string[]; unshallow: string[] };
}

function planFetch(store: InMemoryStore, lines: Buffer[]): FetchPlan {
  const wants: string[] = [];
  const haves: string[] = [];
  let depth: number | undefined;
  const shallowBoundaries: string[] = [];
  for (const line of lines) {
    const s = line.toString().trim();
    if (s.startsWith('want ')) wants.push(s.substring(5).split(' ')[0]);
    else if (s.startsWith('have ')) haves.push(s.substring(5));
    else if (s.startsWith('deepen ')) {
      const n = parseInt(s.substring(7), 10);
      if (!Number.isNaN(n)) depth = n;
    } else if (s.startsWith('shallow ')) shallowBoundaries.push(s.substring(8));
    // thin-pack, no-progress, ofs-delta, filter, done, deepen-since/not: ignored,
    // our packs are self-contained full objects.
  }
  const lookup = (sha: string) => store.getObject(sha);
  const wantSet = collectReachable(wants, lookup, { maxDepth: depth });
  const haveSet = collectReachable(haves, lookup, { boundary: new Set(shallowBoundaries) });
  const acks = haves.filter((h) => wantSet.has(h));
  const info = shallowInfo(store, wantSet, depth, shallowBoundaries);
  return { wants, haves, depth, shallowBoundaries, wantSet, haveSet, acks, info };
}

function handleFetchV2(store: InMemoryStore, owner: string, repoName: string, lines: Buffer[], res: ServerResponse) {
  const plan = planFetch(store, lines);
  // Negotiation (acknowledgments) only happens when the client sent haves;
  // with no haves (e.g. a clone) the response starts at shallow-info/packfile.
  if (plan.haves.length) {
    res.write(encodePktLine(Buffer.from('acknowledgments\n')));
    if (plan.acks.length) {
      for (const a of plan.acks) res.write(encodePktLine(Buffer.from(`ACK ${a}\n`)));
      res.write(encodePktLine(Buffer.from('ready\n')));
    } else {
      res.write(encodePktLine(Buffer.from('NAK\n')));
    }
    res.write(FLUSH);
  }
  if (plan.info.shallow.length || plan.info.unshallow.length) {
    res.write(encodePktLine(Buffer.from('shallow-info\n')));
    for (const s of plan.info.shallow) res.write(encodePktLine(Buffer.from(`shallow ${s}\n`)));
    for (const u of plan.info.unshallow) res.write(encodePktLine(Buffer.from(`unshallow ${u}\n`)));
    res.write(FLUSH);
  }
  res.write(encodePktLine(Buffer.from('packfile\n')));
  sendPackSet(store, plan.wantSet, plan.haveSet, res);
}

function handleUploadPackV0(store: InMemoryStore, owner: string, repoName: string, lines: Buffer[], res: ServerResponse) {
  const plan = planFetch(store, lines);
  if (plan.wants.length === 0) {
    res.end();
    return;
  }
  if (plan.acks.length) {
    for (const a of plan.acks) res.write(encodePktLine(Buffer.from(`ACK ${a}\n`)));
  } else {
    res.write(encodePktLine(Buffer.from('NAK\n')));
  }
  for (const s of plan.info.shallow) res.write(encodePktLine(Buffer.from(`shallow ${s}\n`)));
  for (const u of plan.info.unshallow) res.write(encodePktLine(Buffer.from(`unshallow ${u}\n`)));
  sendPackSet(store, plan.wantSet, plan.haveSet, res);
}

function sendPackSet(store: InMemoryStore, wantSet: Set<string>, haveSet: Set<string>, res: ServerResponse) {
  const objectsToSend: { sha: string; type: string; data: Buffer }[] = [];
  for (const sha of wantSet) {
    if (haveSet.has(sha)) continue;
    const obj = store.getObject(sha);
    if (obj) objectsToSend.push({ sha, type: obj.type, data: obj.data });
  }

  const pack = buildPack(objectsToSend);

  // Side-band 64k framing
  let pos = 0;
  while (pos < pack.length) {
    const chunk = pack.subarray(pos, pos + PKT_LINE_MAX_PAYLOAD - 1);
    const framed = Buffer.alloc(chunk.length + 5);
    const len = (chunk.length + 5).toString(16).padStart(4, '0');
    framed.write(len, 0, 4, 'utf8');
    framed[4] = 1; // band 1: data
    chunk.copy(framed, 5);
    res.write(framed);
    pos += chunk.length;
  }
  res.write(FLUSH);
  res.end();
}

function buildPack(objects: { sha: string; type: string; data: Buffer }[]): Buffer {
  // Simple PACK v2 without deltas
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'utf8');
  header.writeUInt32BE(2, 4); // version 2
  header.writeUInt32BE(objects.length, 8);

  const chunks: Buffer[] = [header];
  const typeMap: any = { commit: 1, tree: 2, blob: 3, tag: 4 };

  for (const obj of objects) {
    const type = typeMap[obj.type];
    let size = obj.data.length;
    let byte = (type << 4) | (size & 0x0f);
    size >>= 4;
    const headerBytes = [];
    while (size > 0) {
      headerBytes.push(byte | 0x80);
      byte = size & 0x7f;
      size >>= 7;
    }
    headerBytes.push(byte);
    chunks.push(Buffer.from(headerBytes));
    chunks.push(deflateSync(obj.data));
  }

  const packSoFar = Buffer.concat(chunks);
  const sha1 = createHash('sha1').update(packSoFar).digest();
  return Buffer.concat([packSoFar, sha1]);
}

/** True when maybeAncestor is reachable from sha by following commit parents. */
function isAncestor(store: InMemoryStore, maybeAncestor: string, sha: string): boolean {
  const seen = new Set<string>();
  const stack = [sha];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === maybeAncestor) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = store.getObject(cur);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return false;
}

function handleReceivePackV0(store: InMemoryStore, owner: string, repoName: string, body: Buffer, res: ServerResponse) {
  const lines = parsePktLines(body);
  const commands: { oldSha: string, newSha: string, ref: string }[] = [];
  let packOffset = 0;

  let pos = 0;
  while (pos < body.length) {
    const lenStr = body.toString('utf8', pos, pos + 4);
    const len = parseInt(lenStr, 16);
    if (len === 0) {
      pos += 4;
      packOffset = pos;
      break;
    }
    const line = body.subarray(pos + 4, pos + len).toString().trim();
    if (line.includes('\x00')) {
       // first line with capabilities
       const [part1, caps] = line.split('\x00');
       const [oldSha, newSha, ref] = part1.split(' ');
       commands.push({ oldSha, newSha, ref });
    } else {
       const [oldSha, newSha, ref] = line.split(' ');
       if (oldSha && newSha && ref) {
         commands.push({ oldSha, newSha, ref });
       }
    }
    pos += len;
    if (body.subarray(pos, pos + 4).toString() === 'PACK') {
      packOffset = pos;
      break;
    }
  }

  const packData = body.subarray(packOffset);
  const report: string[] = [];
  let unpackOk = true;

  // A delete-only command list carries no pack at all.
  if (packData.length === 0) {
    report.push('unpack ok');
  } else {
    try {
      const pack = readPack(packData);
      for (const [sha, obj] of pack.objects) {
        store.putObject(obj);
      }
      report.push('unpack ok');
    } catch (e: any) {
      unpackOk = false;
      report.push(`unpack error ${e.message}`);
    }
  }

  if (unpackOk) {
    for (const cmd of commands) {
      if (cmd.newSha === '0'.repeat(40)) {
        // delete
        if (store.getRef(owner, repoName, cmd.ref) === undefined) {
          report.push(`ng ${cmd.ref} ref does not exist`);
        } else {
          store.deleteRef(owner, repoName, cmd.ref);
          report.push(`ok ${cmd.ref}`);
        }
      } else if (cmd.oldSha === '0'.repeat(40)) {
        // create
        if (store.getRef(owner, repoName, cmd.ref) !== undefined) {
          report.push(`ng ${cmd.ref} already exists`);
        } else {
          store.setRef(owner, repoName, cmd.ref, cmd.newSha);
          report.push(`ok ${cmd.ref}`);
        }
      } else {
        const current = store.getRef(owner, repoName, cmd.ref);
        if (current === undefined) {
          report.push(`ng ${cmd.ref} ref does not exist`);
        } else if (current !== cmd.oldSha) {
          report.push(`ng ${cmd.ref} old value does not match`);
        } else if (cmd.oldSha === cmd.newSha) {
          report.push(`ok ${cmd.ref}`);
        } else if (isAncestor(store, cmd.oldSha, cmd.newSha)) {
          store.setRef(owner, repoName, cmd.ref, cmd.newSha);
          report.push(`ok ${cmd.ref}`);
        } else {
          report.push(`ng ${cmd.ref} non-fast-forward`);
        }
      }
    }
  } else {
    for (const cmd of commands) {
      report.push(`ng ${cmd.ref} unpack failed`);
    }
  }

  // Send report-status in sideband
  const reportPkt = report.map(r => encodePktLine(Buffer.from(r + '\n'))).join('') + '0000';
  const reportBuf = Buffer.from(reportPkt);
  
  const framed = Buffer.alloc(reportBuf.length + 5);
  const len = (reportBuf.length + 5).toString(16).padStart(4, '0');
  framed.write(len, 0, 4, 'utf8');
  framed[4] = 1;
  reportBuf.copy(framed, 5);
  res.write(framed);
  res.write(FLUSH);
  res.end();
}
