/**
 * Commander — the minimal surface an AI strategist (or the UI) uses to read the
 * contract and write directives, without touching raw endpoints.
 *
 * Deliberately dumb: it only reads the shared contract and writes directives.
 * No strategy, no creep logic, no decision-making — that is out of scope for the
 * bridge and lives in the AI session / uploaded game code.
 */

import type { ScreepsBridge } from './bridge';
import type { ColonyState, DirectiveAck, Directives } from './contract';
import type { AwaitAckOptions } from './control';

export interface CommanderSnapshot {
  state: ColonyState | null;
  directives: Directives;
  ack: DirectiveAck | null;
}

export class Commander {
  constructor(private readonly bridge: ScreepsBridge) {}

  /**
   * One call returning everything an AI needs to decide: current colony state,
   * the active directives, and the executor's last acknowledgement.
   */
  async snapshot(): Promise<CommanderSnapshot> {
    const control = this.bridge.control;
    const [state, directives, ack] = await Promise.all([
      control.getState(),
      control.getDirectives(),
      control.getAck(),
    ]);
    return { state, directives, ack };
  }

  /**
   * Write a directive patch and report the new revision plus whether the
   * executor acked it within the timeout.
   */
  async propose(
    patch: Partial<Directives>,
    opts: AwaitAckOptions = {},
  ): Promise<{ rev: number; applied: boolean }> {
    const rev = await this.bridge.control.setDirectives(patch);
    const applied = await this.bridge.control.awaitAck(rev, opts);
    return { rev, applied };
  }
}
