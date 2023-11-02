import type { IncomingMessage, ServerResponse } from 'node:http';

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';

import type { ChildProcessSocket } from './transport';

export interface WebUIOptions {
  port?: number;

  rpc: {
    port: number;

    secret: string | undefined;
  };
}

export async function launchWebUI(options: WebUIOptions) {
  const serveStatic = (await import('serve-static')).default;
  const finalhandler = (await import('finalhandler')).default;
  const http = await import('http');

  const port = options.port ?? 6801;
  const clientDir = fileURLToPath(new URL('../client', import.meta.url));
  const serve = serveStatic(clientDir, { index: ['index.html'] });
  const server = http.createServer(async (req, res) => {
    if (await handleWebUIRequest(req, res, options)) {
      return;
    }
    serve(req, res, finalhandler(req, res));
  });

  server.listen(port);

  return server;
}

export async function attachWebUI(
  process: ChildProcessSocket,
  options: Pick<WebUIOptions, 'port'> = {}
) {
  return await launchWebUI({
    port: options?.port ?? 6801,
    rpc: {
      port: process.getOptions().listenPort,
      secret: process.getOptions().secret
    }
  });
}

export async function handleWebUIRequest(
  req: IncomingMessage,
  res: ServerResponse<IncomingMessage>,
  options: Pick<WebUIOptions, 'rpc'>
) {
  if (!req.url) return false;

  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/jsonrpc') {
      res.end();
      return true;
    } else if (url.pathname === '/_/open') {
      return await handleWebUIOpenRequest(url, req, res, options);
    }
    return false;
  } catch (error) {
    return false;
  }
}

export async function handleWebUIOpenRequest(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse<IncomingMessage>,
  options: Pick<WebUIOptions, 'rpc'>
) {
  try {
    const auth = req.headers.authorization;
    res.setHeader('Content-Type', 'application/json');
    if (options.rpc.secret && options.rpc.secret !== auth) {
      res.statusCode = 400;
      res.write(JSON.stringify({ status: 'ERROR' }));
    } else {
      const dir = url.searchParams.get('dir');
      if (dir) {
        const open = (await import('open')).default;
        const p = decodeURIComponent(dir);
        const stat = await fs.stat(p);
        if (stat.isDirectory()) {
          await open(p).catch(() => {});
          res.write(JSON.stringify({ status: 'OK', open: p }));
        } else {
          const d = path.dirname(p);
          await open(d).catch(() => {});
          res.write(JSON.stringify({ status: 'OK', open: d }));
        }
      }
    }
    res.end();
    return true;
  } catch (error) {
    return false;
  }
}
