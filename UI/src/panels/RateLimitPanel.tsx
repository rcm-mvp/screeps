/** Per-class budget dashboard sourced from the bridge's rate-limit manager. */

import { useStore } from '../lib/store';
import { useNow } from '../lib/hooks';
import { countdown } from '../lib/util';
import { Section } from '../components/common';

function windowLabel(ms: number): string {
  if (ms >= 24 * 3600_000) return `${Math.round(ms / (24 * 3600_000))} d`;
  if (ms >= 3600_000) return `${Math.round(ms / 3600_000)} h`;
  return `${Math.round(ms / 60_000)} min`;
}

export function RateLimitPanel() {
  const budgets = useStore((s) => s.budgets);
  const connected = useStore((s) => s.status?.connected ?? false);
  const now = useNow(1000);

  const global = budgets.find((b) => b.label === 'global');
  const rest = budgets
    .filter((b) => b.label !== 'global')
    .sort((a, b) => a.remaining / a.max - b.remaining / b.max);

  return (
    <div className="panel-body">
      <Section title="Rate limits">
        {!connected && <div className="muted">Connect to see live budgets.</div>}
        {connected && global && (
          <div className={`global-budget ${global.remaining <= 10 ? 'global-budget-low' : ''}`}>
            <strong>Global</strong> {global.remaining}/{global.max} per minute · resets in{' '}
            {countdown(global.resetAt, now)}
            <div className="bar">
              <div
                className="bar-fill"
                style={{ width: `${(global.remaining / global.max) * 100}%` }}
              />
            </div>
          </div>
        )}
        {connected && (
          <table className="table">
            <thead>
              <tr>
                <th>Class</th>
                <th>Remaining</th>
                <th>Window</th>
                <th>Resets in</th>
                <th style={{ width: '30%' }} />
              </tr>
            </thead>
            <tbody>
              {rest.map((b) => {
                const frac = b.max > 0 ? b.remaining / b.max : 0;
                return (
                  <tr key={b.label} className={b.remaining <= 0 ? 'row-bad' : ''}>
                    <td>
                      <code>{b.label}</code>
                    </td>
                    <td>
                      {b.remaining}/{b.max}
                    </td>
                    <td>{windowLabel(b.windowMs)}</td>
                    <td>{countdown(b.resetAt, now)}</td>
                    <td>
                      <div className="bar">
                        <div
                          className={`bar-fill ${frac < 0.15 ? 'bar-bad' : frac < 0.4 ? 'bar-warn' : ''}`}
                          style={{ width: `${frac * 100}%` }}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <p className="muted small">
          Budgets are tracked by the bridge's central rate-limit manager (it queues and backs off
          automatically; on 429 it honours the server's Retry-After before any retry). Buttons across
          the UI disable when their class is exhausted.
        </p>
      </Section>
    </div>
  );
}
