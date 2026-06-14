/** Tiny shared UI primitives: stat cards, budget chips, confirm buttons, errors. */

import { ReactNode, useEffect, useState } from 'react';
import { useNow, useRateLimit } from '../lib/hooks';
import { countdown } from '../lib/util';

export function Section({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="card">
      <div className="card-head">
        <h2>{title}</h2>
        {actions && <div className="card-actions">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

export function StatCard({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: 'ok' | 'warn' | 'bad' }) {
  return (
    <div className={`stat ${tone ? `stat-${tone}` : ''}`}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

/**
 * Live remaining/max + reset countdown for a rate-limit class.
 * Renders red when exhausted.
 */
export function BudgetChip({ label }: { label: string }) {
  const budget = useRateLimit(label === 'subscription' || label === 'none' ? 'global' : label);
  const now = useNow(1000);
  if (label === 'none') return <span className="chip chip-dim">no budget</span>;
  if (!budget) return <span className="chip chip-dim">{label}</span>;
  const exhausted = budget.remaining <= 0;
  return (
    <span className={`chip ${exhausted ? 'chip-bad' : 'chip-ok'}`} title={`${label}: window ${Math.round(budget.windowMs / 60000)} min`}>
      {label === 'subscription' ? 'global' : label}: {budget.remaining}/{budget.max}
      {exhausted && <> · resets {countdown(budget.resetAt, now)}</>}
    </span>
  );
}

/** True when the budget for a class is exhausted (used to disable buttons). */
export function useBudgetBlocked(label: string): boolean {
  const budget = useRateLimit(label === 'subscription' || label === 'none' ? 'global' : label);
  if (label === 'none') return false;
  return budget !== null && budget.remaining <= 0;
}

/**
 * Two-step confirmation button for destructive / budget-expensive actions.
 * First click arms it ("Sure?"); second click within 4s fires.
 */
export function ConfirmButton({
  children,
  onConfirm,
  disabled,
  className = 'btn btn-danger',
  confirmLabel,
}: {
  children: ReactNode;
  onConfirm: () => void;
  disabled?: boolean;
  className?: string;
  confirmLabel?: string;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      className={`${className} ${armed ? 'btn-armed' : ''}`}
      disabled={disabled}
      onClick={() => {
        if (armed) {
          setArmed(false);
          onConfirm();
        } else {
          setArmed(true);
        }
      }}
    >
      {armed ? (confirmLabel ?? 'Click again to confirm') : children}
    </button>
  );
}

export function ErrorBox({ error }: { error: string | null }) {
  if (!error) return null;
  return <div className="error-box">{error}</div>;
}

export function Dot({ tone }: { tone: 'ok' | 'warn' | 'bad' | 'dim' }) {
  return <span className={`dot dot-${tone}`} />;
}

/** Pretty-printed JSON in a scrollable pre. */
export function JsonView({ value, maxHeight = 360 }: { value: unknown; maxHeight?: number }) {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? 'undefined';
  } catch {
    text = String(value);
  }
  return (
    <pre className="json-view" style={{ maxHeight }}>
      {text}
    </pre>
  );
}
