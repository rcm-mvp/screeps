/**
 * AI Strategist commander panel. Polls the standalone strategist service (proxied
 * via /api/strategist/*) for its live status and decision history, exposes the
 * safety controls (dry-run/live, kill switch, decider), and lets a human steer the
 * AI — short-term (next iteration only) and long-term (persistent) guidance.
 *
 * The strategist is optional: when its service isn't running the panel shows an
 * "offline" notice rather than erroring, and the rest of the dashboard is unaffected.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useNow } from '../lib/hooks';
import type {
  DecisionOutcome,
  DeciderKind,
  StrategistDecision,
  StrategistState,
  StrategistStatusKind,
} from '../lib/types';
import type { Directives } from 'screeps-web-api-bridge';
import { ConfirmButton, ErrorBox, Section } from '../components/common';

const STATUS_TONE: Record<StrategistStatusKind, 'ok' | 'warn' | 'bad' | 'dim'> = {
  live: 'ok',
  'dry-run': 'warn',
  idle: 'dim',
  starting: 'dim',
  'awaiting-executor': 'warn',
  'executor-stalled': 'warn',
  'budget-capped': 'warn',
  'kill-switch': 'bad',
  error: 'bad',
};

const OUTCOME_TONE: Record<DecisionOutcome, 'ok' | 'bad' | 'dim'> = {
  written: 'ok',
  'dry-run': 'dim',
  'no-change': 'dim',
  blocked: 'bad',
  'budget-capped': 'bad',
  skipped: 'dim',
  error: 'bad',
};

function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

/** Compact one-line summary of a directive patch. */
function summarizeDirectives(d: Directives | null): string {
  if (!d) return '—';
  const parts: string[] = [];
  if (d.posture) parts.push(d.posture);
  if (d.paused !== undefined) parts.push(d.paused ? 'paused' : 'running');
  if (d.targetRooms?.length) parts.push(`→ ${d.targetRooms.join(', ')}`);
  if (d.roleQuotas && Object.keys(d.roleQuotas).length) {
    parts.push(
      Object.entries(d.roleQuotas)
        .map(([r, n]) => `${r}:${n}`)
        .join(' '),
    );
  }
  if (d.flagsAsOrders !== undefined) parts.push(`flags:${d.flagsAsOrders}`);
  return parts.length ? parts.join('  ') : '(no fields)';
}

export function StrategistPanel() {
  const [state, setState] = useState<StrategistState | null>(null);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shortTerm, setShortTerm] = useState('');
  const [longTerm, setLongTerm] = useState('');
  const [running, setRunning] = useState(false);
  const longTermDirty = useRef(false);
  const now = useNow(1000);

  const refresh = useCallback(async () => {
    try {
      const s = await api.strategist.state();
      setState(s);
      setOffline(false);
      setError(null);
      if (!longTermDirty.current) setLongTerm(s.steering.longTerm ?? '');
    } catch (e) {
      if (e instanceof ApiError && (e.httpStatus === 503 || e.httpStatus === 0)) {
        setOffline(true);
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 2000);
    return () => clearInterval(t);
  }, [refresh]);

  const mutate = async (fn: () => Promise<StrategistState>) => {
    try {
      const s = await fn();
      setState(s);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const runNow = async () => {
    setRunning(true);
    await mutate(() => api.strategist.run());
    setRunning(false);
  };

  if (offline) {
    return (
      <div className="panel-body">
        <Section title="AI Strategist">
          <div className="muted">
            Strategist service not running. Start it with <code>npm run dev</code> in{' '}
            <code>Strategist/</code> (defaults to <code>http://localhost:4100</code>). The strategist
            is optional — the colony runs autonomously without it.
          </div>
        </Section>
      </div>
    );
  }

  if (!state) {
    return (
      <div className="panel-body">
        <Section title="AI Strategist">
          <ErrorBox error={error} />
          <div className="muted">Connecting to strategist service…</div>
        </Section>
      </div>
    );
  }

  const live = !state.dryRun && !state.killSwitch;
  const writePct =
    state.budget.maxPerHour > 0 ? state.budget.writesThisHour / state.budget.maxPerHour : 0;

  return (
    <div className="panel-body">
      <ErrorBox error={error} />

      {/* ---- Status + controls ---- */}
      <Section
        title="AI Strategist"
        actions={
          <div className="row">
            <button
              className="btn"
              disabled={running || state.killSwitch}
              title="Force a strategist evaluation now (re-queries the LLM when decider=ollama)"
              onClick={() => void runNow()}
            >
              {running ? 'Running…' : 'Run now'}
            </button>
            <button
              className={`btn ${state.dryRun ? 'btn-primary' : ''}`}
              disabled={state.killSwitch}
              title={state.dryRun ? 'Currently logging without writing' : 'Currently writing directives'}
              onClick={() => void mutate(() => api.strategist.control({ dryRun: !state.dryRun }))}
            >
              {state.dryRun ? 'Dry-run → go live' : 'Live → dry-run'}
            </button>
            <ConfirmButton
              className={state.killSwitch ? 'btn btn-primary' : 'btn btn-danger'}
              onConfirm={() => void mutate(() => api.strategist.control({ killSwitch: !state.killSwitch }))}
              confirmLabel={state.killSwitch ? 'Release kill switch?' : 'Engage kill switch?'}
            >
              {state.killSwitch ? 'Release kill switch' : 'Kill switch'}
            </ConfirmButton>
          </div>
        }
      >
        <div className="stat-grid">
          <div className={`stat ${tone(STATUS_TONE[state.status])}`}>
            <div className="stat-value">{state.status}</div>
            <div className="stat-label">status</div>
            <div className="stat-hint">{live ? 'writing directives' : state.killSwitch ? 'halted' : 'observing only'}</div>
          </div>
          <div className="stat">
            <div className="stat-value">
              {state.decider}
              <span className="row" style={{ marginTop: 4 }}>
                {(['rules', 'ollama'] as DeciderKind[]).map((k) => (
                  <button
                    key={k}
                    className={`btn btn-xs ${state.decider === k ? 'btn-primary' : ''}`}
                    disabled={state.decider === k}
                    onClick={() => void mutate(() => api.strategist.control({ decider: k }))}
                  >
                    {k}
                  </button>
                ))}
              </span>
            </div>
            <div className="stat-label">decider</div>
            {state.decider === 'ollama' && (
              <div className="stat-hint">{state.ollamaCalls} model call{state.ollamaCalls === 1 ? '' : 's'}</div>
            )}
          </div>
          <div className={`stat ${writePct >= 1 ? 'stat-warn' : ''}`}>
            <div className="stat-value">
              {state.budget.writesThisHour}
              <span className="muted"> / {state.budget.maxPerHour}</span>
            </div>
            <div className="stat-label">writes this hour</div>
            <div className="bar" style={{ marginTop: 6 }}>
              <div className="bar-fill" style={{ width: `${Math.min(100, writePct * 100)}%` }} />
            </div>
          </div>
          <div className="stat">
            <div className="stat-value">{state.tick ?? '—'}</div>
            <div className="stat-label">executor tick</div>
            <div className="stat-hint">heartbeat {state.heartbeat ?? '—'}</div>
          </div>
        </div>
      </Section>

      {/* ---- Current strategy ---- */}
      <Section title="Current strategy">
        <div className="row wrap">
          <span className="chip chip-dim">directives</span>
          <code>{summarizeDirectives(state.currentDirectives)}</code>
          {state.currentDirectives.rev !== undefined && (
            <span className="muted small">rev {state.currentDirectives.rev}</span>
          )}
        </div>
        {state.latestWritten?.note && (
          <>
            <h3>Rationale</h3>
            <p className="muted" style={{ whiteSpace: 'pre-wrap' }}>
              {state.latestWritten.note}
            </p>
          </>
        )}
        {!state.latestWritten && (
          <p className="muted small">No directive has been written yet (dry-run, or nothing to change).</p>
        )}
      </Section>

      {/* ---- Steering ---- */}
      <Section title="Steer the AI">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label className="muted small">Short-term (applies to the next iteration only)</label>
          <textarea
            className="input"
            rows={2}
            placeholder="e.g. prioritise defense of W2N2 this cycle"
            value={shortTerm}
            onChange={(e) => setShortTerm(e.target.value)}
          />
          <div className="row">
            <button
              className="btn btn-primary"
              disabled={!shortTerm.trim()}
              onClick={() =>
                void mutate(async () => {
                  const s = await api.strategist.steer({ shortTerm });
                  setShortTerm('');
                  return s;
                })
              }
            >
              Apply next iteration
            </button>
            {state.steering.shortTerm && (
              <span className="muted small">queued: “{state.steering.shortTerm}”</span>
            )}
          </div>

          <label className="muted small" style={{ marginTop: 12 }}>
            Long-term (persistent guidance in every prompt)
          </label>
          <textarea
            className="input"
            rows={3}
            placeholder="e.g. play economy-first; never go to war; expand toward the east"
            value={longTerm}
            onChange={(e) => {
              longTermDirty.current = true;
              setLongTerm(e.target.value);
            }}
          />
          <div className="row">
            <button
              className="btn btn-primary"
              onClick={() =>
                void mutate(async () => {
                  const s = await api.strategist.steer({ longTerm: longTerm.trim() ? longTerm : null });
                  longTermDirty.current = false;
                  return s;
                })
              }
            >
              Save long-term
            </button>
            {state.steering.longTerm && <span className="muted small">active</span>}
          </div>
        </div>
        <p className="muted small">
          Steering only applies to the LLM decider. With <code>decider=ollama</code> it shapes the
          next model prompt; the rule-based decider ignores it.
        </p>
      </Section>

      {/* ---- Decision history ---- */}
      <Section title={`Decision history (${state.history.length})`}>
        {state.history.length === 0 && <div className="muted">No decisions recorded yet.</div>}
        {state.history.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Tick</th>
                <th>By</th>
                <th>Outcome</th>
                <th>Patch</th>
                <th>Rationale</th>
              </tr>
            </thead>
            <tbody>
              {state.history.map((d) => (
                <HistoryRow key={d.id} d={d} now={now} />
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </div>
  );
}

function HistoryRow({ d, now }: { d: StrategistDecision; now: number }) {
  const detail = d.note ?? (d.blocked?.length ? d.blocked.join('; ') : '');
  return (
    <tr>
      <td className="small muted" title={new Date(d.ts).toLocaleString()}>
        {ago(d.ts, now)}
      </td>
      <td className="small muted">{d.tick ?? '—'}</td>
      <td className="small">{d.decider}</td>
      <td>
        <span className={`chip chip-${OUTCOME_TONE[d.outcome]}`}>{d.outcome}</span>
        {d.outcome === 'written' && (
          <span className="muted small" title="executor acked?">
            {' '}
            {d.appliedConfirmed ? '✓' : '…'}
          </span>
        )}
      </td>
      <td className="small">
        <code>{summarizeDirectives(d.patch)}</code>
      </td>
      <td className="small muted" style={{ maxWidth: 360, whiteSpace: 'pre-wrap' }}>
        {detail.length > 240 ? `${detail.slice(0, 240)}…` : detail}
      </td>
    </tr>
  );
}

function tone(t: 'ok' | 'warn' | 'bad' | 'dim'): string {
  return t === 'ok' ? 'stat-ok' : t === 'warn' ? 'stat-warn' : t === 'bad' ? 'stat-bad' : '';
}
