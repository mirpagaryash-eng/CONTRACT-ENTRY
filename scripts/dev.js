import { spawn } from 'node:child_process';
const children = [
  spawn(process.execPath, ['--use-env-proxy', '--env-file-if-exists=.env', '--watch', 'server/index.js'], { stdio: 'inherit' }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '0.0.0.0'], { stdio: 'inherit' }),
];
let closing = false;
function stop(code = 0) { if (closing) return; closing = true; for (const child of children) child.kill('SIGTERM'); process.exitCode = code; }
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => stop());
for (const child of children) { child.on('error', (err) => { console.error(err.message); stop(1); }); child.on('exit', (code) => stop(code ?? 1)); }
