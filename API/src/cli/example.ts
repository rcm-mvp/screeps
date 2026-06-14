/**
 * Tiny CLI demonstrating the bridge end-to-end:
 *   1. login (token from env) + read account profile
 *   2. read CPU/overview
 *   3. read Memory
 *   4. subscribe to the console channel + one room over WebSocket
 *   5. run a console command
 *   6. (optional) push code to a branch
 *
 * Usage:
 *   SCREEPS_TOKEN=... node dist/cli/example.js [roomName]
 *   SCREEPS_TOKEN=... npm run example -- W1N1
 *
 * Set SCREEPS_SERVER=ptr|private, SCREEPS_SHARD, SCREEPS_HOST as needed.
 */

import { ScreepsBridge } from '../index';

async function main(): Promise<void> {
  const room = process.argv[2] ?? 'W1N1';
  const bridge = new ScreepsBridge({ log: process.env.SCREEPS_LOG === 'true' });

  if (!bridge.http.getToken()) {
    console.error('Set SCREEPS_TOKEN (generate at https://screeps.com/a/#!/account/auth-tokens).');
    process.exit(1);
  }

  // 1. Account
  const me = await bridge.auth.me();
  console.log(`\n👤 Logged in as ${me.username} (id ${me._id})`);
  console.log(`   GCL ${me.gcl ?? '?'} · credits ${me.credits ?? '?'} · CPU ${me.cpu ?? '?'}`);

  // 2. Game time + a stat overview
  const { time } = await bridge.map.time();
  console.log(`⏱️  Shard ${bridge.shard} tick: ${time}`);

  // 3. Memory
  try {
    const mem = await bridge.memory.get('');
    const keys = mem && typeof mem === 'object' ? Object.keys(mem as object) : [];
    console.log(`🧠 Memory top-level keys: ${keys.slice(0, 10).join(', ') || '(empty)'}`);
  } catch (err) {
    console.log(`🧠 Memory read failed: ${(err as Error).message}`);
  }

  // 4. WebSocket: console + one room
  await bridge.connectSocket();
  console.log('🔌 Socket connected + authenticated');

  await bridge.subscribeConsole((msg) => {
    const data = msg.data as { log?: string[]; results?: string[]; error?: string };
    if (data.error) console.log('   ❌ runtime error:', data.error);
    for (const line of data.log ?? []) console.log('   📜', line);
    for (const r of data.results ?? []) console.log('   ↳', r);
  });
  console.log('   subscribed to console');

  bridge.subscribeRoom(room, (msg) => {
    const snap = msg.data;
    console.log(`   🏠 ${room} @${snap.gameTime ?? '?'}: ${Object.keys(snap.objects).length} objects`);
  });
  console.log(`   subscribed to room ${room}`);

  // 5. Run a console command (output arrives on the console channel above)
  await bridge.console.run('Game.time');
  console.log('   ran `Game.time` in the live console');

  // 6. Push code (commented out by default — uncomment to try on a test branch)
  // await bridge.code.push('bridge-test', { main: 'module.exports.loop = () => {};' });
  // console.log('   pushed code to branch "bridge-test"');

  // Show rate-limit budgets
  console.log('\n📊 Rate-limit budgets (sample):');
  for (const b of bridge.getRateLimitBudgets().slice(0, 5)) {
    console.log(`   ${b.label}: ${b.remaining}/${b.max}`);
  }

  console.log('\nStreaming live updates for 15s… (Ctrl-C to exit)');
  await new Promise((r) => setTimeout(r, 15000));
  bridge.close();
  console.log('Done.');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
