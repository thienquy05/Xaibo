// `npm run dev`: Vite on loopback for the renderer, then Electron on the tsc output.
// Unpackaged runs use the Xaibo-dev data dir (P1-T04 app-paths); main reads the dev origin from the env.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'vite';

const electron = createRequire(import.meta.url)('electron') as string;
const server = await createServer({ configFile: 'vite.config.ts' });
await server.listen();
const url = server.resolvedUrls?.local[0];
if (!url) throw new Error('vite: no local URL');

const env: NodeJS.ProcessEnv = { ...process.env, XAIBO_DEV_SERVER_URL: url };
delete env.ELECTRON_RUN_AS_NODE; // D-P0-10
const app = spawn(electron, ['.'], { stdio: 'inherit', env });
app.on('exit', (code) => void server.close().then(() => process.exit(code ?? 0)));
