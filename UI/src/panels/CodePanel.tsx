/**
 * Code / branches: list branches + active markers, view (and optionally edit)
 * a branch's modules, switch the active branch, and a heavily-guarded push.
 * Budgets: GET user/code 60/hr · POST user/code 240/day · set-active 240/day.
 */

import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAsyncAction, useBridge } from '../lib/hooks';
import type { Branch, CodeResponse } from '../lib/types';
import { BudgetChip, ConfirmButton, ErrorBox, Section, useBudgetBlocked } from '../components/common';

export function CodePanel() {
  const { connected } = useBridge();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [viewing, setViewing] = useState<CodeResponse | null>(null);
  const [moduleName, setModuleName] = useState<string | null>(null);
  const [edited, setEdited] = useState<Record<string, string>>({});
  const [pushConfirm, setPushConfirm] = useState('');
  const list = useAsyncAction();
  const view = useAsyncAction();
  const action = useAsyncAction();
  const getBlocked = useBudgetBlocked('GET user/code');
  const pushBlocked = useBudgetBlocked('POST user/code');

  const loadBranches = () =>
    void list.run(async () => {
      const res = await api.invoke<{ list: Branch[] }>('code.branches');
      setBranches(res.list ?? []);
    });

  useEffect(() => {
    if (connected) loadBranches();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  const viewBranch = (branch: string) =>
    void view.run(async () => {
      const res = await api.invoke<CodeResponse>('code.get', { branch });
      setViewing(res);
      setEdited({});
      const names = Object.keys(res.modules ?? {});
      setModuleName(names.includes('main') ? 'main' : (names[0] ?? null));
    });

  const moduleSource = (name: string): string => {
    if (name in edited) return edited[name];
    const m = viewing?.modules[name];
    return typeof m === 'string' ? m : `// binary module (${(m as { binary: string })?.binary?.length ?? 0} b64 chars)`;
  };

  const dirty = Object.keys(edited).length > 0;

  const push = () =>
    void action.run(async () => {
      if (!viewing) return;
      const modules: Record<string, string | { binary: string }> = { ...viewing.modules };
      for (const [k, v] of Object.entries(edited)) modules[k] = v;
      await api.invoke('code.push', { branch: viewing.branch, modules });
      setPushConfirm('');
      setEdited({});
    });

  return (
    <div className="panel-body">
      <Section
        title="Branches"
        actions={
          <div className="row">
            <button className="btn" disabled={!connected || list.loading} onClick={loadBranches}>
              Refresh
            </button>
            <BudgetChip label="GET user/code" />
            <BudgetChip label="POST user/set-active-branch" />
          </div>
        }
      >
        <ErrorBox error={list.error} />
        <ErrorBox error={action.error} />
        <table className="table">
          <thead>
            <tr>
              <th>Branch</th>
              <th>Active</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {branches.map((b) => (
              <tr key={b._id}>
                <td>
                  <code>{b.branch}</code>
                </td>
                <td>
                  {b.activeWorld && <span className="chip chip-ok">world</span>}{' '}
                  {b.activeSim && <span className="chip chip-dim">sim</span>}
                </td>
                <td className="row">
                  <button className="btn btn-xs" disabled={view.loading || getBlocked} onClick={() => viewBranch(b.branch)}>
                    View code
                  </button>
                  {!b.activeWorld && (
                    <ConfirmButton
                      className="btn btn-danger btn-xs"
                      confirmLabel={`Make "${b.branch}" the LIVE world branch?`}
                      onConfirm={() =>
                        void action.run(async () => {
                          await api.invoke('code.setActiveBranch', { branch: b.branch, activeName: 'activeWorld' });
                          loadBranches();
                        })
                      }
                    >
                      Set active (world)
                    </ConfirmButton>
                  )}
                  <button
                    className="btn btn-xs"
                    onClick={() => {
                      const newName = window.prompt(`Clone "${b.branch}" as:`);
                      if (newName?.trim()) {
                        void action.run(async () => {
                          await api.invoke('code.cloneBranch', { branch: b.branch, newName: newName.trim() });
                          loadBranches();
                        });
                      }
                    }}
                  >
                    Clone
                  </button>
                  {!b.activeWorld && !b.activeSim && (
                    <ConfirmButton
                      className="btn btn-danger btn-xs"
                      confirmLabel={`Delete branch "${b.branch}"?`}
                      onConfirm={() =>
                        void action.run(async () => {
                          await api.invoke('code.deleteBranch', { branch: b.branch });
                          loadBranches();
                        })
                      }
                    >
                      Delete
                    </ConfirmButton>
                  )}
                </td>
              </tr>
            ))}
            {branches.length === 0 && (
              <tr>
                <td colSpan={3} className="muted">
                  {connected ? 'No branches loaded.' : 'Connect first.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Section>

      {viewing && (
        <Section title={`Code — ${viewing.branch}`} actions={<BudgetChip label="POST user/code" />}>
          <ErrorBox error={view.error} />
          <div className="code-layout">
            <div className="module-list">
              {Object.keys(viewing.modules ?? {}).map((name) => (
                <button
                  key={name}
                  className={`module-item ${name === moduleName ? 'module-active' : ''} ${name in edited ? 'module-dirty' : ''}`}
                  onClick={() => setModuleName(name)}
                >
                  {name}
                  {name in edited && ' •'}
                </button>
              ))}
            </div>
            <div className="code-editor">
              {moduleName !== null ? (
                <textarea
                  className="input mono code-text"
                  spellCheck={false}
                  value={moduleSource(moduleName)}
                  onChange={(e) => setEdited({ ...edited, [moduleName]: e.target.value })}
                />
              ) : (
                <div className="muted">No modules.</div>
              )}
            </div>
          </div>

          <div className="push-guard">
            <h4>Push code (overwrites the live branch · 240/day)</h4>
            <div className="row">
              <input
                className="input"
                placeholder={`type "${viewing.branch}" to enable push`}
                value={pushConfirm}
                onChange={(e) => setPushConfirm(e.target.value)}
              />
              <ConfirmButton
                disabled={pushConfirm !== viewing.branch || action.loading || pushBlocked}
                confirmLabel={`Really push ${dirty ? Object.keys(edited).length + ' edited module(s)' : 'unchanged code'} to "${viewing.branch}"?`}
                onConfirm={push}
              >
                Push to {viewing.branch}
              </ConfirmButton>
            </div>
            {!dirty && <p className="muted small">No local edits — a push would re-upload the code as fetched.</p>}
          </div>
        </Section>
      )}
    </div>
  );
}
