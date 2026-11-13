import http from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import worker, { collect } from '../src/worker.ts';
import { SqliteStore } from './sqlite.mjs';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
export async function startServer({ port = 8080, host = '0.0.0.0', dbPath = './storage/lab.sqlite', publicDir = new URL('../public/', import.meta.url).pathname, scheduling = true } = {}) {
  const DB = new SqliteStore(dbPath), base = await realpath(publicDir);
  const env = { DB, ASSETS: { async fetch(request) {
    if (!['GET','HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
    try {
      let name = decodeURIComponent(new URL(request.url).pathname);
      if (name.endsWith('/')) name += 'index.html';
      const path = await realpath(resolve(base, '.' + name));
      if (!path.startsWith(base + sep)) return new Response('Not found', { status: 404 });
      let body = await readFile(path);
      // Portable deployment uses its own API origin; portfolio source is unchanged until cutover.
      if (extname(path) === '.html') body = Buffer.from(body.toString().replace(/data-api="[^"]*"/g, 'data-api=""').replace(/ data-mode="[^"]*"/g, ''));
      return new Response(body, { headers: { 'Content-Type': MIME[extname(path)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' } });
    } catch { return new Response('Not found', { status: 404 }); }
  } } };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/healthz') {
        DB.db.prepare('SELECT 1').get(); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ready":true}'); return;
      }
      const response = await worker.fetch(new Request(url, { method: req.method }), env);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(req.method === 'HEAD' ? undefined : Buffer.from(await response.arrayBuffer()));
    } catch (error) { console.error(error); if (!res.headersSent) res.writeHead(500); res.end('Service unavailable'); }
  });
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(port, host, ok); });
  let stopping = false, timer, pending = Promise.resolve();
  const tick = () => {
    const started = Date.now();
    pending = collect(env).catch(error => console.error('Collector failed:', error.message)).finally(() => {
      if (!stopping) timer = setTimeout(tick, Math.max(1000, 60_000 - (Date.now() - started)));
    });
  };
  if (scheduling) tick();
  return { server, DB, async close() {
    stopping = true; clearTimeout(timer);
    await Promise.all([pending, new Promise(resolve => server.close(resolve))]); DB.close();
  } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const runtime = await startServer({ port: Number(process.env.PORT || 8080), dbPath: process.env.DB_PATH || './storage/lab.sqlite', scheduling: process.env.COLLECTOR_ENABLED !== 'false' });
  console.log(`Live Data Lab listening on ${runtime.server.address().port}`);
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => runtime.close().then(() => process.exit(0)));
}
