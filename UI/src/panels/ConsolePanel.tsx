/**
 * Streaming console (WS user/console) + expression input via console.run.
 * Runtime-error frames are styled distinctly; the run button is gated on the
 * POST user/console budget (360/hr).
 */

import { KeyboardEvent, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useAsyncAction, useBridge } from '../lib/hooks';
import { useStore } from '../lib/store';
import { BudgetChip, ErrorBox, useBudgetBlocked } from '../components/common';

export function ConsolePanel() {
  const lines = useStore((s) => s.consoleLines);
  const pushInput = useStore((s) => s.pushConsoleInput);
  const { connected, shard } = useBridge();
  const [expr, setExpr] = useState('');
  const [histIdx, setHistIdx] = useState(-1);
  const historyRef = useRef<string[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const { loading, error, run } = useAsyncAction();
  const blocked = useBudgetBlocked('POST user/console');

  useEffect(() => {
    const el = listRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const submit = () => {
    const expression = expr.trim();
    if (!expression || loading || blocked || !connected) return;
    historyRef.current.push(expression);
    setHistIdx(-1);
    setExpr('');
    pushInput(expression);
    void run(() => api.invoke('console.run', { expression }));
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === 'ArrowUp') {
      const h = historyRef.current;
      if (!h.length) return;
      e.preventDefault();
      const idx = histIdx === -1 ? h.length - 1 : Math.max(0, histIdx - 1);
      setHistIdx(idx);
      setExpr(h[idx]);
    } else if (e.key === 'ArrowDown') {
      const h = historyRef.current;
      if (histIdx === -1) return;
      e.preventDefault();
      const idx = histIdx + 1;
      if (idx >= h.length) {
        setHistIdx(-1);
        setExpr('');
      } else {
        setHistIdx(idx);
        setExpr(h[idx]);
      }
    }
  };

  return (
    <div className="panel-body console-panel">
      <div className="card console-card">
        <div className="card-head">
          <h2>Console {shard && <span className="muted small">({shard})</span>}</h2>
          <BudgetChip label="POST user/console" />
        </div>
        <div
          className="console-list"
          ref={listRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
        >
          {!connected && <div className="muted">Connect to stream console output.</div>}
          {connected && lines.length === 0 && <div className="muted">Waiting for output…</div>}
          {lines.map((l) => (
            <div key={l.id} className={`console-line console-${l.kind}`}>
              <span className="console-ts">{new Date(l.ts).toLocaleTimeString()}</span>
              <span className="console-text">
                {l.kind === 'input' ? `> ${l.text}` : l.text}
              </span>
            </div>
          ))}
        </div>
        <div className="console-input-row">
          <input
            className="input console-input"
            placeholder={blocked ? 'console budget exhausted — waiting for reset' : 'Game.cpu.bucket'}
            value={expr}
            disabled={!connected || blocked}
            onChange={(e) => setExpr(e.target.value)}
            onKeyDown={onKey}
          />
          <button className="btn btn-primary" onClick={submit} disabled={!connected || blocked || loading || !expr.trim()}>
            {loading ? '…' : 'Run'}
          </button>
        </div>
        <ErrorBox error={error} />
        <p className="muted small">
          Results stream back asynchronously on the console channel (the POST only submits the expression).
        </p>
      </div>
    </div>
  );
}
