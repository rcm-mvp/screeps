/**
 * Role registry — the operational layer. To evolve this into a task system
 * later, swap the runner table for a task queue without touching main.ts.
 */
import type { RoleContext } from './context';
import { runHarvester } from './harvester';
import { runHauler } from './hauler';
import { runUpgrader } from './upgrader';
import { runBuilder } from './builder';
import { runMiner } from './miner';
import { runDefender } from './defender';
import { runClaimer } from './claimer';
import { runScout } from './scout';

export type { RoleContext } from './context';

export const ROLE_RUNNERS: Record<string, (creep: Creep, ctx: RoleContext) => void> = {
  harvester: runHarvester,
  hauler: runHauler,
  upgrader: runUpgrader,
  builder: runBuilder,
  miner: runMiner,
  defender: runDefender,
  claimer: runClaimer,
  scout: runScout,
};

/** Roles that keep acting while `directives.paused` is set. */
const DEFENSIVE_ROLES = new Set(['defender']);

export function isKnownRole(role: string): boolean {
  return Object.prototype.hasOwnProperty.call(ROLE_RUNNERS, role);
}

export function runCreep(creep: Creep, ctx: RoleContext): void {
  if (creep.spawning) return;
  const role = creep.memory.role;
  const runner = ROLE_RUNNERS[role];
  if (!runner) return; // unknown role — inert by design, never throws
  if (ctx.d.paused && !DEFENSIVE_ROLES.has(role)) return;
  runner(creep, ctx);
}
