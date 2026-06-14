/**
 * Market module. All endpoints share the `market` rate-limit class (60/hr each).
 */

import type {
  MarketOrder,
  MarketOrdersIndex,
  MarketStatPoint,
  MoneyHistoryEntry,
} from '../types/market';
import { ModuleBase } from './base';

export class MarketModule extends ModuleBase {
  /** Index of resource types with active orders. @rateLimit market (60/hr) */
  ordersIndex(shard?: string): Promise<MarketOrdersIndex> {
    return this.client.call('market/orders-index', { query: { shard: this.shard(shard) } });
  }

  /** All orders for a resource type. @rateLimit market (60/hr) */
  orders(resourceType: string, shard?: string): Promise<{ list: MarketOrder[] }> {
    return this.client.call('market/orders', {
      query: { resourceType, shard: this.shard(shard) },
    });
  }

  /** The current user's market orders, grouped by shard. @rateLimit market (60/hr) */
  myOrders(): Promise<{ shards?: Record<string, MarketOrder[]>; list?: MarketOrder[] }> {
    return this.client.call('market/my-orders');
  }

  /** Historical price stats for a resource. @rateLimit market (60/hr) */
  stats(resourceType: string, shard?: string): Promise<{ stats: MarketStatPoint[] }> {
    return this.client.call('market/stats', {
      query: { resourceType, shard: this.shard(shard) },
    });
  }

  /** Credit transaction history (paginated). @rateLimit market (60/hr) */
  moneyHistory(page = 0): Promise<{ page: number; list: MoneyHistoryEntry[] }> {
    return this.client.call('user/money-history', { query: { page } });
  }
}
