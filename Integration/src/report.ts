/**
 * Failure attribution. A contract round-trip has four halves; when a wait
 * times out, the message must say WHICH half is broken so a red CI run points
 * at the right repo immediately.
 *
 *   bot-write       — executor never wrote/updated `Memory.bridge.state`   → Bot/
 *   bridge-read     — state exists but the bridge's read path (HTTP or WS
 *                     memory channel) never surfaced it                    → API/
 *   directive-write — the bridge failed to land `Memory.bridge.directives` → API/
 *   ack             — directives landed but the executor never acked `rev` → Bot/
 */

export type ContractHalf = 'bot-write' | 'bridge-read' | 'directive-write' | 'ack';

const OWNER: Record<ContractHalf, string> = {
  'bot-write': 'Bot/ (executor state writer)',
  'bridge-read': 'API/ (bridge read path)',
  'directive-write': 'API/ (bridge directive writer)',
  ack: 'Bot/ (executor ack handshake)',
};

/** Build a failure message that names the broken half and its owning repo. */
export function half(part: ContractHalf, detail: string): string {
  return `[contract half: ${part} → look in ${OWNER[part]}] ${detail}`;
}
