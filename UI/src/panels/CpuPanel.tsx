/**
 * Live CPU & Memory from the WS user/cpu channel (history kept in the store).
 * Bucket / tick / GCL come from Memory.bridge.state — the executor contract —
 * because no push channel besides it carries the bucket.
 */

import { useMemo } from 'react';
import uPlot from 'uplot';
import { useStore } from '../lib/store';
import { useBridge } from '../lib/hooks';
import { formatBytes, formatNumber } from '../lib/util';
import { Chart } from '../components/Chart';
import { Section, StatCard } from '../components/common';

const chartOptions: Omit<uPlot.Options, 'width' | 'height'> = {
  scales: { x: { time: true }, cpu: { auto: true }, mem: { auto: true } },
  axes: [
    { stroke: '#9aa0a6', grid: { stroke: 'rgba(255,255,255,0.06)' } },
    { scale: 'cpu', stroke: '#5ec8f2', label: 'CPU', grid: { stroke: 'rgba(255,255,255,0.06)' } },
    { scale: 'mem', side: 1, stroke: '#ffb454', label: 'Memory KB', grid: { show: false } },
  ],
  series: [
    {},
    { label: 'CPU used', scale: 'cpu', stroke: '#5ec8f2', width: 1.5 },
    { label: 'CPU limit', scale: 'cpu', stroke: '#ff5050', width: 1, dash: [4, 4] },
    { label: 'Memory KB', scale: 'mem', stroke: '#ffb454', width: 1 },
  ],
  legend: { show: true },
};

export function CpuPanel() {
  const history = useStore((s) => s.cpuHistory);
  const colony = useStore((s) => s.colonyState);
  const { account, connected } = useBridge();
  const limit = colony?.cpu.limit ?? account?.cpu ?? undefined;

  const data: uPlot.AlignedData = useMemo(() => {
    const ts = history.map((h) => h.ts / 1000);
    return [
      ts,
      history.map((h) => h.cpu),
      history.map(() => limit ?? null),
      history.map((h) => h.memory / 1024),
    ];
  }, [history, limit]);

  const last = history[history.length - 1];
  const overruns = useMemo(
    () => (limit ? history.filter((h) => h.cpu > limit).length : 0),
    [history, limit],
  );
  const avg = useMemo(() => {
    const tail = history.slice(-50);
    return tail.length ? tail.reduce((a, h) => a + h.cpu, 0) / tail.length : null;
  }, [history]);

  return (
    <div className="panel-body">
      <Section title="Live CPU & Memory (WS user/cpu)">
        {!connected && <div className="muted">Connect first — this panel streams in real time.</div>}
        {connected && history.length === 0 && (
          <div className="muted">Waiting for the first tick frame…</div>
        )}
        {history.length > 0 && <Chart options={chartOptions} data={data} height={280} />}
      </Section>

      <div className="stat-grid">
        <StatCard
          label="CPU last tick"
          value={last ? last.cpu.toFixed(1) : '—'}
          hint={limit ? `limit ${limit}` : undefined}
          tone={last && limit && last.cpu > limit ? 'bad' : undefined}
        />
        <StatCard label="CPU avg (50t)" value={avg !== null ? avg.toFixed(1) : '—'} />
        <StatCard
          label="Bucket"
          value={colony ? formatNumber(colony.cpu.bucket) : 'n/a'}
          hint={colony ? 'from Memory.bridge.state' : 'needs the in-game executor (Memory.bridge.state)'}
          tone={colony && colony.cpu.bucket < 1000 ? 'warn' : undefined}
        />
        <StatCard label="Memory" value={last ? formatBytes(last.memory) : '—'} hint="serialized bytes / tick" />
        <StatCard
          label="Overruns in view"
          value={overruns}
          hint="ticks above limit"
          tone={overruns > 0 ? 'warn' : 'ok'}
        />
        <StatCard label="Tick" value={colony ? formatNumber(colony.tick) : '—'} />
      </div>

      {colony && (
        <Section title="Colony state (executor heartbeat)">
          <div className="stat-grid">
            <StatCard label="GCL" value={colony.gcl.level} hint={`${formatNumber(colony.gcl.progress)} / ${formatNumber(colony.gcl.progressTotal)}`} />
            <StatCard label="Credits" value={formatNumber(colony.credits)} />
            <StatCard label="Creeps" value={colony.creeps.total} />
            <StatCard label="Colonies" value={Object.keys(colony.colonies).length} />
            <StatCard
              label="Last error"
              value={colony.lastError ? `t${colony.lastError.tick}` : 'none'}
              hint={colony.lastError?.message}
              tone={colony.lastError ? 'bad' : 'ok'}
            />
            <StatCard label="Heartbeat" value={formatNumber(colony.heartbeat)} />
          </div>
        </Section>
      )}
    </div>
  );
}
