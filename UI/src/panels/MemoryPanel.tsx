/**
 * Memory inspector/editor (gz decode happens in the bridge). Reads are manual —
 * GET user/memory is only 1440/day — and writes (240/day) are path-scoped with
 * confirmation. Separate tab for raw segments 0–99.
 */

import { useState } from 'react';
import { api } from '../lib/api';
import { useAsyncAction, useBridge } from '../lib/hooks';
import { JsonTree } from '../components/JsonTree';
import { BudgetChip, ConfirmButton, ErrorBox, Section, useBudgetBlocked } from '../components/common';

export function MemoryPanel() {
  const [tab, setTab] = useState<'memory' | 'segments'>('memory');
  return (
    <div className="panel-body">
      <div className="tabs">
        <button className={`tab ${tab === 'memory' ? 'tab-active' : ''}`} onClick={() => setTab('memory')}>
          Memory
        </button>
        <button className={`tab ${tab === 'segments' ? 'tab-active' : ''}`} onClick={() => setTab('segments')}>
          Segments 0–99
        </button>
      </div>
      {tab === 'memory' ? <MemoryTab /> : <SegmentsTab />}
    </div>
  );
}

function MemoryTab() {
  const { connected } = useBridge();
  const [path, setPath] = useState('');
  const [data, setData] = useState<unknown>(undefined);
  const [loadedPath, setLoadedPath] = useState<string | null>(null);
  const [editPath, setEditPath] = useState('');
  const [editJson, setEditJson] = useState('');
  const read = useAsyncAction();
  const write = useAsyncAction();
  const readBlocked = useBudgetBlocked('GET user/memory');
  const writeBlocked = useBudgetBlocked('POST user/memory');

  const load = () =>
    void read.run(async () => {
      const value = await api.invoke('memory.get', { path: path.trim() });
      setData(value);
      setLoadedPath(path.trim());
    });

  const startEdit = (p: string, value: unknown) => {
    // p is relative to the loaded subtree; prefix the loaded path.
    const full = loadedPath ? `${loadedPath}.${p}` : p;
    setEditPath(full);
    setEditJson(JSON.stringify(value, null, 2) ?? '');
  };

  const writeValue = () =>
    void write.run(async () => {
      let value: unknown;
      try {
        value = JSON.parse(editJson);
      } catch {
        throw new Error('Value must be valid JSON (quote strings: "like this").');
      }
      await api.invoke('memory.set', { path: editPath.trim(), value });
    });

  return (
    <>
      <Section
        title="Memory tree"
        actions={
          <div className="row">
            <input
              className="input"
              placeholder="path (empty = whole Memory)"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && load()}
            />
            <button className="btn btn-primary" disabled={!connected || read.loading || readBlocked} onClick={load}>
              {read.loading ? 'Loading…' : 'Load'}
            </button>
            <BudgetChip label="GET user/memory" />
          </div>
        }
      >
        <ErrorBox error={read.error} />
        {data === undefined ? (
          <div className="muted">
            Reads are manual — the GET budget is 1440/day. Load a narrow path when you can.
          </div>
        ) : (
          <div className="json-tree">
            <JsonTree value={data} path="" onEdit={startEdit} />
          </div>
        )}
      </Section>

      <Section title="Write value" actions={<BudgetChip label="POST user/memory" />}>
        <label className="field">
          <span className="field-label">Path</span>
          <input className="input" value={editPath} onChange={(e) => setEditPath(e.target.value)} placeholder="rooms.W1N1.plan" />
        </label>
        <label className="field">
          <span className="field-label">Value (JSON)</span>
          <textarea className="input mono" rows={6} value={editJson} onChange={(e) => setEditJson(e.target.value)} />
        </label>
        <div className="row">
          <ConfirmButton
            disabled={!connected || !editPath.trim() || write.loading || writeBlocked}
            onConfirm={writeValue}
            confirmLabel={`Write to Memory.${editPath.trim()}?`}
          >
            Write
          </ConfirmButton>
          {write.loading && <span className="muted">writing…</span>}
        </div>
        <ErrorBox error={write.error} />
        <p className="muted small">Click ✎ on any node above to prefill path + value.</p>
      </Section>
    </>
  );
}

function SegmentsTab() {
  const { connected } = useBridge();
  const [segment, setSegment] = useState(0);
  const [data, setData] = useState('');
  const [loaded, setLoaded] = useState(false);
  const read = useAsyncAction();
  const write = useAsyncAction();
  const writeBlocked = useBudgetBlocked('POST user/memory-segment');

  const load = () =>
    void read.run(async () => {
      const res = await api.invoke<{ data?: string } | string>('memory.getSegment', { segment });
      setData(typeof res === 'string' ? res : (res?.data ?? ''));
      setLoaded(true);
    });

  return (
    <Section
      title="Raw segments"
      actions={
        <div className="row">
          <input
            className="input input-s"
            type="number"
            min={0}
            max={99}
            value={segment}
            onChange={(e) => setSegment(Math.max(0, Math.min(99, Number(e.target.value))))}
          />
          <button className="btn btn-primary" disabled={!connected || read.loading} onClick={load}>
            {read.loading ? '…' : 'Load'}
          </button>
          <BudgetChip label="GET user/memory-segment" />
          <BudgetChip label="POST user/memory-segment" />
        </div>
      }
    >
      <ErrorBox error={read.error} />
      <ErrorBox error={write.error} />
      <textarea
        className="input mono"
        rows={12}
        placeholder={loaded ? '(empty segment)' : 'Load a segment…'}
        value={data}
        onChange={(e) => setData(e.target.value)}
      />
      <div className="row">
        <ConfirmButton
          disabled={!connected || !loaded || write.loading || writeBlocked}
          onConfirm={() => void write.run(() => api.invoke('memory.setSegment', { segment, data }))}
          confirmLabel={`Overwrite segment ${segment}?`}
        >
          Save segment {segment}
        </ConfirmButton>
        <span className="muted small">max 100 KB per segment · POST is 60/hr</span>
      </div>
    </Section>
  );
}
