// Convenience launcher for local integration: synthetic source + workbench in one process group.
// Not used by tests or production; each service can also be started on its own.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const sourcePort = process.env.SOURCE_PORT ?? '4173';
const appPort = process.env.APP_PORT ?? process.env.PORT ?? '4180';

const children = [
  spawn(process.execPath, ['sources/source.mjs'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, SOURCE_PORT: sourcePort },
  }),
  spawn(process.execPath, ['app/server.mjs'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, APP_PORT: appPort, SOURCE_URL: `http://127.0.0.1:${sourcePort}` },
  }),
];

let stopping = false;
function stop(signal) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill(signal);
}

for (const child of children) {
  child.on('exit', (code, signal) => {
    if (code !== 0 && signal == null) process.exitCode = code ?? 1;
    stop('SIGTERM');
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop(signal));
