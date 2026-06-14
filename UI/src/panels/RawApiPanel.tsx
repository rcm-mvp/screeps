/**
 * Raw API console: the capability manifest rendered live. Every callable
 * bridge function is listed with its schema; pick one, fill the generated
 * form, fire it, inspect the raw typed response. New bridge capabilities
 * appear here automatically.
 */

import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useBridge } from '../lib/hooks';
import type { Capability } from '../lib/types';
import { ParamForm } from '../components/ParamForm';
import { ErrorBox, JsonView, Section } from '../components/common';

export function RawApiPanel() {
  const { connected } = useBridge();
  const [caps, setCaps] = useState<Capability[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [showSchema, setShowSchema] = useState(false);

  useEffect(() => {
    api
      .manifest()
      .then((m) => setCaps(m.capabilities))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const groups = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const filtered = f
      ? caps.filter((c) => c.name.toLowerCase().includes(f) || c.description.toLowerCase().includes(f))
      : caps;
    const map = new Map<string, Capability[]>();
    for (const c of filtered) {
      const prefix = c.name.split('.')[0];
      const list = map.get(prefix) ?? [];
      list.push(c);
      map.set(prefix, list);
    }
    return [...map.entries()];
  }, [caps, filter]);

  const cap = caps.find((c) => c.name === selected) ?? null;

  return (
    <div className="panel-body rawapi-layout">
      <div className="card rawapi-list">
        <div className="card-head">
          <h2>Capabilities ({caps.length})</h2>
        </div>
        <input
          className="input"
          placeholder="filter… (e.g. memory, flag, market)"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <ErrorBox error={error} />
        <div className="rawapi-scroll">
          {groups.map(([prefix, list]) => (
            <div key={prefix}>
              <div className="rawapi-group">{prefix}</div>
              {list.map((c) => (
                <button
                  key={c.name}
                  className={`rawapi-item ${selected === c.name ? 'rawapi-active' : ''}`}
                  onClick={() => setSelected(c.name)}
                  title={c.description}
                >
                  {c.name}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>

      <div className="rawapi-detail">
        {cap ? (
          <Section
            title={cap.name}
            actions={
              <button className="btn btn-xs" onClick={() => setShowSchema(!showSchema)}>
                {showSchema ? 'hide schema' : 'show schema'}
              </button>
            }
          >
            {!connected && <div className="muted">Connect first to invoke.</div>}
            {showSchema && (
              <JsonView value={{ params: cap.params, returns: cap.returns, rateLimitClass: cap.rateLimitClass }} maxHeight={260} />
            )}
            <ParamForm key={cap.name} cap={cap} />
          </Section>
        ) : (
          <Section title="Raw API console">
            <p className="muted">
              Every bridge capability, straight from the manifest — including the{' '}
              <code>http.request</code> escape hatch for anything not wrapped yet. Pick one on the
              left.
            </p>
          </Section>
        )}
      </div>
    </div>
  );
}
