/**
 * World Actions: curated, confirmed forms for flags, construction and the
 * discrete object intents. Forms are generated from the capability manifest
 * (same ParamForm as the Raw API console) so they always match the bridge.
 */

import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useBridge } from '../lib/hooks';
import type { Capability } from '../lib/types';
import { ParamForm } from '../components/ParamForm';
import { ErrorBox, Section } from '../components/common';

const GROUPS: Array<{ title: string; caps: string[] }> = [
  {
    title: 'Flags',
    caps: ['world.createFlag', 'world.changeFlag', 'world.changeFlagColor', 'world.removeFlag'],
  },
  {
    title: 'Construction',
    caps: ['world.createConstruction', 'world.placeSpawn', 'world.removeConstructionSite'],
  },
  {
    title: 'Object intents (destructive)',
    caps: ['world.suicideCreep', 'world.unclaimController', 'world.destroyStructures', 'world.setNotifyWhenAttacked'],
  },
  {
    title: 'Executor directives (Memory.bridge contract)',
    caps: ['control.pause', 'control.resume', 'control.setPosture', 'control.setTargetRooms', 'control.setQuota'],
  },
];

export function WorldActionsPanel() {
  const { connected } = useBridge();
  const [caps, setCaps] = useState<Capability[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>('world.createFlag');

  useEffect(() => {
    api
      .manifest()
      .then((m) => setCaps(m.capabilities))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const byName = useMemo(() => new Map(caps.map((c) => [c.name, c])), [caps]);

  return (
    <div className="panel-body">
      {!connected && <div className="muted">Connect first — actions need a live bridge.</div>}
      <ErrorBox error={error} />
      {GROUPS.map((group) => (
        <Section key={group.title} title={group.title}>
          {group.caps.map((name) => {
            const cap = byName.get(name);
            if (!cap) return null;
            const isOpen = open === name;
            return (
              <div key={name} className="action-item">
                <button className={`action-head ${isOpen ? 'action-open' : ''}`} onClick={() => setOpen(isOpen ? null : name)}>
                  <code>{name}</code>
                  <span className="muted small">{cap.description}</span>
                </button>
                {isOpen && <ParamForm cap={cap} submitLabel={name.split('.')[1]} />}
              </div>
            );
          })}
        </Section>
      ))}
      <p className="muted small">
        Destructive intents require two-step confirmation. The room viewer also offers these
        contextually on selected tiles.
      </p>
    </div>
  );
}
