/**
 * Builds the name -> handler dispatch table from the capability catalogue,
 * binding each handler to a concrete {@link ScreepsBridge} instance.
 */

import type { ScreepsBridge } from './bridge';
import { CAPABILITY_DEFS } from './manifest';

export type Dispatch = Record<string, (params: Record<string, unknown>) => Promise<unknown> | unknown>;

export function buildDispatch(bridge: ScreepsBridge): Dispatch {
  const table: Dispatch = {};
  for (const def of CAPABILITY_DEFS) {
    table[def.name] = (params: Record<string, unknown>) => def.run(bridge, params ?? {});
  }
  return table;
}
