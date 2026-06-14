/**
 * Shared Memory contract — the single source of truth for the directive/state
 * channel between the bridge, the in-game executor, the AI strategist, and the
 * UI. All four import these exact types.
 *
 * All contract data lives under the `bridge` key in game Memory:
 *   - `Memory.bridge.directives` — the bridge WRITES, the executor READS
 *   - `Memory.bridge.state`      — the executor WRITES, bridge/AI/UI READ
 *   - `Memory.bridge.ack`        — the executor confirms the applied directive
 *
 * Cadence rule (see ControlChannel): directive *writes* ride the `POST memory`
 * budget (~240/day) — fine for strategic cadence. Live *reading* of state must
 * go through the WebSocket `memory/<path>` channel, never repeated GETs
 * (`GET memory` is only ~1440/day).
 */

export interface BridgeMemory {
  version: number;
  directives: Directives; // bridge WRITES, executor READS
  state: ColonyState; // executor WRITES, bridge/AI/UI READ (HTTP)
  ack: { directiveVersion: number; appliedTick: number }; // executor confirms
  // JSON-string mirrors of `state`/`ack`, written by the executor every tick.
  // The screeps WS memory pubsub coerces object paths with `"" + value`, so a
  // subscription to `bridge.state` (an object) only ever streams the literal
  // "[object Object]". Primitive leaf paths survive intact, so the executor
  // also publishes these stringified copies and the bridge's live WS readers
  // (watchState/awaitAck) subscribe to them and JSON.parse. HTTP readers keep
  // using the object paths above.
  stateJson?: string; // executor WRITES = JSON.stringify(state)
  ackJson?: string; // executor WRITES = JSON.stringify(ack)
}

export interface Directives {
  paused?: boolean;
  posture?: 'economy' | 'expand' | 'defend' | 'war';
  targetRooms?: string[];
  roleQuotas?: Partial<Record<string, number>>;
  flagsAsOrders?: boolean;
  note?: string;
  rev?: number; // directive revision; executor acks this
}

export interface ColonyState {
  tick: number;
  cpu: { used: number; limit: number; bucket: number };
  gcl: { level: number; progress: number; progressTotal: number };
  credits: number;
  colonies: Record<
    string,
    {
      rcl: number;
      energyAvailable: number;
      energyCapacity: number;
      storageEnergy?: number;
      creeps: Record<string, number>;
      constructionSites: number;
      threats: { hostiles: number; safeMode: boolean };
    }
  >;
  creeps: { total: number; byRole: Record<string, number> };
  lastError: { tick: number; message: string } | null;
  heartbeat: number;
}

/** Acknowledgement payload written by the executor at `Memory.bridge.ack`. */
export interface DirectiveAck {
  directiveVersion: number;
  appliedTick: number;
}

/** Memory paths used by the control channel (kept here so they're shared). */
export const CONTRACT_PATHS = {
  root: 'bridge',
  directives: 'bridge.directives',
  state: 'bridge.state',
  ack: 'bridge.ack',
  // WS-safe string mirrors (see BridgeMemory.stateJson/ackJson).
  stateJson: 'bridge.stateJson',
  ackJson: 'bridge.ackJson',
} as const;
