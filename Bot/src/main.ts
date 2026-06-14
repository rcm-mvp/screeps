/**
 * Loop skeleton (every subsystem and creep failure-isolated; the loop never
 * hard-crashes and always writes state + ack + heartbeat):
 *
 *   detect global reset → rebuild heap
 *   read + validate directives → SafeDirectives
 *   clean dead creep memory
 *   strategy        (interval/rev-gated, bucket-guarded)
 *   per colony:     defense (always) · logistics · spawn · construction (gated)
 *   per creep:      role runner (individually guarded)
 *   writeState + writeAck + heartbeat   (even after a top-level throw)
 */
import { ensureHeap } from './heap';
import { ensureBridgeMemory, cleanCreepMemory, adoptCreeps } from './memory';
import { readDirectives, defaultDirectives } from './directives';
import type { SafeDirectives } from './directives';
import type { ColonyPlan, StrategyPlan } from './contract';
import { runStrategy } from './strategy';
import { runDefense } from './managers/defense';
import { runLogistics } from './managers/logistics';
import { runSpawn } from './managers/spawn';
import { runConstruction } from './managers/construction';
import { runCreep } from './roles';
import { buildCensus, writeState, writeAck } from './state';
import type { Census } from './state';
import { installTraffic, runTraffic } from './lib/traffic';
import { ownedRooms, bucket } from './lib/game';
import { log } from './lib/log';
import { SETTINGS } from './settings';

const EMPTY_COLONY_PLAN: ColonyPlan = { quotas: {}, claimTargets: [], attackTargets: [], scoutTargets: [] };

export const loop = (): void => {
  const errors: string[] = [];
  const cpu: Record<string, number> = {};
  let d: SafeDirectives = defaultDirectives();
  let census: Census = { total: 0, byRole: {}, byHome: {} };

  function recordError(where: string, err: unknown): void {
    const detail =
      err instanceof Error ? `${err.message}${err.stack ? ` @ ${err.stack.split('\n')[1]?.trim() ?? ''}` : ''}` : String(err);
    errors.push(`${where}: ${detail}`);
    log.error(`${where}: ${detail}`);
  }

  /** Run a subsystem isolated; one failure never stalls the tick. */
  function guard(label: string, fn: () => void, scope?: string): void {
    const start = Game.cpu.getUsed();
    try {
      fn();
    } catch (err) {
      recordError(scope ? `${label}:${scope}` : label, err);
    } finally {
      cpu[label] = (cpu[label] ?? 0) + (Game.cpu.getUsed() - start);
    }
  }

  try {
    ensureHeap();
    installTraffic(); // patch Creep.move once per global so travelTo registers intent
    ensureBridgeMemory();
    d = readDirectives();

    guard('memory', () => {
      cleanCreepMemory();
      adoptCreeps();
    });

    // Plan periodically (or immediately on a new directive rev), execute every tick.
    let plan: StrategyPlan | undefined = Memory.plan;
    const newRev = !plan || plan.rev !== d.rev;
    const periodicDue = Game.time % SETTINGS.STRATEGY_INTERVAL === 0 && bucket() >= SETTINGS.BUCKET_LOW;
    if (newRev || periodicDue) {
      guard('strategy', () => {
        plan = runStrategy(d);
      });
    }
    const activePlan: StrategyPlan =
      plan ?? { tick: Game.time, rev: d.rev, posture: d.posture, colonies: {} };

    census = buildCensus();
    const critical = bucket() < SETTINGS.BUCKET_CRITICAL;
    const constructionDue =
      !d.paused &&
      !critical &&
      Game.time % SETTINGS.CONSTRUCTION_INTERVAL === 0 &&
      bucket() >= SETTINGS.BUCKET_LOW;

    for (const room of ownedRooms()) {
      guard('defense', () => runDefense(room), room.name); // never skipped
      if (!d.paused && !critical) guard('logistics', () => runLogistics(room), room.name);
      const cplan = activePlan.colonies[room.name] ?? EMPTY_COLONY_PLAN;
      guard('spawn', () => runSpawn(room, cplan, d, census), room.name);
      if (constructionDue) guard('construction', () => runConstruction(room), room.name);
    }

    const ctx = { d, plan: activePlan };
    const creepStart = Game.cpu.getUsed();
    for (const name in Game.creeps) {
      const creep = Game.creeps[name];
      try {
        runCreep(creep, ctx);
      } catch (err) {
        recordError(`creep:${name}(${creep.memory.role})`, err);
      }
    }
    cpu.creeps = Game.cpu.getUsed() - creepStart;

    // Traffic resolution runs once per active room at the END of the loop, after
    // every role has registered its intended move. Resolves collisions/deadlocks
    // and issues the real creep.move calls.
    const trafficRooms = new Set<string>();
    for (const name in Game.creeps) trafficRooms.add(Game.creeps[name].room.name);
    for (const roomName of trafficRooms) {
      const room = Game.rooms[roomName];
      if (room) guard('traffic', () => runTraffic(room), roomName);
    }

    if (SETTINGS.GENERATE_PIXEL && Game.cpu.bucket === 10000 && typeof Game.cpu.generatePixel === 'function') {
      Game.cpu.generatePixel();
    }
  } catch (err) {
    recordError('loop', err);
  } finally {
    // The contract's liveness guarantee: state + ack + heartbeat go out even
    // when the tick above blew up.
    try {
      writeState(census, errors, cpu);
      writeAck(d.rev);
      if (Game.time % SETTINGS.HEARTBEAT_EVERY === 0) {
        log.heartbeat({
          tick: Game.time,
          cpu: Math.round(Game.cpu.getUsed() * 10) / 10,
          bucket: bucket(),
          creeps: census.total,
          rev: d.rev,
          posture: d.posture,
          ...(d.paused ? { paused: true } : {}),
          ...(errors.length ? { errors: errors.length } : {}),
        });
      }
    } catch (err) {
      console.log(`[err] t=${Game.time} state write failed: ${String(err)}`);
    }
  }
};
