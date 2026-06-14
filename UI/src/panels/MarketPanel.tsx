/**
 * Market: order book per resource, my open orders, price-history chart, and
 * credit/transaction history. Every market endpoint shares one 60/hr class,
 * so all fetches are manual and the shared budget is shown prominently.
 */

import { useMemo, useState } from 'react';
import uPlot from 'uplot';
import { api } from '../lib/api';
import { useAsyncAction, useBridge } from '../lib/hooks';
import type { MarketOrder } from '../lib/types';
import { formatNumber } from '../lib/util';
import { Chart } from '../components/Chart';
import { BudgetChip, ErrorBox, Section } from '../components/common';

interface StatPoint {
  resourceType: string;
  date: string;
  transactions: number;
  volume: number;
  avgPrice: number;
  stddevPrice: number;
}

interface MoneyEntry {
  date: string;
  type: string;
  balance: number;
  change: number;
  [key: string]: unknown;
}

type Tab = 'orders' | 'mine' | 'stats' | 'money';

export function MarketPanel() {
  const [tab, setTab] = useState<Tab>('orders');
  return (
    <div className="panel-body">
      <div className="tabs">
        {(
          [
            ['orders', 'Order book'],
            ['mine', 'My orders'],
            ['stats', 'Price history'],
            ['money', 'Credit history'],
          ] as Array<[Tab, string]>
        ).map(([id, label]) => (
          <button key={id} className={`tab ${tab === id ? 'tab-active' : ''}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
        <span className="spacer" />
        <BudgetChip label="market" />
      </div>
      {tab === 'orders' && <OrdersTab />}
      {tab === 'mine' && <MyOrdersTab />}
      {tab === 'stats' && <StatsTab />}
      {tab === 'money' && <MoneyTab />}
    </div>
  );
}

function OrderTable({ orders }: { orders: MarketOrder[] }) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Price</th>
          <th>Amount</th>
          <th>Room</th>
          <th>Type</th>
        </tr>
      </thead>
      <tbody>
        {orders.map((o) => (
          <tr key={o._id}>
            <td>{o.price.toFixed(3)}</td>
            <td>{formatNumber(o.amount)}</td>
            <td>
              <code>{o.roomName ?? '—'}</code>
            </td>
            <td className={o.type === 'sell' ? 'text-sell' : 'text-buy'}>{o.type}</td>
          </tr>
        ))}
        {orders.length === 0 && (
          <tr>
            <td colSpan={4} className="muted">
              none
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function OrdersTab() {
  const { connected } = useBridge();
  const [resource, setResource] = useState('energy');
  const [orders, setOrders] = useState<MarketOrder[]>([]);
  const { loading, error, run } = useAsyncAction();

  const load = () =>
    void run(async () => {
      const res = await api.invoke<{ list: MarketOrder[] }>('market.orders', { resourceType: resource.trim() });
      setOrders(res.list ?? []);
    });

  const sells = useMemo(
    () => orders.filter((o) => o.type === 'sell').sort((a, b) => a.price - b.price).slice(0, 30),
    [orders],
  );
  const buys = useMemo(
    () => orders.filter((o) => o.type === 'buy').sort((a, b) => b.price - a.price).slice(0, 30),
    [orders],
  );

  return (
    <Section
      title="Order book"
      actions={
        <div className="row">
          <input
            className="input input-s"
            value={resource}
            onChange={(e) => setResource(e.target.value)}
            placeholder="energy / H / XGH2O…"
            onKeyDown={(e) => e.key === 'Enter' && load()}
          />
          <button className="btn btn-primary" disabled={!connected || loading} onClick={load}>
            {loading ? '…' : 'Load'}
          </button>
        </div>
      }
    >
      <ErrorBox error={error} />
      <div className="market-book">
        <div>
          <h4 className="text-sell">Sell (lowest first)</h4>
          <OrderTable orders={sells} />
        </div>
        <div>
          <h4 className="text-buy">Buy (highest first)</h4>
          <OrderTable orders={buys} />
        </div>
      </div>
    </Section>
  );
}

function MyOrdersTab() {
  const { connected } = useBridge();
  const [orders, setOrders] = useState<MarketOrder[]>([]);
  const [loaded, setLoaded] = useState(false);
  const { loading, error, run } = useAsyncAction();

  const load = () =>
    void run(async () => {
      const res = await api.invoke<{ shards?: Record<string, MarketOrder[]>; list?: MarketOrder[] }>(
        'market.myOrders',
      );
      const all = res.list ?? Object.entries(res.shards ?? {}).flatMap(([shard, list]) =>
        (list ?? []).map((o) => ({ ...o, shard })),
      );
      setOrders(all);
      setLoaded(true);
    });

  return (
    <Section
      title="My orders"
      actions={
        <button className="btn btn-primary" disabled={!connected || loading} onClick={load}>
          {loading ? '…' : 'Load'}
        </button>
      }
    >
      <ErrorBox error={error} />
      <table className="table">
        <thead>
          <tr>
            <th>Resource</th>
            <th>Type</th>
            <th>Price</th>
            <th>Remaining</th>
            <th>Room</th>
            <th>Shard</th>
            <th>Active</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o._id}>
              <td>
                <code>{o.resourceType}</code>
              </td>
              <td className={o.type === 'sell' ? 'text-sell' : 'text-buy'}>{o.type}</td>
              <td>{o.price.toFixed(3)}</td>
              <td>
                {formatNumber(o.remainingAmount ?? o.amount)}/{formatNumber(o.totalAmount ?? o.amount)}
              </td>
              <td>
                <code>{o.roomName ?? '—'}</code>
              </td>
              <td>{(o.shard as string) ?? '—'}</td>
              <td>{o.active ? 'yes' : 'no'}</td>
            </tr>
          ))}
          {orders.length === 0 && (
            <tr>
              <td colSpan={7} className="muted">
                {loaded ? 'No open orders.' : 'Press Load.'}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Section>
  );
}

const statsChartOptions: Omit<uPlot.Options, 'width' | 'height'> = {
  scales: { x: { time: true }, price: { auto: true }, vol: { auto: true } },
  axes: [
    { stroke: '#9aa0a6', grid: { stroke: 'rgba(255,255,255,0.06)' } },
    { scale: 'price', stroke: '#5ec8f2', label: 'Avg price', grid: { stroke: 'rgba(255,255,255,0.06)' } },
    { scale: 'vol', side: 1, stroke: '#ffb454', label: 'Volume', grid: { show: false } },
  ],
  series: [
    {},
    { label: 'Avg price', scale: 'price', stroke: '#5ec8f2', width: 1.5 },
    { label: 'Volume', scale: 'vol', stroke: '#ffb454', width: 1 },
  ],
};

function StatsTab() {
  const { connected } = useBridge();
  const [resource, setResource] = useState('energy');
  const [points, setPoints] = useState<StatPoint[]>([]);
  const { loading, error, run } = useAsyncAction();

  const load = () =>
    void run(async () => {
      const res = await api.invoke<{ stats: StatPoint[] }>('market.stats', { resourceType: resource.trim() });
      const sorted = (res.stats ?? []).slice().sort((a, b) => a.date.localeCompare(b.date));
      setPoints(sorted);
    });

  const data: uPlot.AlignedData = useMemo(
    () => [
      points.map((p) => new Date(p.date).getTime() / 1000),
      points.map((p) => p.avgPrice),
      points.map((p) => p.volume),
    ],
    [points],
  );

  return (
    <Section
      title="Price history"
      actions={
        <div className="row">
          <input
            className="input input-s"
            value={resource}
            onChange={(e) => setResource(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && load()}
          />
          <button className="btn btn-primary" disabled={!connected || loading} onClick={load}>
            {loading ? '…' : 'Load'}
          </button>
        </div>
      }
    >
      <ErrorBox error={error} />
      {points.length > 0 ? (
        <Chart options={statsChartOptions} data={data} height={260} />
      ) : (
        <div className="muted">Load a resource to chart avg price + volume.</div>
      )}
    </Section>
  );
}

function MoneyTab() {
  const { connected } = useBridge();
  const [page, setPage] = useState(0);
  const [entries, setEntries] = useState<MoneyEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const { loading, error, run } = useAsyncAction();

  const load = (p: number) =>
    void run(async () => {
      const res = await api.invoke<{ list: MoneyEntry[] }>('market.moneyHistory', { page: p });
      setEntries(res.list ?? []);
      setPage(p);
      setLoaded(true);
    });

  return (
    <Section
      title="Credit history"
      actions={
        <div className="row">
          <button className="btn btn-xs" disabled={!connected || loading || page === 0} onClick={() => load(page - 1)}>
            ← newer
          </button>
          <span className="muted">page {page}</span>
          <button className="btn btn-xs" disabled={!connected || loading} onClick={() => load(page + 1)}>
            older →
          </button>
          <button className="btn btn-primary" disabled={!connected || loading} onClick={() => load(0)}>
            {loading ? '…' : loaded ? 'Reload' : 'Load'}
          </button>
        </div>
      }
    >
      <ErrorBox error={error} />
      <table className="table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Type</th>
            <th>Change</th>
            <th>Balance</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e, i) => (
            <tr key={i}>
              <td>{new Date(e.date).toLocaleString()}</td>
              <td>{e.type}</td>
              <td className={e.change >= 0 ? 'text-buy' : 'text-sell'}>
                {e.change >= 0 ? '+' : ''}
                {formatNumber(e.change)}
              </td>
              <td>{formatNumber(e.balance)}</td>
            </tr>
          ))}
          {entries.length === 0 && (
            <tr>
              <td colSpan={4} className="muted">
                {loaded ? 'No entries.' : 'Press Load.'}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Section>
  );
}
