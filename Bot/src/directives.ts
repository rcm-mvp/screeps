/**
 * Defensive directive parsing. An external AI writes Memory.bridge.directives
 * and may produce malformed or partial data — everything is validated and
 * clamped here, so the rest of the bot only ever sees a SafeDirectives.
 */
import type { Posture } from './contract';
import { SETTINGS } from './settings';
import { log } from './lib/log';

export interface SafeDirectives {
  paused: boolean;
  posture: Posture;
  targetRooms: string[];
  roleQuotas: Record<string, number>;
  flagsAsOrders: boolean;
  note: string;
  rev: number;
}

const POSTURES: readonly Posture[] = ['economy', 'expand', 'defend', 'war'];
const ROOM_NAME_RE = /^[WE]\d+[NS]\d+$/;

export function defaultDirectives(): SafeDirectives {
  return {
    paused: false,
    posture: 'economy',
    targetRooms: [],
    roleQuotas: {},
    // Flags are the only steering wheel when no AI is attached; the bridge
    // can switch this off explicitly.
    flagsAsOrders: true,
    note: '',
    rev: 0,
  };
}

export function readDirectives(): SafeDirectives {
  const out = defaultDirectives();
  const raw = Memory.bridge?.directives as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;

  const warnings: string[] = [];

  if (raw.rev !== undefined) {
    if (typeof raw.rev === 'number' && Number.isFinite(raw.rev)) out.rev = Math.max(0, Math.floor(raw.rev));
    else warnings.push(`invalid rev ${JSON.stringify(raw.rev)} — using 0`);
  }

  if (raw.paused !== undefined) {
    if (typeof raw.paused === 'boolean') out.paused = raw.paused;
    else warnings.push('paused must be a boolean — ignored');
  }

  if (raw.posture !== undefined) {
    if (typeof raw.posture === 'string' && (POSTURES as readonly string[]).includes(raw.posture)) {
      out.posture = raw.posture as Posture;
    } else {
      warnings.push(`unknown posture ${JSON.stringify(raw.posture)} — using "${out.posture}"`);
    }
  }

  if (raw.targetRooms !== undefined) {
    if (Array.isArray(raw.targetRooms)) {
      const valid = raw.targetRooms.filter(
        (r): r is string => typeof r === 'string' && ROOM_NAME_RE.test(r),
      );
      if (valid.length !== raw.targetRooms.length) warnings.push('dropped invalid entries from targetRooms');
      out.targetRooms = valid.slice(0, SETTINGS.MAX_TARGET_ROOMS);
    } else {
      warnings.push('targetRooms must be an array — ignored');
    }
  }

  if (raw.roleQuotas !== undefined) {
    if (raw.roleQuotas && typeof raw.roleQuotas === 'object' && !Array.isArray(raw.roleQuotas)) {
      for (const [role, value] of Object.entries(raw.roleQuotas as Record<string, unknown>)) {
        if (role.length === 0 || role.length > SETTINGS.MAX_ROLE_NAME_LEN) {
          warnings.push(`quota role name ${JSON.stringify(role)} out of bounds — ignored`);
          continue;
        }
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          warnings.push(`quota for "${role}" is not a number — ignored`);
          continue;
        }
        const clamped = Math.min(SETTINGS.MAX_QUOTA, Math.max(0, Math.floor(value)));
        if (clamped !== value) warnings.push(`quota ${role}=${value} clamped to ${clamped}`);
        out.roleQuotas[role] = clamped;
      }
    } else {
      warnings.push('roleQuotas must be an object — ignored');
    }
  }

  if (raw.flagsAsOrders !== undefined) {
    if (typeof raw.flagsAsOrders === 'boolean') out.flagsAsOrders = raw.flagsAsOrders;
    else warnings.push('flagsAsOrders must be a boolean — ignored');
  }

  if (typeof raw.note === 'string') out.note = raw.note.slice(0, 500);

  // Log findings when the revision is new (not yet acked) plus a low-rate
  // periodic reminder, so a permanently-bad directive can't spam every tick.
  const acked = Memory.bridge?.ack?.directiveVersion ?? -1;
  if (warnings.length && (out.rev !== acked || Game.time % 256 === 0)) {
    for (const w of warnings) log.warn(`directives: ${w}`);
  }

  return out;
}
