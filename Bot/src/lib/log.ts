/**
 * Structured, greppable console output. The bridge streams the console over
 * its WebSocket channel, so these prefixes are the executor's live telemetry:
 *   [hb]  heartbeat JSON          [err] failures (also mirrored to state.lastError)
 *   [wrn] degraded behaviour      [inf] notable events (spawns, strategy, claims)
 */
export const log = {
  info(msg: string): void {
    console.log(`[inf] t=${Game.time} ${msg}`);
  },
  warn(msg: string): void {
    console.log(`[wrn] t=${Game.time} ${msg}`);
  },
  error(msg: string): void {
    console.log(`[err] t=${Game.time} ${msg}`);
  },
  heartbeat(data: Record<string, unknown>): void {
    console.log(`[hb] ${JSON.stringify(data)}`);
  },
};
