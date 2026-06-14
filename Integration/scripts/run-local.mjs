// One-command local runner for the integration suite:
//
//   npm run itest            build artifacts → server up → tests → server down
//   npm run itest:keep       same, but leaves the server running for debugging
//   node scripts/run-local.mjs --skip-build      reuse existing dist/ artifacts
//   node scripts/run-local.mjs --grep "E\."      run a subset of scenarios
//
// The suite tests BUILT artifacts, so the bridge (API/) and the executor
// (Bot/) are rebuilt first unless --skip-build is given.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..'); // Integration/
const repo = path.resolve(root, '..');

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const skipBuild = args.includes('--skip-build');
const grepIdx = args.indexOf('--grep');
const grep = grepIdx >= 0 ? args[grepIdx + 1] : undefined;

const env = {
  ...process.env,
  SCREEPS_PRIVATE_HOST: process.env.SCREEPS_PRIVATE_HOST ?? 'http://127.0.0.1:21025',
  SCREEPS_CLI_PORT: process.env.SCREEPS_CLI_PORT ?? '21026',
  SCREEPS_TICK_MS: process.env.SCREEPS_TICK_MS ?? '150',
  SCREEPS_RESTART_CMD: process.env.SCREEPS_RESTART_CMD ?? 'docker compose restart screeps',
};

function run(label, cmd, cmdArgs, opts = {}) {
  console.log(`\n[itest] ${label}: ${cmd} ${cmdArgs.join(' ')}`);
  const res = spawnSync(cmd, cmdArgs, {
    stdio: 'inherit',
    shell: process.platform === 'win32', // npm/docker are .cmd shims on Windows
    env,
    ...opts,
  });
  if (res.status !== 0) {
    throw new Error(`[itest] step failed: ${label} (exit ${res.status})`);
  }
}

function tryRun(label, cmd, cmdArgs, opts = {}) {
  try {
    run(label, cmd, cmdArgs, opts);
  } catch (err) {
    console.warn(String(err));
  }
}

let exitCode = 0;
try {
  if (!skipBuild) {
    run('build bridge (API)', 'npm', ['run', 'build'], { cwd: path.join(repo, 'API') });
    run('build executor (Bot)', 'npm', ['run', 'build'], { cwd: path.join(repo, 'Bot') });
  }

  run('private server up', 'docker', ['compose', 'up', '-d'], { cwd: root });

  const vitestArgs = ['vitest', 'run'];
  if (grep) vitestArgs.push('-t', grep);
  run('integration suite', 'npx', vitestArgs, { cwd: root });
} catch (err) {
  console.error(String(err));
  exitCode = 1;
  tryRun('server logs (for the failure above)', 'docker', ['compose', 'logs', '--tail', '150', 'screeps'], {
    cwd: root,
  });
} finally {
  if (keep) {
    console.log('\n[itest] --keep: leaving the private server running (npm run server:down to stop it)');
  } else {
    tryRun('private server down', 'docker', ['compose', 'down', '-v'], { cwd: root });
  }
}
process.exit(exitCode);
