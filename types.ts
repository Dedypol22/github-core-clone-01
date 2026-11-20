"use strict";

export interface GitObject {
  type: 'blob' | 'tree' | 'commit' | 'tag';
  data: Buffer;
}

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitPacket {
  readonly kind: 'data' | 'flush' | 'delim' | 'response-end';
  readonly payload: Buffer;
  readonly raw: Buffer;
}

export interface GitRef {
  name: string;
  oid?: string;
  symrefTarget?: string;
  peeled?: string;
}

export interface GitClientOptions {
  baseUrl: string;
  token: string | null;
  signal: AbortSignal;
  timeoutMs?: number;
  gitProtocol?: 0 | 2;
}

export interface PushCommand {
  ref: string;
  oldOid: string;
  newOid: string;
}

export interface PushResult {
  unpackOk: boolean;
  unpackDetail?: string;
  report?: {
    unpackOk: boolean;
    refs: {
      ref: string;
      ok: boolean;
      reason?: string;
    }[];
  };
  sideband?: boolean;
  progress?: Buffer[];
}

export interface FetchResult {
  objects: Map<string, GitObject>;
  pack?: Uint8Array;
  packBytes: number;
  deltaCount: number;
  declaredCount: number;
  shallow: string[];
  unshallow: string[];
}

export interface CloneResult {
  objects: Map<string, GitObject>;
  refs: GitRef[];
  pack?: Uint8Array;
  packBytes: number;
  deltaCount: number;
  shallow: string[];
  head?: string;
}

export interface RestResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  text: string;
}

export interface GraphQLResponse<T = unknown> {
  status: number;
  headers: Record<string, string>;
  errors: { message: string }[];
  data: T | null;
  text: string;
}

export interface McpResponse {
  status: number;
  headers: Record<string, string>;
  rpc?: {
    jsonrpc: string;
    id?: unknown;
    result?: unknown;
    error?: {
      code: number;
      message: string;
      data?: unknown;
    };
  };
  text: string;
}

export interface GitProtocolError extends Error {
  readonly code: string;
}

export interface GitHttpError extends Error {
  readonly url: string;
  readonly status: number;
  readonly bodySnippet: string;
}
