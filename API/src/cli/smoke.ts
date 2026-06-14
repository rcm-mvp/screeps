/**
 * Control-channel smoke test.
 *
 * Runs the acceptance sequence against the configured server and prints a clear
 * PASS/FAIL per step. It honours rate limits (429s are not blindly retried — the
 * client waits out the server timer).
 *
 * Usage:
 *   SCREEPS_TOKEN=... node dist/cli/smoke.js
 *   SCREEPS_TOKEN=... npm run smoke
 *
 * Without a token the script explains what's needed and exits.
 *
 * Expected output (with a live account; exact numbers vary):
 *   1. auth/me ............... PASS  (alice · GCL 12 · 1.2M credits)
 *   2. control.getState ...... PASS  (null — executor not deployed yet)
 *   3. setDirectives ......... PASS  (rev 7 persisted)
 *   4. WS subscribe .......... PASS  (cpu/console/state subscribed)
 *      ↳ cpu: { cpu: 8.4, memory: 20480 }
 *   5. console Game.time ..... PASS  (submitted; result on console channel)
 *      ↳ console: 49827311
 *   6. code.get .............. PASS  (branch "main": main, util, roles)
 *   RESULT: 6/6 passed
 */

import { ScreepsBridge } from '../index';

type Step = { n: number; name: string; pass: boolean; note: string };

async function main(): Promise<void> {
  const bridge = new ScreepsBridge({ log: process.env.SCREEPS_LOG === 'true' });
  const steps: Step[] = [];

  if (!bridge.http.getToken()) {
    console.error('SCREEPS_TOKEN is required (generate at https://screeps.com/a/#!/account/auth-tokens).');
    console.error('Set SCREEPS_SERVER=ptr|private and SCREEPS_SHARD/SCREEPS_HOST as needed.');
    process.exit(1);
  }

  const record = (n: number, name: string, pass: boolean, note: string) => {
    steps.push({ n, name, pass, note });
    const dots = '.'.repeat(Math.max(2, 22 - name.length));
    console.log(`${n}. ${name} ${dots} ${pass ? 'PASS' : 'FAIL'}  (${note})`);
  };

  // 1. auth/me
  try {
    const me = await bridge.auth.me();
    record(1, 'auth/me', true, `${me.username} · GCL ${me.gcl ?? '?'} · ${me.credits ?? '?'} credits`);
  } catch (err) {
    record(1, 'auth/me', false, (err as Error).message);
  }

  // 2. control.getState (null is expected if the executor isn't deployed)
  try {
    const state = await bridge.control.getState();
    record(2, 'control.getState', true, state ? `tick ${state.tick}` : 'null — executor not deployed yet');
  } catch (err) {
    record(2, 'control.getState', false, (err as Error).message);
  }

  // 3. setDirectives → getDirectives confirms persistence + rev
  try {
    const rev = await bridge.control.setDirectives({ paused: false, posture: 'economy' });
    const after = await bridge.control.getDirectives();
    const ok = after.rev === rev && after.posture === 'economy' && after.paused === false;
    record(3, 'setDirectives', ok, ok ? `rev ${rev} persisted` : `rev mismatch (wrote ${rev}, read ${after.rev})`);
  } catch (err) {
    record(3, 'setDirectives', false, (err as Error).message);
  }

  // 4. WS subscribe: cpu, console, memory/bridge.state
  let consoleSawResult = false;
  try {
    await bridge.connectSocket();
    let count = 0;
    await bridge.subscribeCpu((m) => {
      if (count++ < 2) console.log('   ↳ cpu:', JSON.stringify(m.data));
    });
    await bridge.subscribeConsole((m) => {
      const d = m.data as { results?: string[]; log?: string[] };
      if ((d.results && d.results.length) || (d.log && d.log.length)) {
        consoleSawResult = true;
        console.log('   ↳ console:', JSON.stringify(d.results ?? d.log));
      }
    });
    bridge.control.watchState((s) => console.log('   ↳ state tick:', s.tick));
    record(4, 'WS subscribe', true, 'cpu/console/state subscribed');
  } catch (err) {
    record(4, 'WS subscribe', false, (err as Error).message);
  }

  // 5. console Game.time (result arrives on the console channel above)
  try {
    await bridge.console.run('Game.time');
    // give the console channel a moment to echo the result
    await new Promise((r) => setTimeout(r, 4000));
    record(5, 'console Game.time', true, consoleSawResult ? 'result seen on channel' : 'submitted (watch console channel)');
  } catch (err) {
    record(5, 'console Game.time', false, (err as Error).message);
  }

  // 6. code.get (read-only)
  try {
    const code = await bridge.code.get();
    const modules = Object.keys(code.modules ?? {});
    record(6, 'code.get', true, `branch "${code.branch}": ${modules.slice(0, 6).join(', ') || '(empty)'}`);
  } catch (err) {
    record(6, 'code.get', false, (err as Error).message);
  }

  const passed = steps.filter((s) => s.pass).length;
  console.log(`\nRESULT: ${passed}/${steps.length} passed`);
  bridge.close();
  process.exit(passed === steps.length ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
