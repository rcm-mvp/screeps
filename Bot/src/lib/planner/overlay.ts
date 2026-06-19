/**
 * Toggleable RoomVisual debug overlay (SETTINGS.PLAN_OVERLAY). RoomVisual has
 * no structure glyphs, so we draw coloured markers: filled tiles per structure
 * type, green-outlined tiles for ramparts, faint dots for roads, and a ring on
 * the anchor. Essential for eyeballing a planner.
 */
import type { PlannedStructure, RoomPlan } from './types';

const COLORS: Partial<Record<BuildableStructureConstant, string>> = {
  [STRUCTURE_SPAWN]: '#ff00ff',
  [STRUCTURE_EXTENSION]: '#ffe56d',
  [STRUCTURE_TOWER]: '#ff4040',
  [STRUCTURE_STORAGE]: '#40ff90',
  [STRUCTURE_TERMINAL]: '#40c0ff',
  [STRUCTURE_LINK]: '#c080ff',
  [STRUCTURE_LAB]: '#ff80c0',
  [STRUCTURE_CONTAINER]: '#bfbfbf',
  [STRUCTURE_FACTORY]: '#d0a060',
  [STRUCTURE_POWER_SPAWN]: '#ff6060',
  [STRUCTURE_NUKER]: '#a0ffa0',
  [STRUCTURE_OBSERVER]: '#80d0ff',
};

/** Letter drawn on a role-tagged link so the energy network reads at a glance. */
const LINK_ROLE_GLYPH: Record<NonNullable<PlannedStructure['role']>, string> = {
  core: 'K',
  controller: 'C',
  source: 'S',
};

export function drawPlan(room: Room, plan: RoomPlan): void {
  const v = room.visual;
  if (!v) return;

  for (const r of plan.roads) v.circle(r.x, r.y, { radius: 0.12, fill: '#6f6f6f', opacity: 0.5 });
  for (const s of plan.structures) {
    v.rect(s.x - 0.4, s.y - 0.4, 0.8, 0.8, {
      fill: COLORS[s.type] ?? '#ffffff',
      opacity: 0.45,
      stroke: '#000000',
      strokeWidth: 0.03,
    });
    // Mark a role-tagged link with its initial: K(ore), C(ontroller), S(ource).
    if (s.role) {
      v.text(LINK_ROLE_GLYPH[s.role], s.x, s.y + 0.1, { color: '#000000', font: 0.4, opacity: 0.9 });
    }
  }
  for (const rp of plan.ramparts) {
    v.rect(rp.x - 0.45, rp.y - 0.45, 0.9, 0.9, { fill: 'transparent', stroke: '#3bff3b', strokeWidth: 0.08, opacity: 0.7 });
  }
  v.circle(plan.anchor.x, plan.anchor.y, { radius: 0.55, fill: 'transparent', stroke: '#ffffff', strokeWidth: 0.12 });
}
