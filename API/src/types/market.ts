/** Market order + transaction types. */

import type { RoomName, Shard } from './common';

export type OrderType = 'buy' | 'sell';

export interface MarketOrder {
  _id: string;
  type: OrderType;
  /** Resource type, e.g. `energy`, `H`, `token`. */
  resourceType: string;
  price: number;
  /** Remaining amount available. */
  amount: number;
  /** Total amount the order was created with. */
  totalAmount?: number;
  /** Remaining capacity for the resource at the room (sell orders). */
  remainingAmount?: number;
  roomName?: RoomName;
  shard?: Shard;
  /** Owning user id (present on my-orders / some listings). */
  user?: string;
  created?: number;
  createdTimestamp?: number;
  active?: boolean;
  [key: string]: unknown;
}

export interface MarketOrdersIndex {
  list: Array<{ _id: string; count: number }>;
  shards?: Record<string, Array<{ _id: string; count: number }>>;
}

export interface MarketStatPoint {
  resourceType: string;
  date: string;
  transactions: number;
  volume: number;
  avgPrice: number;
  stddevPrice: number;
}

export interface MoneyHistoryEntry {
  date: string;
  tick?: number;
  type: string;
  balance: number;
  change: number;
  market?: Record<string, unknown>;
  [key: string]: unknown;
}
