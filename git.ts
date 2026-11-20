"use strict";

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

import type { GitObject, GitObjectType, GitPacket, GitRef, PushCommand, PushResult, FetchResult, CloneResult } from './types.ts';

export const ZERO_OID = '0'.repeat(40);
export const PKT_LINE_MAX = 65520;
export const PKT_LINE_MAX_PAYLOAD = PKT_LINE_MAX - 4;

export class GitProtocolError extends Error {
  readonly code: string;
}

export class GitHttpError extends Error {
  readonly url: string;
  readonly status: number;
  readonly bodySnippet: string;
}

export interface GitClientOptions {
  baseUrl: string;
  token: string | null;
  signal: AbortSignal;
  timeoutMs?: number;
  gitProtocol?: 0 | 2;
}

export interface GitClient {
  infoRefs(owner: string, repo: string, service: 'git-upload-pack' | 'git-receive-pack', options: { signal: AbortSignal }): Promise<{ status: number; contentType?: string; packets: GitPacket[] }>;
  lsRefs(owner: string, repo: string, options: { signal: AbortSignal; symrefs?: boolean; peel?: boolean; prefixes?: string[] }): Promise<{ protocol: 0 | 2; refs: GitRef[]; rawRefs: GitRef[] }>;
  advertisement(owner: string, repo: string, service: 'git-upload-pack' | 'git-receive-pack', options: { signal: AbortSignal }): Promise<{ protocol: 0 | 2; capabilities: Map<string, string>; refs: GitRef[] }>;
  clone(owner: string, repo: string, options: { signal: AbortSignal; depth?: number }): Promise<CloneResult>;
  fetch(owner: string, repo: string, options: {
    signal: AbortSignal;
    wants: string[];
    haves: string[];
    haveObjects: Map<string, GitObject>;
    parse: boolean;
    observe?: (packet: GitPacket) => void;
    shallow?: string[];
    depth?: number;
  }): Promise<FetchResult>;
  push(owner: string, repo: string, commands: PushCommand[], options: { objects?: GitObject[]; pack?: Uint8Array; signal: AbortSignal }): Promise<PushResult>;
  postRaw(owner: string, repo: string, service: string, data: Buffer, options: { signal: AbortSignal }): Promise<{ status: number; headers: Record<string, string>; body: Buffer }>;
  createRepo(owner: string, repo: string, body: any, options: { signal: AbortSignal }): Promise<{ status: number; headers: Record<string, string>; body: unknown }>;
}

export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`);
  const hash = createHash('sha1');
  hash.update(header);
  hash.update(data);
  return hash.digest('hex');
}

export function buildCommit(data: {
  tree: string;
  parents: string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
}): Buffer {
  const lines: string[] = [];
  lines.push(`tree ${data.tree}`);
  for (const parent of data.parents) {
    lines.push(`parent ${parent}`);
  }
  lines.push(`author ${data.author} ${data.timestamp} +0000`);
  lines.push(`committer ${data.committer} ${data.timestamp} +0000`);
  lines.push('');
  lines.push(data.message);
  if (!data.message.endsWith('\n')) lines[lines.length - 1] += '\n';
  return Buffer.from(lines.join('\n'));
}

export function buildTree(entries: { mode: string; name: string; oid: string }[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const aName = a.mode === '40000' || a.mode === '040000' ? a.name + '/' : a.name;
    const bName = b.mode === '40000' || b.mode === '040000' ? b.name + '/' : b.name;
    return aName < bName ? -1 : aName > bName ? 1 : 0;
  });
  const chunks: Buffer[] = [];
  for (const entry of sorted) {
    const mode = entry.mode.replace(/^0+/, '');
    chunks.push(Buffer.from(`${mode} ${entry.name}\0`));
    chunks.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(chunks);
}

export function parseCommit(data: Buffer): {
  tree: string;
  parents: string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
} {
  const text = data.toString('utf8');
  const lines = text.split('\n');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  let timestamp = 0;
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line === '') { i++; break; }
    if (line.startsWith('tree ')) tree = line.substring(5);
    else if (line.startsWith('parent ')) parents.push(line.substring(7));
    else if (line.startsWith('author ')) {
      const match = line.match(/^(.*) <.*> (\d+) [+-]\d{4}$/);
      if (match) { author = match[1]; timestamp = parseInt(match[2]); }
      else {
        const match2 = line.match(/^(.*) (\d+) [+-]\d{4}$/);
        if (match2) { author = match2[1]; timestamp = parseInt(match2[2]); }
      }
    } else if (line.startsWith('committer ')) {
      const match = line.match(/^(.*) <.*> (\d+) [+-]\d{4}$/);
      if (match) committer = match[1];
      else {
        const match2 = line.match(/^(.*) (\d+) [+-]\d{4}$/);
        if (match2) committer = match2[1];
      }
    }
  }
  return { tree, parents, author, committer, timestamp, message: lines.slice(i).join('\n') };
}

export function parseTree(data: Buffer): { mode: string; name: string; oid: string }[] {
  const entries: { mode: string; name: string; oid: string }[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(32, pos);
    const nullTerm = data.indexOf(0, space);
    const mode = data.toString('utf8', pos, space);
    const name = data.toString('utf8', space + 1, nullTerm);
    const oid = data.toString('hex', nullTerm + 1, nullTerm + 21);
    entries.push({ mode: mode.padStart(6, '0'), name, oid });
    pos = nullTerm + 21;
  }
  return entries;
}

export function readPack(pack: Buffer, lookup?: (oid: string) => GitObject | undefined): {
  objects: Map<string, GitObject>;
} {
  if (pack.subarray(0, 4).toString() !== 'PACK') throw new Error('Invalid pack header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('Unsupported pack version');
  const count = pack.readUInt32BE(8);
  let pos = 12;

  function readVarint() {
    let byte = pack[pos++];
    let res = BigInt(byte & 0x7f);
    let shift = 7n;
    while (byte & 0x80) {
      byte = pack[pos++];
      res |= BigInt(byte & 0x7f) << shift;
      shift += 7n;
    }
    return res;
  }

  const objects = new Map<string, GitObject>();
  const deferred: { pos: number; start: number; type: number; size: number; base?: string | number }[] = [];
  const offsetToOid = new Map<number, string>();

  for (let i = 0; i < count; i++) {
    const startPos = pos;
    let byte = pack[pos++];
    let type = (byte >> 4) & 0x7;
    let size = BigInt(byte & 0xf);
    let shift = 4n;
    while (byte & 0x80) {
      byte = pack[pos++];
      size |= BigInt(byte & 0x7f) << shift;
      shift += 7n;
    }

    if (type === 6) { // OFS_DELTA
      let byte = pack[pos++];
      let offset = BigInt(byte & 0x7f);
      while (byte & 0x80) {
        byte = pack[pos++];
        offset = ((offset + 1n) << 7n) | BigInt(byte & 0x7f);
      }
      deferred.push({ pos, start: startPos, type, size: Number(size), base: startPos - Number(offset) });
      pos = skipZlib(pos);
    } else if (type === 7) { // REF_DELTA
      const baseOid = pack.toString('hex', pos, pos + 20);
      pos += 20;
      deferred.push({ pos, start: startPos, type, size: Number(size), base: baseOid });
      pos = skipZlib(pos);
    } else {
      const data = inflateSync(pack.subarray(pos));
      const typeStr = (['', 'commit', 'tree', 'blob', 'tag'])[type] as GitObjectType;
      const oid = hashObject(typeStr, data);
      objects.set(oid, { type: typeStr, data });
      offsetToOid.set(startPos, oid);
      pos += findZlibEnd(pos);
    }
  }

  function skipZlib(p: number) {
    return p + findZlibEnd(p);
  }

  function findZlibEnd(p: number): number {
    // inflateSync ignores trailing bytes but throws on a truncated stream,
    // so binary-search the smallest prefix that inflates cleanly: that is
    // exactly the zlib stream (header + deflate data + Adler32).
    inflateSync(pack.subarray(p));
    let lo = 0;
    let hi = pack.length - p;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      try {
        inflateSync(pack.subarray(p, p + mid));
        hi = mid;
      } catch {
        lo = mid + 1;
      }
    }
    return lo;
  }

  // Apply deferred deltas (OFS_DELTA by pack offset, REF_DELTA by base oid;
  // a REF_DELTA base may live outside this pack, via lookup). Deltas are
  // applied in pack order so a delta chained off another delta resolves.
  for (const d of deferred) {
    const deltaData = inflateSync(pack.subarray(d.pos, d.pos + findZlibEnd(d.pos)));
    let baseObj: GitObject | undefined;
    if (typeof d.base === 'number') {
      const baseOid = offsetToOid.get(d.base);
      if (baseOid) baseObj = objects.get(baseOid);
    } else if (typeof d.base === 'string') {
      baseObj = objects.get(d.base) || (lookup ? lookup(d.base) : undefined);
    }
    if (!baseObj) throw new Error('Delta base not found');
    const data = applyDelta(baseObj.data, deltaData);
    const oid = hashObject(baseObj.type, data);
    objects.set(oid, { type: baseObj.type, data });
    offsetToOid.set(d.start, oid);
  }

  return { objects };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  function readVarint() {
    let byte = delta[pos++];
    let res = byte & 0x7f;
    let shift = 7;
    while (byte & 0x80) {
      byte = delta[pos++];
      res |= (byte & 0x7f) << shift;
      shift += 7;
    }
    return res;
  }
  const baseSize = readVarint();
  const targetSize = readVarint();
  const chunks: Buffer[] = [];
  while (pos < delta.length) {
    const cmd = delta[pos++];
    if (cmd & 0x80) { // copy
      let offset = 0;
      if (cmd & 0x01) offset |= delta[pos++];
      if (cmd & 0x02) offset |= delta[pos++] << 8;
      if (cmd & 0x04) offset |= delta[pos++] << 16;
      if (cmd & 0x08) offset |= (delta[pos++] << 24) >>> 0;
      let size = 0;
      if (cmd & 0x10) size |= delta[pos++];
      if (cmd & 0x20) size |= delta[pos++] << 8;
      if (cmd & 0x40) size |= delta[pos++] << 16;
      if (size === 0) size = 0x10000;
      chunks.push(base.subarray(offset, offset + size));
    } else if (cmd > 0) { // insert
      chunks.push(delta.subarray(pos, pos + cmd));
      pos += cmd;
    }
  }
  return Buffer.concat(chunks);
}

export function encodePktLine(payload: Buffer | string): Buffer {
  if (typeof payload === 'string') payload = Buffer.from(payload);
  const len = payload.length + 4;
  const h = len.toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(h), payload]);
}

export function decodePktLines(data: Buffer): Buffer[] {
  const res: Buffer[] = [];
  let pos = 0;
  while (pos < data.length) {
    const len = parseInt(data.toString('utf8', pos, pos + 4), 16);
    if (len === 0) { res.push(Buffer.alloc(0)); pos += 4; continue; }
    if (len < 4) break;
    res.push(data.subarray(pos + 4, pos + len));
    pos += len;
  }
  return res;
}

export class NodeGitClient {
  private readonly baseUrl: string;
  private readonly token: string | null;
  private readonly timeoutMs: number;
  private readonly gitProtocol: 0 | 2;

  constructor(options: GitClientOptions) {
    this.baseUrl = options.baseUrl;
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.gitProtocol = options.gitProtocol ?? 2;
  }

  async infoRefs(owner: string, repo: string, service: 'git-upload-pack' | 'git-receive-pack', options: { signal: AbortSignal }): Promise<{ status: number; contentType?: string; packets: GitPacket[] }> {
    const url = `${this.baseUrl}/${owner}/${repo}.git/info/refs?service=${service}`;
    const headers: Record<string, string> = { 'user-agent': 'makefun-git-client/1.0' };
    if (this.token) {
      headers.authorization = `Bearer ${this.token}`;
    }
    
    const controller = new AbortController();
    options.signal.addEventListener('abort', () => controller.abort());
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      
      const contentType = response.headers.get('content-type') || undefined;
      const packets: GitPacket[] = [];
      const reader = response.body.getReader();
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        let offset = 0;
        while (offset < value.length) {
          if (value.length - offset < 4) break;
          const lengthHex = value.toString('utf8', offset, offset + 4);
          offset += 4;
          const length = parseInt(lengthHex, 16);
          if (length === 0) {
            packets.push({ kind: 'flush', payload: Buffer.alloc(0), raw: Buffer.alloc(0) });
            offset += 1;
            break;
          }
          
          if (offset + length > value.length) break;
          const packetData = value.subarray(offset, offset + length - 1);
          offset += length - 1;
          
          packets.push({
            kind: 'data',
            payload: packetData,
            raw: value.subarray(offset - 4, offset + 1),
          });
        }
      }
      
      return {
        status: response.status,
        contentType,
        packets,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async lsRefs(owner: string, repo: string, options: { signal: AbortSignal; symrefs?: boolean; peel?: boolean; prefixes?: string[] }): Promise<{ protocol: 0 | 2; refs: GitRef[]; rawRefs: GitRef[] }> {
    const url = `${this.baseUrl}/${owner}/${repo}.git/info/refs?service=git-upload-pack`;
    const headers: Record<string, string> = {
      'user-agent': 'makefun-git-client/1.0',
      'git-protocol': 'version=2',
    };
    if (this.token) {
      headers.authorization = `Bearer ${this.token}`;
    }
    
    const controller = new AbortController();
    options.signal.addEventListener('abort', () => controller.abort());
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      
      const packets: GitPacket[] = [];
      const reader = response.body.getReader();
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        let offset = 0;
        while (offset < value.length) {
          if (value.length - offset < 4) break;
          const lengthHex = value.toString('utf8', offset, offset + 4);
          offset += 4;
          const length = parseInt(lengthHex, 16);
          if (length === 0) {
            offset += 1;
            break;
          }
          
          if (offset + length > value.length) break;
          const packetData = value.subarray(offset, offset + length - 1);
          offset += length - 1;
          
          packets.push({
            kind: 'data',
            payload: packetData,
            raw: value.subarray(offset - 4, offset + 1),
          });
        }
      }
      
      const versionLine = packets.find(p => p.kind === 'data' && p.payload.toString('utf8').startsWith('version 2'))?.payload.toString('utf8').trim() || '';
      const protocol = versionLine === 'version 2' ? 2 : 0;
      
      const refs: GitRef[] = [];
      const rawRefs: GitRef[] = [];
      
      for (const packet of packets) {
        if (packet.kind !== 'data') continue;
        const lines = packet.payload.toString('utf8').split('\n');
        for (const line of lines) {
          if (!line) continue;
          if (line === 'capabilities^{}') {
            rawRefs.push({ name: 'capabilities^{}' });
            continue;
          }
          
          const spaceIndex = line.indexOf(' ');
          if (spaceIndex > 0) {
            const oid = line.substring(0, spaceIndex);
            let name = line.substring(spaceIndex + 1);
            let peeled = '';
            let symrefTarget = '';
            
            if (name.startsWith('symref=')) {
              const symrefMatch = name.match(/symref=(refs\/[^,]+),refs\/[^)]+/);
                 if (symrefMatch) {
                   symrefTarget = symrefMatch[1];
                   name = 'HEAD';
                 }
               } else if (name.includes('^{}')) {
                 peeled = name.substring(0, name.length - 3);
                 name = name.substring(0, name.length - 3);
               }
            
            rawRefs.push({ name, oid, peeled, symrefTarget });
            
            if (!options.symrefs && name === 'HEAD' && symrefTarget) continue;
            if (!options.peel && peeled) continue;
            if (options.prefixes && !options.prefixes.some(prefix => name.startsWith(prefix))) continue;
            
            refs.push({ name, oid, peeled, symrefTarget });
          }
        }
      }
      
      return { protocol, refs, rawRefs };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async advertisement(owner: string, repo: string, service: 'git-upload-pack' | 'git-receive-pack', options: { signal: AbortSignal }): Promise<{ protocol: 0 | 2; capabilities: Map<string, string>; refs: GitRef[] }> {
    const url = `${this.baseUrl}/${owner}/${repo}.git/info/refs?service=${service}`;
    const headers: Record<string, string> = {
      'user-agent': 'makefun-git-client/1.0',
    };
    if (this.token) {
      headers.authorization = `Bearer ${this.token}`;
    }
    
    const controller = new AbortController();
    options.signal.addEventListener('abort', () => controller.abort());
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      
      const packets: GitPacket[] = [];
      const reader = response.body.getReader();
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        let offset = 0;
        while (offset < value.length) {
          if (value.length - offset < 4) break;
          const lengthHex = value.toString('utf8', offset, offset + 4);
          offset += 4;
          const length = parseInt(lengthHex, 16);
          if (length === 0) {
            offset += 1;
            break;
          }
          
          if (offset + length > value.length) break;
          const packetData = value.subarray(offset, offset + length - 1);
          offset += length - 1;
          
          packets.push({
            kind: 'data',
            payload: packetData,
            raw: value.subarray(offset - 4, offset + 1),
          });
        }
      }
      
      const refs: GitRef[] = [];
      const capabilities: Map<string, string> = new Map();
      
      for (const packet of packets) {
        if (packet.kind !== 'data') continue;
        const content = packet.payload.toString('utf8');
        if (content.startsWith('version 2')) {
          const lines = content.split('\n');
          for (let i = 1; i < lines.length; i++) {
            const line = lines[i];
            if (!line) continue;
            if (line.includes('=')) {
              const [key, value] = line.split('=', 2);
              capabilities.set(key, value);
            } else if (line.startsWith('PEEL ')) {
              const peeledRef = line.substring(5);
              const existingRef = refs.find(r => r.name === peeledRef);
              if (existingRef) {
                existingRef.peeled = peeledRef;
              }
            }
          }
        } else if (content.startsWith('# service=')) {
          const lines = content.split('\n');
          for (let i = 1; i < lines.length; i++) {
            const line = lines[i];
            if (!line) continue;
            if (line.includes('=')) {
              const [key, value] = line.split('=', 2);
              capabilities.set(key, value);
            } else {
              const spaceIndex = line.indexOf(' ');
              if (spaceIndex > 0) {
                const oid = line.substring(0, spaceIndex);
                let name = line.substring(spaceIndex + 1);
                let peeled = '';
                let symrefTarget = '';
                
                if (name.includes('^{}')) {
                  peeled = name.substring(0, name.length - 3);
                  name = name.substring(0, name.length - 3);
                }
                
                refs.push({ name, oid, peeled, symrefTarget });
              }
            }
          }
        }
      }
      
      const protocol = capabilities.has('version 2') ? 2 : 0;
      return { protocol, capabilities, refs };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async clone(owner: string, repo: string, options: { signal: AbortSignal; depth?: number }): Promise<CloneResult> {
    const service = 'git-upload-pack';
    const advertisement = await this.advertisement(owner, repo, service, options);
    
    const ref = advertisement.refs.find(r => r.name === 'HEAD') || { name: 'HEAD', symrefTarget: 'refs/heads/main' };
    
    const packets: GitPacket[] = [];
    const capabilities: string[] = [];
    const wantRefs: string[] = [];
    const haveRefs: string[] = [];
    
    if (advertisement.protocol === 2) {
      capabilities.push('multi_ack_detailed');
      capabilities.push('no-done');
      capabilities.push('thin-pack');
      capabilities.push('side-band=64k');
      capabilities.push('report-status');
      capabilities.push('delete-refs');
      capabilities.push('ofs-delta');
      capabilities.push('ref-delta');
      capabilities.push('shallow');
      capabilities.push('deepen-since');
      capabilities.push('deepen-not');
      capabilities.push('multi_ack_detailed');
      capabilities.push('no-done');
      capabilities.push('thin-pack');
      capabilities.push('side-band=64k');
      capabilities.push('report-status');
      capabilities.push('delete-refs');
      capabilities.push('ofs-delta');
      capabilities.push('ref-delta');
      capabilities.push('shallow');
      capabilities.push('deepen-since');
      capabilities.push('deepen-not');
      capabilities.push('object-format=sha1');
      
      const url = `${this.baseUrl}/${owner}/${repo}.git/git-upload-pack`;
      const headers: Record<string, string> = {
        'user-agent': 'makefun-git-client/1.0',
        'content-type': 'application/x-git-upload-pack-request',
      };
      if (this.token) {
        headers.authorization = `Bearer ${this.token}`;
      }
      
      const controller = new AbortController();
      options.signal.addEventListener('abort', () => controller.abort());
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
      
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: Buffer.from('version 2\n' + capabilities.map(c => c.includes('=') ? c : `${c}\n`).join('')),
          signal: controller.signal,
        });
        
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          let offset = 0;
          while (offset < value.length) {
            if (value.length - offset < 4) break;
            const lengthHex = value.toString('utf8', offset, offset + 4);
            offset += 4;
            const length = parseInt(lengthHex, 16);
            if (length === 0) {
              offset += 1;
              break;
            }
            
            if (offset + length > value.length) break;
            const packetData = value.subarray(offset, offset + length - 1);
            offset += length - 1;
            
            packets.push({
              kind: 'data',
              payload: packetData,
              raw: value.subarray(offset - 4, offset + 1),
            });
          }
        }
        
        for (const packet of packets) {
          if (packet.kind !== 'data') continue;
          const content = packet.payload.toString('utf8');
          if (content.startsWith('want ')) {
            wantRefs.push(...content.split('\n').filter(line => line.startsWith('want ')).map(line => line.substring(5)));
          } else if (content.startsWith('have ')) {
            haveRefs.push(...content.split('\n').filter(line => line.startsWith('have ')).map(line => line.substring(5)));
          } else if (content === 'done') {
            break;
          }
        }
      } finally {
        clearTimeout(timeoutId);
      }
    } else {
      const url = `${this.baseUrl}/${owner}/${repo}.git/git-upload-pack`;
      const headers: Record<string, string> = {
        'user-agent': 'makefun-git-client/1.0',
        'content-type': 'application/x-git-upload-pack-request',
      };
      if (this.token) {
        headers.authorization = `Bearer ${this.token}`;
      }
      
      const controller = new AbortController();
      options.signal.addEventListener('abort', () => controller.abort());
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
      
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: Buffer.from('# service=git-upload-pack\n'),
          signal: controller.signal,
        });
        
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          let offset = 0;
          while (offset < value.length) {
            if (value.length - offset < 4) break;
            const lengthHex = value.toString('utf8', offset, offset + 4);
            offset += 4;
            const length = parseInt(lengthHex, 16);
            if (length === 0) {
              offset += 1;
              break;
            }
            
            if (offset + length > value.length) break;
            const packetData = value.subarray(offset, offset + length - 1);
            offset += length - 1;
            
            packets.push({
              kind: 'data',
              payload: packetData,
              raw: value.subarray(offset - 4, offset + 1),
            });
          }
        }
        
        for (const packet of packets) {
          if (packet.kind !== 'data') continue;
          const content = packet.payload.toString('utf8');
          if (content.startsWith('want ')) {
            wantRefs.push(...content.split('\n').filter(line => line.startsWith('want ')).map(line => line.substring(5)));
          } else if (content.startsWith('have ')) {
            haveRefs.push(...content.split('\n').filter(line => line.startsWith('have ')).map(line => line.substring(5)));
          } else if (content === 'NAK') {
            break;
          }
        }
      } finally {
        clearTimeout(timeoutId);
      }
    }
    
    const objects: Map<string, GitObject> = new Map();
    let packBytes = 0;
    let deltaCount = 0;
    
    if (wantRefs.length > 0) {
      const fetchResult = await this.fetch(owner, repo, {
        signal: options.signal,
        wants: wantRefs,
        haves: haveRefs,
        haveObjects: objects,
        parse: true,
      });
      
      objects.clear();
      objects.set(...fetchResult.objects.entries());
      packBytes = fetchResult.packBytes;
      deltaCount = fetchResult.deltaCount;
    }
    
    const refs: GitRef[] = [];
    const rawRefs: GitRef[] = [];
    
    if (advertisement.refs.length === 0) {
      refs.push({ name: 'HEAD', symrefTarget: 'refs/heads/main' });
      rawRefs.push({ name: 'HEAD', symrefTarget: 'refs/heads/main' });
    } else {
      refs.push(...advertisement.refs);
      rawRefs.push(...advertisement.refs);
    }
    
    return {
      objects,
      refs,
      pack: undefined,
      packBytes,
      deltaCount,
      shallow: [],
      head: ref.symrefTarget,
    };
  }

  async fetch(owner: string, repo: string, options: {
    signal: AbortSignal;
    wants: string[];
    haves: string[];
    haveObjects: Map<string, GitObject>;
    parse: boolean;
    observe?: (packet: GitPacket) => void;
    shallow?: string[];
    depth?: number;
  }): Promise<FetchResult> {
    const service = 'git-upload-pack';
    
    const packets: GitPacket[] = [];
    const objects: Map<string, GitObject> = new Map();
    
    const wantLines = options.wants.map(want => `want ${want}\n`);
    const haveLines = options.haves.map(have => `have ${have}\n`);
    
    const body = Buffer.from(wantLines.join('') + haveLines.join('') + 'done\n');
    
    const url = `${this.baseUrl}/${owner}/${repo}.git/git-upload-pack`;
    const headers: Record<string, string> = {
      'user-agent': 'makefun-git-client/1.0',
      'content-type': 'application/x-git-upload-pack-request',
    };
    if (this.token) {
      headers.authorization = `Bearer ${this.token}`;
    }
    
    const controller = new AbortController();
    options.signal.addEventListener('abort', () => controller.abort());
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
      
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        let offset = 0;
        while (offset < value.length) {
          if (value.length - offset < 4) break;
          const lengthHex = value.toString('utf8', offset, offset + 4);
          offset += 4;
          const length = parseInt(lengthHex, 16);
          if (length === 0) {
            offset += 1;
            break;
          }
          
          if (offset + length > value.length) break;
          const packetData = value.subarray(offset, offset + length - 1);
          offset += length - 1;
          
          const packet: GitPacket = {
            kind: 'data',
            payload: packetData,
            raw: value.subarray(offset - 4, offset + 1),
          };
          
          packets.push(packet);
          if (options.observe) {
            options.observe(packet);
          }
        }
      }
      
      const packChunks: Buffer[] = [];
      let progressBytes = 0;
      let sidebandPackets = 0;
      
      for (const packet of packets) {
        if (packet.kind !== 'data') continue;
        
        const payload = packet.payload;
        const band = payload[0];
        
        if (band === 1) {
          packChunks.push(payload.subarray(1));
        } else if (band === 2) {
          progressBytes += payload.length - 1;
        } else if (band === 3) {
          throw new GitProtocolError(`sideband error: ${payload.subarray(1).toString('utf8').trim()}`, 'sideband-error');
        } else if (band === 0) {
          throw new GitProtocolError(`invalid sideband ${band}`, 'invalid-sideband');
        }
        
        sidebandPackets++;
      }
      
      if (packChunks.length === 0) {
        return {
          objects: new Map(),
          pack: undefined,
          packBytes: 0,
          deltaCount: 0,
          declaredCount: 0,
          shallow: [],
          unshallow: [],
        };
      }
      
      const pack = Buffer.concat(packChunks);
      packBytes += pack.length;
      
      const parsed = readPack(pack);
      deltaCount = parsed.deltaCount;
      
      objects.clear();
      objects.set(...parsed.objects.entries());
      
      return {
        objects,
        pack,
        packBytes,
        deltaCount,
        declaredCount: parsed.declaredCount,
        shallow: [],
        unshallow: [],
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async push(owner: string, repo: string, commands: PushCommand[], options: { objects?: GitObject[]; pack?: Uint8Array; signal: AbortSignal }): Promise<PushResult> {
    const url = `${this.baseUrl}/${owner}/${repo}.git/git-receive-pack`;
    const headers: Record<string, string> = {
      'user-agent': 'makefun-git-client/1.0',
      'content-type': 'application/x-git-receive-pack-request',
    };
    if (this.token) {
      headers.authorization = `Bearer ${this.token}`;
    }
    
    const controller = new AbortController();
    options.signal.addEventListener('abort', () => controller.abort());
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    
    try {
      let body: Buffer;
      if (options.pack) {
        body = options.pack;
      } else {
        const objMap = new Map<string, GitObject>();
        if (options.objects) {
          for (const obj of options.objects) {
            objMap.set(hashObject(obj.type, obj.data), obj);
          }
        }
        body = this.createPack(objMap);
      }
      
      const commandList = commands.map(cmd => 
        `${cmd.oldOid} ${cmd.newOid} ${cmd.ref}\n`
      ).join('') + 'report-status\ndelete-refs\nside-band=64k\n0000'
        ;
      
      const fullBody = Buffer.concat([Buffer.from(commandList), body]);
      
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: fullBody,
        signal: controller.signal,
      });
      
      const reader = response.body.getReader();
      const packets: GitPacket[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        let offset = 0;
        while (offset < value.length) {
          if (value.length - offset < 4) break;
          const lengthHex = value.toString('utf8', offset, offset + 4);
          offset += 4;
          const length = parseInt(lengthHex, 16);
          if (length === 0) {
            offset += 1;
            break;
          }
          
          if (offset + length > value.length) break;
          const packetData = value.subarray(offset, offset + length - 1);
          offset += length - 1;
          
          packets.push({
            kind: 'data',
            payload: packetData,
            raw: value.subarray(offset - 4, offset + 1),
          });
        }
      }
      
      const sidebandPackets: GitPacket[] = packets.filter(p => p.kind === 'data');
      const reportStatusPackets: GitPacket[] = [];
      const progressPackets: Buffer[] = [];
      
      for (const packet of sidebandPackets) {
        const band = packet.payload[0];
        if (band === 1) {
          reportStatusPackets.push(packet);
        } else if (band === 2) {
          progressPackets.push(packet.payload.subarray(1));
        } else if (band === 3) {
          throw new GitProtocolError(`sideband error: ${packet.payload.subarray(1).toString('utf8').trim()}`, 'sideband-error');
        }
      }
      
      const unpackOk = reportStatusPackets.some(p => {
        const content = p.payload.toString('utf8');
        return content === 'unpack ok' || content === 'unpack ok\n';
      });
      
      const refs: { ref: string; ok: boolean; reason?: string }[] = [];
      for (const packet of reportStatusPackets) {
        const content = packet.payload.toString('utf8');
        if (content.startsWith('ref ')) {
          const [_, ref, status] = content.split(' ');
          refs.push({ ref, ok: status === 'ok', reason: status !== 'ok' ? status : undefined });
        }
      }
      
      return {
        unpackOk,
        report: {
          unpackOk,
          unpackDetail: unpackOk ? undefined : 'unpack failed',
          refs,
        },
        sideband: sidebandPackets.length > 0,
        progress: progressPackets,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  createPack(objects: Map<string, GitObject>): Buffer {
    let offset = 0;
    
    function writeVarint(value: number): void {
      while (value >= 0x80) {
        pack[offset++] = (value & 0x7f) | 0x80;
        value >>>= 7;
      }
      pack[offset++] = value;
    }
    
    const pack: number[] = [];
    
    pack[offset++] = 0x50; // version 2
    
    const objectList: { oid: string; type: GitObjectType; data: Buffer }[] = [];
    for (const [oid, obj] of objects.entries()) {
      objectList.push({ oid, type: obj.type, data: obj.data });
    }
    
    const typeMap: Record<GitObjectType, number> = { blob: 1, tree: 2, commit: 3, tag: 4 };
    
    for (const { oid, type, data } of objectList) {
      const typeCode = typeMap[type];
      const timeSize = (typeCode << 4) | 0;
      pack.writeUInt32BE(timeSize, offset);
      offset += 4;
      writeVarint(data.length);
      pack.set(data, offset);
      offset += data.length;
    }
    
    const checksum = createHash('sha1');
    checksum.update(Buffer.from(pack.slice(0, offset)));
    const checksumBytes = checksum.digest();
    
    pack[offset++] = checksumBytes[0];
    pack[offset++] = checksumBytes[1];
    pack[offset++] = checksumBytes[2];
    pack[offset++] = checksumBytes[3];
    
    return Buffer.from(pack.slice(0, offset));
  }

  async postRaw(owner: string, repo: string, service: string, data: Buffer, options: { signal: AbortSignal }): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
    const url = `${this.baseUrl}/${owner}/${repo}.git/${service}`;
    const headers: Record<string, string> = {
      'user-agent': 'makefun-git-client/1.0',
    };
    if (this.token) {
      headers.authorization = `Bearer ${this.token}`;
    }
    
    const controller = new AbortController();
    options.signal.addEventListener('abort', () => controller.abort());
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: data,
        signal: controller.signal,
      });
      
      const body = await response.arrayBuffer();
      
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });
      
      return {
        status: response.status,
        headers: responseHeaders,
        body: Buffer.from(body),
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async createRepo(owner: string, repo: string, body: any, options: { signal: AbortSignal }): Promise<{ status: number; headers: Record<string, string>; body: unknown }> {
    const url = `${this.baseUrl}/api/v3/user/repos`;
    const headers: Record<string, string> = {
      'user-agent': 'makefun-git-client/1.0',
      'content-type': 'application/json',
    };
    if (this.token) {
      headers.authorization = `Bearer ${this.token}`;
    }
    
    const controller = new AbortController();
    options.signal.addEventListener('abort', () => controller.abort());
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });
      
      let responseBody = null;
      try {
        responseBody = await response.json();
      } catch {}
      
      return {
        status: response.status,
        headers: responseHeaders,
        body: responseBody,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

export const gitClient = new NodeGitClient({
  baseUrl: process.env.MAKEFUN_ENV_URL || 'http://localhost:8080',
  token: process.env.MAKEFUN_SHOP_TOKEN || null,
  signal: AbortSignal.timeout(30000),
});
