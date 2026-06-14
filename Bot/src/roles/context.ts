import type { StrategyPlan } from '../contract';
import type { SafeDirectives } from '../directives';

/** Read-only per-tick context handed to every role runner. */
export interface RoleContext {
  d: SafeDirectives;
  plan: StrategyPlan;
}
