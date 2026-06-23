/**
 * Defense manager — runs every tick for every owned room, even when paused or
 * the bucket is empty. Towers engage hostiles (healers first), heal creeps,
 * and spend surplus energy on critical repairs; safe mode triggers when a
 * spawn is about to fall.
 */
import { SETTINGS } from '../settings';
import { roomHeap } from '../heap';
import { log } from '../lib/log';

/** RCL-scaled rampart repair threshold (CR3). Falls back to the next lower
 *  defined RCL so an unexpected RCL (e.g. 0) still gets a sane value. */
export function rampartRepairThreshold(rcl: number): number {
  const table = SETTINGS.RAMPART_REPAIR_RCL_THRESHOLDS;
  let best = 10000;
  for (const key of Object.keys(table)) {
    const k = Number(key);
    if (k <= rcl && table[k] > best) best = table[k];
  }
  return best;
}

export function runDefense(room: Room): void {
  const rh = roomHeap(room.name);
  const hostiles = room.find(FIND_HOSTILE_CREEPS);
  rh.hostiles = hostiles.length;

  const towers = room.find(FIND_MY_STRUCTURES, {
    filter: (s) => s.structureType === STRUCTURE_TOWER,
  }) as StructureTower[];
  rh.towers = towers.length;

  if (towers.length) {
    const hurt = room.find(FIND_MY_CREEPS, { filter: (c) => c.hits < c.hitsMax });
    const healers = hostiles.filter((h) => h.getActiveBodyparts(HEAL) > 0);
    for (const tower of towers) {
      if (hostiles.length) {
        const target = tower.pos.findClosestByRange(healers.length ? healers : hostiles);
        if (target) tower.attack(target);
        continue;
      }
      if (hurt.length) {
        const patient = tower.pos.findClosestByRange(hurt);
        if (patient) {
          tower.heal(patient);
          continue;
        }
      }
      if (tower.store[RESOURCE_ENERGY] > SETTINGS.TOWER_REPAIR_RESERVE) {
        const rampartThreshold = rampartRepairThreshold(room.controller?.level ?? 0);
        const broken = room.find(FIND_STRUCTURES, {
          filter: (s) =>
            s.hits < s.hitsMax * 0.5 &&
            s.hits < SETTINGS.TOWER_REPAIR_MAX_HITS &&
            s.structureType !== STRUCTURE_WALL &&
            (s.structureType !== STRUCTURE_RAMPART || s.hits < rampartThreshold),
        });
        const target = tower.pos.findClosestByRange(broken);
        if (target) tower.repair(target);
      }
    }
  }

  const controller = room.controller;
  if (!controller?.my || hostiles.length === 0) return;

  // Safe mode: last line of defense when a spawn is about to fall.
  if (!controller.safeMode && !controller.safeModeCooldown && controller.safeModeAvailable > 0) {
    const spawnCritical = room
      .find(FIND_MY_SPAWNS)
      .some((s) => s.hits < s.hitsMax * SETTINGS.SAFE_MODE_SPAWN_HP);
    if (spawnCritical) {
      const result = controller.activateSafeMode();
      if (result === OK) {
        log.warn(`defense: SAFE MODE activated in ${room.name}`);
        Game.notify(`Safe mode activated in ${room.name} at tick ${Game.time}`);
      } else {
        log.warn(`defense: safe mode activation failed in ${room.name}: ${result}`);
      }
    }
  }

  const mem = room.memory;
  if (!mem.lastNotifyAt || Game.time - mem.lastNotifyAt >= SETTINGS.NOTIFY_COOLDOWN) {
    mem.lastNotifyAt = Game.time;
    const owners = [...new Set(hostiles.map((h) => h.owner.username))];
    Game.notify(`${hostiles.length} hostile creep(s) from [${owners.join(', ')}] in ${room.name} (tick ${Game.time})`, 30);
    log.warn(`defense: ${hostiles.length} hostiles in ${room.name} from [${owners.join(', ')}]`);
  }
}
