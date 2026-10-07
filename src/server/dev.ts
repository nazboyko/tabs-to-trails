import { createServer } from 'vite';
import { loadConfig } from './config.js';
import { start } from './app.js';

// Development only: the API server plus Vite with hot reload, which proxies /api and /w to it.
await start();
const vite = await createServer({ configFile: new URL('../../vite.config.ts', import.meta.url).pathname });
await vite.listen();
console.log(`Web with hot reload at http://localhost:${vite.config.server.port} (API on port ${loadConfig().PORT})`);
