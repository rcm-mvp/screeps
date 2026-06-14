/** Connect form (server preset / token / shard) + account card + link status. */

import { FormEvent, useState } from 'react';
import { useBridge } from '../lib/hooks';
import { gclLevel, formatNumber } from '../lib/util';
import { Dot, ErrorBox, Section, StatCard } from '../components/common';

export function ConnectionPanel() {
  const bridge = useBridge();
  const [server, setServer] = useState<'official' | 'ptr' | 'private'>('official');
  const [host, setHost] = useState('');
  const [token, setToken] = useState('');
  const [shard, setShard] = useState('shard3');

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void bridge
      .connect({
        server,
        host: server === 'private' ? host : undefined,
        token: token || undefined,
        shard: shard || undefined,
      })
      .catch(() => undefined); // error already lands in connectError
  };

  const a = bridge.account;

  return (
    <div className="panel-body">
      <Section title="Connect">
        <form className="connect-form" onSubmit={onSubmit}>
          <label className="field">
            <span className="field-label">Server</span>
            <select className="input" value={server} onChange={(e) => setServer(e.target.value as typeof server)}>
              <option value="official">official (screeps.com)</option>
              <option value="ptr">PTR (screeps.com/ptr)</option>
              <option value="private">private host</option>
            </select>
          </label>
          {server === 'private' && (
            <label className="field">
              <span className="field-label">Host</span>
              <input
                className="input"
                placeholder="http://localhost:21025"
                value={host}
                onChange={(e) => setHost(e.target.value)}
              />
            </label>
          )}
          <label className="field">
            <span className="field-label">Auth token</span>
            <input
              className="input"
              type="password"
              autoComplete="off"
              placeholder={
                bridge.status?.envTokenPresent
                  ? 'leave empty to use SCREEPS_TOKEN from the host env'
                  : 'token from screeps.com → Account → Auth Tokens'
              }
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">Shard</span>
            <input className="input" value={shard} onChange={(e) => setShard(e.target.value)} />
          </label>
          <div className="row">
            <button className="btn btn-primary" disabled={bridge.connecting}>
              {bridge.connecting ? 'Connecting…' : bridge.connected ? 'Reconnect' : 'Connect'}
            </button>
            {bridge.connected && (
              <button type="button" className="btn" onClick={() => void bridge.disconnect()}>
                Disconnect
              </button>
            )}
          </div>
          <ErrorBox error={bridge.connectError} />
          <p className="muted small">
            The token stays in the bridge host process — it is never stored in the browser or sent back to it.
          </p>
        </form>
      </Section>

      <Section title="Status">
        <div className="row wrap">
          <span>
            <Dot tone={bridge.connected ? 'ok' : 'bad'} /> bridge {bridge.connected ? 'connected' : 'not connected'}
          </span>
          <span>
            <Dot
              tone={
                bridge.gameSocket === 'connected'
                  ? 'ok'
                  : bridge.gameSocket === 'reconnecting' || bridge.gameSocket === 'connecting'
                    ? 'warn'
                    : 'bad'
              }
            />{' '}
            game socket: {bridge.gameSocket}
          </span>
          <span>
            <Dot tone={bridge.uiSocketState === 'open' ? 'ok' : 'warn'} /> host link: {bridge.uiSocketState}
          </span>
          {bridge.shard && <span className="chip chip-dim">shard: {bridge.shard}</span>}
          {bridge.status?.server && <span className="chip chip-dim">server: {bridge.status.server}</span>}
        </div>
      </Section>

      {a && (
        <Section title="Account">
          <div className="stat-grid">
            <StatCard label="Username" value={a.username} />
            <StatCard label="GCL" value={gclLevel(a.gcl)} hint={`${formatNumber(a.gcl)} pts`} />
            <StatCard label="GPL" value={gclLevel(a.power)} hint={`${formatNumber(a.power)} power`} />
            <StatCard label="Credits" value={formatNumber(a.credits)} />
            <StatCard label="CPU limit" value={a.cpu ?? '—'} />
            <StatCard label="User id" value={<code className="small">{a._id}</code>} />
          </div>
        </Section>
      )}
    </div>
  );
}
