/**
 * Per-scenario fixture: every scenario file calls {@link startScenario} in
 * beforeAll and {@link stopScenario} in afterAll. Isolation contract:
 * creeps (incl. NPC hostiles), flags, construction sites and the user's whole
 * Memory are wiped, base energy is refilled, and the simulation keeps running
 * — so no scenario can poison the next one.
 */

import type { ScreepsBridge } from 'screeps-web-api-bridge';
import { HarnessContext, cliFor, connectBridge, loadContext } from './context';
import { ServerCli } from './serverCli';
import { resetScenario } from './bootstrap';

export interface Scenario {
  ctx: HarnessContext;
  cli: ServerCli;
  bridge: ScreepsBridge;
}

export async function startScenario(): Promise<Scenario> {
  const ctx = loadContext();
  const cli = cliFor(ctx);
  await resetScenario(cli, ctx.userId, ctx.room);
  const bridge = await connectBridge(ctx);
  return { ctx, cli, bridge };
}

export async function stopScenario(s: Scenario | undefined): Promise<void> {
  s?.bridge.close();
}
