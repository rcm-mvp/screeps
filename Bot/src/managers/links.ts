/**
 * Link manager — moves energy through the link network each tick and publishes
 * the link classification to the heap for haulers (which fill the senders) and
 * upgraders (which drain the controller link) to read this same tick.
 *
 * Energy path: containers → (hauler) → sender links (core + source) → controller
 * link → (upgrader withdraws) → controller. Senders forward to the controller
 * link, which feeds the RCL bottleneck; we keep it topped. Cheap per tick — just
 * store/cooldown reads + a transfer per ready sender. Degrades to a no-op when
 * the plan or links aren't built yet (any subset is valid: RCL5 = core +
 * controller, RCL6 adds the first source link).
 */
import { SETTINGS } from '../settings';
import { roomHeap } from '../heap';
import { getCachedPlan } from '../lib/planner/plan';

export function runLinks(room: Room): void {
  const rh = roomHeap(room.name);

  const plan = getCachedPlan(room);
  if (!plan) return;

  const links = room.find(FIND_MY_STRUCTURES, {
    filter: (s) => s.structureType === STRUCTURE_LINK,
  }) as StructureLink[];
  if (!links.length) return;

  // Map each built link to its plan role by position match against the LINK plan
  // entries. Untagged surplus links (and any link without a plan match) are
  // treated as senders — they push toward the controller link like the rest.
  const planLinks = plan.structures.filter((s) => s.type === STRUCTURE_LINK);
  let controllerLink: StructureLink | null = null;
  const senders: StructureLink[] = [];
  for (const link of links) {
    const entry = planLinks.find((s) => s.x === link.pos.x && s.y === link.pos.y);
    if (entry?.role === 'controller') controllerLink = link;
    else senders.push(link);
  }

  // Publish the classification for haulers/upgraders (runs before logistics).
  // `senderLinks` = senders that still have FREE CAPACITY, i.e. the ones haulers
  // should top up so they can forward to the controller link — NOT the ones
  // already full (those need no hauler). The forwarding loop below independently
  // gates on LINK_MIN_SEND, so an empty sender must be advertised here or it
  // could never be filled, crossed the threshold, or forwarded. `controllerLink`
  // = the receiver id regardless of its own fill (upgraders drain it).
  rh.controllerLink = controllerLink ? controllerLink.id : null;
  rh.senderLinks = senders.filter((s) => s.store.getFreeCapacity(RESOURCE_ENERGY) > 0).map((s) => s.id);

  // Nothing to receive into yet (e.g. only surplus links built) → no transfers.
  if (!controllerLink) return;

  // Forward each ready sender into the controller link while it has room. Keep
  // it topped because upgraders draining it are the RCL bottleneck. The threshold
  // (LINK_MIN_SEND) makes the 3% transfer loss worthwhile; default-all is fine
  // since transferEnergy caps the amount at the receiver's free space.
  for (const sender of senders) {
    if (sender.cooldown !== 0) continue;
    if (sender.store[RESOURCE_ENERGY] < SETTINGS.LINK_MIN_SEND) continue;
    if (controllerLink.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) break; // controller full — stop
    sender.transferEnergy(controllerLink);
  }
}
