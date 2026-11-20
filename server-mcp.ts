"use strict";

import { IncomingMessage, ServerResponse } from 'node:http';
import { InMemoryStore } from './store.ts';
import { McpServer } from './mcp.ts';
import { viewerLogin } from './scenario.ts';

let requestIdCounter = 0;

export async function handleMcp(store: InMemoryStore, req: IncomingMessage, res: ServerResponse) {
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
  
  try {
    if (path === '/mcp' && method === 'POST') {
      await handleMcpRequest(store, req, res);
      return;
    }
    
    res.statusCode = 404;
    res.end(JSON.stringify({ message: 'Not Found' }));
  } catch (e: any) {
    res.statusCode = e.status || 500;
    res.end(JSON.stringify({ message: e.message || 'Internal Server Error' }));
  }
}

async function handleMcpRequest(store: InMemoryStore, req: IncomingMessage, res: ServerResponse) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const request = JSON.parse(body) as {
          jsonrpc: string;
          id?: unknown;
          method: string;
          params?: any;
        };
        
        const response = await new McpServer(store, viewerLogin(), 3000).handleRequest(request);
        
        res.setHeader('Content-Type', 'application/json');
        res.statusCode = 200;
        res.end(JSON.stringify(response));
        resolve();
      } catch (error) {
        const errorResponse = {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32700,
            message: 'Parse error',
          },
        };
        res.setHeader('Content-Type', 'application/json');
        res.statusCode = 400;
        res.end(JSON.stringify(errorResponse));
        resolve();
      }
    });
  });
}
