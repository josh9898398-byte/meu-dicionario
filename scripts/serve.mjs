#!/usr/bin/env node
/**
 * Zero-dependency static dev server.
 *
 *   npm run dev            -> http://localhost:5173
 *   npm run dev -- --port 8080
 *
 * Service workers require a secure context: localhost counts as secure, so
 * offline behaviour can be tested locally and then verified on the iPhone over
 * https in production.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const PORT = Number(portArg >= 0 ? args[portArg + 1] : process.env.PORT || 5173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.woff2': 'font/woff2'
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';
    if (!extname(pathname) && pathname !== '/') {
      // SPA-ish fallback for hash routing deep links
      pathname = '/index.html';
    }
    const target = join(ROOT, normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
    if (!target.startsWith(ROOT)) { res.writeHead(403).end('Forbidden'); return; }

    const info = await stat(target).catch(() => null);
    const file = info?.isDirectory() ? join(target, 'index.html') : target;
    const body = await readFile(file);
    const type = MIME[extname(file)] || 'application/octet-stream';
    const headers = {
      'Content-Type': type,
      'Cache-Control': file.endsWith('sw.js') ? 'no-cache' : 'no-cache'
    };
    res.writeHead(200, headers).end(body);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
      return;
    }
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end(String(err));
  }
});

server.listen(PORT, () => {
  console.log(`\n  Meu Dicionário — dev server\n  → http://localhost:${PORT}\n  (Ctrl+C to stop)\n`);
});
