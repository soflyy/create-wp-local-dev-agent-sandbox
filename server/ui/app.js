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
    case 'user_prompt':
      // the message the user sent — claude -p doesn't echo it, so the server records it
      push({ kind: 'user', text: evt.text });
      break;
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

const TRANSIENT_ENV = ['scaffolding', 'setting-up', 'configuring', 'destroying'];

function EnvRow({ env, onAction }) {
  const building = TRANSIENT_ENV.includes(env.status);
  const up = env.status === 'running' || env.status === 'degraded';
  // Link to the WP site on the SAME host the UI was loaded from (not the
  // server's localhost wpUrl) — so it works from a phone/laptop hitting the
  // server's IP, and still works from inside the devbox via localhost.
  const wpUrl = `${location.protocol}//${location.hostname}:${env.port}/`;
  return html`
    <div class="env">
      <div class="env-top">
        <${StatusDot} status=${env.status} /> <span class="env-name">${env.name}</span>
        ${env.preset && html`<span class="badge" title="provisioned from preset">${env.preset}</span>`}
        <a class="env-port" href=${wpUrl} target="_blank" rel="noreferrer" title="Open the site front end" onClick=${(e) => e.stopPropagation()}>:${env.port}</a>
        ${up && html`<button class="env-admin lnk" title="One-click passwordless wp-admin login" onClick=${(e) => { e.stopPropagation(); onAction('admin-login', env); }}>admin ↗</button>`}
      </div>
      <div class="env-actions">
        ${building
          ? html`<span class="muted small">${env.status}…</span>
            <button class="lnk" onClick=${() => onAction('logs', env)}>logs</button>`
          : html`
            ${up && html`<button class="lnk" onClick=${() => onAction('session', env)}>+ session</button>`}
            ${up && html`<button class="lnk" onClick=${() => onAction('stop', env)}>stop</button>`}
            ${env.status === 'stopped' && html`<button class="lnk" onClick=${() => onAction('start', env)}>start</button>`}
            ${env.status === 'failed' && html`<button class="lnk" onClick=${() => onAction('start', env)}>retry</button>`}
            <button class="lnk" onClick=${() => onAction('logs', env)}>logs</button>
            <button class="lnk danger" onClick=${() => onAction('delete', env)}>delete</button>`}
      </div>
    </div>`;
}

function WorkingTag({ since, now }) {
  // Live "working Ns" while a turn is executing (since = turn start = lastActivityAt).
  const ms = (now || Date.now()) - Date.parse(since || '');
  return html`<span class="sess-time working" title="Claude is working right now">working ${fmtDur(ms)}</span>`;
}

function SessionItem({ s, selectedId, onSelect, onDelete, now }) {
  const running = s.status === 'running';
  return html`
    <div class=${`sess ${s.id === selectedId ? 'active' : ''}`} onClick=${() => onSelect(s.id)}>
      <div class="sess-top">
        <${StatusDot} status=${s.status} />
        <span class="sess-title">${s.title || s.id}</span>
        ${running
          ? html`<${WorkingTag} since=${s.lastActivityAt} now=${now} />`
          : html`<span class="sess-time" title=${`last active ${fullTime(s.lastActivityAt)}`}>${fmtAgo(s.lastActivityAt)}</span>`}
        <button class="sess-del lnk" title="Delete session" onClick=${(e) => { e.stopPropagation(); onDelete(s); }}>🗑</button>
      </div>
      <div class="sess-sub muted">started ${fmtAgo(s.createdAt, true)} · ${s.turnCount} turn${s.turnCount === 1 ? '' : 's'} · $${(s.costUsd || 0).toFixed(3)}</div>
    </div>`;
}

function Sidebar({ sessions, envs, selectedId, now, onSelect, onNewEnv, onEnvAction, onSettings, onHealth, onDeleteSession }) {
  const [expanded, setExpanded] = useState(() => new Set());
  const toggle = (id) => setExpanded((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  // The environment holding the selected session is always shown open, so a
  // freshly-created/selected session is visible without a manual expand.
  const selEnvId = (sessions.find((s) => s.id === selectedId) || {}).envId;

  return html`
    <aside class="sidebar">
      <div class="side-head">
        <strong>Devbox</strong>
        <div class="side-head-btns">
          <button class="btn small ghost" onClick=${onHealth} title="System health">📊</button>
          <button class="btn small ghost" onClick=${onSettings} title="Settings">⚙</button>
        </div>
      </div>
      <div class="side-section grow">
        <div class="section-head"><span>Environments</span><button class="btn small" onClick=${onNewEnv}>+ Env</button></div>
        <div class="side-list">
          ${envs.length === 0 && html`<div class="muted pad small">No environments — create one.</div>`}
          ${envs.map((e) => {
            const envSessions = sessions
              .filter((s) => s.envId === e.id)
              .sort((a, b) => String(b.lastActivityAt || '').localeCompare(String(a.lastActivityAt || '')));
            const open = expanded.has(e.id) || e.id === selEnvId;
            return html`
              <div class="env-group" key=${e.id}>
                <${EnvRow} env=${e} onAction=${onEnvAction} />
                <button class="sess-toggle" onClick=${() => toggle(e.id)}>
                  <span class="chev">${open ? '▾' : '▸'}</span>
                  ${envSessions.length} session${envSessions.length === 1 ? '' : 's'}
                </button>
                ${open && html`
                  <div class="env-sessions">
                    ${envSessions.length === 0 && html`<div class="muted pad small no-sess">No sessions yet.</div>`}
                    ${envSessions.map((s) => html`<${SessionItem} s=${s} key=${s.id} selectedId=${selectedId} now=${now} onSelect=${onSelect} onDelete=${onDeleteSession} />`)}
                  </div>`}
              </div>`;
          })}
        </div>
      </div>
    </aside>`;
}

function Bubble({ it }) {
  if (it.kind === 'user') return html`<div class="bubble user"><pre>${it.text}</pre></div>`;
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

function SessionView({ session, now, onChanged, onBack, onDelete }) {
  const [items, setItems] = useState([]);
  const [partial, setPartial] = useState('');
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState('');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const partialRef = useRef({ text: '' });
  const seen = useRef(new Set());
  const scroller = useRef(null);
  const stick = useRef(true); // follow the stream only while pinned near the bottom
  const [hasNew, setHasNew] = useState(false);
  const id = session.id;

  useEffect(() => {
    // Reset for the newly-selected session, load history, then go live.
    setItems([]); setPartial(''); partialRef.current = { text: '' }; seen.current = new Set();
    stick.current = true; setHasNew(false);
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

  // Auto-scroll only while pinned to the bottom. If the user scrolled up to read,
  // leave them there and just flag that new content arrived.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (stick.current) el.scrollTop = el.scrollHeight;
    else if (items.length || partial) setHasNew(true);
  }, [items, partial]);
  const onTranscriptScroll = () => {
    const el = scroller.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (stick.current && hasNew) setHasNew(false);
  };
  const jumpToBottom = () => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stick.current = true;
    setHasNew(false);
  };

  const running = busy || session.status === 'running';
  const send = useCallback(async () => {
    const prompt = input.trim();
    if (!prompt || running) return;
    setInput(''); setBusy(true);
    try { await api(`/sessions/${id}/messages`, { method: 'POST', body: JSON.stringify({ prompt }) }); onChanged && onChanged(); }
    catch (e) { setBusy(false); alert(`Send failed: ${e.message}`); }
  }, [input, running, id]);
  const interrupt = async () => { try { await api(`/sessions/${id}/interrupt`, { method: 'POST' }); } catch (e) { alert(e.message); } };
  const startEdit = () => { setDraft(session.title || ''); setEditing(true); };
  const saveTitle = async () => {
    const t = draft.replace(/\s+/g, ' ').trim();
    setEditing(false);
    if (!t || t === session.title) return;
    try { await api(`/sessions/${id}`, { method: 'PATCH', body: JSON.stringify({ title: t }) }); onChanged && onChanged(); }
    catch (e) { alert(`Rename failed: ${e.message}`); }
  };

  return html`
    <section class="main">
      <header class="bar">
        <div class="bar-title">
          <button class="back btn small ghost" onClick=${onBack} title="Back to list">‹</button>
          <${StatusDot} status=${session.status} />
          ${editing
            ? html`<input class="rename" value=${draft}
                ref=${(el) => { if (el && document.activeElement !== el) { el.focus(); el.select(); } }}
                onInput=${(e) => setDraft(e.target.value)}
                onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); saveTitle(); } else if (e.key === 'Escape') setEditing(false); }}
                onBlur=${saveTitle} />`
            : html`<strong title="Double-click to rename" onDblClick=${startEdit}>${session.title || id}</strong>
                <button class="lnk small" onClick=${startEdit} title="Rename">✎</button>
                <button class="lnk small danger" onClick=${onDelete} title="Delete session">🗑</button>`}
        </div>
        <div class="bar-meta muted">
          ${session.envName} · ${session.model || 'default model'} · $${(session.costUsd || 0).toFixed(4)}
          ${session.claudeSessionId && html`· <code title="claude session id">${session.claudeSessionId.slice(0, 8)}</code>`}
        </div>
        <div class="bar-meta muted" title=${`started ${fullTime(session.createdAt)}\nlast active ${fullTime(session.lastActivityAt)}`}>
          started ${fmtAgo(session.createdAt, true)} ·${' '}
          ${session.status === 'running'
            ? html`<${WorkingTag} since=${session.lastActivityAt} now=${now} />`
            : html`last active ${fmtAgo(session.lastActivityAt, true)}`}
        </div>
      </header>
      ${session.sshResumeHint && html`<div class="ssh muted" onClick=${() => navigator.clipboard?.writeText(session.sshResumeHint)} title="click to copy">SSH resume: <code>${session.sshResumeHint}</code></div>`}
      <div class="transcript" ref=${scroller} onScroll=${onTranscriptScroll}>
        ${items.map((it, i) => html`<${Bubble} it=${it} key=${i} />`)}
        ${partial && html`<div class="bubble assistant live"><pre>${partial}</pre><span class="cursor">▍</span></div>`}
        ${running && !partial && html`<div class="muted pad">…thinking</div>`}
      </div>
      ${hasNew && html`<button class="new-msgs" onClick=${jumpToBottom}>↓ New messages</button>`}
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
  const [prompt, setPrompt] = useState('');
  const [err, setErr] = useState('');
  const create = async () => {
    if (!envId || !prompt.trim()) return;
    try { await onCreate(envId, prompt.trim()); } catch (e) { setErr(e.message); }
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

function fmtDur(ms) {
  if (!ms || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60);
  return m ? `${m}m ${s % 60}s` : `${s}s`;
}

// Relative time. Compact ("3m","2h","3d","Jun 26") or long ("3m ago","on Jun 26").
function fmtAgo(iso, long = false) {
  const t = Date.parse(iso || '');
  if (isNaN(t)) return '';
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m${long ? ' ago' : ''}`;
  if (s < 86400) return `${Math.round(s / 3600)}h${long ? ' ago' : ''}`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)}d${long ? ' ago' : ''}`;
  const d = new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return long ? `on ${d}` : d;
}
// Full timestamp for hover/title.
function fullTime(iso) {
  const t = Date.parse(iso || '');
  return isNaN(t) ? '' : new Date(t).toLocaleString();
}

function LogViewer({ env, onClose }) {
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const box = useRef(null);
  const stick = useRef(true); // keep pinned to bottom unless the user scrolls up
  const lastChange = useRef({ text: null, at: Date.now() }); // when the log last grew

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const { setup } = await api(`/environments/${env.id}/logs?which=setup&tail=2000`);
        if (stop) return;
        const t = setup || '';
        if (t !== lastChange.current.text) { lastChange.current = { text: t, at: Date.now() }; setText(t); }
        setErr('');
      } catch (e) { if (!stop) setErr(e.message); }
    };
    tick();
    const t = setInterval(tick, 2000);
    return () => { stop = true; clearInterval(t); };
  }, [env.id]);

  // 1s ticker so the elapsed/idle counters stay live even when the log is quiet.
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  useEffect(() => { if (stick.current && box.current) box.current.scrollTop = box.current.scrollHeight; }, [text]);
  const onScroll = () => {
    const el = box.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const building = TRANSIENT_ENV.includes(env.status);
  const startedAt = Date.parse(env.setupStartedAt || env.createdAt || '') || now;
  const idle = now - lastChange.current.at;
  return html`
    <div class="modal-bg" onClick=${onClose}>
      <div class="modal wide logs" onClick=${(e) => e.stopPropagation()}>
        <h3><${StatusDot} status=${env.status} /> Setup log — ${env.name}
          <span class="muted small">${env.status}${building ? ` · ${fmtDur(now - startedAt)} elapsed` : ''}</span></h3>
        ${building && html`<div class="heartbeat muted small">
          <span class="pulse">●</span> live · last output ${fmtDur(idle)} ago${idle > 15000 ? ' — long step, still working…' : ''}</div>`}
        ${err && html`<div class="err-msg">${err}</div>`}
        ${env.lastError && html`<div class="err-msg">${env.lastError}</div>`}
        <pre class="logbox" ref=${box} onScroll=${onScroll}>${text || '(no output yet…)'}</pre>
        <div class="modal-foot">
          <button class="btn ghost" onClick=${onClose}>Close</button>
        </div>
      </div>
    </div>`;
}

function NewEnvModal({ presets, onClose, onCreate, onSavePreset, onDeletePreset }) {
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [presetIds, setPresetIds] = useState([]); // selected preset ids, in check order
  const [setupScript, setSetupScript] = useState('');
  const [devScript, setDevScript] = useState('');
  const [definesText, setDefinesText] = useState('');
  const [activateText, setActivateText] = useState('');
  const [presetName, setPresetName] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const togglePreset = (id) => setPresetIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  // Parse the custom fields into a provision object (applied on top of presets),
  // or throw a friendly error. Returns null when no custom fields are set.
  const buildCustom = () => {
    let defines = {};
    const dt = definesText.trim();
    if (dt) {
      let parsed;
      try { parsed = JSON.parse(dt); } catch { throw new Error('Defines must be valid JSON.'); }
      if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) throw new Error('Defines must be a JSON object of { "WP_CONST": value } pairs.');
      defines = parsed;
    }
    const activate = activateText.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    if (!setupScript.trim() && !devScript.trim() && !dt && !activate.length) return null;
    return { setupScript, devScript, defines, activate };
  };

  const create = async () => {
    setErr('');
    let provision;
    try { provision = buildCustom(); } catch (e) { setErr(e.message); return; }
    setBusy(true);
    try { await onCreate(name.trim() || undefined, provision || undefined, prompt.trim() || undefined, presetIds); }
    catch (e) { setErr(e.message); setBusy(false); }
  };
  const savePreset = async () => {
    setErr('');
    const nm = presetName.trim();
    if (!nm) { setErr('Enter a name to save the custom fields as a preset.'); return; }
    let custom;
    try { custom = buildCustom(); } catch (e) { setErr(e.message); return; }
    if (!custom) { setErr('Fill in at least one custom field to save as a preset.'); return; }
    try { await onSavePreset({ name: nm, ...custom }); setPresetName(''); }
    catch (e) { setErr(e.message); }
  };
  const deletePreset = async (id) => {
    const p = presets.find((x) => x.id === id);
    if (!p || !confirm(`Delete preset "${p.name}"?`)) return;
    try { await onDeletePreset(id); setPresetIds((prev) => prev.filter((x) => x !== id)); } catch (e) { setErr(e.message); }
  };

  return html`
    <div class="modal-bg" onClick=${onClose}>
      <div class="modal wide" onClick=${(e) => e.stopPropagation()}>
        <h3>New environment</h3>
        <p class="muted">Builds a fresh WordPress devbox (≈1 min). Compose one or more presets, and/or add custom provisioning below. Leave it all blank for a plain site.</p>
        <label>Name (optional)
          <input value=${name} placeholder="my-devbox (a-z, 0-9, -)" onInput=${(e) => setName(e.target.value)} />
        </label>
        <label>First prompt <span class="muted small">— optional; once the env is ready, a Claude session starts with this</span>
          <textarea rows="3" value=${prompt} placeholder="e.g. Add a custom field to the Oxygen builder and verify it renders." onInput=${(e) => setPrompt(e.target.value)}></textarea>
        </label>
        <label>Presets <span class="muted small">— compose any number; applied in the order you check them</span></label>
        <div class="preset-list">
          ${presets.length === 0 && html`<div class="muted small pad">No saved presets yet.</div>`}
          ${presets.map((p) => html`
            <div class="preset-item" key=${p.id}>
              <label class="preset-check">
                <input type="checkbox" checked=${presetIds.includes(p.id)} onChange=${() => togglePreset(p.id)} />
                <span class="preset-name">${p.name}</span>
                ${p.description && html`<span class="muted small">${p.description}</span>`}
              </label>
              <button class="lnk danger small" title="Delete preset" onClick=${() => deletePreset(p.id)}>✕</button>
            </div>`)}
        </div>
        <details class="custom-prov">
          <summary>Custom provisioning (optional, applied after presets)</summary>
          <label>Setup script <span class="muted small">— runs once in the workspace as <code>node</code> (cwd /home/node, WordPress at ./wp)</span>
            <textarea class="mono" rows="5" value=${setupScript} placeholder=${'#!/usr/bin/env bash\nset -euo pipefail\ncd /home/node\ngh repo clone owner/repo\n…'} onInput=${(e) => setSetupScript(e.target.value)}></textarea>
          </label>
          <label>Dev script <span class="muted small">— long-running; runs in the <code>dev</code> container for as long as the stack is up</span>
            <textarea class="mono" rows="3" value=${devScript} placeholder=${'#!/usr/bin/env bash\ncd /home/node/breakdance\nnpm run dev:codespace'} onInput=${(e) => setDevScript(e.target.value)}></textarea>
          </label>
          <label>wp-config defines <span class="muted small">— JSON object; booleans/numbers become raw PHP literals</span>
            <textarea class="mono" rows="3" value=${definesText} placeholder=${'{\n  "WP_DEBUG": true,\n  "WP_MEMORY_LIMIT": "512M"\n}'} onInput=${(e) => setDefinesText(e.target.value)}></textarea>
          </label>
          <label>Activate plugins <span class="muted small">— slugs, in order, comma-separated</span>
            <input value=${activateText} placeholder="oxygen-elements, breakdance-elements" onInput=${(e) => setActivateText(e.target.value)} />
          </label>
          <div class="row save-preset">
            <input value=${presetName} placeholder="Save these custom fields as a preset named…" onInput=${(e) => setPresetName(e.target.value)} />
            <button class="btn small ghost" onClick=${savePreset} disabled=${!presetName.trim()}>Save preset</button>
          </div>
        </details>
        ${err && html`<div class="err-msg">${err}</div>`}
        <div class="modal-foot">
          <button class="btn ghost" onClick=${onClose}>Cancel</button>
          <button class="btn" onClick=${create} disabled=${busy}>${busy ? 'Creating…' : 'Create'}</button>
        </div>
      </div>
    </div>`;
}

function SettingsModal({ onClose, onLogout }) {
  const [s, setS] = useState(null);
  const [ghToken, setGh] = useState('');
  const [clToken, setCl] = useState('');
  const [wpUser, setWpUser] = useState('');
  const [wpEmail, setWpEmail] = useState('');
  const [wpPass, setWpPass] = useState('');
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try { const d = await api('/settings'); setS(d); setWpUser(d.wpAdminUser || ''); setWpEmail(d.wpAdminEmail || ''); }
      catch (e) { setErr(e.message); }
    })();
  }, []);

  const hint = (f) => (s && s[f] && s[f].set ? `configured ${s[f].hint} · leave blank to keep` : 'not set');
  const save = async () => {
    setBusy(true); setErr(''); setSaved(false);
    try {
      const body = { wpAdminUser: wpUser, wpAdminEmail: wpEmail };
      if (ghToken) body.githubToken = ghToken;
      if (clToken) body.claudeToken = clToken;
      if (wpPass) body.wpAdminPassword = wpPass;
      const d = await api('/settings', { method: 'PUT', body: JSON.stringify(body) });
      setS(d); setGh(''); setCl(''); setWpPass(''); setSaved(true);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  return html`
    <div class="modal-bg" onClick=${onClose}>
      <div class="modal" onClick=${(e) => e.stopPropagation()}>
        <h3>Settings</h3>
        ${!s && !err && html`<div class="muted">Loading…</div>`}
        ${s && html`
          <p class="muted small">Saved on the server (<code>data/settings.json</code>). Tokens are write-only — set or replace them here; they're never shown back.</p>
          <label>GitHub token <span class="muted small">— ${hint('githubToken')}</span>
            <input type="password" value=${ghToken} placeholder="ghp_… / github_pat_…" onInput=${(e) => setGh(e.target.value)} />
          </label>
          <label>Claude token <span class="muted small">— ${hint('claudeToken')}</span>
            <input type="password" value=${clToken} placeholder="sk-ant-oat… (from claude setup-token)" onInput=${(e) => setCl(e.target.value)} />
          </label>
          <label>WordPress admin username
            <input value=${wpUser} onInput=${(e) => setWpUser(e.target.value)} />
          </label>
          <label>WordPress admin password <span class="muted small">— ${hint('wpAdminPassword')}</span>
            <input type="password" value=${wpPass} placeholder="leave blank to keep" onInput=${(e) => setWpPass(e.target.value)} />
          </label>
          <label>WordPress admin email
            <input value=${wpEmail} onInput=${(e) => setWpEmail(e.target.value)} />
          </label>
          <p class="muted small">Token changes apply to newly-created environments and new Claude turns. WP-admin defaults seed new sites.</p>`}
        ${err && html`<div class="err-msg">${err}</div>`}
        ${saved && html`<div class="ok-msg">Saved.</div>`}
        <div class="modal-foot">
          <button class="lnk" onClick=${onLogout} title="Forget the API token on this device">Log out</button>
          <span class="spacer"></span>
          <button class="btn ghost" onClick=${onClose}>Close</button>
          <button class="btn" onClick=${save} disabled=${!s || busy}>${busy ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>`;
}

function HealthBar({ pct, tone }) {
  const w = Math.min(100, Math.max(0, Math.round(pct || 0)));
  return html`<div class="hbar"><div class=${`hbar-fill ${tone}`} style=${`width:${w}%`}></div></div>`;
}

function HealthModal({ onClose }) {
  const [h, setH] = useState(null);
  const [err, setErr] = useState('');
  const [ctrlMsg, setCtrlMsg] = useState('');
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try { const d = await api('/host'); if (!stop) { setH(d); setErr(''); } }
      catch (e) { if (!stop) setErr(e.message); }
    };
    tick();
    const t = setInterval(tick, 5000); // docker stats is ~2s; poll gently
    return () => { stop = true; clearInterval(t); };
  }, []);

  const gb = (b) => (b == null ? '—' : `${(b / 1024 ** 3).toFixed(b < 10 * 1024 ** 3 ? 1 : 0)} GB`);
  const tone = (v, warn, bad) => (v >= bad ? 'bad' : v >= warn ? 'warn' : 'ok');
  const dfRow = (t) => (h && h.docker.df ? h.docker.df.find((r) => r.Type === t) : null);
  const m = h && h.memory, c = h && h.cpu, dsk = h && h.disk, est = h && h.estimate;
  const load1 = c ? c.loadavg[0] : 0;

  const interruptAll = async () => {
    if (!confirm('Interrupt ALL running Claude turns now? (Environments stay up.)')) return;
    try { const r = await api('/control/interrupt-all', { method: 'POST' }); setCtrlMsg(`Interrupted ${r.interrupted} session(s).`); }
    catch (e) { setCtrlMsg(`Failed: ${e.message}`); }
  };
  const stopAll = async () => {
    if (!confirm('Stop ALL environments (containers down)? Running Claude turns are interrupted too.')) return;
    setCtrlMsg('Stopping all environments…');
    try { const r = await api('/control/stop-all', { method: 'POST' }); setCtrlMsg(`Stopped ${r.stopped.length} environment(s).`); }
    catch (e) { setCtrlMsg(`Failed: ${e.message}`); }
  };
  const shutdown = async () => {
    if (!confirm('Shut down EVERYTHING — interrupt Claude, stop all containers, and exit the server process? You will have to restart it from the terminal.')) return;
    setCtrlMsg('Shutting down — stopping all environments and exiting the server…');
    try { await api('/control/shutdown', { method: 'POST' }); } catch { /* the server is exiting; the request may not return */ }
  };

  return html`
    <div class="modal-bg" onClick=${onClose}>
      <div class="modal wide health" onClick=${(e) => e.stopPropagation()}>
        <h3>System health</h3>
        ${err && html`<div class="err-msg">${err}</div>`}
        ${!h && !err && html`<div class="muted">Loading… (gathering docker stats, ~2s)</div>`}
        ${h && html`
          <div class="hrow">
            <span class="hlabel">Memory</span>
            <${HealthBar} pct=${m.usedPct} tone=${tone(m.usedPct, 75, 90)} />
            <span class="hval">${gb(m.usedBytes)} used · <b>${gb(m.availableBytes)} free</b> of ${gb(m.totalBytes)}${m.swapTotalBytes ? '' : ' · no swap'}</span>
          </div>
          <div class="hrow">
            <span class="hlabel">CPU load</span>
            <${HealthBar} pct=${(load1 / c.cores) * 100} tone=${tone(load1 / c.cores, 0.7, 1)} />
            <span class="hval">${load1.toFixed(2)} (1m) of ${c.cores} cores · ${c.loadavg.map((x) => x.toFixed(2)).join(' / ')}</span>
          </div>
          ${dsk && html`<div class="hrow">
            <span class="hlabel">Disk</span>
            <${HealthBar} pct=${dsk.usedPct} tone=${tone(dsk.usedPct, 75, 90)} />
            <span class="hval">${gb(dsk.usedBytes)} used · <b>${gb(dsk.availBytes)} free</b> of ${gb(dsk.totalBytes)}</span>
          </div>`}
          <div class="hrow">
            <span class="hlabel">Docker</span>
            <span class="hval wide-val">${h.docker.containersRunning}/${h.docker.containersTotal} containers${dfRow('Images') ? ` · images ${dfRow('Images').Size}` : ''}${dfRow('Build Cache') ? html` · build cache ${dfRow('Build Cache').Size} <span class="muted">(${dfRow('Build Cache').Reclaimable} reclaimable — run docker system prune)</span>` : ''}</span>
          </div>
          <div class=${`health-callout ${est.ramHeadroomEnvs != null && est.ramHeadroomEnvs <= 1 ? 'bad' : ''}`}>
            ${est.ramHeadroomEnvs != null
              ? html`Room for ≈ <b>${est.ramHeadroomEnvs}</b> more environment${est.ramHeadroomEnvs === 1 ? '' : 's'} in RAM — avg <b>${gb(est.avgEnvMemBytes)}</b>/env, ${h.environments.running} running.${m.swapTotalBytes ? '' : ' No swap: when free RAM hits zero the box starts OOM-killing processes, so keep headroom.'}`
              : html`${h.environments.running} environments running.`}
          </div>
          <div class="muted small">Environments: ${h.environments.running} running · ${h.environments.count} total · cap ${h.environments.max}</div>
          ${h.perEnv.length > 0 && html`
            <table class="health-table">
              <thead><tr><th>Environment</th><th>Status</th><th>Containers</th><th>Memory</th></tr></thead>
              <tbody>
                ${h.perEnv.map((e) => html`<tr key=${e.name}>
                  <td>${e.name}</td>
                  <td><${StatusDot} status=${e.status} /> ${e.status}</td>
                  <td>${e.containers}</td>
                  <td>${gb(e.memBytes)}</td>
                </tr>`)}
              </tbody>
            </table>`}
        `}
        <div class="health-controls">
          <div class="section-head"><span>Controls</span></div>
          <div class="ctrl-row">
            <button class="btn small ghost" onClick=${interruptAll}>Interrupt all sessions</button>
            <button class="btn small warn" onClick=${stopAll}>Stop all environments</button>
            <button class="btn small danger-btn" onClick=${shutdown}>Shut down server</button>
          </div>
          ${ctrlMsg && html`<div class="muted small ctrl-msg">${ctrlMsg}</div>`}
        </div>
        <div class="modal-foot"><button class="btn ghost" onClick=${onClose}>Close</button></div>
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
  const [presets, setPresets] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [newSession, setNewSession] = useState(null); // null | { preselect? }
  const [showNewEnv, setShowNewEnv] = useState(false);
  const [logEnvId, setLogEnvId] = useState(null);
  const [needToken, setNeedToken] = useState(false);
  const [authed, setAuthed] = useState(!!token.get());
  const [showSettings, setShowSettings] = useState(false);
  const [showHealth, setShowHealth] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    try {
      const [s, e, p] = await Promise.all([api('/sessions'), api('/environments'), api('/presets')]);
      setSessions(s.sessions); setEnvs(e.environments); setPresets(p.presets); setNeedToken(false);
    } catch (err) { if (err.status === 401) setNeedToken(true); }
  }, []);

  useEffect(() => { if (authed) { refresh(); const t = setInterval(refresh, 3000); return () => clearInterval(t); } }, [authed, refresh]);

  // Tick once a second ONLY while a session is actively running, so the live
  // "working Ns" counters advance smoothly without re-rendering when idle.
  useEffect(() => {
    if (!sessions.some((s) => s.status === 'running')) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [sessions]);

  if (needToken || !authed) return html`<${TokenGate} onSave=${() => { setAuthed(true); setNeedToken(false); refresh(); }} />`;

  const selected = sessions.find((s) => s.id === selectedId);
  const logEnv = envs.find((e) => e.id === logEnvId);

  const createSession = async (envId, prompt, model) => {
    const s = await api(`/environments/${envId}/sessions`, { method: 'POST', body: JSON.stringify({ prompt, model }) });
    setNewSession(null); await refresh(); setSelectedId(s.id);
  };
  const createEnv = async (name, provision, prompt, presetIds) => {
    await api('/environments', { method: 'POST', body: JSON.stringify({ name, provision, prompt, presetIds }) });
    setShowNewEnv(false); refresh();
  };
  const savePreset = async (preset) => {
    const p = await api('/presets', { method: 'POST', body: JSON.stringify(preset) });
    await refresh();
    return p;
  };
  const deletePreset = async (id) => {
    await api(`/presets/${id}`, { method: 'DELETE' });
    await refresh();
  };
  const deleteSession = async (s) => {
    if (!confirm(`Delete session "${s.title || s.id}"? This removes its transcript.`)) return;
    try {
      await api(`/sessions/${s.id}`, { method: 'DELETE' });
      if (selectedId === s.id) setSelectedId(null);
      await refresh();
    } catch (e) { alert(`Delete failed: ${e.message}`); }
  };
  const envAction = async (action, env) => {
    if (action === 'admin-login') {
      // Open the tab synchronously (in the click gesture) so popup blockers allow
      // it, paint a loading page so it isn't a blank flash, then redirect it to
      // the minted, host-rebased login URL. The API token stays in the POST
      // header — it never appears in any URL.
      const w = window.open('', '_blank');
      if (w) w.document.write(`<!doctype html><meta charset="utf-8"><title>Logging in…</title>`
        + `<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;`
        + `background:#0f1115;color:#8b91a3;font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">`
        + `Logging into ${env.name} wp-admin…</body>`);
      try {
        const { loginUrl } = await api(`/environments/${env.id}/admin-login`, { method: 'POST' });
        const u = new URL(loginUrl);
        const dest = `${location.protocol}//${location.hostname}:${env.port}/?${u.searchParams.toString()}`;
        if (w) w.location = dest; else window.open(dest, '_blank', 'noopener');
      } catch (e) { if (w) w.close(); alert(`Admin login failed: ${e.message}`); }
      return;
    }
    try {
      if (action === 'logs') return setLogEnvId(env.id);
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
    <div class=${`layout ${selected ? 'has-selection' : ''}`}>
      <${Sidebar} sessions=${sessions} envs=${envs} selectedId=${selectedId} now=${now}
        onSelect=${setSelectedId} onNewEnv=${() => setShowNewEnv(true)}
        onEnvAction=${envAction} onSettings=${() => setShowSettings(true)} onHealth=${() => setShowHealth(true)} onDeleteSession=${deleteSession} />
      ${selected
        ? html`<${SessionView} session=${selected} key=${selected.id} now=${now} onChanged=${refresh} onBack=${() => setSelectedId(null)} onDelete=${() => deleteSession(selected)} />`
        : html`<section class="main empty"><div class="muted">
            ${envs.length === 0
              ? html`No environments yet. <button class="btn" onClick=${() => setShowNewEnv(true)}>Create an environment</button> to begin.`
              : html`Select a session, or <button class="btn" onClick=${() => setNewSession({})}>start a new one</button>.`}
          </div></section>`}
      ${newSession && html`<${NewSessionModal} envs=${envs} preselect=${newSession.preselect} onClose=${() => setNewSession(null)} onCreate=${createSession} />`}
      ${showNewEnv && html`<${NewEnvModal} presets=${presets} onClose=${() => setShowNewEnv(false)} onCreate=${createEnv} onSavePreset=${savePreset} onDeletePreset=${deletePreset} />`}
      ${logEnvId && logEnv && html`<${LogViewer} env=${logEnv} onClose=${() => setLogEnvId(null)} />`}
      ${showSettings && html`<${SettingsModal} onClose=${() => setShowSettings(false)}
        onLogout=${() => { token.set(''); setShowSettings(false); setAuthed(false); setNeedToken(true); }} />`}
      ${showHealth && html`<${HealthModal} onClose=${() => setShowHealth(false)} />`}
    </div>`;
}

render(html`<${App} />`, document.getElementById('root'));
