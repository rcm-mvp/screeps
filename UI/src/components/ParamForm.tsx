/**
 * Schema-driven form for one bridge capability, generated from the manifest's
 * params JSON schema. Used by the Raw API console (every capability) and the
 * World Actions panel (curated subset). Submits via api.invoke and shows the
 * raw typed response; the submit button is budget-gated and, for destructive
 * capabilities, requires two-step confirmation.
 */

import { FormEvent, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useAsyncAction } from '../lib/hooks';
import type { Capability } from '../lib/types';
import { BudgetChip, ConfirmButton, ErrorBox, JsonView, useBudgetBlocked } from './common';

/** Capabilities that overwrite live state or destroy objects — always confirmed. */
export const DANGEROUS_CAPS = new Set([
  'code.push',
  'code.setActiveBranch',
  'code.deleteBranch',
  'memory.set',
  'memory.setSegment',
  'world.suicideCreep',
  'world.unclaimController',
  'world.destroyStructures',
  'world.removeConstructionSite',
  'world.removeFlag',
  'world.placeSpawn',
  'control.setDirectives',
  'control.pushAndConfirm',
  'commander.propose',
]);

interface SchemaProp {
  type?: string;
  description?: string;
}

interface ParamsSchema {
  properties?: Record<string, SchemaProp>;
  required?: string[];
}

export function ParamForm({
  cap,
  initial = {},
  submitLabel,
  onResult,
}: {
  cap: Capability;
  /** Pre-filled raw field values (strings; JSON text for object/array). */
  initial?: Record<string, string>;
  submitLabel?: string;
  onResult?: (result: unknown) => void;
}) {
  const schema = cap.params as ParamsSchema;
  const props = useMemo(() => Object.entries(schema.properties ?? {}), [schema]);
  const required = useMemo(() => new Set(schema.required ?? []), [schema]);

  const [fields, setFields] = useState<Record<string, string>>(initial);
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [result, setResult] = useState<unknown>(undefined);
  const [hasResult, setHasResult] = useState(false);
  const { loading, error, setError, run } = useAsyncAction();
  const blocked = useBudgetBlocked(cap.rateLimitClass);

  const missingRequired = props.some(
    ([key, p]) =>
      required.has(key) && (p.type === 'boolean' ? false : !(fields[key]?.trim())),
  );

  const buildParams = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, p] of props) {
      if (p.type === 'boolean') {
        if (checks[key] !== undefined) out[key] = checks[key];
        continue;
      }
      const raw = fields[key]?.trim();
      if (raw === undefined || raw === '') continue;
      if (p.type === 'number') {
        const n = Number(raw);
        if (Number.isNaN(n)) throw new Error(`"${key}" must be a number.`);
        out[key] = n;
      } else if (p.type === 'object' || p.type === 'array' || p.type === undefined) {
        try {
          out[key] = JSON.parse(raw);
        } catch {
          // Schema-less params (e.g. memory.set value) accept any JSON; fall
          // back to the raw string so plain text doesn't need quoting.
          if (p.type === undefined) out[key] = raw;
          else throw new Error(`"${key}" must be valid JSON.`);
        }
      } else {
        out[key] = raw;
      }
    }
    return out;
  };

  const fire = () =>
    run(async () => {
      let params: Record<string, unknown>;
      try {
        params = buildParams();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return;
      }
      const res = await api.invoke(cap.name, params);
      setResult(res);
      setHasResult(true);
      onResult?.(res);
    });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!DANGEROUS_CAPS.has(cap.name)) void fire();
  };

  const disabled = loading || blocked || missingRequired;
  const label = submitLabel ?? `Invoke ${cap.name}`;

  return (
    <form className="param-form" onSubmit={onSubmit}>
      <div className="param-form-head">
        <span className="muted">{cap.description}</span>
        <BudgetChip label={cap.rateLimitClass} />
      </div>
      {props.length === 0 && <div className="muted">No parameters.</div>}
      {props.map(([key, p]) => (
        <label key={key} className="field">
          <span className="field-label">
            {key}
            {required.has(key) && <em className="req">*</em>}
            <span className="field-type">{p.type ?? 'json'}</span>
          </span>
          {p.type === 'boolean' ? (
            <input
              type="checkbox"
              checked={checks[key] ?? false}
              onChange={(e) => setChecks({ ...checks, [key]: e.target.checked })}
            />
          ) : p.type === 'object' || p.type === 'array' || p.type === undefined ? (
            <textarea
              className="input"
              rows={3}
              placeholder={p.description ?? 'JSON'}
              value={fields[key] ?? ''}
              onChange={(e) => setFields({ ...fields, [key]: e.target.value })}
            />
          ) : (
            <input
              className="input"
              type={p.type === 'number' ? 'number' : 'text'}
              placeholder={p.description ?? ''}
              value={fields[key] ?? ''}
              onChange={(e) => setFields({ ...fields, [key]: e.target.value })}
            />
          )}
        </label>
      ))}
      <div className="row">
        {DANGEROUS_CAPS.has(cap.name) ? (
          <ConfirmButton disabled={disabled} onConfirm={() => void fire()}>
            {label}
          </ConfirmButton>
        ) : (
          <button type="submit" className="btn btn-primary" disabled={disabled}>
            {loading ? 'Running…' : label}
          </button>
        )}
        {blocked && <span className="muted">budget exhausted — button disabled until reset</span>}
      </div>
      <ErrorBox error={error} />
      {hasResult && (
        <div>
          <div className="muted small">Response</div>
          <JsonView value={result} />
        </div>
      )}
    </form>
  );
}
