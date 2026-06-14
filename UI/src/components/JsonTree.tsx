/** Collapsible JSON tree with optional per-node edit hooks (Memory inspector). */

import { useState } from 'react';

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function Primitive({ value }: { value: unknown }) {
  const t = typeOf(value);
  const text =
    t === 'string' ? `"${value as string}"` : value === undefined ? 'undefined' : String(value);
  return <span className={`json-${t}`}>{text}</span>;
}

export function JsonTree({
  value,
  name,
  path = '',
  depth = 0,
  onEdit,
}: {
  value: unknown;
  name?: string;
  /** Dotted memory path of this node (root = ''). */
  path?: string;
  depth?: number;
  /** When set, every node gets an edit affordance calling back with its path. */
  onEdit?: (path: string, value: unknown) => void;
}) {
  const [open, setOpen] = useState(depth < 2);
  const t = typeOf(value);
  const isContainer = t === 'object' || t === 'array';

  const label = name !== undefined && (
    <span className="json-key">
      {name}
      {': '}
    </span>
  );

  const editBtn = onEdit && path !== '' && (
    <button className="json-edit" title={`Edit ${path}`} onClick={() => onEdit(path, value)}>
      ✎
    </button>
  );

  if (!isContainer) {
    return (
      <div className="json-row" style={{ paddingLeft: depth * 14 }}>
        {label}
        <Primitive value={value} />
        {editBtn}
      </div>
    );
  }

  const entries = t === 'array'
    ? (value as unknown[]).map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>);
  const preview = t === 'array' ? `[${entries.length}]` : `{${entries.length}}`;

  return (
    <div>
      <div className="json-row json-toggle" style={{ paddingLeft: depth * 14 }} onClick={() => setOpen(!open)}>
        <span className="json-arrow">{open ? '▾' : '▸'}</span>
        {label}
        <span className="json-preview">{preview}</span>
        {editBtn}
      </div>
      {open &&
        entries.map(([k, v]) => (
          <JsonTree
            key={k}
            name={k}
            value={v}
            depth={depth + 1}
            path={path === '' ? k : `${path}.${k}`}
            onEdit={onEdit}
          />
        ))}
    </div>
  );
}
