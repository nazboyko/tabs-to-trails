import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { loadConfig } from './config.js';
import { buildRoutes } from './routes/build.js';
import { healthRoutes } from './routes/health.js';
import { voiceRoutes } from './routes/voices.js';
import { phoneRoutes, walkRoutes } from './routes/walk.js';
import { Jobs } from './walks/jobs.js';
import { isLoopback, lanAddress } from './walks/share.js';

/** Built web files sit next to the built server: dist/server -> dist/web. */
export const WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url));

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function hostName(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(`http://${value}`).hostname;
  } catch {
    return null;
  }
}

function localOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    return LOCAL_HOSTS.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

async function readOptional(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

export interface AccessRequest {
  path: string;
  method: string;
  remote: string | undefined;
  host: string | undefined;
  origin: string | undefined;
}

/**
 * The access rule. Everything answers only to this computer, except the
 * phone page and its audio (which also need the walk's token) and the static
 * files that page loads. /api also checks the Host header, against DNS
 * rebinding, and the Origin of writes, against other sites posting here.
 */
export function access(req: AccessRequest): 'ok' | 'hidden' | 'host' | 'origin' {
  if (req.path.startsWith('/w/') || req.path.startsWith('/assets/') || req.path === '/favicon.svg') return 'ok';
  if (!isLoopback(req.remote)) return 'hidden';
  if (req.path.startsWith('/api/')) {
    const host = hostName(req.host);
    if (!host || !LOCAL_HOSTS.has(host)) return 'host';
    if (req.method !== 'GET' && req.method !== 'HEAD' && !localOrigin(req.origin)) return 'origin';
  }
  return 'ok';
}

export function createApp(jobs: Jobs, webDir = WEB_DIR) {
  const app = new Hono();

  app.use('*', async (c, next) => {
    let remote: string | undefined;
    try {
      remote = getConnInfo(c).remote.address;
    } catch {
      remote = undefined;
    }
    const decision = access({ path: c.req.path, method: c.req.method, remote, host: c.req.header('host'), origin: c.req.header('origin') });
    if (decision === 'hidden') return c.text('Not found', 404);
    if (decision === 'host') return c.json({ error: 'Open the app at localhost.' }, 403);
    if (decision === 'origin') return c.json({ error: 'Requests from other sites are not accepted.' }, 403);
    return next();
  });

  app.use('/api/build', bodyLimit({ maxSize: 3 * 1024 * 1024, onError: (c) => c.json({ error: 'That is more text than one walk can hold.' }, 413) }));

  app.route('/api/health', healthRoutes);
  app.route('/api/voices', voiceRoutes);
  app.route('/api/build', buildRoutes(jobs));
  app.route('/api/walks', walkRoutes(jobs));
  app.route('/w', phoneRoutes(jobs, () => readOptional(path.join(webDir, 'phone.html'))));

  app.use('/assets/*', serveStatic({ root: path.relative(process.cwd(), webDir), onFound: (_p, c) => c.header('Cache-Control', 'public, max-age=31536000, immutable') }));
  app.get('/favicon.svg', serveStatic({ path: path.relative(process.cwd(), path.join(webDir, 'favicon.svg')) }));

  app.get('*', async (c) => {
    if (c.req.path.startsWith('/api/')) return c.json({ error: 'Not found' }, 404);
    const html = await readOptional(path.join(webDir, 'index.html'));
    if (!html) return c.text('The web app is not built yet. Run: npm run build', 503);
    return c.html(html, 200, { 'Cache-Control': 'no-store' });
  });

  return app;
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args as string[], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
  } catch {
    // Opening the browser is a convenience; the address is printed anyway.
  }
}

export async function start(options: { open?: boolean } = {}) {
  const cfg = loadConfig();
  const jobs = new Jobs();
  const app = createApp(jobs);
  const server = serve({ fetch: app.fetch, port: cfg.PORT, hostname: '0.0.0.0' });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  }).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${cfg.PORT} is already in use. Stop the other server, or start with PORT=8790 npm start.`);
      process.exit(1);
    }
    throw err;
  });
  const url = `http://localhost:${cfg.PORT}`;
  console.log(`Tabs to Trails is running at ${url}`);
  console.log(lanAddress() ? 'Phones on the same Wi-Fi can open walks through the QR code.' : 'No network found, so there is no phone link. Downloads still work.');
  const resumed = await jobs.resumeAll();
  if (resumed.length) console.log(`Picking up ${resumed.length} unfinished ${resumed.length === 1 ? 'walk' : 'walks'} where ${resumed.length === 1 ? 'it' : 'they'} stopped.`);
  if (options.open) openBrowser(url);
  return { server, jobs, app };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void start({ open: process.argv.includes('--open') });
}
