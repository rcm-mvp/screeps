// Pushes the bundled bot to a Screeps code branch via the bridge
// (POST user/code, 240/day budget). Auth/server config comes from the same
// env vars the bridge uses: SCREEPS_TOKEN, SCREEPS_SERVER, SCREEPS_HOST, ...
//
// Usage: node scripts/push.mjs [branch]   (default: $SCREEPS_BRANCH or "default")
import { readFile } from 'node:fs/promises';
import { ScreepsBridge } from 'screeps-web-api-bridge';

// Load Bot/.env (if present) into process.env without clobbering vars already
// set in the shell — so a one-off `$env:SCREEPS_BRANCH=...` still wins. Tiny
// parser, no dotenv dependency: KEY=VALUE per line, '#' comments, blanks skipped.
async function loadDotenv() {
  let text;
  try {
    text = await readFile(new URL('../.env', import.meta.url), 'utf8');
  } catch {
    return; // no .env — rely on the shell environment
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (key in process.env) continue; // shell override wins
    process.env[key] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
}
await loadDotenv();

const branch = process.argv[2] ?? process.env.SCREEPS_BRANCH ?? 'default';

let code;
try {
  code = await readFile(new URL('../dist/main.js', import.meta.url), 'utf8');
} catch {
  console.error('dist/main.js not found — run `npm run build` first');
  process.exit(1);
}

const bridge = new ScreepsBridge({});
await bridge.code.push(branch, { main: code });
console.log(`pushed main.js (${(code.length / 1024).toFixed(1)} KiB) to branch "${branch}"`);
