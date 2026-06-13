// Devbox Claude-sessions UI — buildless Preact + htm (ES modules from esm.sh).
import { h, render } from 'https://esm.sh/preact@10.24.3';
import { useState, useEffect, useRef, useCallback } from 'https://esm.sh/preact@10.24.3/hooks';
import htm from 'https://esm.sh/htm@3.1.1';
const html = htm.bind(h);

// ---- API ------------------------------------------------------------------
const token = {
  get: () => localStorage.getItem('devbox_token') || '',
  set: (t) => localStorage.setItem('devbox_token', t || ''),
};
async function api(path, opts = {}) {
  const t = token.get();
  const res = await fetch(path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}), ...(opts.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const e = new Error(body.error || `${res.status} ${res.statusText}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}
const streamUrl = (id) => {
  const t = token.get();
  return `/sessions/${id}/stream${t ? `?access_token=${encodeURIComponent(t)}` : ''}`;
};

// ---- stream-json → transcript items --------------------------------------
function reduce(items, partialRef, evt) {
  const push = (it) => items.push(it);
  switch (evt.type) {
    case 'system':
      if (evt.subtype === 'init') push({ kind: 'system', text: `session ${String(evt.session_id || '').slice(0, 8)} · ${evt.model || ''}` });
      break;
    case 'stream_event': {
      const d = evt.event && evt.event.delta;
      if (d && d.type === 'text_delta' && d.text) partialRef.text += d.text;
      break;
    }
    case 'assistant': {
      partialRef.text = '';
      const content = (evt.message && evt.message.content) || [];
      for (const b of content) {
        if (b.type === 'text' && b.text.trim()) push({ kind: 'assistant', text: b.text });
        else if (b.type === 'tool_use') push({ kind: 'tool_use', name: b.name, input: b.input });
      }
      break;
    }
    case 'user': {
      const content = (evt.message && evt.message.content) || [];
      for (const b of content) {
        if (b.type === 'tool_result') push({ kind: 'tool_result', content: b.content });
      }
      break;
    }
    case 'result':
      push({ kind: 'result', result: evt.result, cost: evt.total_cost_usd, ms: evt.duration_ms, isError: evt.is_error });
      break;
    case 'stderr':
      if (String(evt.text || '').trim()) push({ kind: 'stderr', text: evt.text });
      break;
    case 'control':
      if (evt.subtype === 'turn-start') push({ kind: 'control', text: '— turn —' });
      break;
    case 'raw':
      push({ kind: 'raw', text: evt.text });
      break;
  }
}

// ---- components -----------------------------------------------------------
function StatusDot({ status }) {
  return html`<span class="dot ${status}" title=${status}></span>`;
}

const TRANSIENT_ENV = ['scaffolding', 'setting-up', 'configuring', 'starting-worker', 'destroying'];

function EnvRow({ env, onAction }) {
  const building = TRANSIENT_ENV.includes(env.status);
  const up = env.status === 'running' || env.status === 'degraded';
  return html`
    <div class="env">
      <div class="env-top">
        <${StatusDot} status=${env.status} /> <span class="env-name">${env.name}</span>
        <a class="env-port" href=${env.wpUrl} target="_blank" rel="noreferrer" onClick=${(e) => e.stopPropagation()}>:${env.port}</a>
      </div>
      <div class="env-actions">
        ${building
          ? html`<span class="muted small">${env.status}…</span>`
          : html`
            ${up && html`<button class="lnk" onClick=${() => onAction('session', env)}>+ session</button>`}
            ${up && html`<button class="lnk" onClick=${() => onAction('stop', env)}>stop</button>`}
            ${env.status === 'stopped' && html`<button class="lnk" onClick=${() => onAction('start', env)}>start</button>`}
            ${env.status === 'failed' && html`<button class="lnk" onClick=${() => onAction('start', env)}>retry</button>`}
            <button class="lnk danger" onClick=${() => onAction('delete', env)}>delete</button>`}
      </div>
    </div>`;
}

function Sidebar({ sessions, envs, selectedId, onSelect, onNewSession, onNewEnv, onEnvAction, onSettings }) {
  return html`
    <aside class="sidebar">
      <div class="side-head">
        <strong>Devbox</strong>
        <button class="btn small ghost" onClick=${onSettings} title="API token">⚙</button>
      </div>
      <div class="side-section">
        <div class="section-head"><span>Environments</span><button class="btn small" onClick=${onNewEnv}>+ Env</button></div>
        ${envs.length === 0 && html`<div class="muted pad small">No environments — create one.</div>`}
        ${envs.map((e) => html`<${EnvRow} env=${e} key=${e.id} onAction=${onEnvAction} />`)}
      </div>
      <div class="side-section grow">
        <div class="section-head"><span>Sessions</span><button class="btn small" onClick=${onNewSession}>+ Session</button></div>
        <div class="side-list">
          ${sessions.length === 0 && html`<div class="muted pad small">No sessions yet.</div>`}
          ${sessions.map(
            (s) => html`
              <div class=${`sess ${s.id === selectedId ? 'active' : ''}`} key=${s.id} onClick=${() => onSelect(s.id)}>
                <div class="sess-top"><${StatusDot} status=${s.status} /> <span class="sess-title">${s.title || s.id}</span></div>
                <div class="sess-sub muted">${s.envName} · ${s.turnCount} turn${s.turnCount === 1 ? '' : 's'} · $${(s.costUsd || 0).toFixed(3)}</div>
              </div>`,
          )}
        </div>
      </div>
    </aside>`;
}

function Bubble({ it }) {
  if (it.kind === 'assistant') return html`<div class="bubble assistant"><pre>${it.text}</pre></div>`;
  if (it.kind === 'system') return html`<div class="chip">${it.text}</div>`;
  if (it.kind === 'control') return html`<div class="divider">${it.text}</div>`;
  if (it.kind === 'tool_use')
    return html`<details class="tool"><summary>🔧 ${it.name}</summary><pre>${JSON.stringify(it.input, null, 2)}</pre></details>`;
  if (it.kind === 'tool_result') {
    const text = typeof it.content === 'string' ? it.content : JSON.stringify(it.content, null, 2);
    return html`<details class="tool result"><summary>↳ result</summary><pre>${text}</pre></details>`;
  }
  if (it.kind === 'result')
    return html`<div class="result-foot ${it.isError ? 'err' : ''}">✓ done · $${(it.cost || 0).toFixed(4)} · ${Math.round((it.ms || 0))}ms</div>`;
  if (it.kind === 'stderr') return html`<div class="stderr"><pre>${it.text}</pre></div>`;
  return html`<div class="raw"><pre>${it.text}</pre></div>`;
}

function SessionView({ session, onChanged }) {
  const [items, setItems] = useState([]);
  const [partial, setPartial] = useState('');
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState('');
  const partialRef = useRef({ text: '' });
  const seen = useRef(new Set());
  const scroller = useRef(null);
  const id = session.id;

  useEffect(() => {
    // Reset for the newly-selected session, load history, then go live.
    setItems([]); setPartial(''); partialRef.current = { text: '' }; seen.current = new Set();
    let es;
    let cancelled = false;
    (async () => {
      try {
        const { events } = await api(`/sessions/${id}/transcript?tail=5000`);
        const arr = [];
        for (const e of events) { if (e.uuid) seen.current.add(e.uuid); reduce(arr, partialRef.current, e); }
        if (!cancelled) { setItems(arr.slice()); setPartial(partialRef.current.text); }
      } catch { /* fresh session, no transcript */ }
      if (cancelled) return;
      es = new EventSource(streamUrl(id));
      es.onmessage = (m) => {
        let evt; try { evt = JSON.parse(m.data); } catch { return; }
        if (evt.type === 'control' && evt.subtype === 'snapshot') return;
        if (evt.uuid && seen.current.has(evt.uuid)) return;
        if (evt.uuid) seen.current.add(evt.uuid);
        if (evt.type === 'control' && evt.subtype === 'turn-end') { setBusy(false); onChanged && onChanged(); }
        setItems((prev) => { const next = prev.slice(); reduce(next, partialRef.current, evt); return next; });
        setPartial(partialRef.current.text);
      };
      es.onerror = () => {/* EventSource auto-reconnects */};
    })();
    return () => { cancelled = true; if (es) es.close(); };
  }, [id]);

  useEffect(() => { if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }, [items, partial]);

  const running = busy || session.status === 'running';
  const send = useCallback(async () => {
    const prompt = input.trim();
    if (!prompt || running) return;
    setInput(''); setBusy(true);
    try { await api(`/sessions/${id}/messages`, { method: 'POST', body: JSON.stringify({ prompt }) }); onChanged && onChanged(); }
    catch (e) { setBusy(false); alert(`Send failed: ${e.message}`); }
  }, [input, running, id]);
  const interrupt = async () => { try { await api(`/sessions/${id}/interrupt`, { method: 'POST' }); } catch (e) { alert(e.message); } };

  return html`
    <section class="main">
      <header class="bar">
        <div><${StatusDot} status=${session.status} /> <strong>${session.title || id}</strong></div>
        <div class="bar-meta muted">
          ${session.envName} · ${session.model || 'default model'} · $${(session.costUsd || 0).toFixed(4)}
          ${session.claudeSessionId && html`· <code title="claude session id">${session.claudeSessionId.slice(0, 8)}</code>`}
        </div>
      </header>
      ${session.sshResumeHint && html`<div class="ssh muted" onClick=${() => navigator.clipboard?.writeText(session.sshResumeHint)} title="click to copy">SSH resume: <code>${session.sshResumeHint}</code></div>`}
      <div class="transcript" ref=${scroller}>
        ${items.map((it, i) => html`<${Bubble} it=${it} key=${i} />`)}
        ${partial && html`<div class="bubble assistant live"><pre>${partial}</pre><span class="cursor">▍</span></div>`}
        ${running && !partial && html`<div class="muted pad">…thinking</div>`}
      </div>
      <footer class="composer">
        <textarea
          value=${input}
          placeholder=${running ? 'Turn in progress…' : 'Message Claude (Enter to send, Shift+Enter for newline)'}
          disabled=${running}
          onInput=${(e) => setInput(e.target.value)}
          onKeyDown=${(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
        ></textarea>
        ${running
          ? html`<button class="btn warn" onClick=${interrupt}>Interrupt</button>`
          : html`<button class="btn" onClick=${send} disabled=${!input.trim()}>Send</button>`}
      </footer>
    </section>`;
}

function NewSessionModal({ envs, preselect, onClose, onCreate }) {
  const usable = envs.filter((e) => e.status === 'running' || e.status === 'degraded');
  const [envId, setEnvId] = useState(preselect || (usable[0] && usable[0].id));
  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [err, setErr] = useState('');
  const create = async () => {
    if (!envId || !prompt.trim()) return;
    try { await onCreate(envId, prompt.trim(), model.trim() || undefined); } catch (e) { setErr(e.message); }
  };
  return html`
    <div class="modal-bg" onClick=${onClose}>
      <div class="modal" onClick=${(e) => e.stopPropagation()}>
        <h3>New Claude session</h3>
        ${usable.length === 0 && html`<div class="muted">No running environments. Create/start one first.</div>`}
        <label>Environment
          <select value=${envId} onChange=${(e) => setEnvId(e.target.value)}>
            ${usable.map((e) => html`<option value=${e.id} key=${e.id}>${e.name} (:${e.port})</option>`)}
          </select>
        </label>
        <label>Model <input value=${model} placeholder="default (e.g. claude-sonnet-4-6)" onInput=${(e) => setModel(e.target.value)} /></label>
        <label>First message
          <textarea value=${prompt} rows="4" onInput=${(e) => setPrompt(e.target.value)} placeholder="Describe the task…"></textarea>
        </label>
        ${err && html`<div class="err-msg">${err}</div>`}
        <div class="modal-foot">
          <button class="btn ghost" onClick=${onClose}>Cancel</button>
          <button class="btn" onClick=${create} disabled=${!envId || !prompt.trim()}>Create</button>
        </div>
      </div>
    </div>`;
}

function NewEnvModal({ onClose, onCreate }) {
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true); setErr('');
    try { await onCreate(name.trim() || undefined); } catch (e) { setErr(e.message); setBusy(false); }
  };
  return html`
    <div class="modal-bg" onClick=${onClose}>
      <div class="modal" onClick=${(e) => e.stopPropagation()}>
        <h3>New environment</h3>
        <p class="muted">Builds a fresh WordPress devbox (≈1 min) with the target plugin checked out. Leave the name blank to auto-generate.</p>
        <label>Name (optional)
          <input value=${name} placeholder="my-devbox (a-z, 0-9, -)" onInput=${(e) => setName(e.target.value)} />
        </label>
        ${err && html`<div class="err-msg">${err}</div>`}
        <div class="modal-foot">
          <button class="btn ghost" onClick=${onClose}>Cancel</button>
          <button class="btn" onClick=${create} disabled=${busy}>${busy ? 'Creating…' : 'Create'}</button>
        </div>
      </div>
    </div>`;
}

function TokenGate({ onSave }) {
  const [val, setVal] = useState(token.get());
  return html`
    <div class="modal-bg">
      <div class="modal">
        <h3>API token</h3>
        <p class="muted">Enter the server's <code>DEVBOX_API_TOKEN</code> (stored in this browser only).</p>
        <input type="password" value=${val} onInput=${(e) => setVal(e.target.value)} placeholder="Bearer token" />
        <div class="modal-foot"><button class="btn" onClick=${() => { token.set(val); onSave(); }}>Save</button></div>
      </div>
    </div>`;
}

function App() {
  const [sessions, setSessions] = useState([]);
  const [envs, setEnvs] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [newSession, setNewSession] = useState(null); // null | { preselect? }
  const [showNewEnv, setShowNewEnv] = useState(false);
  const [needToken, setNeedToken] = useState(false);
  const [authed, setAuthed] = useState(!!token.get());

  const refresh = useCallback(async () => {
    try {
      const [s, e] = await Promise.all([api('/sessions'), api('/environments')]);
      setSessions(s.sessions); setEnvs(e.environments); setNeedToken(false);
    } catch (err) { if (err.status === 401) setNeedToken(true); }
  }, []);

  useEffect(() => { if (authed) { refresh(); const t = setInterval(refresh, 3000); return () => clearInterval(t); } }, [authed, refresh]);

  if (needToken || !authed) return html`<${TokenGate} onSave=${() => { setAuthed(true); setNeedToken(false); refresh(); }} />`;

  const selected = sessions.find((s) => s.id === selectedId);

  const createSession = async (envId, prompt, model) => {
    const s = await api(`/environments/${envId}/sessions`, { method: 'POST', body: JSON.stringify({ prompt, model }) });
    setNewSession(null); await refresh(); setSelectedId(s.id);
  };
  const createEnv = async (name) => {
    await api('/environments', { method: 'POST', body: JSON.stringify({ name }) });
    setShowNewEnv(false); refresh();
  };
  const envAction = async (action, env) => {
    try {
      if (action === 'session') return setNewSession({ preselect: env.id });
      if (action === 'start') await api(`/environments/${env.id}/start`, { method: 'POST' });
      if (action === 'stop') await api(`/environments/${env.id}/stop`, { method: 'POST' });
      if (action === 'delete') {
        if (!confirm(`Destroy environment "${env.name}"? This removes its containers and all its data.`)) return;
        await api(`/environments/${env.id}`, { method: 'DELETE' });
      }
      refresh();
    } catch (e) { alert(`${action} failed: ${e.message}`); }
  };

  return html`
    <div class="layout">
      <${Sidebar} sessions=${sessions} envs=${envs} selectedId=${selectedId}
        onSelect=${setSelectedId} onNewSession=${() => setNewSession({})} onNewEnv=${() => setShowNewEnv(true)}
        onEnvAction=${envAction} onSettings=${() => setAuthed(false)} />
      ${selected
        ? html`<${SessionView} session=${selected} key=${selected.id} onChanged=${refresh} />`
        : html`<section class="main empty"><div class="muted">
            ${envs.length === 0
              ? html`No environments yet. <button class="btn" onClick=${() => setShowNewEnv(true)}>Create an environment</button> to begin.`
              : html`Select a session, or <button class="btn" onClick=${() => setNewSession({})}>start a new one</button>.`}
          </div></section>`}
      ${newSession && html`<${NewSessionModal} envs=${envs} preselect=${newSession.preselect} onClose=${() => setNewSession(null)} onCreate=${createSession} />`}
      ${showNewEnv && html`<${NewEnvModal} onClose=${() => setShowNewEnv(false)} onCreate=${createEnv} />`}
    </div>`;
}

render(html`<${App} />`, document.getElementById('root'));
