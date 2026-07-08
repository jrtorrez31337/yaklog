(() => {
  // ────────────────────────────────────────────────────────────────────
  // Existing presence-table state (unchanged from v0.5.7).
  // ────────────────────────────────────────────────────────────────────
  const POLL_MS = 2000;
  const MAX_BACKOFF_MS = 16000;
  const STALE_AFTER_MS = 60000;
  const OLD_AFTER_MS = 600000;
  let lastEtag = null;
  let lastData = null;
  let sort = { key: 'last_heartbeat_at', dir: 'desc' };
  let backoff = POLL_MS;
  let pollTimer = null;

  const COLUMN_LABELS = {
    agent_id: 'agent_id', label: 'label', current_tool: 'tool',
    subagent_active_count: 'subs', last_heartbeat_at: 'last heartbeat',
    cursor_position: 'cursor',
  };

  function shortenModel(m) { if (!m) return ''; return m.replace(/^claude-/, ''); }

  const $ = (id) => document.getElementById(id);
  $('origin').textContent = location.host;

  // CP10.5.3 (2026-06-03): SQLite returns `created_at` etc. as
  // "YYYY-MM-DD HH:MM:SS" (no T, no Z) which browsers parse as LOCAL time.
  // For UTC-stored timestamps viewed from west-of-UTC browsers, the parsed
  // local time shifts INTO THE FUTURE → Date.now()-parsed = NEGATIVE age
  // (Jon-flagged: "the time is wrong, it's a negative number"). Normalize
  // to ISO-Z so Date() parses as UTC.
  function _parseUtcIso(iso) {
    if (!iso) return null;
    return new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  }
  // Jon-direct 2026-06-15: SI-suffix Y-axis values formatter for rate charts.
  // Fixes left-margin truncation where values >99,999 (7+ chars with commas
  // like "150,000") exceeded uPlot's default left-axis width. SI suffixes
  // collapse the longest-magnitude labels to 3-4 chars (150k, 1.5M, 1.2B)
  // without losing readability; preserves bare integers for small values.
  function siAxisValues(self, vals) {
    return vals.map((v) => {
      if (v == null) return '';
      const abs = Math.abs(v);
      if (abs >= 1e9) return (v / 1e9).toFixed(abs >= 1e10 ? 0 : 1) + 'B';
      if (abs >= 1e6) return (v / 1e6).toFixed(abs >= 1e7 ? 0 : 1) + 'M';
      if (abs >= 1e3) return (v / 1e3).toFixed(abs >= 1e4 ? 0 : 1) + 'k';
      if (abs > 0 && abs < 1) return v.toFixed(2);
      return String(v);
    });
  }
  function fmtAge(iso) {
    if (!iso) return '—';
    const ts = _parseUtcIso(iso);
    if (!ts || Number.isNaN(ts.getTime())) return iso;
    let ms = Date.now() - ts.getTime();
    // Defend against clock-skew / server-side future timestamps: clamp at 0
    // instead of rendering a negative.
    if (ms < 0) ms = 0;
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + 's ago';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + (s % 60) + 's ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h ' + (m % 60) + 'm ago';
    const d = Math.floor(h / 24);
    return d + 'd ' + (h % 24) + 'h ago';
  }
  function ageClass(iso) {
    if (!iso) return 'old';
    const ts = _parseUtcIso(iso);
    if (!ts || Number.isNaN(ts.getTime())) return 'old';
    const ms = Math.max(0, Date.now() - ts.getTime());
    if (ms < STALE_AFTER_MS) return 'recent';
    if (ms < OLD_AFTER_MS) return 'stale';
    return 'old';
  }
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k === 'class') node.className = v;
      else if (k === 'title') node.setAttribute('title', v);
      else node.setAttribute(k, v);
    }
    for (const c of children) {
      if (c == null) continue;
      if (typeof c === 'string') node.appendChild(document.createTextNode(c));
      else node.appendChild(c);
    }
    return node;
  }
  function clearChildren(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  // DOM-XSS-safe error rendering — text via createTextNode (el()), NOT innerHTML.
  // Per secops #11877 completeness finding: use for every catch-branch that
  // wants to display an error message. Prevents the copy-paste class from
  // re-emerging.
  function renderError(container, cls, text) {
    clearChildren(container);
    container.appendChild(el('div', { class: cls }, text));
  }

  // CP6.3: makeRow + thead-click handler retired with the presence table.
  // Presence data now feeds AgentCard grid via render() → renderCards().
  // _UNUSED_ — kept as deadcode reference for v0.5.7-era tooling that
  // looked for the table; safe to delete in a later commit. Compiler-
  // unused; kept as comment only.
  function _retired_makeRow(r) {
    const labelStr = r.label || '';
    const tr = el('tr', { class: 'label-' + labelStr });
    // CP3 + CP4 a11y: agent cell is a popover trigger; keyboard-focusable.
    const agentCell = el('td', { class: 'agent' });
    if (r.agent_id) {
      const trigger = el('span', {
        class: 'agent-clickable',
        'data-agent-id': r.agent_id,
        title: 'click for identity + runtime details',
        tabindex: '0',
        role: 'button',
        'aria-label': `${r.agent_id} — open identity card`,
      }, r.agent_id);
      agentCell.appendChild(trigger);
      // 2026-05-25: OTel-status pill — shows whether this agent has pushed
      // OTel data recently (= restarted CC since Path A install).
      const otel = agentOtelStatus(r.agent_id);
      if (otel) {
        const cls = 'otel-pill ' + otel.kind;
        const tip = otel.kind === 'live'
          ? `Plexus OTel data observed ${Math.floor(otel.ageS)}s ago — agent has restarted CC since Path A install`
          : `Plexus OTel data observed but stale (${Math.floor(otel.ageS/60)}m ago) — was emitting but quiet now`;
        agentCell.appendChild(el('span', { class: cls, title: tip }, otel.kind === 'live' ? 'OTel' : 'OTel quiet'));
      }
      // v0.5.7.2: Monitor-dead pill. Shown when events_consumer_count===0
      // (= no process is tailing this agent's events.ndjson stream). This
      // is the original v0.5.6 daemon_only signal, now surfaced as a
      // separate pill rather than overriding session_state in the label
      // column. Common cause: CC's tail|jq Monitor subprocess died (often
      // post rate-limit class wedge).
      if (r.events_consumer_count === 0 && r.daemon_state === 'up') {
        agentCell.appendChild(el('span', {
          class: 'mon-pill',
          title: 'events.ndjson Monitor subprocess is dead (events_consumer_count=0). Agent will MISS live @-mentions until the Monitor restarts. Session_state still reflects hook activity correctly.',
        }, 'Monitor dead'));
      }
    }
    tr.appendChild(agentCell);
    // 2026-05-25 dedup pass: daemon + session + model columns removed
    // (label encodes daemon×session derivation; model lives in popover +
    // chart legends). Click an agent name for the raw breakdown.
    const labelTd = el('td', {
      class: 'label-cell',
      title: `daemon=${r.daemon_state || '?'}, session=${r.session_state || '?'}, model=${shortenModel(r.current_model) || '?'}`,
    });
    labelTd.appendChild(el('span', { class: 'badge' }, labelStr));
    tr.appendChild(labelTd);
    // v0.5.7.1 (2026-05-25): when session_state=tool_running but current_tool
    // is missing (CC 2.1.144 hooks fire with empty stdin in production, so
    // tool_name never reaches the daemon), show "(running)" rather than
    // falling back to a stale last_tool_name from sessions ago. Also prefix
    // historical names with "last:" so operators can tell at a glance.
    const toolTd = el('td', { class: 'tool' });
    const inFlight = (r.session_state === 'tool_running');
    if (r.current_tool) {
      toolTd.classList.add('has-value');
      toolTd.appendChild(el('span', { class: 'pill', title: 'currently running' }, r.current_tool));
    } else if (inFlight) {
      toolTd.classList.add('has-value');
      toolTd.setAttribute('title', 'session_state=tool_running but CC did not deliver tool_name on hook stdin (CC 2.1.144 behavior)');
      const pill = el('span', { class: 'pill' }, '(running)');
      pill.style.opacity = '0.6';
      toolTd.appendChild(pill);
    } else if (r.last_tool_name) {
      toolTd.classList.add('has-value');
      if (r.last_tool_status === 'error') toolTd.classList.add('error');
      toolTd.setAttribute('title', `last tool (${r.last_tool_status || '?'})`);
      toolTd.appendChild(document.createTextNode('last: ' + r.last_tool_name));
    } else {
      toolTd.appendChild(document.createTextNode('—'));
    }
    tr.appendChild(toolTd);
    const subN = r.subagent_active_count;
    const subTd = el('td', {
      class: 'subagents' + (subN > 0 ? ' active' : ''),
      style: 'text-align: right;',
      title: subN == null ? 'pre-v0.5.7 daemon' : `${subN} active subagent dispatch(es)`,
    }, subN == null || subN === 0 ? '—' : String(subN));
    tr.appendChild(subTd);
    // 2026-05-25 dedup: last_hook_at column dropped (popover has it; heartbeat
    // tracks the same recency at finer cadence). Tooltip on heartbeat surfaces
    // both timestamps for quick comparison without a popover open.
    tr.appendChild(el('td', {
      class: 'ts ' + ageClass(r.last_heartbeat_at),
      title: `heartbeat=${r.last_heartbeat_at || '—'}\nlast hook=${r.last_hook_at || '—'}`,
    }, fmtAge(r.last_heartbeat_at)));
    tr.appendChild(el('td', { class: 'cursor' },
      r.cursor_position == null ? '—' : String(r.cursor_position)));
    return tr;
  }

  function render(payload) {
    const hwmNode = $('hwm');
    if (hwmNode && payload.global_hwm != null) {
      hwmNode.textContent = 'global HWM: ' + payload.global_hwm;
    }
    const rows = payload.presence.slice();
    const dir = sort.dir === 'desc' ? -1 : 1;
    rows.sort((a, b) => {
      const av = a[sort.key]; const bv = b[sort.key];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });

    const counts = { online: 0, stalled: 0, offline: 0, daemon_only: 0, stop_failure: 0 };
    // F4 (parch #8743 + Jon-direct major-bug 2026-06-14): mirror the
    // stale-idle visual decay threshold so the count agrees with the card
    // visuals. Stale-idle cards (online_idle + last_hook > 30min) count
    // toward stalled, matching Jon's UX expectation that rate-limited CC
    // sessions surface in the stalled counter.
    const STALE_IDLE_THRESHOLD_MS = 30 * 60 * 1000;
    for (const r of payload.presence) {
      const staleIdle = r.label === 'online_idle' && r.last_hook_at
        && (Date.now() - new Date(r.last_hook_at).getTime()) > STALE_IDLE_THRESHOLD_MS;
      if (r.label === 'stop_failure' || r.session_state === 'stop_failure') counts.stop_failure++;
      else if (staleIdle) counts.stalled++;
      else if (r.label && r.label.startsWith('online')) counts.online++;
      else if (r.label === 'daemon_only') counts.daemon_only++;
      else if (r.label === 'stalled' || r.label === 'unknown') counts.stalled++;
      else if (r.label === 'offline') counts.offline++;
    }
    const countsNode = $('counts'); clearChildren(countsNode);
    countsNode.appendChild(el('span', { class: 'count online' }, counts.online + ' online'));
    if (counts.daemon_only > 0) countsNode.appendChild(el('span', { class: 'count daemon_only' }, counts.daemon_only + ' daemon_only'));
    countsNode.appendChild(el('span', { class: 'count stalled' }, counts.stalled + ' stalled'));
    if (counts.stop_failure > 0) countsNode.appendChild(el('span', { class: 'count offline', title: 'sessions terminated by API/rate-limit error (v0.5.7)' }, counts.stop_failure + ' stop_failure'));
    countsNode.appendChild(el('span', { class: 'count offline' }, counts.offline + ' offline'));

    // CP6.3: feed cards instead of a table.
    renderCards(rows);
  }

  function setStatus(state, text) {
    $('pulse').className = 'pulse' + (state === 'ok' ? '' : ' ' + state);
    $('status-text').textContent = text;
  }
  function setBanner(msg) {
    const b = $('banner');
    if (msg) { b.textContent = msg; b.classList.add('visible'); }
    else { b.classList.remove('visible'); b.textContent = ''; }
  }

  async function poll() {
    try {
      const headers = lastEtag ? { 'If-None-Match': lastEtag } : {};
      const res = await fetch('/api/v1/presence/public', { headers, cache: 'no-store' });
      if (res.status === 304) {
        if (lastData) render(lastData);
        $('last-update').textContent = 'updated ' + new Date().toLocaleTimeString();
        setStatus('ok', 'live'); setBanner(null);
      } else if (res.ok) {
        lastEtag = res.headers.get('ETag');
        lastData = await res.json();
        render(lastData);
        $('last-update').textContent = 'updated ' + new Date().toLocaleTimeString();
        setStatus('ok', 'live'); setBanner(null);
      } else {
        throw new Error('HTTP ' + res.status);
      }
      backoff = POLL_MS;
    } catch (e) {
      setStatus('error', 'unreachable');
      setBanner('Plexus server unreachable: ' + e.message + ' — retry in ' + (backoff / 1000) + 's');
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
    pollTimer = setTimeout(poll, backoff);
  }

  // CP6.3: 1s ticker re-renders cards so "last hook age" / freshness
  // counters tick without a server roundtrip.
  setInterval(() => { if (lastData) renderCards(lastData.presence); }, 1000);

  // ────────────────────────────────────────────────────────────────────
  // Task #264 v1 (Jon-direct 2026-07-01): dashboard-tier time-range picker.
  // Preset-only MVP per canon-N1-light forward-track discipline.
  // Modes: live (auto-refresh; SSE flows) OR one of {1h, 24h, 7d, 30d}
  // (static view; poll-loops honor isLiveMode() to skip refresh).
  // URL persistence: `#<tab>?range=<preset>` shape (OQ4 parch RATIFY v1).
  // Operate tab pinned-Live (OQ3 defensible-default) — picker auto-clamps.
  // Per-view read integration is per-tab / per-view work; v1 lands infra
  // (state + isLiveMode gate + URL persistence + Operate clamp + picker UX).
  // ────────────────────────────────────────────────────────────────────
  const TRP_PRESETS = ['live', '1h', '24h', '7d', '30d'];
  const TRP_PRESET_MS = {
    '1h':  3600_000,
    '24h': 24 * 3600_000,
    '7d':  7 * 24 * 3600_000,
    '30d': 30 * 24 * 3600_000,
  };
  const TRP_OPERATE_LIVE_ONLY = true;  // OQ3 defensible-default (Operate pinned-Live)

  // Global state readable by any view; write via _trpSetPreset() only.
  window.dashboardTimeRange = { preset: 'live' };
  function isLiveMode() {
    return !window.dashboardTimeRange || window.dashboardTimeRange.preset === 'live';
  }
  // Returns null in live mode (view-native default); else {fromMs, toMs, windowS}.
  function getTimeWindow() {
    const preset = window.dashboardTimeRange?.preset;
    if (!preset || preset === 'live') return null;
    const span = TRP_PRESET_MS[preset];
    if (!span) return null;
    const to = Date.now();
    return { fromMs: to - span, toMs: to, windowS: Math.floor(span / 1000), preset };
  }
  // Expose to any downstream consumer.
  window.isDashboardLive = isLiveMode;
  window.getDashboardTimeWindow = getTimeWindow;

  // Parse "tab?range=preset" hash into { tab, range }
  function _trpParseHash(hash) {
    const s = String(hash || '').replace(/^#/, '');
    const qIdx = s.indexOf('?');
    const tab = (qIdx >= 0 ? s.slice(0, qIdx) : s) || 'live';
    let range = 'live';
    if (qIdx >= 0) {
      const qs = new URLSearchParams(s.slice(qIdx + 1));
      const r = qs.get('range');
      if (r && TRP_PRESETS.includes(r)) range = r;
    }
    return { tab, range };
  }
  function _trpBuildHash(tab, range) {
    const t = tab || 'live';
    if (!range || range === 'live') return '#' + t;
    return '#' + t + '?range=' + range;
  }

  function _trpUpdateButtons() {
    const preset = window.dashboardTimeRange.preset;
    document.querySelectorAll('#time-range-picker .trp-btn').forEach((b) => {
      const isActive = b.dataset.range === preset;
      b.classList.toggle('active', isActive);
      b.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
    const pill = document.getElementById('trp-static-pill');
    if (pill) pill.hidden = (preset === 'live');
  }
  function _trpUpdateOperateClamp(currentTab) {
    // OQ3: Operate tab pinned-Live. When Operate active, grey the non-live buttons
    // + auto-clamp back to live if operator navigates to Operate on a non-live picker.
    const isOperate = currentTab === 'operate';
    document.querySelectorAll('#time-range-picker .trp-btn').forEach((b) => {
      if (isOperate && TRP_OPERATE_LIVE_ONLY && b.dataset.range !== 'live') {
        b.classList.add('disabled');
        b.setAttribute('aria-disabled', 'true');
      } else {
        b.classList.remove('disabled');
        b.removeAttribute('aria-disabled');
      }
    });
    if (isOperate && TRP_OPERATE_LIVE_ONLY && !isLiveMode()) {
      // silent clamp — no chrome flash for the operator
      _trpSetPreset('live', { updateHash: true, quiet: true });
    }
  }
  function _trpSetPreset(preset, opts) {
    if (!TRP_PRESETS.includes(preset)) preset = 'live';
    window.dashboardTimeRange.preset = preset;
    _trpUpdateButtons();
    // Sync URL hash with current active tab + new preset
    if (opts && opts.updateHash) {
      const activeTab = document.querySelector('.tab-btn.active');
      const tabName = activeTab ? activeTab.dataset.tab : (location.hash.slice(1).split('?')[0] || 'live');
      const newHash = _trpBuildHash(tabName, preset);
      if (location.hash !== newHash) {
        history.replaceState(null, '', newHash);
      }
    }
    // Broadcast to any listeners (view render fns can subscribe via
    // `document.addEventListener('dashboardTimeRangeChange', ...)`).
    if (!(opts && opts.quiet)) {
      document.dispatchEvent(new CustomEvent('dashboardTimeRangeChange', {
        detail: { preset, window: getTimeWindow() },
      }));
    }
  }
  function _trpWireHandlers() {
    document.querySelectorAll('#time-range-picker .trp-btn').forEach((b) => {
      b.addEventListener('click', () => {
        if (b.classList.contains('disabled')) return;
        const r = b.dataset.range;
        if (r === window.dashboardTimeRange.preset) return;  // no-op
        _trpSetPreset(r, { updateHash: true });
      });
      b.addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !b.classList.contains('disabled')) {
          e.preventDefault();
          b.click();
        }
      });
    });
  }
  // Init from URL on load
  {
    const parsed = _trpParseHash(location.hash);
    window.dashboardTimeRange.preset = parsed.range;
  }

  // ────────────────────────────────────────────────────────────────────
  // CP2: tab navigation (URL-fragment-persisted; #live default / #cost).
  // ────────────────────────────────────────────────────────────────────
  function activateTab(name) {
    // Task #264 v1: strip "?range=..." off hash before tab-name matching;
    // preserves preset when navigating between tabs via hash.
    if (typeof name === 'string' && name.includes('?')) {
      const parsed = _trpParseHash('#' + name);
      name = parsed.tab;
      if (parsed.range !== window.dashboardTimeRange.preset) {
        _trpSetPreset(parsed.range, { updateHash: false, quiet: true });
      }
    }
    // ADR-0041 v2 (Gate A): #repos renamed → #output. Alias preserves bookmarks/deep-links.
    if (name === 'repos') name = 'output';
    // CP14.x: 'orp' tab is conditional (only reachable via Ptah AgentCard
    // click or direct hash navigation #orp/<agent_id>); not in the default
    // chrome but accepted as valid tab-name when navigated to.
    const ORP_HASH_RE = /^orp(\/[a-zA-Z0-9_:@/-]+)?$/;
    if (ORP_HASH_RE.test(name)) {
      // Show the conditional tab button when navigated to ORP
      document.querySelectorAll('.tab-btn-conditional[data-tab="orp"]').forEach((b) => b.hidden = false);
      // Extract agent_id from hash if present: #orp/<agent_id>
      const m = name.match(/^orp\/(.+)$/);
      const orpAgentId = m ? m[1] : null;
      mountOrpView(orpAgentId);
      name = 'orp';  // collapse to canonical tab-name for class-toggle below
    } else if (!['live', 'cost', 'bus', 'audit', 'effort', 'output', 'register', 'operate'].includes(name)) {
      name = 'live';
    }
    document.querySelectorAll('.tab-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === name);
    });
    document.querySelectorAll('.tab-panel').forEach(p => {
      p.classList.toggle('active', p.dataset.tab === name);
    });
    // Task #264 v1: preserve `?range=<preset>` in URL when navigating tabs.
    // Also update Operate-tab clamp (silently clamps to Live if non-live picker).
    _trpUpdateOperateClamp(name);
    const desiredHash = _trpBuildHash(name, window.dashboardTimeRange.preset);
    if (location.hash !== desiredHash) {
      history.replaceState(null, '', desiredHash);
    }
    // CP8: lazy-mount the Bus tab on first activation. Ticker is mounted
    // unconditionally on initial page load (it lives on Live tab and is
    // always-on; the BusStream singleton shares one EventSource between
    // ticker + tab).
    if (name === 'bus') mountBusTab();
    // CP8.2: lazy-mount the Audit tab.
    if (name === 'audit') mountAuditTab();
    // CP8.5: lazy-mount the Register tab.
    if (name === 'register') mountRegisterTab();
    // CP13.4: lazy-mount the Effort tab (ADR-0032 Phase 1.4 UX).
    if (name === 'effort' && typeof ensureEffortView === 'function') ensureEffortView();
    // CP14 Operate tab lazy-mount + refresh on activation.
    if (name === 'operate' && typeof mountOperateTab === 'function') mountOperateTab();
    // ADR-0041 v2 (Gate A): #output = #repos survivor + shared hero. Mount BOTH the
    // hero (mountOutputTab → /output/hero-summary) AND the repos bands (mountReposTab →
    // heatmap/grid/widgets; its internal repos-* element ids are unchanged).
    if (name === 'output') {
      if (typeof mountOutputTab === 'function') mountOutputTab();
      if (typeof mountReposTab === 'function') mountReposTab();
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // CP14.x ORP tab substrate-shell (Jon-direct #9904; yaklog-dev #10048)
  // Author-mode + Live-view mode skeleton; content rendering gated on
  // s345-aieng ORP schema contract + gemini episode-trace contract.
  // A11Y-first per [[feedback_accessibility_is_structural_canon_not_polish]].
  // ─────────────────────────────────────────────────────────────────────
  let orpInitialized = false;
  const orpState = { agentId: null, mode: 'author' };

  function mountOrpView(agentId) {
    if (!orpInitialized) {
      orpInitialized = true;
      // Wire mode toggle (Author / Live-view)
      document.querySelectorAll('#tab-orp .orp-mode-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          orpState.mode = btn.dataset.mode;
          document.querySelectorAll('#tab-orp .orp-mode-btn').forEach((b) => {
            const active = b.dataset.mode === orpState.mode;
            b.classList.toggle('active', active);
            b.setAttribute('aria-pressed', active ? 'true' : 'false');
          });
          document.querySelectorAll('#tab-orp .orp-pane').forEach((p) => {
            p.style.display = p.dataset.modePane === orpState.mode ? '' : 'none';
          });
        });
      });
    }
    if (agentId) orpState.agentId = agentId;
    // Surface selected instance in the heading + status (live-region for AT)
    const nameEl = document.getElementById('orp-instance-name');
    const statusEl = document.getElementById('orp-instance-status');
    if (orpState.agentId) {
      if (nameEl) nameEl.textContent = orpState.agentId;
      // Content-fill: fetch + render the ORP record in Author pane (read-mode).
      // Live-view still pending gemini episode-trace contract.
      // Edit-mode forward-track (POST /api/v1/ops/orp/<agent_id> shipped CP14-X
      // server-side; UI editing surface deferred to ADR-0037 authoring cycle).
      renderOrpAuthor(orpState.agentId, statusEl);
    } else {
      if (nameEl) nameEl.textContent = '(select a Ptah AgentCard)';
      if (statusEl) statusEl.textContent = 'awaiting instance selection — click a Ptah AgentCard to open its ORP view';
    }
  }

  // ORP Author pane content-fill (Task #212 forward-cycle; sister-shape to
  // existing /api/v1/orp/<agent_id> server endpoint shipped CP14-X / task #220).
  // Fetches the ORP record + renders schema-aware read-only sections. Per
  // ptah-orp.schema.json: role_id, display_name, description, version,
  // capabilities[], goals[], decision_tree[], queries[], idle_behavior,
  // priorities[], comms_style, command_authority.
  async function renderOrpAuthor(agentId, statusEl) {
    const body = document.getElementById('orp-author-body');
    if (!body) return;
    // Replace shell content with loading state
    clearChildren(body);
    body.appendChild(el('p', { class: 'orp-muted' }, `loading ORP for ${agentId}…`));
    if (statusEl) statusEl.textContent = `loading ORP for ${agentId}…`;

    let resp;
    try {
      resp = await fetch(`/api/v1/orp/${encodeURIComponent(agentId)}`, { cache: 'no-store' });
    } catch (e) {
      clearChildren(body);
      body.appendChild(el('p', { class: 'orp-muted' }, `network error: ${e.message}`));
      if (statusEl) statusEl.textContent = `network error loading ${agentId} ORP`;
      return;
    }
    if (resp.status === 404) {
      clearChildren(body);
      body.appendChild(el('p', { class: 'orp-muted' },
        `no ORP authored yet for ${agentId}. Server-side substrate is ready; ORP must be authored + POSTed to /api/v1/ops/orp/${agentId} (UI authoring deferred to forward-cycle).`));
      if (statusEl) statusEl.textContent = `no ORP for ${agentId}`;
      return;
    }
    if (resp.status === 401) {
      clearChildren(body);
      body.appendChild(el('p', { class: 'orp-muted' }, `auth required — log in to view ORP`));
      if (statusEl) statusEl.textContent = `auth required`;
      return;
    }
    if (!resp.ok) {
      clearChildren(body);
      body.appendChild(el('p', { class: 'orp-muted' }, `error: HTTP ${resp.status}`));
      if (statusEl) statusEl.textContent = `error HTTP ${resp.status}`;
      return;
    }
    const payload = await resp.json();
    const orp = payload.orp_json || {};
    clearChildren(body);

    // Metadata header
    const meta = el('div', { class: 'orp-meta' });
    meta.appendChild(el('span', null, `version ${payload.version || '?'}`));
    if (payload.schema_version) {
      meta.appendChild(el('span', null, ` · schema ${payload.schema_version}`));
    }
    if (payload.updated_at) {
      meta.appendChild(el('span', null, ` · updated ${fmtAge(payload.updated_at)}`));
    }
    body.appendChild(meta);

    // Identity section
    body.appendChild(el('h4', { class: 'orp-section-h' }, 'Identity'));
    const idDl = el('dl', { class: 'orp-dl' });
    const idFields = [
      ['role_id', orp.role_id || '—'],
      ['display_name', orp.display_name || '—'],
      ['version', orp.version || '—'],
    ];
    for (const [k, v] of idFields) {
      idDl.appendChild(el('dt', null, k));
      idDl.appendChild(el('dd', null, String(v)));
    }
    body.appendChild(idDl);
    if (orp.description) {
      body.appendChild(el('p', { class: 'orp-description' }, orp.description));
    }

    // Capabilities
    const caps = Array.isArray(orp.capabilities) ? orp.capabilities : [];
    body.appendChild(el('h4', { class: 'orp-section-h' },
      `Capabilities (${caps.length})`));
    if (caps.length === 0) {
      body.appendChild(el('p', { class: 'orp-muted' }, 'none'));
    } else {
      const ul = el('ul', { class: 'orp-list' });
      for (const c of caps) {
        const li = el('li');
        li.appendChild(el('span', { class: 'orp-intent' }, c.intent || '(no intent)'));
        const extras = [];
        if (Array.isArray(c.app_scope) && c.app_scope.length) extras.push(`apps: ${c.app_scope.join(', ')}`);
        if (Array.isArray(c.path_roots) && c.path_roots.length) extras.push(`paths: ${c.path_roots.join(', ')}`);
        if (Array.isArray(c.url_allowlist) && c.url_allowlist.length) extras.push(`urls: ${c.url_allowlist.length}`);
        if (typeof c.value_max_len === 'number') extras.push(`value≤${c.value_max_len}`);
        if (extras.length) {
          li.appendChild(el('span', { class: 'orp-extras' }, ' · ' + extras.join(' · ')));
        }
        ul.appendChild(li);
      }
      body.appendChild(ul);
    }

    // Goals
    const goals = Array.isArray(orp.goals) ? orp.goals : [];
    body.appendChild(el('h4', { class: 'orp-section-h' }, `Goals (${goals.length})`));
    if (goals.length === 0) {
      body.appendChild(el('p', { class: 'orp-muted' }, 'none'));
    } else {
      const ul = el('ul', { class: 'orp-list' });
      for (const g of goals) {
        const li = el('li');
        const critClass = g.criticality === 'hard' ? 'orp-crit-hard' : 'orp-crit-stretch';
        li.appendChild(el('span', { class: `orp-criticality ${critClass}` }, g.criticality || '?'));
        li.appendChild(el('span', { class: 'orp-goal-id' }, ' ' + (g.id || '(no id)')));
        if (g.description) li.appendChild(el('span', { class: 'orp-extras' }, ' — ' + g.description));
        const checks = Array.isArray(g.success_checks) ? g.success_checks.length : 0;
        const blocked = Array.isArray(g.blocked_terminals) ? g.blocked_terminals.length : 0;
        const summary = [];
        if (checks) summary.push(`${checks} check${checks > 1 ? 's' : ''}`);
        if (blocked) summary.push(`${blocked} blocked-terminal${blocked > 1 ? 's' : ''}`);
        if (summary.length) {
          li.appendChild(el('span', { class: 'orp-extras' }, ' · ' + summary.join(', ')));
        }
        ul.appendChild(li);
      }
      body.appendChild(ul);
    }

    // Decision tree
    const dt = Array.isArray(orp.decision_tree) ? orp.decision_tree : [];
    body.appendChild(el('h4', { class: 'orp-section-h' }, `Decision tree (${dt.length})`));
    if (dt.length === 0) {
      body.appendChild(el('p', { class: 'orp-muted' }, 'none'));
    } else {
      const ul = el('ul', { class: 'orp-list orp-decision-list' });
      for (const d of dt) {
        const li = el('li');
        li.appendChild(el('span', { class: 'orp-when' }, 'when: '));
        li.appendChild(el('span', null, d.when || '(empty)'));
        li.appendChild(el('br'));
        li.appendChild(el('span', { class: 'orp-then' }, 'then: '));
        li.appendChild(el('span', null, d.then || '(empty)'));
        ul.appendChild(li);
      }
      body.appendChild(ul);
    }

    // Queries (optional)
    const queries = Array.isArray(orp.queries) ? orp.queries : [];
    if (queries.length) {
      body.appendChild(el('h4', { class: 'orp-section-h' }, `Queries (${queries.length})`));
      const ul = el('ul', { class: 'orp-list' });
      for (const q of queries) {
        const li = el('li');
        li.appendChild(el('span', null, `${q.id || '(no id)'} (${q.type || '?'})`));
        if (typeof q.ttl_ticks === 'number') {
          li.appendChild(el('span', { class: 'orp-extras' }, ` · ttl=${q.ttl_ticks}`));
        }
        ul.appendChild(li);
      }
      body.appendChild(ul);
    }

    // Idle behavior
    if (orp.idle_behavior && orp.idle_behavior.mode) {
      body.appendChild(el('h4', { class: 'orp-section-h' }, 'Idle behavior'));
      body.appendChild(el('p', null, `mode: ${orp.idle_behavior.mode}`));
    }

    // Priorities
    const prios = Array.isArray(orp.priorities) ? orp.priorities : [];
    if (prios.length) {
      body.appendChild(el('h4', { class: 'orp-section-h' }, `Priorities (${prios.length})`));
      const ol = el('ol', { class: 'orp-list' });
      for (const p of prios) ol.appendChild(el('li', null, String(p)));
      body.appendChild(ol);
    }

    // Comms style (optional)
    if (orp.comms_style && (orp.comms_style.formality || orp.comms_style.progress_report)) {
      body.appendChild(el('h4', { class: 'orp-section-h' }, 'Comms style'));
      const dl = el('dl', { class: 'orp-dl' });
      if (orp.comms_style.formality) {
        dl.appendChild(el('dt', null, 'formality'));
        dl.appendChild(el('dd', null, orp.comms_style.formality));
      }
      if (orp.comms_style.progress_report) {
        dl.appendChild(el('dt', null, 'progress_report'));
        dl.appendChild(el('dd', null, orp.comms_style.progress_report));
      }
      body.appendChild(dl);
    }

    // Command authority
    if (orp.command_authority && Array.isArray(orp.command_authority.accept_from)) {
      body.appendChild(el('h4', { class: 'orp-section-h' },
        `Command authority — accepts from (${orp.command_authority.accept_from.length})`));
      const ul = el('ul', { class: 'orp-list' });
      for (const s of orp.command_authority.accept_from) ul.appendChild(el('li', null, String(s)));
      body.appendChild(ul);
    }

    if (statusEl) {
      statusEl.textContent = `loaded ORP for ${agentId} (version ${payload.version || '?'}); read-mode — edit-UI forward-track`;
    }
  }

  /**
   * CP14.x: Make Ptah-runtime AgentCards clickable → opens ORP view.
   * Called by AgentCard render path when runtime=ptah. Adds data-runtime
   * attribute (CSS hook) + click handler + ARIA semantics (role=link,
   * aria-label describes destination).
   */
  function wirePtahAgentCardClick(cardEl, agentId) {
    if (!cardEl || cardEl.dataset.runtime === 'ptah') return;  // idempotent
    cardEl.dataset.runtime = 'ptah';
    cardEl.setAttribute('role', 'link');
    cardEl.setAttribute('tabindex', '0');
    cardEl.setAttribute('aria-label',
      `${agentId} — Ptah agent. Press Enter to open ORP authoring and live-view.`);
    const open = () => {
      location.hash = `#orp/${agentId}`;
    };
    cardEl.addEventListener('click', (e) => {
      // Don't hijack clicks on inner controls (arrows, pills, links)
      if (e.target.closest('button, a, input, select, textarea')) return;
      open();
    });
    cardEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        if (e.target.closest('button, a, input, select, textarea')) return;
        e.preventDefault();
        open();
      }
    });
  }
  // Expose for AgentCard render path (Live tab + Ptah filter chip cycle)
  window.wirePtahAgentCardClick = wirePtahAgentCardClick;
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.addEventListener('click', () => activateTab(b.dataset.tab));
  });
  window.addEventListener('hashchange', () => activateTab(location.hash.slice(1)));
  // Task #264 v1: wire time-range picker click/keyboard handlers + sync UI to initial state
  _trpWireHandlers();
  _trpUpdateButtons();
  // CP14.x: support direct #orp/<agent_id> deep-link on initial page load
  activateTab(location.hash.slice(1) || 'live');

  // ────────────────────────────────────────────────────────────────────
  // CP2: PlexusChart — wraps uPlot with template-name + auto-refresh +
  // Prom-matrix → uPlot data conversion + multi-series legend.
  // ────────────────────────────────────────────────────────────────────

  // CP5: chart refresh cadence + lookback now owned server-side by
  // plexusStreamer.js (which polls Prom + pushes to SSE subscribers).
  // No client-side polling constants needed anymore.

  // CP9.1 (2026-06-01): per-agent color attribution — deterministic + stable
  // across reloads + shared across the entire site (channel bubbles, chart
  // series, AgentCard accents). djb2 hash → palette index; 30 hand-curated
  // colors with familiar names; Legend modal exposes the mapping.
  const AGENT_PALETTE = [
    { name: 'sky',          hex: '#60a5fa' },
    { name: 'mint',         hex: '#4ade80' },
    { name: 'sunflower',    hex: '#facc15' },
    { name: 'violet',       hex: '#c084fc' },
    { name: 'rose',         hex: '#f472b6' },
    { name: 'coral',        hex: '#f87171' },
    { name: 'cyan',         hex: '#22d3ee' },
    { name: 'lavender',     hex: '#a78bfa' },
    { name: 'tangerine',    hex: '#fb923c' },
    { name: 'lime',         hex: '#84cc16' },
    { name: 'turquoise',    hex: '#2dd4bf' },
    { name: 'amber',        hex: '#fbbf24' },
    { name: 'magenta',      hex: '#e879f9' },
    { name: 'azure',        hex: '#3b82f6' },
    { name: 'emerald',      hex: '#10b981' },
    { name: 'fuchsia',      hex: '#d946ef' },
    { name: 'salmon',       hex: '#fb7185' },
    { name: 'jade',         hex: '#14b8a6' },
    { name: 'indigo',       hex: '#818cf8' },
    { name: 'goldenrod',    hex: '#eab308' },
    { name: 'peach',        hex: '#fdba74' },
    { name: 'plum',         hex: '#a855f7' },
    { name: 'seafoam',      hex: '#5eead4' },
    { name: 'periwinkle',   hex: '#7c3aed' },
    { name: 'apricot',      hex: '#fdaf64' },
    { name: 'chartreuse',   hex: '#a3e635' },
    { name: 'orchid',       hex: '#d8b4fe' },
    { name: 'crimson',      hex: '#ef4444' },
    { name: 'teal',         hex: '#0d9488' },
    { name: 'cerulean',     hex: '#0ea5e9' },
  ];
  function djb2(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return Math.abs(h);
  }
  function hexToRgb(hex) {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    if (!m) return null;
    return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
  }
  function rgbStr(hex) {
    const c = hexToRgb(hex); if (!c) return 'rgb(0,0,0)';
    return `rgb(${c.r},${c.g},${c.b})`;
  }
  function agentColor(agentId) {
    if (!agentId) return { name: 'slate', hex: '#64748b', rgb: 'rgb(100,116,139)' };
    const entry = AGENT_PALETTE[djb2(agentId) % AGENT_PALETTE.length];
    return { name: entry.name, hex: entry.hex, rgb: rgbStr(entry.hex) };
  }
  // Non-agent series fallback (aggregate buckets): first 10 palette entries.
  function seriesColor(i) { return AGENT_PALETTE[i % 10].hex; }

  // Build the human-readable legend label for a Prom series given its metric labels.
  // 2026-05-25 dedup: when the chart has only ONE distinct plexus_agent_id
  // across all series, drop the agent prefix (it's the same on every line —
  // pure noise). When multi-agent, keep the prefix for disambiguation. The
  // actual agent_id is always stored in a data attribute on the legend row
  // (via wireChartLegendPopovers) so the popover trigger still works.
  function seriesLabel(metric, otherFields, omitAgentPrefix) {
    const agent = metric.plexus_agent_id || '(no agent)';
    const tail = (otherFields || [])
      .map(f => metric[f])
      .filter(v => v != null && v !== '')
      .join(' · ');
    if (omitAgentPrefix) return tail || agent;
    return tail ? `${agent} · ${tail}` : agent;
  }

  // Convert Prom matrix result → uPlot data shape.
  // Prom matrix per-series: { metric: {…labels}, values: [[ts_seconds, "value_string"], …] }
  // uPlot wants: [ [t0, t1, …], [s0_v0, s0_v1, …], [s1_v0, s1_v1, …], … ]
  // Series timestamps may differ; we unify on the sorted union, fill missing as null.
  // v0.5.8.1: token-type bucketing. Backend returns 4 type values
  // (input / output / cacheRead / cacheCreation); UI shows 3 (cache = read +
  // creation, summed). Operates on a Prom matrix `result` array and returns
  // a new array with merged-by-bucket series.
  const TOKEN_TYPE_BUCKET = {
    input: 'input',
    output: 'output',
    cacheRead: 'cache',
    cacheCreation: 'cache',
  };
  // Stable color per bucket so legend + series colors don't shuffle on rerender.
  const TOKEN_BUCKET_COLOR = {
    input: '#60a5fa',   // blue
    output: '#34d399',  // green
    cache: '#c084fc',   // purple
  };
  const TOKEN_BUCKET_ORDER = ['input', 'output', 'cache'];

  // Group a Prom matrix result by the `type` label, mapping the 4 raw types
  // into 3 display buckets, summing values within each bucket at each ts.
  // `extraGroupKeys` lets per-agent rendering also key on plexus_agent_id
  // (so cluster-wide buckets stay distinct from per-agent buckets).
  function bucketResultByType(result, extraGroupKeys = []) {
    if (!result || result.length === 0) return [];
    const buckets = new Map();  // groupKey → { metric, valuesMap: ts→val }
    for (const s of result) {
      const rawType = s.metric && s.metric.type;
      const bucket = TOKEN_TYPE_BUCKET[rawType];
      if (!bucket) continue;  // unknown type — drop
      const groupParts = [bucket, ...extraGroupKeys.map(k => s.metric && s.metric[k] || '')];
      const groupKey = groupParts.join('||');
      let entry = buckets.get(groupKey);
      if (!entry) {
        const metric = { type: bucket };
        for (const k of extraGroupKeys) metric[k] = s.metric && s.metric[k];
        entry = { metric, valuesMap: new Map() };
        buckets.set(groupKey, entry);
      }
      for (const [t, v] of s.values) {
        const n = parseFloat(v);
        if (!Number.isFinite(n)) continue;
        entry.valuesMap.set(t, (entry.valuesMap.get(t) || 0) + n);
      }
    }
    // Re-emit as Prom matrix-shaped series with the stable bucket order.
    const orderedKeys = [...buckets.keys()].sort((a, b) => {
      const ai = TOKEN_BUCKET_ORDER.indexOf(a.split('||')[0]);
      const bi = TOKEN_BUCKET_ORDER.indexOf(b.split('||')[0]);
      if (ai !== bi) return ai - bi;
      return a.localeCompare(b);
    });
    return orderedKeys.map(k => {
      const e = buckets.get(k);
      const values = [...e.valuesMap.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => [t, String(v)]);
      return { metric: e.metric, values };
    });
  }

  function promMatrixToUplot(result, otherFields) {
    if (!result || result.length === 0) return { data: [[]], series: [{ label: 'time' }], agentIds: [] };

    const tsSet = new Set();
    for (const s of result) for (const [t] of s.values) tsSet.add(t);
    const tsList = [...tsSet].sort((a, b) => a - b);
    const tsIndex = new Map(tsList.map((t, i) => [t, i]));

    // 2026-05-25 dedup: detect single-agent case → omit agent prefix on legend.
    const distinctAgents = new Set(result.map(s => s.metric.plexus_agent_id || '(no agent)'));
    const omitAgentPrefix = (distinctAgents.size === 1);

    const seriesDefs = [{ label: 'time' }];
    const seriesData = [tsList];
    // Track per-legend-row agent_id so popover wiring can use a data attr,
    // not text parsing (which would break when agent prefix is omitted).
    const agentIds = [null];

    result.forEach((s, idx) => {
      const valuesAligned = new Array(tsList.length).fill(null);
      for (const [t, v] of s.values) {
        const parsed = parseFloat(v);
        valuesAligned[tsIndex.get(t)] = Number.isFinite(parsed) ? parsed : null;
      }
      // CP9.1: prefer per-agent color when series is keyed on plexus_agent_id;
      // fall back to index-cycle palette for aggregate / non-agent series.
      const aid = s.metric && s.metric.plexus_agent_id;
      const stroke = aid ? agentColor(aid).hex : seriesColor(idx);
      seriesDefs.push({
        label: seriesLabel(s.metric, otherFields, omitAgentPrefix),
        stroke,
        width: 1.5,
        spanGaps: false,
        // uPlot value formatter for legend hover
        value: (u, v) => v == null ? '—' : v.toFixed(4),
      });
      seriesData.push(valuesAligned);
      agentIds.push(aid || null);
    });
    return { data: seriesData, series: seriesDefs, agentIds };
  }

  // CP5 / Stage 2.5: PlexusChart is now push-driven. No more fetch loops.
  // It registers with PlexusLiveStream (shared EventSource) and renders
  // frames as they arrive. Server sends an initial snapshot on connect +
  // deltas on change.
  class PlexusChart {
    constructor(cardEl, opts) {
      this.cardEl = cardEl;
      this.bodyEl = cardEl.querySelector('.chart-card-body');
      this.statusEl = cardEl.querySelector('[data-chart-status]');
      this.template = opts.template;
      this.otherFields = opts.otherFields || [];
      this.valueFmt = opts.valueFmt || ((v) => v.toFixed(3));
      // v0.5.8.1 hook: optional pre-render transform on Prom matrix `result`.
      // Lets per-template logic re-bucket / re-label series (e.g. token type
      // collapse cacheRead+cacheCreation → cache) without forking PlexusChart.
      // Identity by default.
      this.transformResult = opts.transformResult || ((r) => r);
      // Per-series color override map keyed on a label-extracted bucket
      // (e.g. token-type bucket). null = use the default rotating palette.
      this.colorByBucket = opts.colorByBucket || null;
      this.bucketKey = opts.bucketKey || null;  // metric field used to look up colorByBucket
      this.uplot = null;
      this.lastSeriesSig = null;  // signature for "did series structure change?"
    }
    setStatus(text, isError) {
      if (!this.statusEl) return;
      this.statusEl.textContent = text;
      this.statusEl.style.color = isError ? 'var(--red)' : '';
    }
    renderEmpty(msg) {
      clearChildren(this.bodyEl);
      this.bodyEl.appendChild(el('div', { class: 'chart-empty' }, msg));
      if (this.uplot) { this.uplot.destroy(); this.uplot = null; }
      this.lastSeriesSig = null;
    }
    renderError(msg) {
      clearChildren(this.bodyEl);
      this.bodyEl.appendChild(el('div', { class: 'chart-error' }, msg));
      if (this.uplot) { this.uplot.destroy(); this.uplot = null; }
      this.lastSeriesSig = null;
    }
    // Called by PlexusLiveStream when a frame for this template arrives.
    onFrame(payload) {
      this.lastFrameMs = Date.now();
      const rawResult = payload.data && payload.data.result;
      if (!rawResult || rawResult.length === 0) {
        this.renderEmpty('no data in window (no opted-in agents pushing?)');
        this._tickStatus();
        return;
      }
      const result = this.transformResult(rawResult);
      const { data, series, agentIds } = promMatrixToUplot(result, this.otherFields);
      // v0.5.8.1: override series colors by bucket when configured.
      if (this.colorByBucket && this.bucketKey) {
        for (let i = 0; i < result.length; i++) {
          const bucket = result[i].metric && result[i].metric[this.bucketKey];
          const c = this.colorByBucket[bucket];
          if (c && series[i + 1]) {
            series[i + 1].stroke = c;
            series[i + 1].fill = c.length === 7 ? c + '22' : c;
          }
        }
      }
      this.lastAgentIds = agentIds;
      this.lastSeriesCount = result.length;
      // Signature = label list. Same labels → setData (fast); different → rebuild.
      const sig = series.map(s => s.label).join('|');
      if (this.uplot && sig === this.lastSeriesSig) {
        this.uplot.setData(data);
      } else {
        if (this.uplot) { this.uplot.destroy(); this.uplot = null; }
        clearChildren(this.bodyEl);
        this.uplot = new uPlot({
          width: this.bodyEl.clientWidth - 8,
          height: 220,
          series,
          scales: { x: { time: true } },
          axes: [
            { stroke: '#8a93a6', grid: { stroke: 'rgba(255,255,255,0.04)' } },
            // Jon-direct 2026-06-15: SI-suffix Y-axis fixes left-margin
            // truncation when token rate exceeds 99k. size:48 is sufficient
            // for 4-char SI labels (150k, 1.5M).
            { stroke: '#8a93a6', grid: { stroke: 'rgba(255,255,255,0.04)' }, size: 48, values: siAxisValues },
          ],
          legend: { live: true },
          cursor: { drag: { x: true, y: false } },
        }, data, this.bodyEl);
        this.lastSeriesSig = sig;
      }
      this._tickStatus();
    }
    // CP5: status string is "freshness since last frame" so the cell stays
    // honest between deduped-quiet broadcasts. Updated on each frame +
    // ticked by the dashboard-wide 1s renderer.
    _tickStatus() {
      if (!this.statusEl) return;
      const seriesPart = this.lastSeriesCount != null ? `${this.lastSeriesCount} series` : '—';
      let freshnessPart = 'no frame yet';
      if (this.lastFrameMs) {
        const ageS = Math.floor((Date.now() - this.lastFrameMs) / 1000);
        freshnessPart = ageS < 2 ? 'live · just now' : `live · ${ageS}s ago`;
      }
      this.statusEl.textContent = `${seriesPart} · ${freshnessPart}`;
      this.statusEl.style.color = '';
    }
    resize() {
      if (!this.uplot) return;
      this.uplot.setSize({ width: this.bodyEl.clientWidth - 8, height: 220 });
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // CP5: PlexusLiveStream — single EventSource shared by all Live charts.
  // Server pushes "frame" events on change. Client routes by template name
  // to subscribed charts. Replaces N per-chart fetch loops with one push
  // connection.
  // ────────────────────────────────────────────────────────────────────
  class PlexusLiveStream {
    constructor() {
      this.es = null;
      this.subscribers = new Map();   // template-name → [chart, …]
      this.reconnectAttempt = 0;
      this.reconnectTimer = null;
      // CP6.14: connection state for UI indicator.
      // 'connecting' (initial / reconnecting) | 'open' | 'error' | 'paused'
      this.state = 'connecting';
      this.lastFrameMs = 0;
      // Cascade-prevention #10559 Q2: visibility-pause. When the tab is
      // hidden the operator can't see live charts; closing the EventSource
      // sheds Prom-query load on the server until the tab comes back.
      this.paused = false;
    }
    subscribe(template, chart) {
      if (!this.subscribers.has(template)) this.subscribers.set(template, []);
      this.subscribers.get(template).push(chart);
    }
    connect() {
      this.state = 'connecting';
      try {
        this.es = new EventSource('/api/v1/plexus/public/stream');
      } catch (e) {
        this.state = 'error';
        this._scheduleReconnect();
        return;
      }
      this.es.addEventListener('open', () => {
        this.state = 'open';
        this.reconnectAttempt = 0;
      });
      this.es.addEventListener('frame', (ev) => {
        this.lastFrameMs = Date.now();
        let payload;
        try { payload = JSON.parse(ev.data); } catch { return; }
        // 2026-05-25: refresh the OTel-presence map BEFORE routing to charts.
        // Even templates a chart doesn't subscribe to contribute agent-id
        // observations (e.g. session.count carries plexus_agent_id even if
        // no chart on this dashboard cares).
        noteFrameOtelAgents(payload);
        const subs = this.subscribers.get(payload.template);
        if (!subs) return;
        for (const chart of subs) {
          try { chart.onFrame(payload); } catch (e) { /* one chart's render error shouldn't kill others */ }
        }
      });
      this.es.addEventListener('error', () => {
        this.state = 'error';
        // EventSource auto-reconnects on its own for normal drops; this fires
        // on hard errors. Belt-and-suspenders explicit reconnect with backoff.
        this._scheduleReconnect();
      });
    }
    _scheduleReconnect() {
      if (this.paused) return;
      if (this.reconnectTimer) return;
      const delay = Math.min(30000, 1000 * Math.pow(2, this.reconnectAttempt));
      this.reconnectAttempt++;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (this.es) { try { this.es.close(); } catch {} ; this.es = null; }
        this.connect();
      }, delay);
    }
    pause() {
      if (this.paused) return;
      this.paused = true;
      if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
      if (this.es) { try { this.es.close(); } catch {} ; this.es = null; }
      this.state = 'paused';
    }
    resume() {
      if (!this.paused) return;
      this.paused = false;
      this.reconnectAttempt = 0;
      this.connect();
    }
  }

  // CP5: instantiate the shared live stream + register the Live tab charts.
  const liveStream = new PlexusLiveStream();

  // 2026-05-25: per-agent OTel-presence tracker. Every incoming SSE frame
  // carries series with plexus_agent_id labels; populate this map so the
  // presence table can show a "live OTel" badge next to agents that are
  // currently emitting (= they restarted CC since the Path A install).
  // Map<agent_id, lastSeenMs>
  const otelLastSeen = new Map();
  // v0.5.8.2: track service_name observed per agent_id so the AgentCard
  // runtime badge can derive runtime from OTel (claude-code | gemini-cli)
  // first, falling back to the server registry only when OTel is silent.
  // CP12.x.3.1 (2026-06-13): also track plexus.runtime_class resource attr
  // per s345-aieng #8539 canonical schema. Prefer runtime_class over
  // service_name when both present (runtime_class is the cluster-canonical
  // attribute; service_name is the OTel SDK built-in). Cluster substrate
  // sets both today via ssw-devops #8526/#8530 substrate-touch on aieng3 +
  // gemini, plus s345-aieng #8544 sister-CC propagation; backward-compat
  // preserved for agents that only set OTEL_SERVICE_NAME.
  const otelServiceByAgent = new Map();
  const SERVICE_TO_RUNTIME = {
    'claude-code': 'claude_code',
    'gemini-cli': 'gemini',
    // CP12.x.3 (2026-06-13; renamed from CP14.1 per Jon-direct premature-
    // chapter-numbering correction while CP13 unratified): codex-cli mapping
    // so aieng3 + future codex-class agents resolve to the codex runtime
    // badge when they emit OTel with PLEXUS_SERVICE_NAME=codex-cli. Without
    // this entry the OTel-first resolution returned null and silently fell
    // back to the registry — mostly a no-op because registry already has
    // aieng3-agent → codex, but it meant the OTel-first preference was
    // structurally dead for codex.
    'codex-cli': 'codex',
  };
  const OTEL_LIVE_WINDOW_MS = 10 * 60 * 1000;   // 10 min = "recently emitted"
  function noteFrameOtelAgents(payload) {
    const now = Date.now();
    const result = payload && payload.data && payload.data.result;
    if (!result) return;
    for (const s of result) {
      const id = s.metric && s.metric.plexus_agent_id;
      if (id) otelLastSeen.set(id, now);
      // CP12.x.3.1: prefer plexus_runtime_class resource attr over service_name.
      // OTel resource attrs surface as Prom labels with dots converted to
      // underscores (plexus.runtime_class → plexus_runtime_class). Falls
      // back to service_name when the canonical attr isn't set — defends
      // against agents whose OTel emit hasn't been Layer-2-aligned yet.
      const cls = s.metric && s.metric.plexus_runtime_class;
      const svc = s.metric && s.metric.service_name;
      const observed = cls || svc;
      if (id && observed) otelServiceByAgent.set(id, observed);
    }
  }
  function resolveRuntime(agentId, presenceRow) {
    const svc = otelServiceByAgent.get(agentId);
    if (svc && SERVICE_TO_RUNTIME[svc]) return SERVICE_TO_RUNTIME[svc];
    return (presenceRow && presenceRow.runtime) || null;
  }
  // v0.5.8.2 runtime badges. Abstract geometric glyphs in brand-adjacent
  // colors — distinctive but NOT reproductions of any vendor's actual mark.
  // Tooltip carries the explicit runtime label so users always know what
  // they're looking at; the SVG is just at-a-glance recognition.
  const RUNTIME_META = {
    claude_code: {
      label: 'Claude Code',
      color: '#cc785c',
      // 8-pointed asterisk (common geometric primitive)
      svg: '<path d="M12 1 L13.2 8.5 L20 4 L15.5 10.8 L22.5 12 L15.5 13.2 L20 20 L13.2 15.5 L12 23 L10.8 15.5 L4 20 L8.5 13.2 L1.5 12 L8.5 10.8 L4 4 L10.8 8.5 Z" />',
    },
    gemini: {
      label: 'Gemini CLI',
      color: '#4285f4',
      // 4-pointed sparkle (common geometric primitive)
      svg: '<path d="M12 1 C12 7 14 10 23 12 C14 14 12 17 12 23 C12 17 10 14 1 12 C10 10 12 7 12 1 Z" />',
    },
    codex: {
      label: 'OpenAI Codex',
      color: '#10a37f',
      // hexagonal weave (common geometric primitive)
      svg: '<g stroke-width="2" stroke-linejoin="round" fill="none"><polygon points="12,2 21,7 21,17 12,22 3,17 3,7" stroke="currentColor"/><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/></g>',
    },
    // Ptah — Subnet345-owned runtime (Phase 0-Ptah sister-cycle). Per
    // cluster brand-spine convergence cycle 2026-06-19/20:
    //  - label per writer #9667 ratify
    //  - color per s345 #9673 FINAL RATIFY (Subnet345-owned palette tier;
    //    brand-purple distinct from vendor-adjacent CC/Gemini/Codex hues)
    //  - svg per gfxartist #9670 (djed-pillar; Egyptian creator-deity
    //    evoke; geometric primitive distinct from existing 3 glyphs)
    //  - techmark proof-grounding CONCUR #9671
    //  - parch WIRE-AUTHORIZED #9676
    ptah: {
      label: 'Ptah',
      color: '#7c3aed',
      svg: '<path d="M10.6 3 h2.8 v18 h-2.8 z M5.5 3.4 h13 v2 h-13 z M6.5 6.4 h11 v2 h-11 z M7.5 9.4 h9 v2 h-9 z M7.5 21 h9 v2.4 h-9 z" />',
    },
  };
  function runtimeBadge(runtime) {
    const meta = RUNTIME_META[runtime];
    if (!meta) return null;
    // Wrap SVG markup; uses currentColor so the fill cascades from CSS color.
    const span = el('span', {
      class: 'runtime-badge runtime-' + runtime,
      title: meta.label,
      style: `color:${meta.color}`,
    });
    span.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-label="${meta.label}">${meta.svg}</svg>`;
    return span;
  }
  function agentOtelStatus(agentId) {
    const t = otelLastSeen.get(agentId);
    if (!t) return null;                                  // never seen
    const ageS = Math.floor((Date.now() - t) / 1000);
    if (ageS < OTEL_LIVE_WINDOW_MS / 1000) return { kind: 'live', ageS };
    return { kind: 'quiet', ageS };
  }

  // CP3: wire popover triggers on chart legend rows. Extracts agent_id
  // from "agent · model · type" labels (first segment).
  // 2026-05-25 dedup: agent_id is no longer text-parseable from the legend
  // label (single-agent charts omit the prefix). Use the agentIds array
  // stashed on the PlexusChart instance during render.
  function wireChartLegendPopovers(chart) {
    if (!chart || !chart.uplot || !chart.uplot.root) return;
    const legendRows = chart.uplot.root.querySelectorAll('.u-legend .u-series th');
    const agentIds = chart.lastAgentIds || [];
    legendRows.forEach((th, idx) => {
      if (idx === 0) return;
      const agentId = agentIds[idx];
      if (!agentId) return;
      th.classList.add('agent-clickable');
      th.dataset.agentId = agentId;
      th.style.cursor = 'pointer';
      th.setAttribute('tabindex', '0');
      th.setAttribute('role', 'button');
      th.setAttribute('aria-label', `${agentId} — open identity card`);
    });
  }
  // CP5: wire popover triggers after each onFrame instead of after each
  // refresh (refresh is gone in the push model).
  const _origOnFrame = PlexusChart.prototype.onFrame;
  PlexusChart.prototype.onFrame = function (payload) {
    // Task #264 Phase 2.1 (Jon-direct 2026-07-03): in non-live mode, ignore
    // SSE frame updates so the historical snapshot rendered via
    // setHistoricalWindow() isn't clobbered by continuing SSE deltas.
    // Cache last SSE frame so return-to-live can restore without waiting
    // for the next server-side frame emission (which may lag ~15s per
    // plexusStreamer poll cadence).
    if (payload && payload.data) this._lastSseFrame = payload;
    if (!window.isDashboardLive || window.isDashboardLive()) {
      _origOnFrame.call(this, payload);
      wireChartLegendPopovers(this);
    }
  };
  // Task #264 Phase 2.1: on-demand historical fetch that renders through the
  // same onFrame pipeline. Uses existing /query_range endpoint sister-shape
  // fetchAgentSeries (dashboard.js:1624) but preserves the full multi-series
  // result (not filtered to one agent, since these are cluster-level charts).
  PlexusChart.prototype.setHistoricalWindow = async function (windowS) {
    if (!windowS || !Number.isFinite(windowS)) return;
    const to = Math.floor(Date.now() / 1000);
    const from = to - windowS;
    const step = pickStep(windowS);
    const rateWindow = pickRateWindow(windowS);
    const qs = new URLSearchParams({
      template: this.template,
      window: rateWindow,
      from: String(from),
      to: String(to),
      step,
    });
    this.setStatus(`loading ${windowS}s window…`);
    try {
      const res = await fetch('/api/v1/plexus/public/query_range?' + qs.toString(), { cache: 'no-store' });
      if (!res.ok) {
        this.setStatus(`historical fetch: HTTP ${res.status}`, true);
        return;
      }
      const body = await res.json();
      // Reconstruct payload sister-shape SSE frame so onFrame's rendering path
      // works unchanged. `_lastSseFrame` capture in the monkeypatch happens for
      // this too (so live-mode restore has a "just-loaded" snapshot rather
      // than the pre-historical SSE frame — fresher; harmless).
      const historicalPayload = {
        template: this.template,
        kind: 'range',
        query: body.query || null,
        range: { from: String(from), to: String(to), step },
        ...body,  // includes {status, data:{resultType, result}}
      };
      _origOnFrame.call(this, historicalPayload);
      wireChartLegendPopovers(this);
    } catch (e) {
      this.setStatus('historical fetch error', true);
    }
  };
  // Task #264 Phase 2.1: restore live mode by replaying the last cached SSE
  // frame. If no SSE frame has arrived yet (chart lifecycle: created but
  // stream hasn't emitted), no-op — the next SSE frame will render normally
  // via the (now-passing) onFrame gate.
  PlexusChart.prototype.restoreLiveWindow = function () {
    if (this._lastSseFrame) {
      _origOnFrame.call(this, this._lastSseFrame);
      wireChartLegendPopovers(this);
    }
  };

  // Live-tab top: tokens (left) + cost-accounting card (right).
  // CP6.6 (per Jon-direct 2026-05-25): removed the "agents emitting OTel"
  // card — adoption-count info now lives in the card-grid section
  // divider's "N agents · M emitting OTel" meta instead, freeing up
  // top-row real estate.
  const charts = [
    new PlexusChart(document.querySelector('[data-chart="tokens"]'), {
      template: 'tokens.rate.cluster',
      // v0.5.8.1: type-broken-out cluster token rate. Backend returns 4 raw
      // types (input/output/cacheRead/cacheCreation); transformResult buckets
      // cacheRead+cacheCreation → cache, yielding 3 series (in/out/cache).
      otherFields: ['type'],
      transformResult: (r) => bucketResultByType(r),
      colorByBucket: TOKEN_BUCKET_COLOR,
      bucketKey: 'type',
      valueFmt: (v) => v.toFixed(2) + ' tok/s',
    }),
  ];
  for (const c of charts) liveStream.subscribe(c.template, c);

  // Task #264 Phase 2.1: subscribe top-level Live tab charts to the picker.
  // On preset change: non-live → one-shot /query_range with computed window;
  // live → replay cached SSE frame (fresher render than waiting for next
  // ~15s SSE emit cadence).
  document.addEventListener('dashboardTimeRangeChange', (e) => {
    const preset = e.detail && e.detail.preset;
    const win = e.detail && e.detail.window;
    if (preset === 'live') {
      for (const c of charts) c.restoreLiveWindow();
    } else if (win && win.windowS) {
      for (const c of charts) c.setHistoricalWindow(win.windowS);
    }
  });
  // Initial-load hash may have `?range=<preset>` → render historical on mount.
  // Deferred one tick so PlexusChart lifecycle + tabs activate first.
  setTimeout(() => {
    if (window.getDashboardTimeWindow) {
      const win = window.getDashboardTimeWindow();
      if (win && win.windowS) {
        for (const c of charts) c.setHistoricalWindow(win.windowS);
      }
    }
  }, 0);

  // ── Cost-accounting card (middle slot) state + render ────────────────
  // Defect fix (Jon-direct via parch #6747, 2026-05-28): values 'reset on
  // page load' because the page initially renders with '—' placeholders
  // and the first SSE cost frame only arrives a moment later — operators
  // see their prior numbers disappear then reappear. Fix: persist last-
  // known state to localStorage, restore on init before SSE connects, so
  // returning users see continuity from prior session.
  const ACCT_STORAGE_KEY = 'yaklog_acct_state_v1';
  const ACCT_STORAGE_MAX_AGE_MS = 6 * 3600_000;   // 6h — beyond this, prior values are stale enough to be misleading; show '—' and wait for fresh SSE
  function loadAcctState() {
    try {
      const raw = localStorage.getItem(ACCT_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      if (!parsed.lastFrameMs || (Date.now() - parsed.lastFrameMs) > ACCT_STORAGE_MAX_AGE_MS) return null;
      return parsed;
    } catch { return null; }
  }
  function saveAcctState() {
    try {
      // Only persist fields that survive a reload meaningfully; skip transient.
      localStorage.setItem(ACCT_STORAGE_KEY, JSON.stringify({
        today: acctState.today,
        sevend: acctState.sevend,
        mtd: acctState.mtd,
        topAgents: acctState.topAgents,
        byAccount: acctState.byAccount,
        by: acctState.by,
        lastFrameMs: acctState.lastFrameMs,
      }));
    } catch {}   // quota or disabled — silent
  }
  const _restored = loadAcctState();
  const acctState = _restored ? {
    today: _restored.today ?? null,
    sevend: _restored.sevend ?? null,
    mtd: _restored.mtd ?? null,
    topAgents: _restored.topAgents ?? null,
    topAgentTokens: _restored.topAgentTokens ?? null,
    byAccount: _restored.byAccount ?? null,
    by: _restored.by || 'agent',
    lastFrameMs: _restored.lastFrameMs || 0,
  } : {
    today: null, sevend: null, mtd: null,
    topAgents: null, topAgentTokens: null, byAccount: null,
    by: 'agent',
    lastFrameMs: 0,
  };
  // CP11.0.1 (2026-06-04): hero-tile USD precision floor — ALWAYS 2-decimal
  // regardless of magnitude. Per bizmodel R3 refinement (#7640 + #7643 v2.1)
  // CFO-readability standard: sub-penny precision is anti-pattern on a
  // finance screen; readers expect $0.12 not $0.1234 or $0.0001. For
  // large values, drop decimals (compact CFO display) above the $1000 threshold.
  const fmtUSD = (v) => {
    if (v == null || Number.isNaN(v)) return '—';
    if (v >= 1000) return '$' + v.toFixed(0);
    return '$' + v.toFixed(2);
  };
  const valFromVector = (payload) => {
    const r = payload && payload.data && payload.data.result;
    if (!r || r.length === 0) return null;
    const v = parseFloat(r[0].value[1]);
    return Number.isFinite(v) ? v : null;
  };
  function renderAcctNumbers() {
    $('acct-today').textContent = fmtUSD(acctState.today);
    $('acct-7d').textContent    = fmtUSD(acctState.sevend);
    $('acct-mtd').textContent   = fmtUSD(acctState.mtd);
    let proj = null, projSub = 'linear extrap';
    if (acctState.mtd != null && acctState.mtd > 0) {
      const now = new Date();
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
      const elapsedMs = now - monthStart;
      const totalMs = monthEnd - monthStart;
      if (elapsedMs > 0) {
        proj = acctState.mtd / (elapsedMs / totalMs);
        const elapsedDays = elapsedMs / 86400000;
        const totalDays = totalMs / 86400000;
        projSub = `${elapsedDays.toFixed(1)}d of ${totalDays.toFixed(0)}d`;
      }
    }
    $('acct-proj').textContent = fmtUSD(proj);
    $('acct-proj-sub').textContent = projSub;
    const ageS = acctState.lastFrameMs ? Math.floor((Date.now() - acctState.lastFrameMs) / 1000) : null;
    $('acct-status').textContent = ageS == null ? 'no data yet' : `live · ${ageS < 2 ? 'just now' : ageS + 's ago'}`;
  }
  function renderAcctDrivers() {
    const body = $('acct-drivers-body');
    clearChildren(body);
    const payload = acctState.by === 'agent' ? acctState.topAgents : acctState.byAccount;
    const result = payload && payload.data && payload.data.result;
    // Multi-runtime companion for agent view: union with token-only agents
    // (codex/gemini) so quota-honest $0 agents appear alongside metered agents
    // per s345-aieng #12203 Option A honest multi-runtime framing.
    const tokenResult = acctState.by === 'agent'
      && acctState.topAgentTokens && acctState.topAgentTokens.data
      ? acctState.topAgentTokens.data.result : [];
    if ((!result || result.length === 0) && tokenResult.length === 0) {
      body.appendChild(el('div', { class: 'chart-empty', style: 'padding: 20px 0;' }, `no ${acctState.by} cost data`));
      return;
    }
    const labelFor = (m) => acctState.by === 'agent'
      ? (m.plexus_agent_id || '(unknown)')
      : (m.user_email || m.user_account_id || '(unknown)');
    const byName = new Map();
    for (const s of (result || [])) {
      const name = labelFor(s.metric);
      byName.set(name, { name, cost: parseFloat(s.value[1]) || 0, tokens: 0 });
    }
    for (const s of tokenResult) {
      const name = labelFor(s.metric);
      const existing = byName.get(name);
      const tokens = parseFloat(s.value[1]) || 0;
      if (existing) existing.tokens = tokens;
      else byName.set(name, { name, cost: 0, tokens });
    }
    const rows = [...byName.values()].sort((a, b) => (b.cost - a.cost) || (b.tokens - a.tokens));
    const maxCost = Math.max(...rows.map(r => r.cost), 0.01);
    const maxTokens = Math.max(...rows.map(r => r.tokens), 1);
    const fmtTokens = (t) => t < 1000 ? String(Math.round(t))
                        : t < 1_000_000 ? (t / 1000).toFixed(1) + 'k'
                        : (t / 1_000_000).toFixed(1) + 'M';
    const table = el('table');
    const tbody = el('tbody');
    for (const r of rows) {
      const tr = el('tr');
      tr.appendChild(el('td', { class: 'driver-name' }, r.name));
      const barTd = el('td', { class: 'driver-bar-wrap' });
      const bar = el('div', { class: 'driver-bar' });
      const fill = el('div', { class: 'driver-bar-fill' });
      // Bar reflects cost when >0, else tokens (normalized to token max) so
      // quota-tier agents get visible bars proportional to token spend.
      const barPct = r.cost > 0 ? (r.cost / maxCost) * 100 : (r.tokens / maxTokens) * 100;
      fill.style.width = barPct.toFixed(1) + '%';
      bar.appendChild(fill); barTd.appendChild(bar); tr.appendChild(barTd);
      // Cell shows just $ — codex cost now comes from per-query rate calc
      // (agent-tooling@53beb4c) so all runtimes report honest $ per Jon-direct #12215.
      tr.appendChild(el('td', { class: 'driver-cost' }, fmtUSD(r.cost)));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    body.appendChild(table);
  }
  function noteAcctFrame(payload) {
    if (!payload || !payload.template) return;
    let touched = false;
    switch (payload.template) {
      case 'cluster.cost.today':    acctState.today  = valFromVector(payload); touched = true; break;
      case 'cluster.cost.7d':       acctState.sevend = valFromVector(payload); touched = true; break;
      case 'cluster.cost.mtd':      acctState.mtd    = valFromVector(payload); touched = true; break;
      case 'cluster.cost.topAgents':acctState.topAgents = payload; renderAcctDrivers(); break;
      case 'cluster.cost.topAgentTokens':acctState.topAgentTokens = payload; renderAcctDrivers(); break;
      case 'cluster.cost.byAccount':acctState.byAccount = payload; renderAcctDrivers(); break;
      default: return;
    }
    acctState.lastFrameMs = Date.now();
    if (touched) renderAcctNumbers();
    saveAcctState();   // persist after every frame so reload shows continuity
  }
  document.querySelectorAll('#acct-by button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#acct-by button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      acctState.by = b.dataset.by;
      renderAcctDrivers();
      saveAcctState();
    });
  });
  // CP8.6: if we restored state from localStorage, render NOW (before SSE
  // arrives) so returning users see continuity. SSE frames will update in
  // place a moment later. Also sync the by-toggle UI to the restored value.
  if (_restored) {
    document.querySelectorAll('#acct-by button').forEach((b) => {
      b.classList.toggle('active', b.dataset.by === acctState.by);
    });
    renderAcctNumbers();
    renderAcctDrivers();
  }

  // CP11.4 (2026-06-04): Phase 4 wire-up to persisted /cost/summary endpoint.
  // Pre-CP11.4 the hero tiles depended entirely on live Prom queries
  // (cluster.cost.{today,7d,mtd} SSE frames), bounded by Prom retention
  // (15d default). Past mid-month, MTD silently dropped early-month data.
  //
  // Post-CP11.4: hero tiles are FED BY both — SSE Prom-template frame keeps
  // sub-hour freshness; persisted /cost/summary fetch every 60s overrides
  // with the canonical SQLite-backed value for periods extending past
  // Prom retention. Persisted wins on conflict (it's the canon).
  async function refreshAcctFromPersisted() {
    for (const [period, field] of [['today', 'today'], ['7d', 'sevend'], ['mtd', 'mtd']]) {
      try {
        const r = await fetch(`/api/v1/plexus/public/cost/summary?period=${period}`);
        if (!r.ok) continue;
        const j = await r.json();
        if (typeof j.value_usd === 'number') {
          acctState[field] = j.value_usd;
        }
      } catch { /* non-fatal; SSE Prom frames continue to drive */ }
    }
    acctState.lastFrameMs = Date.now();
    renderAcctNumbers();
    saveAcctState();
  }
  // Initial fetch (immediate; doesn't wait for SSE warm-up)
  refreshAcctFromPersisted();
  // Periodic refresh every 60s — picks up intraday-rollup updates
  setInterval(refreshAcctFromPersisted, 60_000);
  // Hook the SSE listener so accounting frames flow into the card.
  const _origConnect = PlexusLiveStream.prototype.connect;
  PlexusLiveStream.prototype.connect = function () {
    _origConnect.call(this);
    if (!this.es) return;
    this.es.addEventListener('frame', (ev) => {
      try { noteAcctFrame(JSON.parse(ev.data)); } catch { /* ignore */ }
    });
  };

  liveStream.connect();

  // 1s ticker keeps chart-card "live · Ns ago" indicators honest AND
  // keeps the accounting card's status freshness honest AND ticks the
  // per-AgentCard chart-view freshness footers (Activity + Cost views)
  // so the user can SEE the channel is alive even when the chart line
  // is visually static (e.g., during steady-state cacheRead bursts).
  setInterval(() => {
    for (const c of charts) c._tickStatus();
    if (acctState.lastFrameMs) renderAcctNumbers();
    // CP6.11: tick each AgentCard's freshness footer in place (no full
    // rerender — just patch the textContent of the .view-freshness el).
    for (const card of cardInstances.values()) {
      if (card.currentView !== 1 && card.currentView !== 2) continue;
      const footer = card.bodyEl && card.bodyEl.querySelector('.view-freshness');
      if (!footer) continue;
      const ts = (card.currentView === 1) ? perAgentFrames._tokensTs : perAgentFrames._costTs;
      if (!ts) { footer.textContent = 'no frame yet'; continue; }
      const ageS = Math.floor((Date.now() - ts) / 1000);
      footer.textContent = `live · ${ageS < 2 ? 'just now' : ageS + 's ago'}`;
    }
    // CP6.14: SSE-state indicator. 4 states displayed via CSS class:
    //   connecting (grey, pulsing) | open (green) | stale (yellow) | error (red, pulsing)
    // "stale" = open but no frame seen for >60s; signals a server-side
    // dedup-or-stall situation that's distinct from connection drop.
    const ind = $('sse-indicator');
    if (ind) {
      let cls, tip;
      const age = liveStream.lastFrameMs ? Math.floor((Date.now() - liveStream.lastFrameMs) / 1000) : null;
      if (liveStream.state === 'error') {
        cls = 'state-error';
        tip = `SSE: error (reconnect in progress; last frame ${age == null ? 'never' : age + 's ago'})`;
      } else if (liveStream.state === 'connecting') {
        cls = 'state-connecting';
        tip = 'SSE: connecting…';
      } else if (age == null) {
        cls = 'state-connecting';
        tip = 'SSE: open, awaiting first frame…';
      } else if (age > 60) {
        cls = 'state-stale';
        tip = `SSE: open but stale (last frame ${age}s ago)`;
      } else {
        cls = 'state-open';
        tip = `SSE: open, last frame ${age < 2 ? 'just now' : age + 's ago'}`;
      }
      // Only update className when changed (avoid CSS-animation restart flicker)
      if (!ind.classList.contains(cls)) {
        ind.className = 'sse-dot ' + cls;
      }
      ind.setAttribute('title', tip);
    }
  }, 1000);

  // ────────────────────────────────────────────────────────────────────
  // CP6.3 — AgentCard grid (replaces presence table).
  // One card per presence row. 4 dot-tab views per card:
  //   Live · Activity · Cost · Identity
  // Cards reuse SSE frame cache for per-agent telemetry; identity is
  // lazy-fetched via the agent.identity.byAgentId instant template.
  // ────────────────────────────────────────────────────────────────────

  const VIEW_LABELS = ['Live', 'Activity', 'Cost', 'Identity', 'Runtime', 'Trace'];
  const cardInstances = new Map();    // agent_id → AgentCard
  // Per-agent latest SSE frame slices (for chart views).
  // SSE templates have FIXED lookback (1h); these are the default-window cache.
  const perAgentFrames = {
    tokensByAgent: null,    // tokens.rate.byAgent matrix (1h)
    costByAgent: null,      // cost.rate.byAgent matrix (1h)
    activeTimeByAgent: null,// active_time.rate.byAgent matrix (1h)
    costCumByAgent: null,   // cluster.cost.topAgents (cumulative; instant)
  };
  // CP6.5: global history window for AgentCard Activity + Cost views.
  // 1h uses the SSE cache above (instant; pushed). Longer windows do
  // on-demand /query_range fetches with scaled step.
  const cardsWindow = { windowS: 3600, fetchSeq: 0 };
  // Per-agent on-demand fetch cache keyed by (template, windowS).
  // Map<`${tpl}::${agent}::${ws}`, {data, ts}>
  const cardsFetchCache = new Map();
  const CARDS_FETCH_TTL_MS = 60000;   // 60s; matches server cache TTL
  function pickStep(ws) {
    if (ws <= 3600)   return '15s';
    if (ws <= 21600)  return '1m';
    if (ws <= 86400)  return '5m';
    return '30m';
  }
  // CP6.5: scale rate-window with lookback so sparse-usage agents still
  // show non-zero buckets. Allowlist (RATE_WINDOW_ALLOWLIST in
  // plexusRoutes) caps at '1h'; 24h + 7d both use 1h.
  function pickRateWindow(ws) {
    if (ws <= 3600)   return '5m';
    if (ws <= 21600)  return '15m';
    if (ws <= 86400)  return '1h';
    return '1d';   // 7d lookback uses 1d rate window (CP6.13)
  }

  function noteAgentFrame(payload) {
    if (!payload || !payload.template) return;
    const now = Date.now();
    switch (payload.template) {
      case 'tokens.rate.byAgent':       perAgentFrames.tokensByAgent = payload; perAgentFrames._tokensTs = now; break;
      case 'cost.rate.byAgent':         perAgentFrames.costByAgent = payload; perAgentFrames._costTs = now; break;
      case 'active_time.rate.byAgent':  perAgentFrames.activeTimeByAgent = payload; perAgentFrames._activeTs = now; break;
      case 'cluster.cost.topAgents':    perAgentFrames.costCumByAgent = payload; perAgentFrames._cumTs = now; break;
      default: return;
    }
    // Push to any cards currently showing Activity (1) or Cost (2) view.
    // Perf: cards on Live (0) or Identity (3) don't redraw on telemetry frames.
    // Task #264 Phase 2.2: in non-live dashboard mode, historical snapshot
    // is authoritative — SSE frames must not trigger view 1/2 re-render
    // (would refetch historical via 60s-cached path; wasteful DOM churn).
    if (window.isDashboardLive && !window.isDashboardLive()) return;
    for (const card of cardInstances.values()) {
      if (card.currentView === 1 || card.currentView === 2) card.rerenderBody();
    }
  }
  // Subscribe via the same SSE listener pattern the accounting card uses.
  // The accounting connect-monkeypatch already installed an event listener;
  // we need to ALSO get cluster.cost.topAgents + the per-agent rate frames
  // to flow into per-card state. The cleanest hook is to extend the existing
  // PlexusLiveStream.connect monkey-patch.
  const _origConnectForCards = PlexusLiveStream.prototype.connect;
  PlexusLiveStream.prototype.connect = function () {
    _origConnectForCards.call(this);
    if (!this.es) return;
    this.es.addEventListener('frame', (ev) => {
      try { noteAgentFrame(JSON.parse(ev.data)); } catch { /* ignore */ }
    });
  };

  // Filter Prom matrix-series to those whose plexus_agent_id matches.
  function seriesForAgent(payload, agentId) {
    if (!payload || !payload.data || !payload.data.result) return [];
    return payload.data.result.filter(s => s.metric && s.metric.plexus_agent_id === agentId);
  }

  // CP6.5: on-demand range fetch for AgentCard chart views when the
  // window > 1h (SSE-cached default). Returns Promise<series-array> for
  // the named agent, or empty array on miss/error. Cached per
  // (template, agent_id, windowS) with 60s TTL.
  async function fetchAgentSeries(template, agentId, windowS) {
    const cacheKey = `${template}::${agentId}::${windowS}`;
    const cached = cardsFetchCache.get(cacheKey);
    if (cached && (Date.now() - cached.ts) < CARDS_FETCH_TTL_MS) {
      return cached.series;
    }
    try {
      const to = Math.floor(Date.now() / 1000);
      const from = to - windowS;
      const step = pickStep(windowS);
      const window = pickRateWindow(windowS);
      const qs = new URLSearchParams({ template, window, from: String(from), to: String(to), step });
      const res = await fetch('/api/v1/plexus/public/query_range?' + qs.toString(), { cache: 'no-store' });
      if (!res.ok) return [];
      const body = await res.json();
      const results = (body.data && body.data.result) || [];
      const series = results.filter(s => s.metric && s.metric.plexus_agent_id === agentId);
      cardsFetchCache.set(cacheKey, { series, ts: Date.now() });
      return series;
    } catch (e) { return []; }
  }

  // Convert filtered matrix series to a single aggregate uPlot data array
  // (sum across all matching series at each timestamp). Returns null if no
  // data at all. Keeps cards visually simple — one line per chart.
  function aggregateSeriesToUplot(series) {
    if (!series.length) return null;
    const tsSet = new Set();
    for (const s of series) for (const [t] of s.values) tsSet.add(t);
    const tsList = [...tsSet].sort((a, b) => a - b);
    const tsIndex = new Map(tsList.map((t, i) => [t, i]));
    const sum = new Array(tsList.length).fill(0);
    const has = new Array(tsList.length).fill(false);
    for (const s of series) {
      for (const [t, v] of s.values) {
        const i = tsIndex.get(t);
        const parsed = parseFloat(v);
        if (Number.isFinite(parsed)) { sum[i] += parsed; has[i] = true; }
      }
    }
    const vals = sum.map((v, i) => has[i] ? v : null);
    return [tsList, vals];
  }

  // v0.5.8.1: convert a bucketed-by-type series array (already filtered to one
  // agent) into uPlot data + series defs. Returns { data, series, lastVals }
  // where lastVals is {input, output, cache} for the header stat row.
  function bucketedSeriesToUplot(buckets) {
    if (!buckets || buckets.length === 0) {
      return { data: null, series: null, lastVals: { input: 0, output: 0, cache: 0 } };
    }
    const tsSet = new Set();
    for (const s of buckets) for (const [t] of s.values) tsSet.add(t);
    const tsList = [...tsSet].sort((a, b) => a - b);
    const tsIndex = new Map(tsList.map((t, i) => [t, i]));
    // Stable bucket order: input, output, cache (matches TOKEN_BUCKET_ORDER).
    const byBucket = new Map();
    for (const s of buckets) byBucket.set(s.metric.type, s);
    const data = [tsList];
    const series = [{ label: 't' }];
    const lastVals = { input: 0, output: 0, cache: 0 };
    for (const bucket of TOKEN_BUCKET_ORDER) {
      const s = byBucket.get(bucket);
      const valuesAligned = new Array(tsList.length).fill(null);
      if (s) {
        for (const [t, v] of s.values) {
          const n = parseFloat(v);
          valuesAligned[tsIndex.get(t)] = Number.isFinite(n) ? n : null;
        }
        // Last non-null value for the stat row
        for (let i = valuesAligned.length - 1; i >= 0; i--) {
          if (valuesAligned[i] != null) { lastVals[bucket] = valuesAligned[i]; break; }
        }
      }
      const color = TOKEN_BUCKET_COLOR[bucket];
      data.push(valuesAligned);
      series.push({
        label: bucket,
        stroke: color,
        width: 1.5,
        fill: color + '22',
        spanGaps: false,
        value: (u, v) => v == null ? '—' : v.toFixed(2) + ' tok/s',
      });
    }
    return { data, series, lastVals };
  }

  // Tiny inline chart helper supporting N series; default 130px tall.
  function tinyMultiChart(hostEl, data, series, opts = {}) {
    if (hostEl._uplot) { hostEl._uplot.destroy(); hostEl._uplot = null; }
    clearChildren(hostEl);
    if (!data || !data[0] || data[0].length === 0) {
      hostEl.appendChild(el('div', { class: 'view-empty' }, opts.emptyText || 'no data'));
      return;
    }
    hostEl._uplot = new uPlot({
      width: hostEl.clientWidth - 4,
      height: opts.height || 130,
      series,
      scales: { x: { time: true } },
      axes: [
        { stroke: '#8a93a6', grid: { stroke: 'rgba(255,255,255,0.04)' }, size: 24 },
        { stroke: '#8a93a6', grid: { stroke: 'rgba(255,255,255,0.04)' }, size: 40 },
      ],
      legend: { show: false },
      cursor: { drag: { x: true, y: false }, points: { show: true } },
    }, data, hostEl);
  }

  // Tiny inline chart helper (smaller than PlexusChart; no legend; fixed height).
  function tinyChart(hostEl, data, opts = {}) {
    if (hostEl._uplot) { hostEl._uplot.destroy(); hostEl._uplot = null; }
    clearChildren(hostEl);
    if (!data || !data[0].length) {
      hostEl.appendChild(el('div', { class: 'view-empty' }, opts.emptyText || 'no data'));
      return;
    }
    hostEl._uplot = new uPlot({
      width: hostEl.clientWidth - 4,
      height: 130,
      series: [
        { label: 't' },
        { label: opts.label || 'value', stroke: opts.stroke || '#60a5fa', width: 1.5,
          fill: opts.fill || 'rgba(96,165,250,0.08)',
          value: (u, v) => v == null ? '—' : (opts.fmt ? opts.fmt(v) : v.toFixed(2)) },
      ],
      scales: { x: { time: true } },
      axes: [
        { stroke: '#8a93a6', grid: { stroke: 'rgba(255,255,255,0.04)' }, size: 24 },
        { stroke: '#8a93a6', grid: { stroke: 'rgba(255,255,255,0.04)' }, size: 40 },
      ],
      legend: { show: false },
      cursor: { drag: { x: true, y: false }, points: { show: true } },
    }, data, hostEl);
  }

  // CP6.4: freshness footer for chart views inside cards. Returns a small
  // muted-text element showing "live · Ns ago" since the relevant frame
  // last touched (matches the accounting card pattern).
  function _freshnessEl(tsMs) {
    if (!tsMs) return el('div', { class: 'view-freshness' }, 'no frame yet');
    const ageS = Math.floor((Date.now() - tsMs) / 1000);
    return el('div', { class: 'view-freshness' },
      `live · ${ageS < 2 ? 'just now' : ageS + 's ago'}`);
  }
  // CP6.5: human-readable window label
  function _windowLabel(ws) {
    if (ws <= 3600)   return '1h';
    if (ws <= 21600)  return '6h';
    if (ws <= 86400)  return '24h';
    return '7d';
  }

  // POPOVER_IDENTITY_FIELDS + POPOVER_SECTIONS are defined further below
  // (CP3 popover code); we reference them at view-render time so the
  // identity view shares its schema with the popover (when popover still
  // exists post-CP6.3 — TODO consider removing popover since cards now
  // show identity inline).

  class AgentCard {
    constructor(agentId) {
      this.agentId = agentId;
      this.currentView = 0;
      this.identityCache = null;   // lazy-fetched on first Identity view
      this.identityFetching = false;
      this.presence = null;        // latest presence row
      this.el = el('div', { class: 'agent-card', 'data-agent-id': agentId });
      this.headEl = el('div', { class: 'agent-card-head' });
      this.bodyEl = el('div', { class: 'agent-card-body' });
      // CP10.5 (2026-06-03): replaced bottom dot-row with side-edge prev/next
      // arrows + a compact view-label in the header. Saves vertical card space
      // and makes the navigation feel like a carousel. Arrows wrap around.
      this.prevBtn = el('button', {
        type: 'button',
        class: 'agent-card-arrow agent-card-arrow-prev',
        'aria-label': 'previous view',
        title: 'previous view (or use left arrow key when card focused)',
      }, '‹');
      this.nextBtn = el('button', {
        type: 'button',
        class: 'agent-card-arrow agent-card-arrow-next',
        'aria-label': 'next view',
        title: 'next view (or use right arrow key when card focused)',
      }, '›');
      this.prevBtn.addEventListener('click', (e) => { e.stopPropagation(); this.cycleView(-1); });
      this.nextBtn.addEventListener('click', (e) => { e.stopPropagation(); this.cycleView(+1); });
      // CP10.5.1 (2026-06-03): content wrapper so arrows don't overlap card
      // info. Card is now a 3-column grid: prev | content | next. Content
      // stacks head + body as before. Arrows live in dedicated columns,
      // never overlap data.
      this.contentEl = el('div', { class: 'agent-card-content' });
      this.contentEl.appendChild(this.headEl);
      this.contentEl.appendChild(this.bodyEl);
      this.el.appendChild(this.prevBtn);
      this.el.appendChild(this.contentEl);
      this.el.appendChild(this.nextBtn);
      // Keyboard nav when card is focused
      this.el.tabIndex = 0;
      this.el.addEventListener('keydown', (e) => {
        if (e.target !== this.el) return;
        if (e.key === 'ArrowLeft') { e.preventDefault(); this.cycleView(-1); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); this.cycleView(+1); }
      });
    }
    cycleView(delta) {
      const n = VIEW_LABELS.length;
      const next = ((this.currentView + delta) % n + n) % n;
      this.setView(next);
    }
    setView(idx) {
      if (idx === this.currentView) return;
      this.currentView = idx;
      // CP12.23 (2026-06-11): per Jon-direct, view-label "$idx/$count" replaced
      // with a clickable pill row. Update active state on the pills instead of
      // mutating a text span.
      const pillEls = this.headEl.querySelectorAll('.agent-card-view-pill');
      pillEls.forEach((p, i) => {
        if (i === idx) p.classList.add('active');
        else p.classList.remove('active');
      });
      this.rerenderBody();
    }
    update(presenceRow) {
      this.presence = presenceRow;
      this._renderHead();
      this.rerenderBody();
    }
    _renderHead() {
      clearChildren(this.headEl);
      const r = this.presence || {};
      // CP9.1: per-agent color swatch — same color as channel bubbles + chart series
      const ac = agentColor(this.agentId);
      this.headEl.appendChild(el('span', {
        class: 'agent-color-dot',
        style: `background:${ac.hex}`,
        title: `color: ${ac.name} · ${ac.hex} · ${ac.rgb}`,
      }));
      // v0.5.8.2: runtime badge — OTel-derived first, server registry fallback.
      // CP14.1 (2026-06-13): also expose runtime on the AgentCard root via
      // data-runtime attribute so CSS can apply runtime-class accent styling
      // (right-edge border-tint) — visual distinction at-a-glance without
      // making the badge larger or competing with the status-color border-left.
      const runtime = resolveRuntime(this.agentId, r);
      if (runtime) this.el.setAttribute('data-runtime', runtime);
      else this.el.removeAttribute('data-runtime');
      const badge = runtime && runtimeBadge(runtime);
      if (badge) this.headEl.appendChild(badge);
      this.headEl.appendChild(el('span', { class: 'name' }, r.agent_id || this.agentId));
      // CP12.23 (2026-06-11): replaced "$idx/$count" view-label with a row of
      // clickable pills per Jon-direct. Each pill jumps directly to that view;
      // the active view's pill is highlighted. Side arrows + arrow-keys still
      // work for sequential navigation.
      const viewPills = el('span', {
        class: 'agent-card-view-pills',
        title: 'click a pill to jump to that view (or use ‹/› arrows / left+right keys)',
      });
      VIEW_LABELS.forEach((lbl, i) => {
        const pill = el('button', {
          type: 'button',
          class: 'agent-card-view-pill' + (i === this.currentView ? ' active' : ''),
          'data-view-idx': String(i),
          'aria-label': `switch to ${lbl} view`,
          title: lbl,
        }, lbl);
        pill.addEventListener('click', (e) => {
          e.stopPropagation();
          this.setView(i);
        });
        viewPills.appendChild(pill);
      });
      this.headEl.appendChild(viewPills);
      const lbl = r.label || '';
      // F4 (parch #8743 + Jon-direct major-bug fix 2026-06-14): age-aware
      // stale-idle visual decay. CC clients fire `Stop` on rate-limit
      // interrupt (admin #8737 empirical: zero StopFailure across ~10
      // rate-limit cycles), which puts session_state='idle' (sticky
      // terminal per v0.5.2 design / gamedev-client #4535). Without this
      // hint, a rate-limited CC session stays online_idle (green) forever.
      // Dashboard-only fix: when an idle session hasn't fired any hook
      // in > STALE_IDLE_THRESHOLD_MS, visually surface as stale (yellow
      // border + suffix on the label tooltip + "stale idle" pill). The
      // canonical API label is preserved unchanged for downstream consumers;
      // this is presentation-layer-only. Server-side age-aware deriveLabel
      // (F1) is queued post-defensive-freeze + Jon-direction on whether
      // the v0.5.2 sticky-idle design needs canon-change.
      const STALE_IDLE_THRESHOLD_MS = 30 * 60 * 1000; // 30 min
      let staleIdle = false;
      let staleIdleAgeMs = null;
      if (r.label === 'online_idle' && r.last_hook_at) {
        const ageMs = Date.now() - new Date(r.last_hook_at).getTime();
        if (Number.isFinite(ageMs) && ageMs > STALE_IDLE_THRESHOLD_MS) {
          staleIdle = true;
          staleIdleAgeMs = ageMs;
        }
      }
      const labelTitle = `daemon=${r.daemon_state || '?'} · session=${r.session_state || '?'}`
        + (staleIdle ? ` · stale-idle (no hook for ${Math.round(staleIdleAgeMs/60000)}m; CC rate-limit fires Stop → sticky idle; presentation-layer hint)` : '');
      this.headEl.appendChild(el('span', {
        class: 'label-badge label-' + lbl + (staleIdle ? ' stale-idle' : ''),
        title: labelTitle,
      }, lbl + (staleIdle ? ' (stale)' : '')));
      const pills = el('span', { class: 'agent-card-pills' });
      const otel = agentOtelStatus(this.agentId);
      if (otel) {
        const tip = otel.kind === 'live'
          ? `Plexus OTel data observed ${otel.ageS}s ago`
          : `OTel data stale (${Math.floor(otel.ageS/60)}m ago)`;
        pills.appendChild(el('span', { class: 'otel-pill ' + otel.kind, title: tip },
          otel.kind === 'live' ? 'OTel' : 'OTel quiet'));
      }
      // v0.5.9: runtime-execution-liveness pill (per parch ratification #6684;
      // ADR-0027 scope). Fires when runtime_state is set and not 'active' —
      // the runtime can't execute work even though the daemon may be up.
      // Distinct from daemon-down / Monitor-dead / stalled.
      if (r.runtime_state && r.runtime_state !== 'active') {
        const stateLabel = r.runtime_state === 'quota_exhausted' ? 'quota-blocked'
                         : r.runtime_state === 'error' ? 'runtime-error'
                         : r.runtime_state;
        let etaTxt = '';
        if (r.runtime_blocked_until) {
          const ms = new Date(r.runtime_blocked_until).getTime() - Date.now();
          if (Number.isFinite(ms)) {
            if (ms <= 0) etaTxt = ' · reset due';
            else if (ms < 60_000) etaTxt = ` · resets in <1m`;
            else if (ms < 3600_000) etaTxt = ` · resets in ${Math.round(ms/60_000)}m`;
            else etaTxt = ` · resets in ${(ms/3600_000).toFixed(1)}h`;
          }
        }
        const tip = `runtime_state=${r.runtime_state}` +
          (r.runtime_blocked_until ? ` · runtime_blocked_until=${r.runtime_blocked_until}` : '') +
          ` · daemon may still be heartbeating but runtime can't execute work`;
        pills.appendChild(el('span', { class: 'rt-pill', title: tip }, stateLabel + etaTxt));
      }
      if (r.events_consumer_count === 0 && r.daemon_state === 'up') {
        pills.appendChild(el('span', {
          class: 'mon-pill',
          title: 'events.ndjson Monitor subprocess is dead',
        }, 'Monitor dead'));
      }
      // CP12.x.4 (2026-06-13): SSE-stale pill per sleuth #8532 + admin
      // #8534/#8536 forensic. Server derives sse_stream_stale = heartbeat
      // fresh AND cursor unchanged > 5min AND cluster traffic flowing.
      // Catches the daemon-alive + stream-silent failure mode that left
      // sleuth's events.ndjson frozen for ~21h until server-restart jolted
      // the daemon out of its silent-dead state. Distinct from Monitor-dead
      // (subprocess) and stalled (no hook activity); this surfaces the
      // SSE consume-loop being stuck despite daemon health probes passing.
      if (r.sse_stream_stale === true) {
        const ageM = r.last_cursor_advance_at
          ? Math.round((Date.now() - new Date(r.last_cursor_advance_at).getTime()) / 60000)
          : null;
        const tip = `SSE stream silent-dead — daemon process alive + heartbeating, but cursor hasn't advanced in ${ageM != null ? ageM + 'min' : '5+ min'} while cluster traffic continues. Last cursor: ${r.cursor_position}. Per sleuth #8532 + CP12.x.4 substrate bug.`;
        pills.appendChild(el('span', {
          class: 'sse-pill',
          title: tip,
        }, 'SSE-stale'));
      }
      // CP7.2: update-available pill (server enriches /presence/public with
      // update_available + canonical_daemon_version per /update manifest).
      if (r.update_available === true) {
        const tip = `daemon v${r.daemon_version} is behind canonical v${r.canonical_daemon_version || '?'} — see /update for install command`;
        pills.appendChild(el('span', {
          class: 'upd-pill',
          title: tip,
        }, 'update available'));
      } else if (r.daemon_version == null && r.daemon_state === 'up') {
        // CP7.3: agent's daemon is pre-version-reporting (pre-v0.5.7.4) so we
        // can't compare against canon. Surface a distinct "stale daemon" pill
        // so this cohort gets the upgrade nag — they were silent under CP7.2.
        const tip = `daemon is pre-v${r.canonical_daemon_version || '0.5.7.4'} (pre-version-reporting); re-pull the Plexus daemon from /update`;
        pills.appendChild(el('span', {
          class: 'stale-pill',
          title: tip,
        }, 'stale daemon'));
      }
      this.headEl.appendChild(pills);
      // PLAN-DASHBOARD-OPERATOR-DM Phase A: DM compose icon-button on each
      // AgentCard. Click → opens compose modal pre-bound to this agent_id.
      // Requires operator login (sessionStorage operator-bearer); if absent,
      // opens login modal first per §2.9.1 binding canon.
      const dmBtn = el('button', {
        type: 'button',
        class: 'agent-card-dm-btn',
        title: 'DM this agent (operator-class send)',
        'aria-label': 'Send DM to ' + this.agentId,
      }, '✉ DM');
      dmBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (window.PlexusOperatorDM) {
          window.PlexusOperatorDM.openCompose(this.agentId);
        }
      });
      this.headEl.appendChild(dmBtn);
      // CP6.5: status-color left border + dimmed offline cards
      // Strip prior status- classes, add the current one
      this.el.className = 'agent-card';
      if (r.label) this.el.classList.add('status-' + r.label);
      if (r.label === 'offline') this.el.classList.add('is-offline');
      // Jon-direct 2026-06-21: online + runtime_state=quota_exhausted ("quota-blocked")
      // was rendering green via status-online_* class. Add the status-quota_blocked
      // class so the CSS rule (defined AFTER status-online_*) overrides to purple.
      // The label-badge already reads "quota-blocked" per the labelTitle block above;
      // this is additive sighted-user color, AT-readable signal unchanged per a11y canon.
      if (r.runtime_state === 'quota_exhausted') this.el.classList.add('status-quota_blocked');
      // F4 (parch #8743) + v0.5.63 (Jon-direct 2026-06-16): stale-idle class
      // adds the label-badge dim+italic CSS only. Border-left stays at the
      // status-derived color — yellow now reserved exclusively for the
      // quota_exhausted runtime_state signal (gemini Google-quota,
      // aieng3 OpenAI-quota) + stalled/unknown "needs attention" band.
      // Computed above in the labelTitle block; mirrored here for the card.
      if (staleIdle) this.el.classList.add('stale-idle');
    }
    rerenderBody() {
      switch (this.currentView) {
        case 0: this._renderLive(); break;
        case 1: this._renderActivity(); break;
        case 2: this._renderCost(); break;
        case 3: this._renderIdentity(); break;
        case 4: this._renderRuntime(); break;
        case 5: this._renderTrace(); break;
      }
    }
    _renderLive() {
      clearChildren(this.bodyEl);
      this.bodyEl.className = 'agent-card-body view-live';
      const r = this.presence || {};
      const dl = el('dl');
      const fields = [
        ['daemon', r.daemon_state || '—'],
        ['session', r.session_state || '—'],
        ['model', shortenModel(r.current_model) || '—'],
        ['tool', r.current_tool
          || (r.session_state === 'tool_running' ? '(running)' : (r.last_tool_name ? `last: ${r.last_tool_name}` : '—'))],
        ['last hook', fmtAge(r.last_hook_at)],
        ['heartbeat', fmtAge(r.last_heartbeat_at)],
        ['subs', r.subagent_active_count == null ? '—' : String(r.subagent_active_count)],
        ['cursor', r.cursor_position == null ? '—' : String(r.cursor_position)],
      ];
      for (const [k, v] of fields) {
        dl.appendChild(el('dt', null, k));
        dl.appendChild(el('dd', null, String(v)));
      }
      this.bodyEl.appendChild(dl);
    }
    async _renderActivity() {
      clearChildren(this.bodyEl);
      this.bodyEl.className = 'agent-card-body view-activity';
      const ws = cardsWindow.windowS;
      let series, fromSse = false;
      // CP6.14: when SSE cache is cold (page just loaded; no frame yet),
      // do an on-demand /query_range fetch to populate immediately with
      // history. The next SSE frame will replace this with the live cache.
      // Eliminates the "waiting for first SSE frame…" empty state.
      if (ws === 3600 && perAgentFrames.tokensByAgent !== null) {
        series = seriesForAgent(perAgentFrames.tokensByAgent, this.agentId);
        fromSse = true;
      } else if (ws === 3600) {
        this.bodyEl.appendChild(el('div', { class: 'view-loading-inline' }, 'loading history…'));
        const seq = ++cardsWindow.fetchSeq;
        series = await fetchAgentSeries('tokens.rate.byAgent', this.agentId, ws);
        if (seq !== cardsWindow.fetchSeq || this.currentView !== 1) return;
        clearChildren(this.bodyEl);
      } else {
        this.bodyEl.appendChild(el('div', { class: 'view-loading-inline' }, `fetching ${ws/3600}h…`));
        const seq = ++cardsWindow.fetchSeq;
        series = await fetchAgentSeries('tokens.rate.byAgent', this.agentId, ws);
        if (seq !== cardsWindow.fetchSeq || this.currentView !== 1) return;
        clearChildren(this.bodyEl);
      }
      // v0.5.8.1: bucket the agent's series by type → 3 lines (in/out/cache).
      const bucketed = bucketResultByType(series);
      const { data, series: uplotSeries, lastVals } = bucketedSeriesToUplot(bucketed);
      this.bodyEl.appendChild(el('div', { class: 'view-live' },
        el('div', { class: 'stat-row tok-stat-row' },
          el('span', { class: 'k' }, `tok/s (${pickRateWindow(ws)} rate, ${_windowLabel(ws)})`),
          el('span', { class: 'v tok-vals' },
            el('span', { class: 'tok-in',    style: `color:${TOKEN_BUCKET_COLOR.input}`  }, `in ${lastVals.input.toFixed(2)}`),
            el('span', { class: 'tok-sep' }, ' · '),
            el('span', { class: 'tok-out',   style: `color:${TOKEN_BUCKET_COLOR.output}` }, `out ${lastVals.output.toFixed(2)}`),
            el('span', { class: 'tok-sep' }, ' · '),
            el('span', { class: 'tok-cache', style: `color:${TOKEN_BUCKET_COLOR.cache}`  }, `cache ${lastVals.cache.toFixed(2)}`),
          ))));
      const host = el('div', { class: 'chart-host' });
      this.bodyEl.appendChild(host);
      tinyMultiChart(host, data, uplotSeries, {
        emptyText: 'no telemetry — install Path A, or session idle >5min, or just-restarted (wait 60s)',
      });
      this.bodyEl.appendChild(_freshnessEl(fromSse ? perAgentFrames._tokensTs : Date.now()));
    }
    async _renderCost() {
      clearChildren(this.bodyEl);
      this.bodyEl.className = 'agent-card-body view-cost';
      const ws = cardsWindow.windowS;
      let cum = null;
      const cumPayload = perAgentFrames.costCumByAgent;
      if (cumPayload && cumPayload.data && cumPayload.data.result) {
        const match = cumPayload.data.result.find(s => s.metric.plexus_agent_id === this.agentId);
        if (match) cum = parseFloat(match.value[1]);
      }
      this.bodyEl.appendChild(el('div', { class: 'cum' },
        cum == null ? '—' : (cum >= 1 ? '$' + cum.toFixed(2) : '$' + cum.toFixed(4))));
      this.bodyEl.appendChild(el('div', { class: 'cum-sub' }, 'cumulative all-time spend'));
      let series, fromSse = false;
      // CP6.14: same cold-cache → fetch-history pattern as _renderActivity
      if (ws === 3600 && perAgentFrames.costByAgent !== null) {
        series = seriesForAgent(perAgentFrames.costByAgent, this.agentId);
        fromSse = true;
      } else if (ws === 3600) {
        this.bodyEl.appendChild(el('div', { class: 'view-loading-inline' }, 'loading history…'));
        const seq = ++cardsWindow.fetchSeq;
        series = await fetchAgentSeries('cost.rate.byAgent', this.agentId, ws);
        if (seq !== cardsWindow.fetchSeq || this.currentView !== 2) return;
        const loadingEl = this.bodyEl.querySelector('.view-loading-inline');
        if (loadingEl) loadingEl.remove();
      } else {
        this.bodyEl.appendChild(el('div', { class: 'view-loading-inline' }, `fetching ${ws/3600}h…`));
        const seq = ++cardsWindow.fetchSeq;
        series = await fetchAgentSeries('cost.rate.byAgent', this.agentId, ws);
        if (seq !== cardsWindow.fetchSeq || this.currentView !== 2) return;
        // Remove only the loading-inline el (keep cum + cum-sub)
        const loadingEl = this.bodyEl.querySelector('.view-loading-inline');
        if (loadingEl) loadingEl.remove();
      }
      const data = aggregateSeriesToUplot(series);
      const host = el('div', { class: 'chart-host' });
      this.bodyEl.appendChild(host);
      tinyChart(host, data, {
        label: '$/s',
        fmt: (v) => '$' + v.toFixed(6) + '/s',
        emptyText: 'no telemetry — install Path A, or session idle >5min, or just-restarted (wait 60s)',
      });
      this.bodyEl.appendChild(_freshnessEl(fromSse ? perAgentFrames._costTs : Date.now()));
    }
    // v0.5.8.3: extracted shared fetch so Identity + Runtime both await
    // the same Promise. Eliminates the recursive _render path that caused
    // mid-render glitches when the body was partially built then cleared.
    async _ensureIdentityCache() {
      const needFetch = this.identityCache === null || this.identityCache === false;
      if (!needFetch) return this.identityCache;
      if (this.identityFetchPromise) return this.identityFetchPromise;
      this.identityFetchPromise = (async () => {
        try {
          const qs = new URLSearchParams({ template: 'agent.identity.byAgentId', agent_id: this.agentId });
          const res = await fetch('/api/v1/plexus/public/query?' + qs.toString(), { cache: 'no-store' });
          if (res.ok) {
            const respBody = await res.json();
            const results = respBody.data && respBody.data.result;
            this.identityCache = (results && results.length > 0) ? results[0].metric : false;
          } else {
            this.identityCache = false;
          }
        } catch (e) { this.identityCache = false; }
        this.identityFetchPromise = null;
        return this.identityCache;
      })();
      return this.identityFetchPromise;
    }
    async _renderIdentity() {
      clearChildren(this.bodyEl);
      this.bodyEl.className = 'agent-card-body view-identity';
      const cached = this.identityCache;
      if (cached === null || cached === false) {
        this.bodyEl.appendChild(el('div', { class: 'view-empty' }, 'fetching…'));
        await this._ensureIdentityCache();
        if (this.currentView !== 3) return;
        clearChildren(this.bodyEl);
      }
      const metric = this.identityCache;
      if (!metric) {
        // v0.5.8.3: runtime-aware empty state messaging.
        const runtime = resolveRuntime(this.agentId, this.presence);
        let msg;
        if (runtime === 'codex') {
          msg = 'OpenAI Codex doesn’t emit Plexus telemetry (Anthropic OTel-only)';
        } else if (runtime === 'gemini') {
          msg = 'no Gemini identity data in last 24h — session not yet run, or daemon offline';
        } else {
          msg = 'no OTel data in last 24h — agent not opted in to Plexus, or no CC sessions yet';
        }
        this.bodyEl.appendChild(el('div', { class: 'view-empty' }, msg));
        return;
      }
      // CP6.10: Identity = pure Anthropic-account identity. Runtime
      // fingerprint (CC version / os / arch / terminal / service_name /
      // query_source) moved to the Runtime view.
      const identitySectionIds = ['plexus', 'anthropic'];
      for (const sec of POPOVER_SECTIONS.filter(s => identitySectionIds.includes(s.id))) {
        const fields = POPOVER_IDENTITY_FIELDS.filter(f => f.section === sec.id && metric[f.key] != null);
        if (!fields.length) continue;
        this.bodyEl.appendChild(el('h4', null, sec.title));
        const dl = el('dl');
        for (const f of fields) {
          const v = metric[f.key];
          const display = f.truncate ? truncMid(v, f.truncate) : v;
          dl.appendChild(el('dt', null, f.label));
          dl.appendChild(el('dd', { title: v }, display));
        }
        this.bodyEl.appendChild(dl);
      }
      // CP17.C Task 3: cross-nav link to Repos tab filtered to this agent.
      // Hash param handled by _reposReadHashParams on mount. Anchor is
      // keyboard-accessible via native <a> semantics.
      const crossNav = el('div', { class: 'agent-card-cross-nav' });
      crossNav.appendChild(el('a', {
        href: `#repos?agent=${encodeURIComponent(this.agentId)}`,
        class: 'agent-card-cross-nav-link',
      }, 'View activity across repos →'));
      this.bodyEl.appendChild(crossNav);
    }
    // CP6.10: Runtime view — technical detail for SREs / debuggers.
    // Four sections:
    //   1. Daemon process    pid / version / started_at / hostname / uid / gid
    //   2. Runtime fingerprint   OTel: CC version / os / arch / terminal /
    //                            service_name / query_source (moved here from
    //                            Identity per Jon-direct 2026-05-26)
    //   3. CC session            cwd / model / source / current_tool /
    //                            last_tool_name / last_tool_status
    //   4. Plexus wire state     events_consumer_count / sse_connected /
    //                            cursor_position / last_hook_at /
    //                            last_state_change_at
    //
    // Sources: (1) + (3) + (4) from presence row (no fetch); (2) reuses
    // identityCache lazy-fetch (shared with Identity view).
    async _renderRuntime() {
      // v0.5.8.3: kick the OTel fetch BEFORE building DOM, so we render the
      // full view exactly once. Prior code rendered Daemon section, then
      // appended a "fetching..." el, awaited, then recursed into _renderRuntime
      // — that re-cleared the body and built it twice, causing flicker +
      // intermittent half-rendered states.
      const cached = this.identityCache;
      if (cached === null || cached === false) {
        const fetchP = this._ensureIdentityCache();
        // Render skeleton with a placeholder while we wait; replace once resolved.
        // (Most fetches complete in <200ms thanks to server 60s cache.)
        await fetchP;
        if (this.currentView !== 4) return;
      }
      clearChildren(this.bodyEl);
      this.bodyEl.className = 'agent-card-body view-identity';
      const r = this.presence || {};
      const has = (k) => r[k] != null && r[k] !== '';
      const fmtIso = (s) => {
        if (!s) return '—';
        try { return new Date(s).toLocaleString(); } catch { return s; }
      };
      const ageOf = (s) => {
        if (!s) return null;
        const ms = Date.now() - new Date(s).getTime();
        if (Number.isNaN(ms)) return null;
        return fmtAge(s);
      };

      // ── Section 1: Daemon process ─────────────────────────────
      this.bodyEl.appendChild(el('h4', null, 'Daemon process'));
      const daemonDl = el('dl');
      const daemonAge = ageOf(r.daemon_started_at);
      const daemonFields = [
        ['version',    has('daemon_version') ? r.daemon_version : '(pre-v0.5.7.4)'],
        ['pid',        has('daemon_pid') ? String(r.daemon_pid) : '(not reported)'],
        ['started',    has('daemon_started_at')
                         ? `${fmtIso(r.daemon_started_at)} (${daemonAge})`
                         : '(not reported)'],
        ['hostname',   has('runtime_hostname') ? r.runtime_hostname : '(not reported)'],
        ['uid / gid',  (has('runtime_uid') || has('runtime_gid'))
                        ? `${has('runtime_uid') ? r.runtime_uid : '?'} / ${has('runtime_gid') ? r.runtime_gid : '?'}`
                        : '(not reported)'],
      ];
      for (const [k, v] of daemonFields) {
        daemonDl.appendChild(el('dt', null, k));
        daemonDl.appendChild(el('dd', { title: String(v) }, String(v)));
      }
      this.bodyEl.appendChild(daemonDl);

      // ── Section 2: Runtime fingerprint (OTel; cache populated before render)
      this.bodyEl.appendChild(el('h4', null, 'Runtime fingerprint (OTel)'));
      const metric = this.identityCache;
      if (!metric) {
        // v0.5.8.3: runtime-aware empty messaging (matches _renderIdentity).
        const runtime = resolveRuntime(this.agentId, this.presence);
        let msg;
        if (runtime === 'codex') {
          msg = 'OpenAI Codex doesn’t emit Plexus telemetry';
        } else if (runtime === 'gemini') {
          msg = 'no Gemini OTel observations in last 24h';
        } else {
          msg = 'no CC OTel observations in last 24h — agent not opted in, or no sessions yet';
        }
        this.bodyEl.appendChild(el('div', { class: 'view-empty', style: 'padding: 8px 0;' }, msg));
      } else {
        const runtimeFields = POPOVER_IDENTITY_FIELDS.filter(f => f.section === 'runtime' && metric[f.key] != null);
        if (runtimeFields.length) {
          const fpDl = el('dl');
          for (const f of runtimeFields) {
            const v = metric[f.key];
            const display = f.truncate ? truncMid(v, f.truncate) : v;
            fpDl.appendChild(el('dt', null, f.label));
            fpDl.appendChild(el('dd', { title: v }, display));
          }
          this.bodyEl.appendChild(fpDl);
        } else {
          this.bodyEl.appendChild(el('div', { class: 'view-empty', style: 'padding: 8px 0;' },
            'no runtime fingerprint labels in current OTel series'));
        }
      }

      // ── Section 3: CC session ─────────────────────────────────
      this.bodyEl.appendChild(el('h4', null, 'CC session'));
      const sessDl = el('dl');
      const toolLine = r.current_tool
        ? `${r.current_tool} (running)`
        : (r.last_tool_name ? `last: ${r.last_tool_name}${r.last_tool_status ? ' ('+r.last_tool_status+')' : ''}` : '—');
      const sessFields = [
        ['cwd',       has('current_cwd') ? r.current_cwd : '(not reported)'],
        ['model',     shortenModel(r.current_model) || '—'],
        ['source',    r.last_session_source || '—'],
        ['tool',      toolLine],
        ['stop',      r.last_stop_reason || '—'],
        ['subagents', r.subagent_active_count == null ? '—' : String(r.subagent_active_count)],
      ];
      for (const [k, v] of sessFields) {
        sessDl.appendChild(el('dt', null, k));
        sessDl.appendChild(el('dd', { title: String(v) }, String(v)));
      }
      this.bodyEl.appendChild(sessDl);

      // ── Section 4: Plexus wire state ─────────────────────────
      this.bodyEl.appendChild(el('h4', null, 'Plexus wire state'));
      const wireDl = el('dl');
      const hookAge = ageOf(r.last_hook_at);
      const stateAge = ageOf(r.last_state_change_at);
      const wireFields = [
        ['daemon state',  r.daemon_state || '—'],
        ['session state', r.session_state || '—'],
        ['label',         r.label || '—'],
        ['consumers',     r.events_consumer_count == null ? '—' : String(r.events_consumer_count)],
        ['sse',           r.sse_connected ? 'connected' : 'disconnected'],
        ['cursor',        r.cursor_position == null ? '—' : String(r.cursor_position)],
        ['last hook',     hookAge || '—'],
        ['last state Δ',  stateAge || '—'],
      ];
      for (const [k, v] of wireFields) {
        wireDl.appendChild(el('dt', null, k));
        wireDl.appendChild(el('dd', { title: String(v) }, String(v)));
      }
      this.bodyEl.appendChild(wireDl);
    }
    // CP10.3 M3: per-agent event-trace bubble timeline.
    // Fetches /plexus/public/activity?agent_id=X (operator-only network-isolation
    // trust). Renders each event as an agent-colored bubble, newest-first.
    // Distillation is daemon-side (allowlist-redacted secrets); UI just renders.
    async _renderTrace() {
      // Task #260 Phase B (parch #11233 RATIFY): ptah-* agents render Ptah ORP
      // trace records via the dedicated ORP endpoints (sister-shape existing
      // generic-activity view). Non-ptah agents keep existing render unchanged.
      // Per PLAN-PTAH-ORP-DASHBOARD-LIVE-PANE §5.
      if (/^ptah-/.test(this.agentId)) return this._renderPtahTrace();
      clearChildren(this.bodyEl);
      this.bodyEl.className = 'agent-card-body view-trace';
      this.bodyEl.appendChild(el('div', { class: 'view-loading-inline' }, 'loading activity…'));
      const seq = ++this._traceSeq || (this._traceSeq = 1);
      try {
        const r = await fetch(`/api/v1/plexus/public/activity?agent_id=${encodeURIComponent(this.agentId)}&limit=50`);
        if (this.currentView !== 5) return;
        if (this._traceSeq !== seq) return;
        clearChildren(this.bodyEl);
        if (!r.ok) {
          this.bodyEl.appendChild(el('div', { class: 'view-empty' }, `error: HTTP ${r.status}`));
          return;
        }
        const j = await r.json();
        const events = j.activity || [];
        if (events.length === 0) {
          this.bodyEl.appendChild(el('div', { class: 'view-empty' },
            'no activity captured yet — daemon needs v0.5.15+ (M2 rollout pending)'));
          return;
        }
        const ac = agentColor(this.agentId);
        const wrap = el('div', { class: 'trace-stream' });
        // Events come newest-first from server; render in that order (newest at top)
        for (const ev of events) {
          const row = el('div', { class: 'trace-row' });
          row.appendChild(el('span', { class: 'trace-icon' }, traceIcon(ev.event)));
          const bubble = el('div', {
            class: 'trace-bubble',
            style: `background:${ac.hex}`,
            title: `${ev.event} · ${ev.ts || ''} · #${ev.id}`,
          });
          bubble.appendChild(el('span', { class: 'trace-evt' }, ev.event));
          const summary = summarizeTraceEvent(ev);
          if (summary) bubble.appendChild(el('span', { class: 'trace-sum' }, ' · ' + summary));
          row.appendChild(bubble);
          row.appendChild(el('span', { class: 'trace-age' }, _fmtAgeShort(ev.ts)));
          wrap.appendChild(row);
        }
        this.bodyEl.appendChild(wrap);
        // 5s auto-refresh while this view is active
        if (this._traceInterval) clearInterval(this._traceInterval);
        this._traceInterval = setInterval(() => {
          if (this.currentView === 5) this._renderTrace();
          else { clearInterval(this._traceInterval); this._traceInterval = null; }
        }, 5000);
      } catch (e) {
        if (this.currentView !== 5) return;
        clearChildren(this.bodyEl);
        this.bodyEl.appendChild(el('div', { class: 'view-empty' }, 'error: ' + e.message));
      }
    }

    // Task #260 Phase B: Ptah ORP trace render (parch #11233 RATIFY view=5
    // branch per OQ3). Sister-shape existing _renderTrace polling + trace-row
    // bubble render but sources from /api/v1/plexus/ptah-orp/<agent>/{episodes,trace}
    // per Task #246 substrate. Auth via sessionStorage plexus_operator_bearer
    // (OQ2 empirical-verified sister-shape PlexusOperatorDM at dashboard.js:6294).
    async _renderPtahTrace() {
      clearChildren(this.bodyEl);
      this.bodyEl.className = 'agent-card-body view-trace view-ptah-trace';
      this.bodyEl.appendChild(el('div', { class: 'view-loading-inline' }, 'loading Ptah trace…'));
      const seq = ++this._traceSeq || (this._traceSeq = 1);
      const bearer = sessionStorage.getItem('plexus_operator_bearer');
      const headers = bearer ? { Authorization: `Bearer ${bearer}` } : {};
      try {
        // Phase B.1 (Jon-direct 2026-07-01 overnight-visibility): fetch recent
        // episode LIST (was limit=1); operator picks from dropdown to review
        // historical episodes. Sticky per-instance selection preserved across
        // 5s auto-refresh so poll doesn't hijack the operator's active review.
        const epRes = await fetch(
          `/api/v1/plexus/ptah-orp/${encodeURIComponent(this.agentId)}/episodes?limit=20`,
          { headers },
        );
        if (this.currentView !== 5) return;
        if (this._traceSeq !== seq) return;
        clearChildren(this.bodyEl);
        if (epRes.status === 401 || epRes.status === 403) {
          this.bodyEl.appendChild(el('div', { class: 'view-empty' },
            'Operator login required to view Ptah traces (session-context PII scope).'));
          return;
        }
        if (!epRes.ok) {
          this.bodyEl.appendChild(el('div', { class: 'view-empty' }, 'Couldn’t load Ptah episodes. Retry shortly.'));
          return;
        }
        const epJson = await epRes.json();
        const episodes = epJson.episodes || [];
        if (episodes.length === 0) {
          this.bodyEl.appendChild(el('div', { class: 'view-empty' },
            'No Ptah episodes yet. Awaiting the first trace emit.'));
          this._schedulePtahTracePoll();
          return;
        }
        // Resolve selected episode: sticky prior selection if still present, else most-recent (episodes[0])
        let ep = episodes[0];
        if (this._ptahSelectedEpisodeId) {
          const found = episodes.find((e) => e.episode_id === this._ptahSelectedEpisodeId);
          if (found) ep = found;
          else this._ptahSelectedEpisodeId = null;  // vanished (e.g. purged); revert to newest
        }
        // Fetch traces for selected episode
        const trRes = await fetch(
          `/api/v1/plexus/ptah-orp/${encodeURIComponent(this.agentId)}/trace?episode_id=${encodeURIComponent(ep.episode_id)}&limit=200`,
          { headers },
        );
        if (this.currentView !== 5) return;
        if (this._traceSeq !== seq) return;
        if (!trRes.ok) {
          this.bodyEl.appendChild(el('div', { class: 'view-empty' }, 'Couldn’t load traces for this episode. Retry shortly.'));
          this._schedulePtahTracePoll();
          return;
        }
        const trJson = await trRes.json();
        const traces = trJson.traces || [];
        // Episode picker (dropdown) — Phase B.1 historical navigation
        const pickerRow = el('div', { class: 'ptah-episode-picker' });
        pickerRow.appendChild(el('span', { class: 'ptah-picker-label' }, `Episode (${episodes.length}):`));
        const select = el('select', { class: 'ptah-episode-select', 'aria-label': 'Select Ptah episode to view' });
        for (const e of episodes) {
          const shortId = String(e.episode_id || '').slice(0, 24);
          const started = e.started_at ? _fmtAgeShort(e.started_at) : '?';
          const goalMark = e.goal_terminal === 'completed' ? ' ✓' : (e.goal_terminal === 'blocked' ? ' ⚠' : '');
          const opt = el('option', { value: e.episode_id }, `${shortId} · ${started} · @${e.last_tick ?? '?'}${goalMark}`);
          if (e.episode_id === ep.episode_id) opt.selected = true;
          select.appendChild(opt);
        }
        select.addEventListener('change', (ev) => {
          this._ptahSelectedEpisodeId = ev.target.value;
          this._renderPtahTrace();  // re-fetch with new selection
        });
        pickerRow.appendChild(select);
        this.bodyEl.appendChild(pickerRow);
        // Episode header (metadata for selected)
        const epShort = String(ep.episode_id || '').slice(0, 12);
        const goalState = ep.goal_terminal || 'pending';
        const startedAgo = ep.started_at ? _fmtAgeShort(ep.started_at) : '?';
        const header = el('div', { class: 'ptah-episode-header', title: ep.episode_id },
          `${epShort}… · started ${startedAgo} · orp_v${ep.orp_version || '?'} · @tick ${ep.last_tick ?? '?'} · goal:${goalState}`);
        this.bodyEl.appendChild(header);
        // Tick timeline (sister-shape existing trace-stream bubbles)
        if (traces.length === 0) {
          this.bodyEl.appendChild(el('div', { class: 'view-empty' },
            'Episode exists but no trace records yet.'));
        } else {
          const wrap = el('div', { class: 'trace-stream' });
          // Server returns ordered by (episode_id, tick); render chronological
          for (const t of traces) {
            const row = el('div', { class: 'trace-row' });
            row.appendChild(el('span', { class: 'trace-icon' }, _ptahTickIcon(t.result_dispatch)));
            const decisionLabel = t.chosen_decision || '?';
            const summary = String(t.snapshot_summary || '').slice(0, 60);
            const bubble = el('div', {
              class: 'trace-bubble ' + _ptahDispatchClass(t.result_dispatch),
              title: `T${t.tick} · decision=${decisionLabel} · dispatch=${t.result_dispatch || 'null'} · ${t.received_at || ''}`,
            });
            bubble.appendChild(el('span', { class: 'trace-evt' }, `T${t.tick}`));
            bubble.appendChild(el('span', { class: 'trace-sum' }, ' · ' + decisionLabel + (summary ? ' · ' + summary : '')));
            row.appendChild(bubble);
            const ageMs = t.ts_unix_ms ? Date.now() - Number(t.ts_unix_ms) : null;
            row.appendChild(el('span', { class: 'trace-age' }, ageMs != null ? _fmtAgeShort(new Date(t.ts_unix_ms).toISOString()) : ''));
            wrap.appendChild(row);
          }
          this.bodyEl.appendChild(wrap);
        }
        this._schedulePtahTracePoll();
      } catch (e) {
        if (this.currentView !== 5) return;
        clearChildren(this.bodyEl);
        this.bodyEl.appendChild(el('div', { class: 'view-empty' }, 'error: ' + e.message));
      }
    }

    _schedulePtahTracePoll() {
      // 5s auto-refresh per OQ1 RATIFY (MVP sister-shape existing _renderTrace cadence)
      if (this._traceInterval) clearInterval(this._traceInterval);
      this._traceInterval = setInterval(() => {
        if (this.currentView === 5) this._renderTrace();
        else { clearInterval(this._traceInterval); this._traceInterval = null; }
      }, 5000);
    }
  }
  // Task #260 helpers for Ptah tick render — outside class for purity.
  function _ptahTickIcon(dispatch) {
    switch (dispatch) {
      case 'accept':
      case 'applied':  return '✅';
      case 'reject':   return '❌';
      case 'defer':
      case 'retry':    return '⏸';
      default:         return '·';
    }
  }
  function _ptahDispatchClass(dispatch) {
    if (dispatch === 'accept' || dispatch === 'applied') return 'ptah-dispatch-accept';
    if (dispatch === 'reject') return 'ptah-dispatch-reject';
    if (dispatch === 'defer' || dispatch === 'retry') return 'ptah-dispatch-defer';
    return '';
  }
  // Tiny helpers for trace view — outside the class so they can stay pure.
  function traceIcon(event) {
    switch (event) {
      case 'SessionStart': return '🟢';
      case 'Stop': return '🤖';
      case 'StopFailure': return '🛑';
      case 'PreToolUse': return '🔧';
      case 'PostToolUse': return '✓';
      case 'PostToolUseFailure': return '⚠️';
      case 'UserPromptSubmit': return '📥';
      case 'SubagentStart': return '🧠';
      case 'SubagentStop': return '↩️';
      case 'Compaction': case 'PreCompact': return '💾';
      default: return '·';
    }
  }
  function summarizeTraceEvent(ev) {
    const p = ev.payload || {};
    const parts = [];
    if (p.tool) parts.push(p.tool);
    if (p.cmd) parts.push('`' + String(p.cmd).slice(0, 60) + '`');
    else if (p.cmd_preview) parts.push('`' + String(p.cmd_preview).slice(0, 60) + '`');
    if (p.file) parts.push(String(p.file).replace(/^\/home\/[^/]+/, '~'));
    else if (p.file_path) parts.push(String(p.file_path).replace(/^\/home\/[^/]+/, '~'));
    if (p.pattern) parts.push(`/${p.pattern}/`);
    if (p.url) parts.push(p.url);
    if (p.subagent_type) parts.push(p.subagent_type);
    if (p.desc) parts.push('"' + String(p.desc).slice(0, 40) + '"');
    if (p.model) parts.push(p.model);
    if (p.status) parts.push(p.status);
    if (p.duration_ms != null) parts.push(p.duration_ms + 'ms');
    if (p.reason) parts.push(p.reason);
    return parts.join(' ');
  }
  function _fmtAgeShort(iso) {
    // CP10.5.3: same UTC-parse fix as fmtAge (Trace view bubble ages were
    // also negative for west-of-UTC browsers when the timestamp came from
    // SQLite's naive 'YYYY-MM-DD HH:MM:SS' format).
    if (!iso) return '';
    const dStr = iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z';
    const ts = new Date(dStr);
    if (Number.isNaN(ts.getTime())) return '';
    const ms = Math.max(0, Date.now() - ts.getTime());
    if (ms < 60_000) return Math.floor(ms / 1000) + 's';
    if (ms < 3_600_000) return Math.floor(ms / 60_000) + 'm';
    if (ms < 86_400_000) return Math.floor(ms / 3_600_000) + 'h';
    return Math.floor(ms / 86_400_000) + 'd';
  }

  // CP6.5: history-window toggle (1h / 6h / 24h / 7d).
  // Triggers rerender of any card currently showing Activity or Cost view.
  document.querySelectorAll('#cards-window-toggle button').forEach((btn) => {
    btn.addEventListener('click', () => {
      // Task #264 Phase 2.2: when dashboard picker is non-live, per-card
      // toggle is overridden — silently ignore clicks (visually disabled).
      if (btn.classList.contains('trp-clamp-disabled')) return;
      const ws = parseInt(btn.dataset.windowS, 10);
      if (ws === cardsWindow.windowS) return;
      cardsWindow.windowS = ws;
      // Update toggle visuals
      document.querySelectorAll('#cards-window-toggle button').forEach((x) => {
        x.classList.toggle('active', x === btn);
        x.style.color = (x === btn) ? 'var(--blue)' : 'var(--muted)';
      });
      // Invalidate cache (the 60s TTL would auto-expire, but switching window
      // demands instant refresh)
      cardsFetchCache.clear();
      // Rerender visible chart cards
      for (const card of cardInstances.values()) {
        if (card.currentView === 1 || card.currentView === 2) card.rerenderBody();
      }
    });
  });

  // Task #264 Phase 2.2 (Jon-direct 2026-07-03): unify AgentCard Activity/Cost
  // views under the top-level dashboard time-range picker. Per-card cardsWindow
  // toggle (1h/6h/24h/7d) is clamped in non-live mode — picker owns windowS.
  // On return to Live: restore user's last per-card choice (or default 1h).
  let _savedCardsWindowS = cardsWindow.windowS;   // user's per-card pick to restore
  let _prevDashboardWasLive = true;                // for save-only-on-transition-from-live
  function _syncCardsPickerClamp(clamped) {
    document.querySelectorAll('#cards-window-toggle button').forEach((btn) => {
      btn.classList.toggle('trp-clamp-disabled', !!clamped);
      btn.style.opacity = clamped ? '0.35' : '';
      btn.style.cursor = clamped ? 'not-allowed' : '';
      if (clamped) btn.setAttribute('aria-disabled', 'true');
      else btn.removeAttribute('aria-disabled');
    });
  }
  document.addEventListener('dashboardTimeRangeChange', (e) => {
    const preset = e.detail && e.detail.preset;
    const win = e.detail && e.detail.window;
    const goingLive = preset === 'live';
    if (goingLive) {
      cardsWindow.windowS = _savedCardsWindowS;
      _syncCardsPickerClamp(false);
    } else if (win && win.windowS) {
      if (_prevDashboardWasLive) _savedCardsWindowS = cardsWindow.windowS;
      cardsWindow.windowS = win.windowS;
      _syncCardsPickerClamp(true);
    }
    _prevDashboardWasLive = goingLive;
    cardsFetchCache.clear();
    for (const card of cardInstances.values()) {
      if (card.currentView === 1 || card.currentView === 2) card.rerenderBody();
    }
  });
  // Initial-load hash with `?range=<preset>`: apply clamp on mount.
  if (window.getDashboardTimeWindow) {
    const initWin = window.getDashboardTimeWindow();
    if (initWin && initWin.windowS) {
      _savedCardsWindowS = cardsWindow.windowS;
      cardsWindow.windowS = initWin.windowS;
      _syncCardsPickerClamp(true);
      _prevDashboardWasLive = false;
    }
  }

  // CP8.3 (2026-05-27): card-grid filter state. Pure-client filter applied
  // in renderCards (cards re-render every presence poll = filter naturally
  // re-applies). All on by default.
  const cardFilter = {
    search: '',
    statuses: new Set(['online', 'stalled', 'offline']),
    // 2026-06-19: 'ptah' added per ADR-0032 Phase 0-Ptah sister-cycle
    // (CP14.1 runtime_class enum extension Jon-ratified #9643). Keep in
    // sync with filter-chip UI in dashboard.html + reset handler below.
    runtimes: new Set(['claude_code', 'gemini', 'codex', 'ptah']),
  };
  function statusBucket(label) {
    if (!label) return 'offline';
    if (label.startsWith('online') || label === 'compacting' || label === 'stop_failure') return 'online';
    if (label === 'stalled') return 'stalled';
    return 'offline';   // includes 'offline', 'daemon_only', 'unknown', anything else
  }
  // F4 (parch #8743): stale-idle agents bucket as stalled for filtering,
  // matching the visual decay + count semantics. Same 30min threshold.
  function isStaleIdle(r) {
    if (r.label !== 'online_idle' || !r.last_hook_at) return false;
    const ageMs = Date.now() - new Date(r.last_hook_at).getTime();
    return Number.isFinite(ageMs) && ageMs > 30 * 60 * 1000;
  }
  function passesCardFilter(r) {
    const q = cardFilter.search.trim().toLowerCase();
    if (q && !((r.agent_id || '').toLowerCase().includes(q))) return false;
    const bucket = isStaleIdle(r) ? 'stalled' : statusBucket(r.label);
    if (!cardFilter.statuses.has(bucket)) return false;
    const runtime = resolveRuntime(r.agent_id, r);
    if (runtime && !cardFilter.runtimes.has(runtime)) return false;
    return true;
  }

  function renderCards(presence) {
    const grid = $('cards-grid');
    if (!grid) return;
    // Sort: online states first, then by label, then by name
    const sortedAll = presence.slice().sort((a, b) => {
      const aOn = a.label && a.label.startsWith('online') ? 0 : 1;
      const bOn = b.label && b.label.startsWith('online') ? 0 : 1;
      if (aOn !== bOn) return aOn - bOn;
      const ag = (a.label || '').localeCompare(b.label || '');
      if (ag !== 0) return ag;
      return (a.agent_id || '').localeCompare(b.agent_id || '');
    });
    const sorted = sortedAll.filter(passesCardFilter);
    // Build/update cards (only for visible)
    const visibleIds = new Set();
    let firstPaint = false;
    if (grid.querySelector('.chart-loading')) { clearChildren(grid); firstPaint = true; }
    for (const r of sorted) {
      visibleIds.add(r.agent_id);
      let card = cardInstances.get(r.agent_id);
      if (!card) {
        card = new AgentCard(r.agent_id);
        cardInstances.set(r.agent_id, card);
        grid.appendChild(card.el);
      }
      card.update(r);
    }
    // Remove cards for agents not in the visible set (either filtered or gone)
    for (const id of [...cardInstances.keys()]) {
      if (!visibleIds.has(id)) {
        const card = cardInstances.get(id);
        if (card && card.el && card.el.parentNode) card.el.parentNode.removeChild(card.el);
        cardInstances.delete(id);
      }
    }
    // Reorder DOM to match sort (cards may have been appended in old order)
    for (const r of sorted) {
      const card = cardInstances.get(r.agent_id);
      if (card && card.el) grid.appendChild(card.el);
    }
    // Update meta — show filtered/total + OTel count consistent with the
    // visible cohort (apples-to-apples). When filter is active, the cluster-
    // total appears in parens so operator still knows the full picture.
    const metaEl = $('cards-meta');
    if (metaEl) {
      const visN = sorted.length;
      const totN = sortedAll.length;
      const otelVisN = sorted.filter(r => agentOtelStatus(r.agent_id)).length;
      const otelTotN = sortedAll.filter(r => agentOtelStatus(r.agent_id)).length;
      const filterActive = (visN !== totN);
      metaEl.textContent = filterActive
        ? `${visN} of ${totN} agents shown · ${otelVisN} of ${visN} visible emitting OTel (cluster total: ${otelTotN})`
        : `${totN} agents · ${otelTotN} emitting OTel`;
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // CP3: AgentPopover — click-to-open identity + runtime fingerprint card.
  // Fetches via agent.identity.byAgentId template; falls back to "no OTel
  // data" if Prom returns no series. Also pulls the latest presence row
  // from cached /presence/public for v0.5.7 fields.
  // ────────────────────────────────────────────────────────────────────
  const POPOVER_IDENTITY_FIELDS = [
    { key: 'plexus_agent_id',    label: 'agent_id',    section: 'plexus' },
    { key: 'plexus_cluster_id',  label: 'cluster',     section: 'plexus' },
    { key: 'plexus_deployment',  label: 'deployment',  section: 'plexus' },
    { key: 'plexus_run_kind',    label: 'run kind',    section: 'plexus' },
    { key: 'user_email',         label: 'email',       section: 'anthropic' },
    { key: 'user_account_id',    label: 'account_id',  section: 'anthropic' },
    { key: 'user_account_uuid',  label: 'account_uuid',section: 'anthropic', truncate: 18 },
    { key: 'user_id',            label: 'user_id sha', section: 'anthropic', truncate: 18 },
    { key: 'organization_id',    label: 'org_id',      section: 'anthropic', truncate: 18 },
    { key: 'service_version',    label: 'CC version',  section: 'runtime' },
    { key: 'service_name',       label: 'service',     section: 'runtime' },
    { key: 'host_arch',          label: 'arch',        section: 'runtime' },
    { key: 'os_type',            label: 'os',          section: 'runtime' },
    { key: 'os_version',         label: 'os version',  section: 'runtime' },
    { key: 'terminal_type',      label: 'terminal',    section: 'runtime' },
    { key: 'query_source',       label: 'query_source',section: 'runtime' },
  ];
  const POPOVER_SECTIONS = [
    { id: 'plexus',    title: 'Plexus' },
    { id: 'anthropic', title: 'Anthropic account' },
    { id: 'runtime',   title: 'Runtime fingerprint' },
  ];

  const popoverEl = $('agent-popover');
  let popoverFetchSeq = 0;
  let popoverPrevFocus = null;  // CP4 a11y: restore focus to trigger on close

  function truncMid(s, keep) {
    if (!s) return '';
    if (s.length <= keep * 2 + 1) return s;
    return s.slice(0, keep) + '…' + s.slice(-keep);
  }

  function positionPopover(triggerEl) {
    const rect = triggerEl.getBoundingClientRect();
    const popW = 380;
    const margin = 8;
    let left = rect.left + window.scrollX;
    const top = rect.bottom + window.scrollY + 6;
    if (left + popW + margin > window.innerWidth + window.scrollX) {
      left = window.innerWidth + window.scrollX - popW - margin;
    }
    if (left < margin) left = margin;
    popoverEl.style.left = left + 'px';
    popoverEl.style.top = top + 'px';
  }

  function closePopover() {
    popoverEl.classList.remove('visible');
    popoverEl.setAttribute('aria-hidden', 'true');
    clearChildren(popoverEl);
    // CP4 a11y: restore keyboard focus to the trigger that opened us, so
    // tab order resumes naturally for screen-reader / keyboard users.
    if (popoverPrevFocus && typeof popoverPrevFocus.focus === 'function') {
      try { popoverPrevFocus.focus(); } catch (e) { /* trigger removed */ }
    }
    popoverPrevFocus = null;
  }

  function findPresenceRowFor(agentId) {
    if (!lastData || !lastData.presence) return null;
    return lastData.presence.find(r => r.agent_id === agentId) || null;
  }

  function buildPopoverShell(agentId) {
    // Returns { root, body } — root already attached to popoverEl.
    clearChildren(popoverEl);
    const head = el('div', { class: 'pop-head' });
    head.appendChild(el('h3', null, agentId));
    const closeBtn = el('button', { class: 'close', type: 'button', 'aria-label': 'close', title: 'close (ESC)' }, '×');
    closeBtn.addEventListener('click', closePopover);
    head.appendChild(closeBtn);
    popoverEl.appendChild(head);
    const body = el('div', { class: 'pop-body' });
    popoverEl.appendChild(body);
    return { body };
  }

  function renderPopoverIdentity(body, metric, presenceRow) {
    clearChildren(body);
    for (const sec of POPOVER_SECTIONS) {
      const fields = POPOVER_IDENTITY_FIELDS.filter(f => f.section === sec.id && metric && metric[f.key] != null);
      if (fields.length === 0) continue;
      const section = el('section');
      section.appendChild(el('h4', null, sec.title));
      const dl = el('dl');
      for (const f of fields) {
        const v = metric[f.key];
        const display = f.truncate ? truncMid(v, f.truncate) : v;
        dl.appendChild(el('dt', null, f.label));
        dl.appendChild(el('dd', { title: v }, display));
      }
      section.appendChild(dl);
      body.appendChild(section);
    }
    if (presenceRow) {
      const section = el('section');
      section.appendChild(el('h4', null, 'Presence (live)'));
      const dl = el('dl');
      const fields = [
        ['daemon', presenceRow.daemon_state],
        ['session', presenceRow.session_state],
        ['label', presenceRow.label],
        ['model', shortenModel(presenceRow.current_model) || '—'],
        ['current tool', presenceRow.current_tool || (presenceRow.last_tool_name ? `last: ${presenceRow.last_tool_name}` : '—')],
        ['last hook', fmtAge(presenceRow.last_hook_at)],
        ['last heartbeat', fmtAge(presenceRow.last_heartbeat_at)],
        ['cursor', presenceRow.cursor_position == null ? '—' : presenceRow.cursor_position],
      ];
      for (const [k, v] of fields) {
        dl.appendChild(el('dt', null, k));
        dl.appendChild(el('dd', null, String(v == null ? '—' : v)));
      }
      section.appendChild(dl);
      body.appendChild(section);
    }
    if (!metric && !presenceRow) {
      body.appendChild(el('div', { class: 'pop-empty' }, 'no data — agent unknown to both Plexus OTel and the presence registry'));
    } else if (!metric) {
      body.appendChild(el('div', { class: 'pop-empty' }, 'no Plexus OTel data — agent has not opted in to telemetry'));
    }
  }

  async function openPopoverFor(agentId, triggerEl) {
    const seq = ++popoverFetchSeq;
    // CP4 a11y: remember the trigger so closePopover() can restore focus.
    popoverPrevFocus = (document.activeElement && document.activeElement !== document.body)
      ? document.activeElement : triggerEl;
    const { body } = buildPopoverShell(agentId);
    popoverEl.classList.add('visible');
    popoverEl.setAttribute('aria-hidden', 'false');
    positionPopover(triggerEl);
    // CP4 a11y: focus the close button so keyboard users can dismiss with Enter/Space.
    const closeBtn = popoverEl.querySelector('.close');
    if (closeBtn) closeBtn.focus();
    body.appendChild(el('div', { class: 'pop-loading' }, 'fetching identity…'));

    const presenceRow = findPresenceRowFor(agentId);
    let metric = null;
    try {
      const qs = new URLSearchParams({ template: 'agent.identity.byAgentId', agent_id: agentId });
      const res = await fetch('/api/v1/plexus/public/query?' + qs.toString(), { cache: 'no-store' });
      if (res.ok) {
        const respBody = await res.json();
        const results = respBody.data && respBody.data.result;
        if (results && results.length > 0) metric = results[0].metric;
      }
    } catch (e) { /* swallow; render fallback */ }

    // Stale guard: another popover opened in the meantime
    if (seq !== popoverFetchSeq) return;
    if (!popoverEl.classList.contains('visible')) return;
    renderPopoverIdentity(body, metric, presenceRow);
  }

  // Click-away dismisses; ESC dismisses; click on trigger re-opens.
  document.addEventListener('click', (e) => {
    if (!popoverEl.classList.contains('visible')) return;
    if (popoverEl.contains(e.target)) return;
    if (e.target.closest && e.target.closest('.agent-clickable')) return;
    closePopover();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && popoverEl.classList.contains('visible')) closePopover();
    // CP4 a11y: Enter/Space on a focused .agent-clickable opens its popover.
    if ((e.key === 'Enter' || e.key === ' ') && e.target && e.target.classList && e.target.classList.contains('agent-clickable')) {
      const agentId = e.target.dataset.agentId;
      if (agentId) {
        e.preventDefault();
        openPopoverFor(agentId, e.target);
      }
    }
  });

  // Delegated click handler: one popover instance, all triggers.
  document.addEventListener('click', (e) => {
    const trigger = e.target.closest && e.target.closest('.agent-clickable');
    if (!trigger) return;
    const agentId = trigger.dataset.agentId;
    if (!agentId) return;
    e.stopPropagation();
    openPopoverFor(agentId, trigger);
  });

  // ────────────────────────────────────────────────────────────────────
  // CP3: Cost tab — dim-picker + window-preset + cumulative table + rate chart.
  // ────────────────────────────────────────────────────────────────────
  const COST_REFRESH_MS = 30000;

  function pickActiveOpt(containerSel, attr) {
    const c = document.querySelector(containerSel);
    if (!c) return null;
    const btn = c.querySelector('button.active');
    return btn ? btn.dataset[attr] : null;
  }

  function bindOpts(containerSel, onChange) {
    document.querySelectorAll(containerSel + ' button').forEach(b => {
      b.addEventListener('click', () => {
        const c = b.parentElement;
        c.querySelectorAll('button').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        onChange();
      });
    });
  }

  class CostView {
    constructor() {
      this.cumulativeCard = document.querySelector('[data-chart="cost-cumulative"]');
      this.cumulativeBody = this.cumulativeCard.querySelector('.chart-card-body');
      this.cumulativeStatus = this.cumulativeCard.querySelector('[data-chart-status]');
      this.rateCard = document.querySelector('[data-chart="cost-rate"]');
      this.rateBody = this.rateCard.querySelector('.chart-card-body');
      this.rateStatus = this.rateCard.querySelector('[data-chart-status]');
      this.rateChart = null;
      this.refreshTimer = null;
      this.fetchSeq = 0;
    }
    currentDim()     { return pickActiveOpt('#cost-dim-opts', 'dim'); }
    currentWindowS() { return parseInt(pickActiveOpt('#cost-window-opts', 'windowS'), 10); }

    setCumulativeStatus(t, err) { this.cumulativeStatus.textContent = t; this.cumulativeStatus.style.color = err ? 'var(--red)' : ''; }
    setRateStatus(t, err)       { this.rateStatus.textContent = t;       this.rateStatus.style.color = err ? 'var(--red)' : ''; }

    async refresh() {
      const seq = ++this.fetchSeq;
      const dim = this.currentDim();
      const windowS = this.currentWindowS();
      await Promise.all([
        this.refreshCumulative(seq, dim, windowS),
        this.refreshRate(seq, dim, windowS),
      ]);
    }

    async refreshCumulative(seq, dim, _windowS) {
      try {
        // CP8.4 (2026-05-27): parallel fetch — cumulative cost + 7d rate baseline.
        // Lets us flag rate anomalies (current >> 7d mean) on the cumulative
        // table without an extra round-trip. 7d window = ~604800s.
        const cumQs = new URLSearchParams({ template: 'cost.cumulative.byDim', dim });
        const now = Math.floor(Date.now() / 1000);
        const rateQs = new URLSearchParams({
          template: 'cost.rate.byDim', dim, window: '5m',
          from: now - 604800, to: now, step: '15m',
        });
        const [cumRes, rateRes] = await Promise.all([
          fetch('/api/v1/plexus/public/query?' + cumQs.toString(), { cache: 'no-store' }),
          fetch('/api/v1/plexus/public/query_range?' + rateQs.toString(), { cache: 'no-store' }),
        ]);
        if (!cumRes.ok) throw new Error('cum HTTP ' + cumRes.status);
        const cacheHdr = cumRes.headers.get('X-Plexus-Cache');
        const respBody = await cumRes.json();
        if (seq !== this.fetchSeq) return;
        const results = (respBody.data && respBody.data.result) || [];
        if (results.length === 0) {
          clearChildren(this.cumulativeBody);
          this.cumulativeBody.appendChild(el('div', { class: 'chart-empty' }, 'no cost data in this slice'));
          this.setCumulativeStatus(`empty · ${new Date().toLocaleTimeString()}`);
          return;
        }
        // Build rate-baseline map: {dimValue: {current, mean7d, ratio}}.
        // current = last sample of the 7d series for that dim.
        // mean7d  = arithmetic mean of all samples in the series.
        // ratio   = current / mean7d (1.0 = exactly mean; >2 flagged as anomaly).
        const ratesByDim = new Map();
        if (rateRes.ok) {
          const rateBody = await rateRes.json();
          const rateResults = (rateBody.data && rateBody.data.result) || [];
          for (const s of rateResults) {
            const dv = s.metric[dim];
            if (!dv) continue;
            const vals = (s.values || [])
              .map(([, v]) => parseFloat(v))
              .filter(v => Number.isFinite(v));
            if (vals.length === 0) continue;
            const current = vals[vals.length - 1];
            const mean7d = vals.reduce((a, b) => a + b, 0) / vals.length;
            const ratio = mean7d > 0 ? current / mean7d : 0;
            ratesByDim.set(dv, { current, mean7d, ratio });
          }
        }
        const rows = results.map(s => ({
          dimValue: s.metric[dim] || '(empty)',
          cost: parseFloat(s.value[1]) || 0,
          rate: ratesByDim.get(s.metric[dim] || '(empty)') || null,
        })).sort((a, b) => b.cost - a.cost);
        const max = rows[0].cost || 1;
        const ANOMALY_RATIO = 2.0;   // current > 2× 7d mean → flag
        const anomalyN = rows.filter(r => r.rate && r.rate.ratio >= ANOMALY_RATIO).length;
        clearChildren(this.cumulativeBody);
        const table = el('table', { class: 'cost-table' });
        const thead = el('thead');
        thead.appendChild(el('tr', null,
          el('th', null, dim),
          el('th', null, ''),
          el('th', { class: 'num' }, 'USD (all-time)'),
          el('th', { class: 'num', title: 'current cost rate (last sample of 7d series)' }, '$/hr now'),
        ));
        table.appendChild(thead);
        const tbody = el('tbody');
        // CP10.1: feed cost-spike alerts when dim is plexus_agent_id.
        // Spike alerts only fire when the cost-tab cumulative table has
        // rendered — Phase 1 limitation; Phase 2 may add background poll.
        const spikeAgents = new Set();
        for (const r of rows) {
          const tr = el('tr');
          if (r.rate && r.rate.ratio >= ANOMALY_RATIO) tr.classList.add('cost-anomaly');
          if (r.rate && r.rate.ratio >= ANOMALY_RATIO && dim === 'plexus_agent_id') {
            spikeAgents.add(r.dimValue);
            const usdPerHr = r.rate.current * 3600;
            const meanPerHr = r.rate.mean7d * 3600;
            alertEngine.pushCostSpike(r.dimValue, r.rate.ratio, meanPerHr, usdPerHr);
          }
          const dimCell = el('td', { class: 'dim-val' });
          if (dim === 'plexus_agent_id') {
            dimCell.appendChild(el('span', { class: 'agent-clickable', 'data-agent-id': r.dimValue }, r.dimValue));
          } else {
            dimCell.appendChild(document.createTextNode(r.dimValue));
          }
          tr.appendChild(dimCell);
          const bar = el('td', { class: 'bar' });
          const wrap = el('div', { class: 'bar-wrap' });
          const fill = el('div', { class: 'bar-fill' });
          fill.style.width = ((r.cost / max) * 100).toFixed(1) + '%';
          wrap.appendChild(fill); bar.appendChild(wrap); tr.appendChild(bar);
          tr.appendChild(el('td', { class: 'cost' }, '$' + r.cost.toFixed(4)));
          // Current $/hr column with optional anomaly marker
          const rateCell = el('td', { class: 'cost' });
          if (r.rate) {
            const usdPerHr = r.rate.current * 3600;
            const meanPerHr = r.rate.mean7d * 3600;
            if (r.rate.ratio >= ANOMALY_RATIO) {
              rateCell.appendChild(el('span', {
                class: 'cost-anomaly-dot',
                title: `current $${usdPerHr.toFixed(4)}/hr is ${r.rate.ratio.toFixed(1)}× the 7d mean ($${meanPerHr.toFixed(4)}/hr)`,
              }, '●'));
              rateCell.appendChild(document.createTextNode(' '));
            }
            rateCell.appendChild(document.createTextNode(
              usdPerHr >= 0.001 ? '$' + usdPerHr.toFixed(4) : '$' + usdPerHr.toExponential(1)
            ));
          } else {
            rateCell.appendChild(el('span', { class: 'muted' }, '—'));
          }
          tr.appendChild(rateCell);
          tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        this.cumulativeBody.appendChild(table);
        // CP10.1: auto-resolve cost-spike alerts for agents no longer flagged.
        if (dim === 'plexus_agent_id') alertEngine.syncCostSpikes(spikeAgents);
        const anomalyTxt = anomalyN > 0 ? `· 🔴 ${anomalyN} anomaly` : '';
        this.setCumulativeStatus(`${rows.length} ${dim}(s) ${anomalyTxt} · ${cacheHdr || '—'} · ${new Date().toLocaleTimeString()}`);
      } catch (e) {
        clearChildren(this.cumulativeBody);
        this.cumulativeBody.appendChild(el('div', { class: 'chart-error' }, 'error: ' + e.message));
        this.setCumulativeStatus('error', true);
      }
    }

    async refreshRate(seq, dim, windowS) {
      try {
        const to = Math.floor(Date.now() / 1000);
        const from = to - windowS;
        const step = windowS <=  3600 ? '15s'
                   : windowS <= 21600 ? '1m'
                   : windowS <= 86400 ? '5m'
                   : '15m';
        const qs = new URLSearchParams({ template: 'cost.rate.byDim', dim, window: '5m', from, to, step });
        const res = await fetch('/api/v1/plexus/public/query_range?' + qs.toString(), { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const cacheHdr = res.headers.get('X-Plexus-Cache');
        const respBody = await res.json();
        if (seq !== this.fetchSeq) return;
        const results = (respBody.data && respBody.data.result) || [];
        if (results.length === 0) {
          if (this.rateChart) { this.rateChart.destroy(); this.rateChart = null; }
          clearChildren(this.rateBody);
          this.rateBody.appendChild(el('div', { class: 'chart-empty' }, 'no cost rate in this window'));
          this.setRateStatus(`empty · ${new Date().toLocaleTimeString()}`);
          return;
        }
        const tsSet = new Set();
        for (const s of results) for (const [t] of s.values) tsSet.add(t);
        const tsList = [...tsSet].sort((a, b) => a - b);
        const tsIndex = new Map(tsList.map((t, i) => [t, i]));
        const seriesDefs = [{ label: 'time' }];
        const seriesData = [tsList];
        results.forEach((s, idx) => {
          const valsAligned = new Array(tsList.length).fill(null);
          for (const [t, v] of s.values) {
            const p = parseFloat(v);
            valsAligned[tsIndex.get(t)] = Number.isFinite(p) ? p : null;
          }
          const labelStr = s.metric[dim] || '(empty)';
          // CP9.1: when dim is plexus_agent_id, use the canonical agent color
          // (same as bubbles/cards). Otherwise fall back to index-cycle palette.
          const stroke = (dim === 'plexus_agent_id') ? agentColor(labelStr).hex : seriesColor(idx);
          seriesDefs.push({
            label: labelStr,
            stroke,
            width: 1.5,
            spanGaps: false,
            value: (u, v) => v == null ? '—' : '$' + v.toFixed(8) + '/s',
          });
          seriesData.push(valsAligned);
        });
        if (this.rateChart) { this.rateChart.destroy(); this.rateChart = null; }
        clearChildren(this.rateBody);
        this.rateChart = new uPlot({
          width: this.rateBody.clientWidth - 8,
          height: 240,
          series: seriesDefs,
          scales: { x: { time: true } },
          axes: [
            { stroke: '#8a93a6', grid: { stroke: 'rgba(255,255,255,0.04)' } },
            // Jon-direct 2026-06-15: SI-suffix Y-axis fixes left-margin
            // truncation for large rate values (sister to line ~557 token
            // rate view fix; same root cause + same fix).
            { stroke: '#8a93a6', grid: { stroke: 'rgba(255,255,255,0.04)' }, size: 48, values: siAxisValues },
          ],
          legend: { live: true },
          cursor: { drag: { x: true, y: false } },
        }, seriesData, this.rateBody);
        // CP3: popover triggers on legend (only when dim=plexus_agent_id; otherwise the
        // legend label is a non-agent string like an email or model name).
        if (dim === 'plexus_agent_id') {
          this.rateChart.root.querySelectorAll('.u-legend .u-series th').forEach((th, idx) => {
            if (idx === 0) return;
            const labelStr = th.textContent.split('·')[0].trim();
            if (!labelStr) return;
            th.classList.add('agent-clickable');
            th.dataset.agentId = labelStr;
            th.style.cursor = 'pointer';
          });
        }
        this.setRateStatus(`${results.length} ${dim}(s) · ${cacheHdr || '—'} · ${new Date().toLocaleTimeString()}`);
      } catch (e) {
        clearChildren(this.rateBody);
        this.rateBody.appendChild(el('div', { class: 'chart-error' }, 'error: ' + e.message));
        this.setRateStatus('error', true);
      }
    }

    start() {
      this.refresh().catch(() => {});
      // Task #264 Phase 2.3: gate CostView per-chart refresh on isLiveMode().
      this.refreshTimer = setInterval(() => {
        if (!window.isDashboardLive || window.isDashboardLive()) this.refresh().catch(() => {});
      }, COST_REFRESH_MS);
    }
    stop() {
      if (this.refreshTimer) clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // CP11.4-6 (2026-06-04): three-lens Cost-tab mount.
  // Lazy-init Cost view on first activation. Builds hero strip (4 KPI
  // tiles fed by /cost/* endpoints), sub-tab nav, + per-sub-view content
  // (Pace, Composition, Anomaly, Detail, Reconcile, Budgets). Detail
  // sub-view retains the existing CostView (Prom-templated charts).
  // ────────────────────────────────────────────────────────────────────
  let _costMounted = false;
  let _costSubActive = 'pace';
  let _costView = null;            // CostView instance (Detail sub-view; lazy)
  const _opsKeyStorageKey = 'yaklog_ops_key_v1';

  async function ensureCostView() {
    if (_costMounted) return;
    _costMounted = true;
    refreshHeroStrip();
    // CP11.x.2: per-vendor totals strip refreshed alongside hero (same cadence).
    refreshVendorStrip();
    // Task #264 Phase 2.3: gate auto-refresh on isLiveMode(). Cost hero + vendor
    // strip freeze-at-snapshot when dashboard picker is non-live — Cost data
    // is accrual-model (cost_daily doesn't support as-of-ts queries), so
    // freeze semantics are the honest interpretation of "static view" here.
    setInterval(() => { if (window.isDashboardLive && window.isDashboardLive()) refreshHeroStrip(); }, 60_000);
    setInterval(() => { if (window.isDashboardLive && window.isDashboardLive()) refreshVendorStrip(); }, 60_000);
    document.querySelectorAll('#cost-subnav button').forEach((b) => {
      b.addEventListener('click', () => costShowSub(b.dataset.sub));
    });
    // Task #264 Phase 2.7 (Jon-direct 2026-07-06): Cost Composition sub-panel
    // period selector responds to dashboard picker. Mapping preserves finer
    // native periods where the dashboard preset doesn't have an equivalent
    // (1h → 'today', 24h → 'today'; 7d → '7d'; 30d → '30d'). Return-to-Live
    // restores user's pre-clamp period. Sister-shape Effort period-override
    // (Phase 2.5) + AgentCard cards-window clamp (Phase 2.2).
    const COMP_PRESET_MAP = { '1h': 'today', '24h': 'today', '7d': '7d', '30d': '30d' };
    let _compPrevLive = true;
    document.addEventListener('dashboardTimeRangeChange', (e) => {
      const preset = e.detail && e.detail.preset;
      const mapped = COMP_PRESET_MAP[preset];
      const goingLive = preset === 'live';
      if (goingLive) {
        if (!_compPrevLive) {
          _compPeriod = _compSavedPeriod;
          _compClampedByDashboard = false;
          if (_costSubActive === 'composition') renderComposition();
        else if (_costSubActive === 'accounts') renderAccounts();
        }
      } else if (mapped) {
        if (_compPrevLive) _compSavedPeriod = _compPeriod;
        _compPeriod = mapped;
        _compClampedByDashboard = true;
        if (_costSubActive === 'composition') renderComposition();
        else if (_costSubActive === 'accounts') renderAccounts();
      }
      _compPrevLive = goingLive;
    });
    // Initial-load `?range=<preset>`: apply mapping on mount.
    if (window.getDashboardTimeWindow) {
      const initWin = window.getDashboardTimeWindow();
      if (initWin && initWin.preset) {
        const mapped = COMP_PRESET_MAP[initWin.preset];
        if (mapped) {
          _compSavedPeriod = _compPeriod;
          _compPeriod = mapped;
          _compClampedByDashboard = true;
          _compPrevLive = false;
        }
      }
    }
    costShowSub('pace');
  }

  // CP11.x.2 (2026-06-13): per-vendor totals strip refresh. Populates the
  // 3-card row above the sub-nav (Anthropic / OpenAI / Google) from the
  // /cost/by-vendor endpoint. Cards for vendors with zero spend render
  // muted but visible — light up automatically when codex (aieng3 #8545)
  // + gemini (#8524) canonical-token-emitters land data into cost_daily.
  async function refreshVendorStrip() {
    try {
      const r = await fetch('/api/v1/plexus/public/cost/by-vendor?period=mtd');
      const j = await r.json();
      const totalEl = document.getElementById('vendor-strip-total');
      if (totalEl) totalEl.textContent = fmtUSD(j.total_usd || 0);
      // Build lookup by vendor name; iterate the 3 canonical cards in DOM order.
      const byVendor = new Map();
      for (const v of (j.vendors || [])) byVendor.set(v.vendor, v);
      const cards = document.querySelectorAll('#vendor-strip-cards .vendor-card');
      cards.forEach((card) => {
        const name = card.getAttribute('data-vendor');
        const data = byVendor.get(name);
        const valEl = card.querySelector('.vendor-card-val');
        const shareEl = card.querySelector('.vendor-card-share');
        if (data && data.cost_usd > 0) {
          card.classList.remove('is-zero');
          valEl.textContent = fmtUSD(data.cost_usd);
          shareEl.textContent = `${data.share_pct}% · ${data.agent_count} agent${data.agent_count === 1 ? '' : 's'}`;
        } else {
          card.classList.add('is-zero');
          valEl.textContent = fmtUSD(0);
          shareEl.textContent = 'no spend yet';
        }
      });
    } catch { /* keep prior render */ }
  }

  function costShowSub(name) {
    _costSubActive = name;
    document.querySelectorAll('#cost-subnav button').forEach((b) => {
      b.classList.toggle('active', b.dataset.sub === name);
    });
    document.querySelectorAll('.cost-subpanel').forEach((p) => {
      p.classList.toggle('active', p.dataset.sub === name);
    });
    switch (name) {
      case 'pace':         renderPace(); break;
      case 'composition':  renderComposition(); break;
      case 'accounts':     renderAccounts(); break;
      case 'anomaly':      renderAnomaly(); break;
      case 'detail':       ensureDetail(); break;
      case 'reconcile':    renderReconcile(); break;
      case 'budgets':      renderBudgets(); break;
    }
  }

  // ─── Hero strip ──────────────────────────────────────────────────────
  async function refreshHeroStrip() {
    // Burn-vs-Budget (cluster-wide envelope; cost_center='')
    try {
      const r = await fetch('/api/v1/plexus/public/cost/burn-vs-budget?cost_center=&period_kind=monthly');
      const j = await r.json();
      const tile = document.getElementById('tile-burn-budget');
      if (j.budget_usd != null) {
        tile.querySelector('.tile-val').textContent = `${fmtUSD(j.actual_usd)} / ${fmtUSD(j.budget_usd)}`;
        const pct = j.pct_consumed || 0;
        const bar = tile.querySelector('.tile-bar-fill');
        bar.style.width = Math.min(100, pct).toFixed(1) + '%';
        tile.className = 'cost-tile threshold-' + j.threshold_state;
        const runway = j.days_of_runway != null && Number.isFinite(j.days_of_runway)
          ? `${j.days_of_runway.toFixed(1)}d runway`
          : 'no runway data';
        tile.querySelector('.tile-sub').textContent = `${pct.toFixed(1)}% consumed · ${runway} · ${j.threshold_state}`;
      } else {
        tile.querySelector('.tile-val').textContent = fmtUSD(j.actual_usd);
        tile.querySelector('.tile-sub').textContent = 'no budget set · operator can set in Budgets sub-tab';
      }
    } catch { /* keep prior */ }

    // Run-rate · projected EOM
    try {
      const r = await fetch('/api/v1/plexus/public/cost/projection?period=eom');
      const j = await r.json();
      const tile = document.getElementById('tile-runrate');
      tile.querySelector('.tile-val').textContent = fmtUSD(j.projected_usd);
      tile.querySelector('.tile-sub').textContent = `${j.basis_label} · ${fmtUSD(j.basis_avg_per_day)}/day`;
    } catch { /* keep prior */ }

    // Top movers (using 7d cost_daily grouped by agent)
    try {
      const sevenDaysAgo = new Date(Date.now() - 6 * 86400_000).toISOString().slice(0, 10);
      const today = new Date().toISOString().slice(0, 10);
      // R1 (ADR-0029 v2.3 §Hero strip): default top-movers to cost_center (CFO-tier)
      // not agent_id (engineering-ops-tier). Operator-switchable dimension TBD.
      const r = await fetch(`/api/v1/plexus/public/cost/daily?from=${sevenDaysAgo}&to=${today}&by=cost_center`);
      const j = await r.json();
      const tile = document.getElementById('tile-top-movers');
      const wrap = tile.querySelector('.tile-movers');
      clearChildren(wrap);
      const top3 = (j.rows || []).slice(0, 3);
      if (top3.length === 0) {
        wrap.appendChild(el('div', { class: 'mover-row' }, el('span', { class: 'mover-name muted' }, 'no data')));
      } else {
        for (const r of top3) {
          const row = el('div', { class: 'mover-row' });
          const label = r.cost_center || '(unallocated)';
          row.appendChild(el('span', { class: 'mover-name', title: label }, label));
          row.appendChild(el('span', { class: 'mover-cost' }, fmtUSD(r.cost_usd)));
          wrap.appendChild(row);
        }
      }
    } catch { /* keep prior */ }

    // MTD
    try {
      const r = await fetch('/api/v1/plexus/public/cost/summary?period=mtd');
      const j = await r.json();
      const tile = document.getElementById('tile-mtd');
      tile.querySelector('.tile-val').textContent = fmtUSD(j.value_usd);
      tile.querySelector('.tile-sub').textContent = `${j.from} → ${j.to} (calendar UTC)`;
    } catch { /* keep prior */ }
  }

  // ─── Pace sub-view ───────────────────────────────────────────────────
  async function renderPace() {
    const panel = document.getElementById('sub-pace');
    panel.innerHTML = '<div class="cost-loading">loading pace data…</div>';
    try {
      const [bvbR, projR, ccR] = await Promise.all([
        fetch('/api/v1/plexus/public/cost/burn-vs-budget?cost_center=&period_kind=monthly').then(r => r.json()),
        fetch('/api/v1/plexus/public/cost/projection?period=eom').then(r => r.json()),
        fetch('/api/v1/plexus/public/cost/by-cost-center?period=mtd&period_kind=monthly').then(r => r.json()),
      ]);
      clearChildren(panel);
      const grid = el('div', { class: 'pace-grid' });

      // Card 1: Cluster envelope
      const card1 = el('div', { class: 'pace-card' });
      card1.appendChild(el('h3', null, 'Cluster envelope (monthly)'));
      const rows1 = [
        ['Actual', fmtUSD(bvbR.actual_usd || 0)],
        ['Budget', bvbR.budget_usd != null ? fmtUSD(bvbR.budget_usd) : '(no budget set)'],
        ['% consumed', bvbR.pct_consumed != null ? bvbR.pct_consumed.toFixed(1) + '%' : '—'],
        ['Days of runway', bvbR.days_of_runway != null && Number.isFinite(bvbR.days_of_runway) ? bvbR.days_of_runway.toFixed(1) + 'd' : '—'],
        ['Daily burn', bvbR.daily_burn_usd != null ? fmtUSD(bvbR.daily_burn_usd) + '/day' : '—'],
        ['Projected EOP', bvbR.projected_eop_usd != null ? fmtUSD(bvbR.projected_eop_usd) : '—'],
        ['Threshold state', bvbR.threshold_state],
      ];
      for (const [k, v] of rows1) {
        const row = el('div', { class: 'pace-row' });
        row.appendChild(el('span', { class: 'pace-lbl' }, k));
        row.appendChild(el('span', { class: 'pace-val' }, v));
        card1.appendChild(row);
      }
      grid.appendChild(card1);

      // Card 2: Projection
      const card2 = el('div', { class: 'pace-card' });
      card2.appendChild(el('h3', null, 'Run-rate · projected EOM'));
      const rows2 = [
        ['Current', fmtUSD(projR.current_usd || 0)],
        ['Projected EOM', fmtUSD(projR.projected_usd || 0)],
        ['Basis', projR.basis_label || '—'],
        ['Daily avg', fmtUSD(projR.basis_avg_per_day || 0) + '/day'],
        ['Days into period', String(projR.basis_days || 0)],
      ];
      for (const [k, v] of rows2) {
        const row = el('div', { class: 'pace-row' });
        row.appendChild(el('span', { class: 'pace-lbl' }, k));
        row.appendChild(el('span', { class: 'pace-val' }, v));
        card2.appendChild(row);
      }
      grid.appendChild(card2);

      // Card 3: per-cost-center breakdown
      const card3 = el('div', { class: 'pace-card' });
      card3.style.gridColumn = '1 / span 2';
      card3.appendChild(el('h3', null, 'Per-cost-center MTD (with budget where set)'));
      if (!ccR.rows || ccR.rows.length === 0) {
        card3.appendChild(el('div', { class: 'cost-loading' }, 'No cost-center data; operator can tag agents in Budgets sub-tab.'));
      } else {
        const tbl = el('table', { class: 'comp-table' });
        const thead = el('thead');
        thead.appendChild(el('tr', null,
          el('th', null, 'Cost center'),
          el('th', { class: 'num' }, 'Actual'),
          el('th', { class: 'num' }, 'Budget'),
          el('th', { class: 'num' }, '% consumed'),
          el('th', null, 'State'),
        ));
        tbl.appendChild(thead);
        const tbody = el('tbody');
        for (const r of ccR.rows) {
          const tr = el('tr');
          tr.appendChild(el('td', null, r.cost_center || '(unallocated)'));
          tr.appendChild(el('td', { class: 'num' }, fmtUSD(r.actual_usd)));
          tr.appendChild(el('td', { class: 'num' }, r.budget_usd != null ? fmtUSD(r.budget_usd) : '—'));
          tr.appendChild(el('td', { class: 'num' }, r.pct_consumed != null ? r.pct_consumed.toFixed(1) + '%' : '—'));
          tr.appendChild(el('td', null, r.threshold_state || '—'));
          tbody.appendChild(tr);
        }
        tbl.appendChild(tbody);
        card3.appendChild(tbl);
      }
      grid.appendChild(card3);

      panel.appendChild(grid);
    } catch (e) {
      renderError(panel, 'cost-loading', `Pace render error: ${e.message}`);
    }
  }

  // ─── Composition sub-view ────────────────────────────────────────────
  // R2 (ADR-0029 v2.3 §Composition): default to cost_center (CFO-tier).
  // Operator can switch to agent_id via the dim picker.
  let _compDim = 'cost_center';
  let _compPeriod = 'mtd';
  // Task #264 Phase 2.7 (Jon-direct 2026-07-06 re Cost detail → user_email view):
  // extend picker-clamp to Composition sub-panel — sister-shape Effort period
  // override (Phase 2.5) + AgentCard cards-window clamp (Phase 2.2).
  let _compClampedByDashboard = false;
  let _compSavedPeriod = _compPeriod;
  async function renderComposition() {
    const panel = document.getElementById('sub-composition');
    clearChildren(panel);
    const ctrl = el('div', { class: 'comp-controls' });
    ctrl.appendChild(el('label', null, 'Period'));
    const periodSel = el('select');
    for (const p of ['today', '7d', '30d', '90d', 'mtd', 'ytd', 'last_month', 'lifetime']) {
      const opt = el('option', { value: p }, p);
      if (p === _compPeriod) opt.selected = true;
      periodSel.appendChild(opt);
    }
    if (_compClampedByDashboard) periodSel.disabled = true;
    periodSel.addEventListener('change', () => { _compPeriod = periodSel.value; renderComposition(); });
    ctrl.appendChild(periodSel);
    ctrl.appendChild(el('label', null, 'Group by'));
    const dimSel = el('select');
    for (const d of ['vendor', 'agent_id', 'cost_center', 'project_tag', 'environment_tier', 'model', 'user_email', 'organization_id']) {
      const opt = el('option', { value: d }, d);
      if (d === _compDim) opt.selected = true;
      dimSel.appendChild(opt);
    }
    dimSel.addEventListener('change', () => { _compDim = dimSel.value; renderComposition(); });
    ctrl.appendChild(dimSel);
    panel.appendChild(ctrl);

    panel.appendChild(el('div', { class: 'cost-loading' }, 'loading…'));
    try {
      // Convert period to from/to first
      const sumR = await fetch(`/api/v1/plexus/public/cost/summary?period=${_compPeriod}`).then(r => r.json());
      const r = await fetch(`/api/v1/plexus/public/cost/daily?from=${sumR.from}&to=${sumR.to}&by=${_compDim}`);
      const j = await r.json();
      // Remove "loading" placeholder
      panel.removeChild(panel.lastChild);
      const tbl = el('table', { class: 'comp-table' });
      const thead = el('thead');
      thead.appendChild(el('tr', null,
        el('th', null, _compDim),
        el('th', { class: 'num' }, 'Cost (USD)'),
        el('th', { class: 'num' }, 'In tokens'),
        el('th', { class: 'num' }, 'Out tokens'),
        el('th', { class: 'num' }, 'Cache tokens'),
      ));
      tbl.appendChild(thead);
      const tbody = el('tbody');
      for (const row of (j.rows || []).slice(0, 100)) {
        const tr = el('tr');
        tr.appendChild(el('td', null, String(row[_compDim] || '(empty)')));
        tr.appendChild(el('td', { class: 'num' }, fmtUSD(row.cost_usd || 0)));
        tr.appendChild(el('td', { class: 'num' }, (row.tokens_input || 0).toLocaleString()));
        tr.appendChild(el('td', { class: 'num' }, (row.tokens_output || 0).toLocaleString()));
        tr.appendChild(el('td', { class: 'num' }, ((row.tokens_cache_read || 0) + (row.tokens_cache_creation || 0)).toLocaleString()));
        tbody.appendChild(tr);
      }
      tbl.appendChild(tbody);
      panel.appendChild(tbl);
    } catch (e) {
      panel.appendChild(el('div', { class: 'cost-loading' }, 'error: ' + e.message));
    }
  }

  // ─── Accounts sub-view (Task #264 Phase 2.7, Jon-direct 2026-07-06) ──
  // Agent-account timeline: rows are (agent_id, user_email) tuples over the
  // selected window. Supports operator workflow of rotating Anthropic accounts
  // on CC sessions to unlock more time. Uses existing /cost/daily?by= endpoint
  // with days_active field extension (server side same commit). Respects
  // dashboard time-range picker via _compPeriod override (Ship 1 wire).
  let _accountsSortKey = 'agent_id';
  let _accountsSortAsc = true;
  async function renderAccounts() {
    const panel = document.getElementById('sub-accounts');
    clearChildren(panel);
    const header = el('div', { class: 'comp-controls' });
    header.appendChild(el('label', null, `Window: ${_compPeriod}${_compClampedByDashboard ? ' (dashboard-clamped)' : ''}`));
    panel.appendChild(header);
    panel.appendChild(el('div', { class: 'cost-loading' }, 'loading…'));
    try {
      const sumR = await fetch(`/api/v1/plexus/public/cost/summary?period=${_compPeriod}`).then(r => r.json());
      const r = await fetch(`/api/v1/plexus/public/cost/daily?from=${sumR.from}&to=${sumR.to}&by=agent_id,user_email`);
      if (!r.ok) {
        panel.removeChild(panel.lastChild);
        panel.appendChild(el('div', { class: 'view-empty' }, "Couldn't load account timeline. Retry shortly."));
        return;
      }
      const j = await r.json();
      panel.removeChild(panel.lastChild);
      const rows = (j.rows || []).filter(x => x.agent_id && x.user_email);
      if (rows.length === 0) {
        panel.appendChild(el('div', { class: 'view-empty' }, 'No agent-account activity in this window.'));
        return;
      }
      // Sort
      const sortRows = rows.slice().sort((a, b) => {
        let va = a[_accountsSortKey], vb = b[_accountsSortKey];
        if (typeof va === 'string') { va = va.toLowerCase(); vb = (vb || '').toLowerCase(); }
        if (va < vb) return _accountsSortAsc ? -1 : 1;
        if (va > vb) return _accountsSortAsc ? 1 : -1;
        return 0;
      });
      const tbl = el('table', { class: 'comp-table' });
      const thead = el('thead');
      const cols = [
        { k: 'agent_id',    label: 'agent',       num: false },
        { k: 'user_email',  label: 'user email',  num: false },
        { k: 'date_min',    label: 'first',       num: false },
        { k: 'date_max',    label: 'last',        num: false },
        { k: 'days_active', label: 'days',        num: true },
        { k: 'cost_usd',    label: 'spend (USD)', num: true },
      ];
      const trh = el('tr');
      for (const c of cols) {
        const th = el('th', { class: c.num ? 'num' : '', 'data-sort-key': c.k, style: 'cursor:pointer;user-select:none' },
          c.label + (c.k === _accountsSortKey ? (_accountsSortAsc ? ' ▲' : ' ▼') : ''));
        th.addEventListener('click', () => {
          if (_accountsSortKey === c.k) _accountsSortAsc = !_accountsSortAsc;
          else { _accountsSortKey = c.k; _accountsSortAsc = c.num ? false : true; }
          renderAccounts();
        });
        trh.appendChild(th);
      }
      thead.appendChild(trh);
      tbl.appendChild(thead);
      const tbody = el('tbody');
      for (const row of sortRows) {
        const tr = el('tr');
        tr.appendChild(el('td', null, row.agent_id));
        tr.appendChild(el('td', null, row.user_email));
        tr.appendChild(el('td', null, row.date_min));
        tr.appendChild(el('td', null, row.date_max));
        tr.appendChild(el('td', { class: 'num' }, String(row.days_active || 0)));
        tr.appendChild(el('td', { class: 'num' }, fmtUSD(row.cost_usd || 0)));
        tbody.appendChild(tr);
      }
      tbl.appendChild(tbody);
      panel.appendChild(tbl);
    } catch (e) {
      panel.appendChild(el('div', { class: 'view-empty' }, "Couldn't load account timeline. Retry shortly."));
    }
  }

  // ─── Anomaly sub-view ────────────────────────────────────────────────
  async function renderAnomaly() {
    const panel = document.getElementById('sub-anomaly');
    panel.innerHTML = '<div class="cost-loading">scanning for anomalies (current > 2× 7d mean)…</div>';
    try {
      // Compute anomalies client-side: for each agent, compare today's cost
      // against the 7d average. Flag agents with ratio >= 2.
      const sumR = await fetch('/api/v1/plexus/public/cost/summary?period=today').then(r => r.json());
      const today = sumR.to;
      const sevenAgo = new Date(new Date(today) - 6 * 86400_000).toISOString().slice(0, 10);
      const dailyR = await fetch(`/api/v1/plexus/public/cost/daily?from=${sevenAgo}&to=${today}&by=agent_id,date`).then(r => r.json());

      // Group by agent_id; for each, separate today vs the prior 6 days
      const byAgent = new Map();
      for (const row of dailyR.rows || []) {
        const id = row.agent_id || '(unattributed)';
        let g = byAgent.get(id) || { agent_id: id, today_usd: 0, prior_total_usd: 0, prior_days: 0 };
        if (row.date_min === today || row.date_max === today) {
          g.today_usd += row.cost_usd;
        } else {
          g.prior_total_usd += row.cost_usd;
          g.prior_days += 1;
        }
        byAgent.set(id, g);
      }

      const anomalies = [];
      for (const g of byAgent.values()) {
        if (g.today_usd <= 0 || g.prior_days === 0) continue;
        const priorAvg = g.prior_total_usd / g.prior_days;
        if (priorAvg <= 0) continue;
        const ratio = g.today_usd / priorAvg;
        if (ratio >= 2.0) {
          anomalies.push({ ...g, prior_avg: priorAvg, ratio });
        }
      }
      anomalies.sort((a, b) => b.ratio - a.ratio);

      clearChildren(panel);
      if (anomalies.length === 0) {
        panel.appendChild(el('div', { class: 'cost-loading' }, 'No cost anomalies today (no agent ≥ 2× their 6-day prior mean).'));
        return;
      }
      const list = el('div', { class: 'anomaly-list' });
      for (const a of anomalies) {
        const row = el('div', { class: 'anomaly-row' });
        const meta = el('div', { class: 'anomaly-meta' });
        meta.appendChild(el('div', { class: 'anomaly-headline' }, `${a.agent_id} · ${a.ratio.toFixed(1)}× prior 6d mean`));
        meta.appendChild(el('div', { class: 'anomaly-sub' }, `today ${fmtUSD(a.today_usd)} · prior 6d avg ${fmtUSD(a.prior_avg)}/day`));
        row.appendChild(meta);
        row.appendChild(el('div', { class: 'anomaly-val' }, fmtUSD(a.today_usd)));
        list.appendChild(row);
      }
      panel.appendChild(list);
    } catch (e) {
      renderError(panel, 'cost-loading', `anomaly scan error: ${e.message}`);
    }
  }

  // ─── Detail sub-view (legacy CostView relocated) ────────────────────
  function ensureDetail() {
    if (_costView) {
      _costView.refresh().catch(() => {});
      return;
    }
    _costView = new CostView();
    bindOpts('#cost-dim-opts',    () => _costView.refresh().catch(() => {}));
    bindOpts('#cost-window-opts', () => _costView.refresh().catch(() => {}));
    _costView.start();
  }

  // ─── Reconcile sub-view (ops-key gated) ─────────────────────────────
  function _opsKey() { try { return localStorage.getItem(_opsKeyStorageKey) || ''; } catch { return ''; } }
  function _setOpsKey(k) { try { if (k) localStorage.setItem(_opsKeyStorageKey, k); else localStorage.removeItem(_opsKeyStorageKey); } catch {} }

  function renderReconcile() {
    const panel = document.getElementById('sub-reconcile');
    clearChildren(panel);
    panel.appendChild(_renderOpsBanner('Reconcile + Budgets are ops-key gated', 'Enter your ops-key once; stored in browser localStorage only (never sent to bus). Cleared via the "clear" button below.'));

    // Recon form
    const form = el('div', { class: 'recon-controls' });
    const fields = [
      ['period_start', 'Period start (YYYY-MM-DD)', new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10)],
      ['period_end', 'Period end (YYYY-MM-DD)', new Date().toISOString().slice(0, 10)],
      ['invoice_label', 'Invoice label', ''],
      ['invoice_total_usd', 'Invoice total USD', ''],
    ];
    const inputs = {};
    for (const [name, label, dft] of fields) {
      const f = el('div', { class: 'recon-field' });
      f.appendChild(el('label', null, label));
      const inp = el('input', { type: name.includes('usd') ? 'number' : 'text', value: dft });
      inp.step = '0.01';
      inputs[name] = inp;
      f.appendChild(inp);
      form.appendChild(f);
    }
    const submitBtn = el('button', null, 'Reconcile');
    form.appendChild(submitBtn);

    const exportBtn = el('button', { class: 'ghost' }, 'Export period CSV');
    form.appendChild(exportBtn);
    exportBtn.addEventListener('click', () => {
      const url = `/api/v1/plexus/public/cost/export?format=csv&schema=anthropic-invoice&period=mtd`;
      window.open(url, '_blank');
    });
    panel.appendChild(form);

    const result = el('div', { id: 'recon-result' });
    panel.appendChild(result);

    submitBtn.addEventListener('click', async () => {
      const opsKey = await _promptOpsKey();
      if (!opsKey) return;
      const body = {
        period_start: inputs.period_start.value,
        period_end: inputs.period_end.value,
        invoice_label: inputs.invoice_label.value || null,
        invoice_total_usd: parseFloat(inputs.invoice_total_usd.value || '0'),
      };
      result.innerHTML = '<div class="cost-loading">submitting…</div>';
      try {
        const r = await fetch('/api/v1/ops/cost/reconcile', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${opsKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const j = await r.json();
        if (!r.ok) {
          renderError(result, 'cost-loading', `error: ${j.message || r.status}`);
          return;
        }
        result.innerHTML = '';
        const banner = el('div', { class: 'recon-banner' });
        banner.appendChild(el('div', null, `Reconciled · invoice ${fmtUSD(body.invoice_total_usd)} vs Plexus ${fmtUSD(j.plexus_total_usd)} · delta ${fmtUSD(j.delta_usd)} (${j.delta_pct.toFixed(1)}%)`));
        result.appendChild(banner);
        loadReconHistory();
      } catch (e) {
        renderError(result, 'cost-loading', `network error: ${e.message}`);
      }
    });

    panel.appendChild(el('h3', { style: 'margin: 20px 0 10px; font-size: 13px; color: var(--text);' }, 'Reconciliation history'));
    const histDiv = el('div', { id: 'recon-history', class: 'cost-loading' }, 'loading history (ops-key required)…');
    panel.appendChild(histDiv);
    loadReconHistory();
  }

  async function loadReconHistory() {
    const div = document.getElementById('recon-history');
    if (!div) return;
    const opsKey = _opsKey();
    if (!opsKey) {
      div.className = 'cost-loading';
      div.textContent = 'enter ops-key on first reconcile submit to load history';
      return;
    }
    // No public endpoint for listing reconciliations — re-use authed
    // /messages-style listing isn't exposed. For now show a note that
    // history is in cost_reconciliation table; full UI in Phase 6 v2.
    div.className = 'cost-loading';
    div.textContent = 'reconciliation history persisted in cost_reconciliation table; listing UI deferred to Phase 6';
  }

  // ─── Budgets sub-view (ops-key gated) ───────────────────────────────
  function renderBudgets() {
    const panel = document.getElementById('sub-budgets');
    clearChildren(panel);
    panel.appendChild(_renderOpsBanner('Budget management is ops-key gated',
      'Set per-cost-center monthly/quarterly envelopes; updates via /api/v1/ops/cost/budget. Tag agents via /api/v1/ops/cost/dimension-tag.'));

    const controls = el('div', { class: 'budget-controls' });
    const addBtn = el('button', null, '+ Add / update budget');
    controls.appendChild(addBtn);
    const tagBtn = el('button', null, 'Tag agent');
    controls.appendChild(tagBtn);
    const refreshBtn = el('button', { class: 'ghost' }, 'Refresh');
    controls.appendChild(refreshBtn);
    panel.appendChild(controls);

    const addForm = _buildBudgetAddForm();
    panel.appendChild(addForm);
    addBtn.addEventListener('click', () => addForm.classList.toggle('open'));

    const tagForm = _buildTagForm();
    panel.appendChild(tagForm);
    tagBtn.addEventListener('click', () => tagForm.classList.toggle('open'));

    // R4 (ADR-0029 v2.3 §cost_budgets): divergence indicator between
    // cluster-cap envelope and SUM(per-CC envelopes). Pre-empts an operator-
    // confusion class at first budget-rollout. Renders only when at least
    // one budget is set (cluster-cap or per-CC) — silent otherwise.
    const divergence = el('div', { id: 'budget-divergence' });
    panel.appendChild(divergence);

    const list = el('div', { class: 'budget-list', id: 'budget-list' });
    panel.appendChild(list);
    refreshBtn.addEventListener('click', () => { loadBudgetList(); loadBudgetDivergence(); });
    loadBudgetList();
    loadBudgetDivergence();
  }

  async function loadBudgetDivergence() {
    const wrap = document.getElementById('budget-divergence');
    if (!wrap) return;
    clearChildren(wrap);
    try {
      const [clusterR, ccR] = await Promise.all([
        fetch('/api/v1/plexus/public/cost/burn-vs-budget?cost_center=&period_kind=monthly').then(r => r.json()),
        fetch('/api/v1/plexus/public/cost/by-cost-center?period=mtd&period_kind=monthly').then(r => r.json()),
      ]);
      const clusterCap = clusterR.budget_usd;
      const ccBudgets = (ccR.rows || []).filter(r => r.budget_usd != null && r.cost_center !== '');
      const sumCC = ccBudgets.reduce((s, r) => s + (r.budget_usd || 0), 0);
      if (clusterCap == null && ccBudgets.length === 0) return;  // silent: no budgets

      const banner = el('div', { class: 'divergence-banner' });
      const left = el('div', { class: 'divergence-row' });
      left.appendChild(el('span', { class: 'divergence-lbl' }, 'Cluster cap'));
      left.appendChild(el('span', { class: 'divergence-val' }, clusterCap != null ? fmtUSD(clusterCap) : '(not set)'));
      left.appendChild(el('span', { class: 'divergence-sep' }, '·'));
      left.appendChild(el('span', { class: 'divergence-lbl' }, `Sum of ${ccBudgets.length} CC envelope${ccBudgets.length === 1 ? '' : 's'}`));
      left.appendChild(el('span', { class: 'divergence-val' }, fmtUSD(sumCC)));
      banner.appendChild(left);

      if (clusterCap != null) {
        const delta = sumCC - clusterCap;
        const pct = clusterCap > 0 ? (delta / clusterCap) * 100 : 0;
        const right = el('div', { class: 'divergence-delta' });
        if (Math.abs(delta) < 0.005) {
          right.classList.add('match');
          right.textContent = '✓ envelopes match cluster cap';
        } else if (delta < 0) {
          right.classList.add('slack');
          right.textContent = `↓ ${fmtUSD(Math.abs(delta))} cluster slack (${Math.abs(pct).toFixed(1)}% unallocated headroom)`;
        } else {
          right.classList.add('overage');
          right.textContent = `↑ ${fmtUSD(delta)} CC overage (${pct.toFixed(1)}% over cluster cap)`;
        }
        banner.appendChild(right);
      } else if (sumCC > 0) {
        const right = el('div', { class: 'divergence-delta slack' });
        right.textContent = 'no cluster-cap set — operator should set one for envelope-divergence governance';
        banner.appendChild(right);
      }
      wrap.appendChild(banner);
    } catch (e) { /* silent fail */ }
  }

  async function loadBudgetList() {
    const list = document.getElementById('budget-list');
    if (!list) return;
    list.innerHTML = '<div class="cost-loading">loading…</div>';
    try {
      // Use by-cost-center for current period
      const r = await fetch('/api/v1/plexus/public/cost/by-cost-center?period=mtd&period_kind=monthly');
      const j = await r.json();
      clearChildren(list);
      const withBudget = (j.rows || []).filter(r => r.budget_usd != null);
      const withoutBudget = (j.rows || []).filter(r => r.budget_usd == null);
      if (withBudget.length === 0 && withoutBudget.length === 0) {
        list.appendChild(el('div', { class: 'budget-empty' }, 'No budgets configured + no cost-center data yet. Tag agents + set budgets via the buttons above.'));
        return;
      }
      // Render budget-configured rows first
      for (const r of withBudget) {
        const row = el('div', { class: 'budget-row threshold-' + (r.threshold_state || 'green') });
        row.appendChild(el('div', { class: 'budget-cc' }, r.cost_center || '(unallocated)'));
        row.appendChild(el('div', { class: 'budget-num' }, fmtUSD(r.actual_usd)));
        row.appendChild(el('div', { class: 'budget-num' }, fmtUSD(r.budget_usd)));
        const barWrap = el('div', { class: 'budget-bar' });
        barWrap.appendChild(el('div', { class: 'budget-bar-fill', style: `width: ${Math.min(100, r.pct_consumed || 0).toFixed(1)}%` }));
        row.appendChild(barWrap);
        row.appendChild(el('div', { class: 'budget-pct' }, (r.pct_consumed != null ? r.pct_consumed.toFixed(1) + '%' : '—')));
        row.appendChild(el('div', { class: 'budget-state' }, r.threshold_state || 'green'));
        list.appendChild(row);
      }
      // Show "no-budget" cost centers as a separate group
      if (withoutBudget.length > 0) {
        list.appendChild(el('div', { class: 'budget-empty', style: 'text-align:left; padding: 14px 0 6px' },
          `${withoutBudget.length} cost-center(s) with cost but no budget set:`));
        for (const r of withoutBudget) {
          const row = el('div', { class: 'budget-row threshold-green' });
          row.appendChild(el('div', { class: 'budget-cc' }, r.cost_center || '(unallocated)'));
          row.appendChild(el('div', { class: 'budget-num' }, fmtUSD(r.actual_usd)));
          row.appendChild(el('div', { class: 'budget-num muted' }, '(no budget)'));
          row.appendChild(el('div'));
          row.appendChild(el('div'));
          row.appendChild(el('div'));
          list.appendChild(row);
        }
      }
    } catch (e) {
      renderError(list, 'cost-loading', `error: ${e.message}`);
    }
  }

  function _buildBudgetAddForm() {
    const form = el('div', { class: 'budget-add-form' });
    const fieldRow = el('div', { class: 'field-row' });
    const ccI = el('input', { type: 'text', placeholder: 'cost_center (empty = cluster-wide)' });
    const kindI = el('select');
    for (const k of ['monthly', 'quarterly']) kindI.appendChild(el('option', { value: k }, k));
    const anchorI = el('input', { type: 'text', placeholder: 'YYYY-MM or YYYY-Q1' });
    const budgetI = el('input', { type: 'number', step: '0.01', placeholder: 'budget_usd' });
    const submit = el('button', null, 'Save');
    for (const [lbl, inp] of [['Cost center', ccI], ['Period kind', kindI], ['Period anchor', anchorI], ['Budget USD', budgetI]]) {
      const f = el('div', { class: 'recon-field' });
      f.appendChild(el('label', null, lbl));
      f.appendChild(inp);
      fieldRow.appendChild(f);
    }
    fieldRow.appendChild(submit);
    form.appendChild(fieldRow);
    submit.addEventListener('click', async () => {
      const opsKey = await _promptOpsKey();
      if (!opsKey) return;
      const r = await fetch('/api/v1/ops/cost/budget', {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${opsKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cost_center: ccI.value,
          period_kind: kindI.value,
          period_anchor: anchorI.value,
          budget_usd: parseFloat(budgetI.value || '0'),
        }),
      });
      if (r.ok) {
        form.classList.remove('open');
        loadBudgetList();
      } else {
        const j = await r.json();
        alert('Error: ' + (j.message || r.status));
      }
    });
    return form;
  }

  function _buildTagForm() {
    const form = el('div', { class: 'budget-add-form' });
    const fieldRow = el('div', { class: 'field-row' });
    const aI = el('input', { type: 'text', placeholder: 'agent_id' });
    const ccI = el('input', { type: 'text', placeholder: 'cost_center' });
    const pI = el('input', { type: 'text', placeholder: 'project_tag' });
    const eI = el('select');
    for (const o of ['', 'prod', 'staging', 'dev', 'experimental']) eI.appendChild(el('option', { value: o }, o || '(unset)'));
    const bI = el('input', { type: 'checkbox' });
    const submit = el('button', null, 'Tag');
    for (const [lbl, inp] of [['Agent ID', aI], ['Cost center', ccI], ['Project tag', pI], ['Environment', eI], ['Billable', bI]]) {
      const f = el('div', { class: 'recon-field' });
      f.appendChild(el('label', null, lbl));
      f.appendChild(inp);
      fieldRow.appendChild(f);
    }
    fieldRow.appendChild(submit);
    form.appendChild(fieldRow);
    submit.addEventListener('click', async () => {
      const opsKey = await _promptOpsKey();
      if (!opsKey) return;
      const r = await fetch('/api/v1/ops/cost/dimension-tag', {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${opsKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_id: aI.value, cost_center: ccI.value, project_tag: pI.value,
          environment_tier: eI.value, billable_flag: bI.checked,
        }),
      });
      if (r.ok) {
        form.classList.remove('open');
        loadBudgetList();
      } else {
        const j = await r.json();
        alert('Error: ' + (j.message || r.status));
      }
    });
    return form;
  }

  // ─── Ops-key helpers ────────────────────────────────────────────────
  async function _promptOpsKey() {
    let key = _opsKey();
    if (!key) {
      key = prompt('Enter ops-key (sent only with ops requests; stored in this browser localStorage):');
      if (key) _setOpsKey(key);
    }
    return key;
  }

  function _renderOpsBanner(title, sub) {
    const wrap = el('div', { class: 'ops-banner' });
    wrap.appendChild(el('div', null, el('strong', null, '🔐 ' + title)));
    wrap.appendChild(el('div', { style: 'margin-top: 4px;' }, sub));
    const clear = el('button', { class: 'audit-btn audit-btn-ghost', style: 'margin-top: 8px;' }, 'clear stored ops-key');
    clear.addEventListener('click', () => { _setOpsKey(''); alert('ops-key cleared'); });
    if (_opsKey()) wrap.appendChild(clear);
    return wrap;
  }

  // ────────────────────────────────────────────────────────────────────
  // CP12.3 (2026-06-05): three-lens Audit-tab mount per ratified ADR-0030 v1.1.
  // Hero strip (4 GRC-tier KPI tiles) + 6 sub-tabs (Incident default / Review /
  // Attest / Policies / Reconcile / Detail). Detail sub-view retains the legacy
  // DM-audit-log reader unchanged. Audience-tier-transition default-audit
  // applied per `feedback_audience_tier_transition_default_check` — hero
  // defaults are control_area / policy_rule / control_framework, NOT
  // agent_id / event_type / tool_name.
  // ────────────────────────────────────────────────────────────────────
  let _auditMounted = false;
  let _auditSubActive = 'incident';
  let _attestFramework = 'soc2';
  let _reviewDim = 'control_area';

  async function ensureAuditView() {
    if (_auditMounted) return;
    _auditMounted = true;
    refreshAuditHero();
    // Cascade-prevention #10535 substrate-design Option (a): pause polling
    // when document hidden (no point spending Prom + DB cycles on a tab
    // the operator can't see). resume + immediate-refresh on visibilitychange.
    let _auditHeroInterval = null;
    function startAuditHeroInterval() {
      if (_auditHeroInterval) return;
      // Task #264 Phase 2.4: gate on isLiveMode() sister-shape Cost tab
      // Phase 2.3 — audit-hero freezes at snapshot in non-live dashboard mode
      // (audit posture is accrual/attest-model; no as-of-ts server support).
      _auditHeroInterval = setInterval(() => {
        if (!window.isDashboardLive || window.isDashboardLive()) refreshAuditHero();
      }, 60_000);
    }
    function stopAuditHeroInterval() {
      if (!_auditHeroInterval) return;
      clearInterval(_auditHeroInterval);
      _auditHeroInterval = null;
    }
    if (typeof document.hidden === 'boolean' && !document.hidden) startAuditHeroInterval();
    else if (typeof document.hidden !== 'boolean') startAuditHeroInterval();  // older browsers
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stopAuditHeroInterval();
      else { refreshAuditHero(); startAuditHeroInterval(); }
    });
    document.querySelectorAll('#audit-subnav button').forEach((b) => {
      b.addEventListener('click', () => auditShowSub(b.dataset.sub));
    });
    auditShowSub('incident');
  }

  function auditShowSub(name) {
    _auditSubActive = name;
    document.querySelectorAll('#audit-subnav button').forEach((b) => {
      b.classList.toggle('active', b.dataset.sub === name);
    });
    document.querySelectorAll('.audit-subpanel').forEach((p) => {
      p.classList.toggle('active', p.dataset.sub === name);
    });
    switch (name) {
      case 'incident':   renderIncident(); break;
      case 'review':     renderReview(); break;
      case 'attest':     renderAttest(); break;
      case 'policies':   renderPolicies(); break;
      case 'reconcile':  renderAuditReconcile(); break;
      case 'detail':     /* legacy DM-audit reader already wired by existing code */ break;
    }
  }

  // ─── Hero strip ──────────────────────────────────────────────────────
  async function refreshAuditHero() {
    // Tile 1: Open policy violations (severity-colored)
    try {
      const r = await fetch('/api/v1/plexus/public/policy/violations?disposition=pending&limit=100');
      const j = await r.json();
      const tile = document.getElementById('tile-open-violations');
      if (!tile) return;
      const rows = j.violations || [];
      const sevCounts = { critical: 0, violation: 0, warn: 0, info: 0 };
      for (const v of rows) {
        const s = (v.severity_class || 'info').toLowerCase();
        if (sevCounts[s] != null) sevCounts[s] += 1;
      }
      const total = rows.length;
      let topSev = 'clean';
      for (const s of ['critical', 'violation', 'warn', 'info']) {
        if (sevCounts[s] > 0) { topSev = s; break; }
      }
      tile.className = 'audit-tile severity-' + topSev;
      tile.querySelector('.tile-val').textContent = String(total);
      tile.querySelector('.tile-sub').textContent = total === 0
        ? 'no pending violations'
        : `${sevCounts.critical || 0} crit · ${sevCounts.violation || 0} viol · ${sevCounts.warn || 0} warn · ${sevCounts.info || 0} info`;
    } catch (e) { /* keep prior */ }

    // Tile 2: Coverage gaps (policies + audit-trail)
    try {
      const [polR, gapR] = await Promise.all([
        fetch('/api/v1/plexus/public/policy/divergence').then(r => r.json()),
        fetch('/api/v1/plexus/public/audit/coverage-gap').then(r => r.json()),
      ]);
      const tile = document.getElementById('tile-coverage-gaps');
      if (!tile) return;
      const codified = polR.policies_codified || 0;
      const missingTrail = gapR.agents_missing_trail_7d || 0;
      const genuineGap = gapR.genuine_gap_count != null ? gapR.genuine_gap_count : missingTrail;
      const inactiveCount = gapR.inactive_count || 0;
      const aliasCount = gapR.alias_count || 0;
      const differentRuntimeCount = gapR.different_runtime_count || 0;

      // Headline: codified / genuine-gap (NOT raw missing — most of the
      // raw missing count is known-inactive / alias / different-runtime
      // noise per CP12.9 disposition enrichment).
      tile.querySelector('.tile-val').textContent = `${codified} / ${genuineGap}`;

      // Build noise-breakdown suffix when there's any noise to surface.
      const noiseParts = [];
      if (inactiveCount > 0) noiseParts.push(`${inactiveCount} inactive`);
      if (aliasCount > 0) noiseParts.push(`${aliasCount} alias`);
      if (differentRuntimeCount > 0) noiseParts.push(`${differentRuntimeCount} non-CC runtime`);
      const noiseSuffix = noiseParts.length > 0
        ? ` (${noiseParts.join(' · ')} excluded as known-disposition)`
        : '';

      // CP12.9 (2026-06-06): Phase 1.5.D OPERATIONAL per #7959 — forensic-
      // content tier (tool_name + file-access digests) now landed via the
      // plexus-audit-ingester eBPF substrate. Stale "gated on Phase 1.5.D"
      // qualifier removed.
      tile.querySelector('.tile-sub').textContent =
        `${codified} policies codified · ${genuineGap} genuine instrumentation gaps in 7d` +
        noiseSuffix +
        ` · presence-tier + forensic-content both wired (CP12.4 + Phase 1.5.D OPERATIONAL)`;

      tile.title =
        'Coverage gaps = policies codified + agents with genuine audit-trail gap in last 7d. ' +
        'Per CP12.9 disposition enrichment: missing agents classified as ' +
        'alias_of / different_runtime / inactive / genuine_gap; headline reflects ' +
        'genuine_gap only. Phase 1.5.D file-access substrate OPERATIONAL per #7959 ' +
        '(eBPF tracepoints + 3-program load + ringbuf pin; CC7 events_mtd ~16K).';

      // Severity: warn if any genuine gap OR no codified policies; clean otherwise
      tile.className = 'audit-tile' +
        (codified === 0 || genuineGap > 0 ? ' severity-warn' : ' severity-clean');
    } catch (e) { /* keep prior */ }

    // Tile 3: Recent high-risk events (last 24h)
    try {
      const r = await fetch('/api/v1/plexus/public/audit/anomaly-detail');
      const j = await r.json();
      const tile = document.getElementById('tile-recent-risk');
      if (!tile) return;
      const wrap = tile.querySelector('.tile-events');
      clearChildren(wrap);
      const top3 = (j.anomalies || []).slice(0, 3);
      if (top3.length === 0) {
        wrap.appendChild(el('div', { class: 'event-row' }, el('span', { class: 'event-agent muted' }, 'no anomalies')));
        tile.className = 'audit-tile severity-clean';
      } else {
        for (const a of top3) {
          const row = el('div', { class: 'event-row' });
          row.appendChild(el('span', { class: 'event-agent', title: a.agent_id || '(unattributed)' }, a.agent_id || '(unattributed)'));
          row.appendChild(el('span', { class: 'event-count' }, `${a.policy_violation_count || 0} viol`));
          wrap.appendChild(row);
        }
        tile.className = 'audit-tile severity-warn';
      }
    } catch (e) { /* keep prior */ }

    // Tile 4: Attestation status — per-framework completeness rollup.
    // CP12.10: ratio measures substrate-wired vs total (6/6 once Phase 3
    // governance substrate is wired). Producing-ratio = areas with non-zero
    // counts; surfaced as a secondary signal so operators see attestation-
    // cadence health alongside substrate-coverage.
    try {
      const r = await fetch('/api/v1/plexus/public/audit/by-control-area?control_framework=soc2&period=mtd');
      const j = await r.json();
      const tile = document.getElementById('tile-attest-status');
      if (!tile) return;
      const areas = j.control_areas || [];
      const wired = areas.filter(a => (a.audit_object_classes || []).length > 0).length;
      const producing = areas.filter(a => ((a.counts && a.counts.total) || 0) > 0).length;
      const total = areas.length || 0;
      const pct = total > 0 ? ((wired / total) * 100).toFixed(0) : 0;
      tile.querySelector('.tile-val').textContent = total > 0 ? `${pct}%` : '—';
      tile.querySelector('.tile-sub').textContent =
        `SOC 2 · ${wired}/${total} substrate-wired · ${producing}/${total} producing events (MTD)`;
      tile.className = 'audit-tile' + (wired === total && producing === total && total > 0
        ? ' severity-clean'
        : (wired === total ? ' severity-info' : ' severity-warn'));
    } catch (e) { /* keep prior */ }
  }

  // ─── Incident sub-view: high-risk-event list + drill-through ─────────
  async function renderIncident() {
    const panel = document.getElementById('audit-sub-incident');
    clearChildren(panel);

    // Search bar (event_id lookup)
    const search = el('div', { class: 'incident-search' });
    const searchInput = el('input', { type: 'text', placeholder: 'event_id lookup (16-char sha256 prefix)' });
    const searchBtn = el('button', { class: 'audit-btn' }, 'Lookup');
    search.appendChild(searchInput);
    search.appendChild(searchBtn);
    panel.appendChild(search);
    searchBtn.addEventListener('click', () => {
      const id = searchInput.value.trim();
      if (!id) return;
      lookupEvent(id, panel);
    });
    searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') searchBtn.click(); });

    const list = el('div', { class: 'incident-list', id: 'incident-list' });
    panel.appendChild(list);
    list.appendChild(el('div', { class: 'audit-loading' }, 'loading high-risk events…'));

    try {
      // Pending violations sorted by severity (server already does R-A2 sort)
      const r = await fetch('/api/v1/plexus/public/policy/violations?disposition=pending&limit=50');
      const j = await r.json();
      clearChildren(list);
      const rows = j.violations || [];
      if (rows.length === 0) {
        list.appendChild(el('div', { class: 'audit-loading' }, 'No pending policy violations. Cluster discipline holding.'));
        return;
      }
      for (const v of rows) {
        const sev = (v.severity_class || 'info').toLowerCase();
        const row = el('div', { class: 'incident-row severity-' + sev });
        row.appendChild(el('div', { class: 'inc-ts' }, fmtAge(v.occurred_at) || v.occurred_at));
        row.appendChild(el('div', { class: 'inc-sev' }, sev));
        row.appendChild(el('div', { class: 'inc-headline' }, `${v.rule_id} → ${v.matched_object_class}:${v.matched_object_ref}`));
        row.appendChild(el('div', { class: 'inc-agent' }, v.agent_id || '(cluster)'));
        row.appendChild(el('div', { class: 'inc-event-id' }, v.event_id || '—'));
        row.addEventListener('click', () => lookupEvent(v.event_id, panel));
        list.appendChild(row);
      }
    } catch (e) {
      renderError(list, 'audit-loading', `error: ${e.message}`);
    }
  }

  async function lookupEvent(eventId, panel) {
    try {
      const r = await fetch(`/api/v1/plexus/public/audit/event/${encodeURIComponent(eventId)}`);
      if (r.status === 404) { alert(`Event ${eventId} not found`); return; }
      const j = await r.json();
      const detail = JSON.stringify(j, null, 2);
      alert(`Event ${eventId}\n\n${detail}`);
    } catch (e) {
      alert(`Lookup failed: ${e.message}`);
    }
  }

  // ─── Review sub-view: aggregate registers + coverage-gap indicator ───
  async function renderReview() {
    const panel = document.getElementById('audit-sub-review');
    clearChildren(panel);

    // Coverage-gap banner (bizmodel R-A3)
    const cg = el('div', { class: 'coverage-gap-banner', id: 'cg-banner' }, el('div', null, 'loading coverage gap…'));
    panel.appendChild(cg);

    // Dim picker (bizmodel R-A1: default control_area, not agent_id)
    const ctrl = el('div', { class: 'review-controls' });
    ctrl.appendChild(el('label', null, 'Activity register grouped by'));
    const dimSel = el('select');
    for (const d of ['control_area', 'agent_id', 'policy_rule', 'cost_center']) {
      const opt = el('option', { value: d }, d);
      if (d === _reviewDim) opt.selected = true;
      dimSel.appendChild(opt);
    }
    dimSel.addEventListener('change', () => { _reviewDim = dimSel.value; renderReview(); });
    ctrl.appendChild(dimSel);
    panel.appendChild(ctrl);

    const grid = el('div', { class: 'review-grid' });
    panel.appendChild(grid);

    // Card 1: per-agent activity register
    const c1 = el('div', { class: 'review-card' });
    c1.appendChild(el('h3', null,
      el('span', null, 'Activity register (last 7d)'),
      el('span', { class: 'review-card-meta' }, `by ${_reviewDim}`),
    ));
    const c1body = el('div', { id: 'review-activity-body' }, el('div', { class: 'audit-loading' }, 'loading…'));
    c1.appendChild(c1body);
    grid.appendChild(c1);

    // Card 2: per-policy-rule violation register
    const c2 = el('div', { class: 'review-card' });
    c2.appendChild(el('h3', null,
      el('span', null, 'Policy-violation register (pending first; R-A2 sort)'),
    ));
    const c2body = el('div', { id: 'review-violation-body' }, el('div', { class: 'audit-loading' }, 'loading…'));
    c2.appendChild(c2body);
    grid.appendChild(c2);

    // Card 3: credential-rotation register
    const c3 = el('div', { class: 'review-card' });
    c3.appendChild(el('h3', null, el('span', null, 'Credential-rotation register (last 30d)')));
    const c3body = el('div', { id: 'review-cred-body' }, el('div', { class: 'audit-loading' }, 'loading…'));
    c3.appendChild(c3body);
    grid.appendChild(c3);

    // Card 4: permission-change register
    const c4 = el('div', { class: 'review-card' });
    c4.appendChild(el('h3', null, el('span', null, 'Permission-change register (last 30d)')));
    const c4body = el('div', { id: 'review-perm-body' }, el('div', { class: 'audit-loading' }, 'loading…'));
    c4.appendChild(c4body);
    grid.appendChild(c4);

    // Populate coverage gap
    try {
      const r = await fetch('/api/v1/plexus/public/audit/coverage-gap');
      const j = await r.json();
      clearChildren(cg);
      const missing = j.agents_missing_trail_7d || 0;
      if (missing > 0) cg.classList.add('has-gap');
      cg.appendChild(el('span', { class: 'cg-lbl' }, 'Audit coverage:'));
      cg.appendChild(el('span', { class: 'cg-stat' }, `${j.agents_audit_wired || 0} agents wired`));
      cg.appendChild(el('span', { class: 'cg-lbl' }, '·'));
      cg.appendChild(el('span', { class: 'cg-stat' }, `${missing} agents missing 7d trail`));
      if (missing > 0 && (j.missing_agent_ids || []).length > 0) {
        cg.appendChild(el('span', { class: 'cg-missing', title: j.missing_agent_ids.join(', ') }, `(${j.missing_agent_ids.slice(0, 3).join(', ')}${missing > 3 ? '…' : ''})`));
      }
    } catch (e) { /* leave loading text */ }

    // Card 1 + 2 + 3 + 4 populate
    populateReviewCard1(c1body);
    populateReviewCard2(c2body);
    populateReviewCard3(c3body);
    populateReviewCard4(c4body);
  }

  async function populateReviewCard1(body) {
    // CP12.3.1 (bizmodel #7773 R-A1 fix): route all 4 picker options properly.
    // Picker shows {control_area, agent_id, policy_rule, cost_center}; original
    // populator only branched on agent_id vs fallback to tool_name — same shape
    // as CP11.7 R1/R2 gap. Each dim now uses the source-of-truth endpoint.
    try {
      const today = new Date().toISOString().slice(0, 10);
      const sevenAgo = new Date(Date.now() - 6 * 86400_000).toISOString().slice(0, 10);
      clearChildren(body);

      // control_area: aggregate from /audit/by-control-area (same source-of-truth
      // as the Attest sub-tab; class-level counts surface directly per area).
      if (_reviewDim === 'control_area') {
        const r = await fetch(`/api/v1/plexus/public/audit/by-control-area?control_framework=soc2&period=7d`);
        const j = await r.json();
        const counts = new Map();
        for (const a of (j.control_areas || [])) {
          const total = Object.values(a.counts || {}).reduce((s, v) => s + (v || 0), 0);
          counts.set(`${a.id} · ${a.name}`, total);
        }
        renderCard1Counts(body, counts, 'control areas (SOC2)');
        return;
      }

      // policy_rule: aggregate from /policy/violations grouped by rule_id.
      if (_reviewDim === 'policy_rule') {
        const r = await fetch(`/api/v1/plexus/public/policy/violations?from=${sevenAgo}&to=${today}&limit=500`);
        const j = await r.json();
        const counts = new Map();
        for (const v of (j.violations || [])) {
          const k = v.rule_id || '(unknown)';
          counts.set(k, (counts.get(k) || 0) + 1);
        }
        renderCard1Counts(body, counts, 'policy rules with violations in 7d');
        return;
      }

      // cost_center: honest Phase 2 hedge. agent_id → cost_center mapping lives
      // in cost_dimension_tags (no public endpoint in Phase 1); ingester-side
      // enrichment of audit_tool_invocation rows is Phase 2 scope per ADR-0030
      // §Phase 2 source-coverage expansion (admin R4 fold).
      if (_reviewDim === 'cost_center') {
        body.appendChild(el('div', { class: 'audit-loading' },
          'cost_center enrichment ships in Phase 2 (admin R4 ingester source-coverage). Switch to control_area / agent_id / policy_rule for Phase 1 data.'));
        return;
      }

      // agent_id (and any other fallthrough): aggregate from /audit/tool-invocations.
      const r = await fetch(`/api/v1/plexus/public/audit/tool-invocations?from=${sevenAgo}&to=${today}&limit=500`);
      const j = await r.json();
      const rows = j.rows || j.tool_invocations || [];
      const counts = new Map();
      for (const row of rows) {
        const key = row.agent_id || '(unattributed)';
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      renderCard1Counts(body, counts, 'agents emitting tool-invocations in 7d');
    } catch (e) {
      renderError(body, 'audit-loading', `error: ${e.message}`);
    }
  }

  function renderCard1Counts(body, counts, emptyLabel) {
    if (counts.size === 0) {
      body.appendChild(el('div', { class: 'audit-loading' }, `no ${emptyLabel}`));
      return;
    }
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    for (const [k, v] of sorted) {
      const row = el('div', { class: 'review-row' });
      row.appendChild(el('span', { class: 'review-lbl' }, k));
      row.appendChild(el('span', { class: 'review-val' }, String(v)));
      body.appendChild(row);
    }
  }

  async function populateReviewCard2(body) {
    try {
      const r = await fetch('/api/v1/plexus/public/policy/violations?limit=100');
      const j = await r.json();
      const rows = j.violations || [];
      clearChildren(body);
      if (rows.length === 0) {
        body.appendChild(el('div', { class: 'audit-loading' }, 'no policy violations recorded'));
        return;
      }
      const byRule = new Map();
      for (const v of rows) {
        const k = v.rule_id;
        if (!byRule.has(k)) byRule.set(k, { pending: 0, total: 0 });
        const g = byRule.get(k);
        g.total += 1;
        if (v.disposition === 'pending') g.pending += 1;
      }
      const sorted = [...byRule.entries()].sort((a, b) => b[1].pending - a[1].pending);
      for (const [k, g] of sorted.slice(0, 10)) {
        const row = el('div', { class: 'review-row' });
        row.appendChild(el('span', { class: 'review-lbl' }, k));
        row.appendChild(el('span', { class: 'review-val' }, `${g.pending} pending · ${g.total} total`));
        body.appendChild(row);
      }
    } catch (e) {
      renderError(body, 'audit-loading', `error: ${e.message}`);
    }
  }

  async function populateReviewCard3(body) {
    try {
      const today = new Date().toISOString();
      const thirtyAgo = new Date(Date.now() - 30 * 86400_000).toISOString();
      const r = await fetch(`/api/v1/plexus/public/audit/credential-changes?from=${thirtyAgo}&to=${today}&limit=50`);
      const j = await r.json();
      const rows = j.rows || j.credential_changes || [];
      clearChildren(body);
      if (rows.length === 0) {
        body.appendChild(el('div', { class: 'audit-loading' }, 'no credential-rotation events in 30d window'));
        return;
      }
      for (const r of rows.slice(0, 10)) {
        const row = el('div', { class: 'review-row' });
        row.appendChild(el('span', { class: 'review-lbl' }, `${r.credential_class} ${r.change_type}`));
        row.appendChild(el('span', { class: 'review-val' }, fmtAge(r.occurred_at) || ''));
        body.appendChild(row);
      }
    } catch (e) {
      renderError(body, 'audit-loading', `error: ${e.message}`);
    }
  }

  async function populateReviewCard4(body) {
    try {
      const today = new Date().toISOString();
      const thirtyAgo = new Date(Date.now() - 30 * 86400_000).toISOString();
      const r = await fetch(`/api/v1/plexus/public/audit/permission-changes?from=${thirtyAgo}&to=${today}&limit=50`);
      const j = await r.json();
      const rows = j.rows || j.permission_changes || [];
      clearChildren(body);
      if (rows.length === 0) {
        body.appendChild(el('div', { class: 'audit-loading' }, 'no permission-change events in 30d window'));
        return;
      }
      for (const r of rows.slice(0, 10)) {
        const row = el('div', { class: 'review-row' });
        row.appendChild(el('span', { class: 'review-lbl' }, `${r.agent_id} ${r.change_type}`));
        row.appendChild(el('span', { class: 'review-val' }, fmtAge(r.occurred_at) || ''));
        body.appendChild(row);
      }
    } catch (e) {
      renderError(body, 'audit-loading', `error: ${e.message}`);
    }
  }

  // ─── Attest sub-view: control-area browser per framework ─────────────
  async function renderAttest() {
    const panel = document.getElementById('audit-sub-attest');
    clearChildren(panel);

    const ctrl = el('div', { class: 'attest-controls' });
    ctrl.appendChild(el('label', null, 'Framework'));
    const fwSel = el('select');
    for (const f of ['soc2', 'iso27001', 'gdpr']) {
      const opt = el('option', { value: f }, f.toUpperCase());
      if (f === _attestFramework) opt.selected = true;
      fwSel.appendChild(opt);
    }
    fwSel.addEventListener('change', () => { _attestFramework = fwSel.value; renderAttest(); });
    ctrl.appendChild(fwSel);
    const exportBtn = el('button', null, 'Export evidence bundle');
    exportBtn.addEventListener('click', () => {
      const url = `/api/v1/plexus/public/audit/export?format=csv&schema=${_attestFramework}-bundle&period=mtd`;
      window.open(url, '_blank');
    });
    ctrl.appendChild(exportBtn);
    panel.appendChild(ctrl);

    const list = el('div', { class: 'control-area-list', id: 'attest-list' });
    panel.appendChild(list);
    list.appendChild(el('div', { class: 'audit-loading' }, `loading ${_attestFramework.toUpperCase()} control areas…`));

    try {
      const r = await fetch(`/api/v1/plexus/public/audit/by-control-area?control_framework=${_attestFramework}&period=mtd`);
      const j = await r.json();
      clearChildren(list);
      const areas = j.control_areas || [];
      if (areas.length === 0) {
        list.appendChild(el('div', { class: 'audit-loading' }, 'no control areas defined for this framework'));
        return;
      }
      for (const a of areas) {
        const row = el('div', { class: 'control-area-row' });
        row.appendChild(el('div', { class: 'ca-id' }, a.id));
        row.appendChild(el('div', { class: 'ca-name' }, a.name));
        const cls = el('div', { class: 'ca-classes' });
        for (const c of (a.audit_object_classes || [])) {
          cls.appendChild(el('span', { class: 'ca-class' }, c));
        }
        if ((a.audit_object_classes || []).length === 0) {
          cls.appendChild(el('span', { class: 'muted', style: 'font-style: italic' }, '(no audit-class mapping yet)'));
        }
        row.appendChild(cls);
        const counts = a.counts || {};
        const total = Object.values(counts).reduce((s, v) => s + (v || 0), 0);
        row.appendChild(el('div', { class: 'ca-counts' }, `${total} events`));
        list.appendChild(row);
      }
    } catch (e) {
      renderError(list, 'audit-loading', `error: ${e.message}`);
    }

    // CP12.20: Chain integrity card — last 30 days anchor verify status.
    // Per ADR-0030 v1.2 §Phase 3(A) + secops #8028 honesty note: anchor
    // covers high-water event_id + 100-event recent horizon (sample-based);
    // verify uses Reading-2 semantics (CP12.12.1) so match:true is
    // reproducible + match:false signals genuine tamper.
    const chainCard = _buildChainIntegrityCard();
    panel.appendChild(chainCard);
    _populateChainIntegrityCard(chainCard);  // async fill
  }

  function _buildChainIntegrityCard() {
    const card = el('div', { class: 'chain-integrity-card' });
    const header = el('div', { class: 'ci-header' });
    header.appendChild(el('div', { class: 'ci-title' }, 'Chain integrity (Phase 3 (A) anchor verify)'));
    header.appendChild(el('div', { class: 'ci-substrate' }, 'substrate: s3-object-lock'));
    card.appendChild(header);
    card.appendChild(el('div', { class: 'ci-note' },
      'Anchor covers chain high-water event_id + 100-event recent horizon (sample-based, not full Merkle). Reading-2 verify (CP12.12.1): match:false = genuine tamper signal, not chain-advancement noise. Click any day to inspect.'));

    const grid = el('div', { class: 'chain-integrity-grid' });
    card.appendChild(grid);

    // Build 30-day window placeholder (gray) first; populate from API.
    const today = new Date();
    const days = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today.getTime() - i * 86400_000);
      days.push(d.toISOString().slice(0, 10));
    }
    const cellByDay = new Map();
    for (const day of days) {
      const cell = el('div', { class: 'ci-cell ci-missing', title: `${day} · no anchor recorded yet` });
      cell.addEventListener('click', () => _drillChainIntegrity(day));
      cellByDay.set(day, cell);
      grid.appendChild(cell);
    }

    // Legend
    const legend = el('div', { class: 'chain-integrity-legend' });
    const mkSwatch = (cls) => {
      const s = el('span', { class: `legend-swatch ${cls}` });
      s.style.backgroundColor = cls === 'ci-match' ? 'var(--green)'
        : cls === 'ci-tamper' ? 'var(--red)'
        : 'rgba(255,255,255,0.04)';
      return s;
    };
    const lm = el('span'); lm.appendChild(mkSwatch('ci-match')); lm.appendChild(document.createTextNode(' verified (match)'));
    const lt = el('span'); lt.appendChild(mkSwatch('ci-tamper')); lt.appendChild(document.createTextNode(' TAMPER DETECTED'));
    const ln = el('span'); ln.appendChild(mkSwatch('ci-missing')); ln.appendChild(document.createTextNode(' no anchor (gap)'));
    legend.appendChild(lm); legend.appendChild(lt); legend.appendChild(ln);
    card.appendChild(legend);

    // Stash cell-by-day map on the card so the async populator can find it.
    card._cellByDay = cellByDay;
    card._days = days;
    return card;
  }

  async function _populateChainIntegrityCard(card) {
    const cellByDay = card._cellByDay;
    const days = card._days;
    if (!cellByDay || !days) return;
    try {
      const r = await fetch(`/api/v1/plexus/public/audit/anchors?from=${days[0]}&to=${days[days.length-1]}&limit=100`);
      const j = await r.json();
      const anchors = j.rows || [];
      await Promise.all(anchors.map(async (a) => {
        const cell = cellByDay.get(a.anchor_day);
        if (!cell) return;
        try {
          const vr = await fetch(`/api/v1/plexus/public/audit/anchor-verify?day=${a.anchor_day}&anchor_substrate=${encodeURIComponent(a.anchor_substrate)}`);
          const vj = await vr.json();
          cell.classList.remove('ci-missing');
          if (vj.match) {
            cell.classList.add('ci-match');
            cell.title = `${a.anchor_day} · ${a.anchor_substrate} · verified (match:true)`;
          } else {
            cell.classList.add('ci-tamper');
            cell.title = `${a.anchor_day} · ${a.anchor_substrate} · TAMPER DETECTED — ${vj.note || 'mismatch'}`;
          }
        } catch (e) { /* leave as missing */ }
      }));
    } catch (e) { /* leave grid as missing */ }
  }

  async function _drillChainIntegrity(day) {
    try {
      const r = await fetch(`/api/v1/plexus/public/audit/anchor/${day}`);
      if (r.status === 404) {
        alert(`No anchor recorded for ${day}.\n\nGap may mean: anchor-publisher cron didn't run that day, OR the day is before the first anchor was recorded.`);
        return;
      }
      const j = await r.json();
      const vr = await fetch(`/api/v1/plexus/public/audit/anchor-verify?day=${day}`);
      const vj = await vr.json();
      const lines = [
        `Anchor: ${day}`,
        '',
        `Substrate: ${j.anchor_substrate || (j.anchors && j.anchors[0] && j.anchors[0].anchor_substrate) || '(multi)'}`,
        `Anchor URI: ${j.anchor_uri || (j.anchors && j.anchors[0] && j.anchors[0].anchor_uri) || '(see anchors[])'}`,
        '',
        `Verify result: ${vj.match ? '✓ MATCH' : '✗ TAMPER DETECTED'}`,
        `tamper_detected: ${vj.tamper_detected}`,
        '',
        `Stored digest:     ${vj.stored_digest || '—'}`,
        `Recomputed digest: ${vj.recomputed_digest || '—'}`,
        '',
        `Stored high-water: ${vj.stored_high_water_event_id || '—'}`,
        `Stored table:      ${vj.stored_high_water_table || '—'}`,
        `Sample size:       ${vj.sample_size || '—'}`,
        '',
        `Note: ${vj.note || ''}`,
      ];
      alert(lines.join('\n'));
    } catch (e) {
      alert(`drill failed: ${e.message}`);
    }
  }

  // ─── Policies sub-view: rule list + add/edit form ───────────────────
  async function renderPolicies() {
    const panel = document.getElementById('audit-sub-policies');
    clearChildren(panel);
    panel.appendChild(_renderAuditOpsBanner('Policy-as-code management is ops-key gated',
      'Add/edit/ratify/deprecate rules; updates via /api/v1/ops/policy/rule. DSL evaluator is sandboxed per secops #7706 (100ms / 1MB / no fs-net-proc / no regex; use contains/startsWith/endsWith/IN/IS NULL).'));

    const ctrl = el('div', { class: 'budget-controls' });
    const addBtn = el('button', null, '+ Add / edit rule');
    ctrl.appendChild(addBtn);
    const refreshBtn = el('button', { class: 'ghost', style: 'background:transparent;border:1px solid var(--border);color:var(--muted);' }, 'Refresh');
    ctrl.appendChild(refreshBtn);
    panel.appendChild(ctrl);

    const form = _buildPolicyAddForm();
    panel.appendChild(form);
    addBtn.addEventListener('click', () => form.classList.toggle('open'));

    const list = el('div', { class: 'policy-list', id: 'policy-rule-list' });
    panel.appendChild(list);
    refreshBtn.addEventListener('click', () => loadPolicyList());
    loadPolicyList();
  }

  async function loadPolicyList() {
    const list = document.getElementById('policy-rule-list');
    if (!list) return;
    list.innerHTML = '<div class="audit-loading">loading…</div>';
    try {
      const r = await fetch('/api/v1/plexus/public/policy/rules');
      const j = await r.json();
      clearChildren(list);
      const rules = j.rules || [];
      if (rules.length === 0) {
        list.appendChild(el('div', { class: 'budget-empty' }, 'No policy rules codified yet. Click "+ Add / edit rule" to author one (ops-key required).'));
        return;
      }
      for (const r of rules) {
        const row = el('div', { class: 'policy-row status-' + (r.status || 'draft') });
        row.appendChild(el('div', { class: 'pol-id', title: r.description || '' }, r.rule_id));
        row.appendChild(el('div', { class: 'pol-name', title: r.name }, r.name));
        row.appendChild(el('div', { class: 'pol-severity sev-' + (r.severity_class || 'info') }, (r.severity_class || 'info').slice(0, 4)));
        row.appendChild(el('div', { class: 'pol-status' }, r.status));
        list.appendChild(row);
      }
    } catch (e) {
      renderError(list, 'audit-loading', `error: ${e.message}`);
    }
  }

  function _buildPolicyAddForm() {
    const form = el('div', { class: 'budget-add-form' });
    const fieldRow = el('div', { class: 'field-row', style: 'display:grid;grid-template-columns:1fr 1fr;gap:10px;' });
    const ridI = el('input', { type: 'text', placeholder: 'e.g. POL-SECRETS-001' });
    const nameI = el('input', { type: 'text', placeholder: 'human-readable name' });
    const descI = el('input', { type: 'text', placeholder: 'description' });
    const applI = el('input', { type: 'text', value: '{"object_classes":["messages"]}', placeholder: 'applicability JSON' });
    const dslI = el('input', { type: 'text', placeholder: 'predicate DSL (e.g. body contains "sk-")' });
    const sevI = el('select');
    for (const s of ['info', 'warn', 'violation', 'critical']) sevI.appendChild(el('option', { value: s }, s));
    const submit = el('button', null, 'Save (draft)');
    const ratifyBtn = el('button', { class: 'ghost', style: 'background:transparent;border:1px solid var(--green);color:var(--green);' }, 'Save + ratify');
    for (const [lbl, inp] of [['Rule ID', ridI], ['Name', nameI], ['Description', descI], ['Applicability JSON', applI], ['Predicate DSL', dslI], ['Severity', sevI]]) {
      const f = el('div', { class: 'recon-field' });
      f.appendChild(el('label', null, lbl));
      f.appendChild(inp);
      fieldRow.appendChild(f);
    }
    fieldRow.appendChild(submit);
    fieldRow.appendChild(ratifyBtn);
    form.appendChild(fieldRow);

    async function savePolicy(ratify) {
      const opsKey = await _promptOpsKey();
      if (!opsKey) return;
      let applicability;
      try { applicability = JSON.parse(applI.value); }
      catch (e) { alert('Invalid applicability JSON: ' + e.message); return; }
      const body = {
        rule_id: ridI.value.trim(),
        name: nameI.value.trim(),
        description: descI.value.trim(),
        applicability_json: applicability,
        predicate_dsl: dslI.value.trim(),
        severity_class: sevI.value,
      };
      const r = await fetch('/api/v1/ops/policy/rule', {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${opsKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        alert('Error: ' + (j.message || r.status));
        return;
      }
      if (ratify) {
        const r2 = await fetch(`/api/v1/ops/policy/rule/${encodeURIComponent(body.rule_id)}/ratify`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${opsKey}` },
        });
        if (!r2.ok) {
          const j = await r2.json().catch(() => ({}));
          alert('Save succeeded but ratify failed: ' + (j.message || r2.status));
        }
      }
      form.classList.remove('open');
      loadPolicyList();
      refreshAuditHero();
    }
    submit.addEventListener('click', () => savePolicy(false));
    ratifyBtn.addEventListener('click', () => savePolicy(true));
    return form;
  }

  // ─── Reconcile sub-view (ops-key gated) ─────────────────────────────
  function renderAuditReconcile() {
    const panel = document.getElementById('audit-sub-reconcile');
    clearChildren(panel);
    panel.appendChild(_renderAuditOpsBanner('Audit reconciliation is ops-key gated',
      'Reconcile against external systems (SIEM / GRC platform / external audit firm bundle). Mirror of cost-reconciliation shape; computes delta + concentration.'));

    const form = el('div', { class: 'recon-controls' });
    const fields = [
      ['period_start', 'Period start (YYYY-MM-DD)', new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10)],
      ['period_end', 'Period end (YYYY-MM-DD)', new Date().toISOString().slice(0, 10)],
      ['external_system_label', 'External system label', 'siem'],
      ['plexus_count', 'Plexus count', ''],
      ['external_count', 'External count', ''],
      ['reconciler_agent_id', 'Reconciler agent_id', SELF_AGENT_ID || ''],
    ];
    const inputs = {};
    for (const [name, label, dft] of fields) {
      const f = el('div', { class: 'recon-field' });
      f.appendChild(el('label', null, label));
      const inp = el('input', { type: name.includes('count') ? 'number' : 'text', value: dft });
      inputs[name] = inp;
      f.appendChild(inp);
      form.appendChild(f);
    }
    const submitBtn = el('button', null, 'Reconcile');
    form.appendChild(submitBtn);
    panel.appendChild(form);

    const result = el('div', { id: 'audit-recon-result' });
    panel.appendChild(result);

    submitBtn.addEventListener('click', async () => {
      const opsKey = await _promptOpsKey();
      if (!opsKey) return;
      const body = {
        period_start: inputs.period_start.value,
        period_end: inputs.period_end.value,
        external_system_label: inputs.external_system_label.value,
        plexus_count: parseInt(inputs.plexus_count.value || '0', 10),
        external_count: parseInt(inputs.external_count.value || '0', 10),
        reconciler_agent_id: inputs.reconciler_agent_id.value,
      };
      result.innerHTML = '<div class="audit-loading">submitting…</div>';
      try {
        const r = await fetch('/api/v1/ops/audit/reconcile', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${opsKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const j = await r.json();
        if (!r.ok) {
          renderError(result, 'audit-loading', `error: ${j.message || r.status}`);
          return;
        }
        result.innerHTML = '';
        const banner = el('div', { class: 'recon-banner' });
        banner.appendChild(el('div', null,
          `Reconciled · external ${body.external_count} vs Plexus ${body.plexus_count} · delta ${j.delta_count >= 0 ? '+' : ''}${j.delta_count} (${(j.delta_pct || 0).toFixed(1)}%)`));
        result.appendChild(banner);
      } catch (e) {
        renderError(result, 'audit-loading', `network error: ${e.message}`);
      }
    });
  }

  // ─── Audit ops-banner helper (mirrors cost _renderOpsBanner) ─────────
  function _renderAuditOpsBanner(title, sub) {
    const wrap = el('div', { class: 'ops-banner' });
    wrap.appendChild(el('div', null, el('strong', null, '🔐 ' + title)));
    wrap.appendChild(el('div', { style: 'margin-top: 4px;' }, sub));
    const clear = el('button', { class: 'audit-btn audit-btn-ghost', style: 'margin-top: 8px;' }, 'clear stored ops-key');
    clear.addEventListener('click', () => { _setOpsKey(''); alert('ops-key cleared'); });
    if (_opsKey()) wrap.appendChild(clear);
    return wrap;
  }

  // ─── Tab activation hook ────────────────────────────────────────────
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.addEventListener('click', () => {
      if (b.dataset.tab === 'cost') ensureCostView();
      if (b.dataset.tab === 'audit') ensureAuditView();
      if (b.dataset.tab === 'effort') ensureEffortView();
    });
  });
  window.addEventListener('hashchange', () => {
    if (location.hash === '#cost') ensureCostView();
    if (location.hash === '#audit') ensureAuditView();
    if (location.hash === '#effort') ensureEffortView();
  });

  // ────────────────────────────────────────────────────────────────────
  // CP13.4 / ADR-0032 Phase 1.4: /dashboard#effort three-lens UX
  //
  // Two orthogonal axes per s345 #9234 CLEAN RATIFY:
  //   Lens (data-slicing): pace / composition / anomaly
  //   Audience-tier (render):  buyer / practitioner / investor
  // Default audience = buyer per s345 #9234 Criterion 5.
  //
  // SERVER-SIDE Fold B HARD GATE: activity-numerator ratios stripped at
  // /api/v1/output/ratios for buyer + investor. UI also hides those
  // tiles (defense in depth) via the CSS class `audience-practitioner`
  // on the tab-panel. Even if a user toggles the CSS class, the API
  // responses for buyer/investor never contain the activity-numerator
  // data so the tiles render as '—'.
  // ────────────────────────────────────────────────────────────────────
  let effortInitialized = false;
  const effortState = {
    audience: 'buyer',
    lens: 'pace',
    period: '30d',
  };

  function ensureEffortView() {
    if (effortInitialized) {
      refreshEffortData();
      return;
    }
    effortInitialized = true;

    document.querySelectorAll('#tab-effort .audience-btn').forEach((b) => {
      b.addEventListener('click', () => {
        effortState.audience = b.dataset.audience;
        document.querySelectorAll('#tab-effort .audience-btn').forEach((x) => {
          x.classList.toggle('active', x.dataset.audience === effortState.audience);
        });
        const panel = document.getElementById('tab-effort');
        if (panel) {
          // CP13.6 Phase 2.4: 3-way audience-tier class toggle for Fold-B
          // canon-compliant tile visibility (buyer = cross-tier-safe only)
          panel.classList.toggle('audience-buyer', effortState.audience === 'buyer');
          panel.classList.toggle('audience-investor', effortState.audience === 'investor');
          panel.classList.toggle('audience-practitioner', effortState.audience === 'practitioner');
        }
        refreshEffortData();
      });
    });

    document.querySelectorAll('#tab-effort .lens-btn').forEach((b) => {
      b.addEventListener('click', () => {
        effortState.lens = b.dataset.lens;
        document.querySelectorAll('#tab-effort .lens-btn').forEach((x) => {
          x.classList.toggle('active', x.dataset.lens === effortState.lens);
        });
        document.querySelectorAll('#tab-effort .effort-lens-pane').forEach((p) => {
          p.style.display = p.dataset.lensPane === effortState.lens ? '' : 'none';
        });
        refreshEffortData();
      });
    });

    const periodSel = document.getElementById('effort-period');
    if (periodSel) {
      periodSel.addEventListener('change', () => {
        effortState.period = periodSel.value;
        refreshEffortData();
      });
    }

    // Task #264 Phase 2.5: dashboard picker overrides effort period when
    // the preset maps cleanly (7d / 30d). Non-matching presets (1h / 24h)
    // leave effort period alone — no meaningful sub-day semantics on effort
    // aggregates. Return-to-Live restores user's pre-override effort period.
    let _savedEffortPeriod = effortState.period;
    const EFFORT_PRESET_MAP = { '7d': '7d', '30d': '30d' };
    let _prevEffortLive = true;
    document.addEventListener('dashboardTimeRangeChange', (e) => {
      const preset = e.detail && e.detail.preset;
      const mapped = EFFORT_PRESET_MAP[preset];
      const goingLive = preset === 'live';
      if (goingLive) {
        if (!_prevEffortLive && periodSel) {
          effortState.period = _savedEffortPeriod;
          periodSel.value = _savedEffortPeriod;
          if (periodSel) periodSel.disabled = false;
          refreshEffortData();
        }
      } else if (mapped && periodSel) {
        if (_prevEffortLive) _savedEffortPeriod = effortState.period;
        effortState.period = mapped;
        periodSel.value = mapped;
        periodSel.disabled = true;
        refreshEffortData();
      } else if (periodSel) {
        // Non-mappable preset (1h / 24h) — leave period alone but disable the
        // selector so the operator isn't led to expect finer resolution.
        if (_prevEffortLive) _savedEffortPeriod = effortState.period;
        periodSel.disabled = true;
      }
      _prevEffortLive = goingLive;
    });
    // Initial-load `?range=<preset>`: apply mapping on mount.
    if (window.getDashboardTimeWindow) {
      const initWin = window.getDashboardTimeWindow();
      if (initWin && initWin.preset) {
        const mapped = EFFORT_PRESET_MAP[initWin.preset];
        if (mapped && periodSel) {
          _savedEffortPeriod = effortState.period;
          effortState.period = mapped;
          periodSel.value = mapped;
          periodSel.disabled = true;
          _prevEffortLive = false;
        } else if (periodSel) {
          _savedEffortPeriod = effortState.period;
          periodSel.disabled = true;
          _prevEffortLive = false;
        }
      }
    }

    // CP13.6 Phase 2.4 init-time audience-tier class application
    // (effortState defaults to 'buyer'; click handler only fires on user-change)
    const initPanel = document.getElementById('tab-effort');
    if (initPanel) {
      initPanel.classList.toggle('audience-buyer', effortState.audience === 'buyer');
      initPanel.classList.toggle('audience-investor', effortState.audience === 'investor');
      initPanel.classList.toggle('audience-practitioner', effortState.audience === 'practitioner');
    }

    refreshEffortData();
  }

  function fmtEffortMoney(v) {
    if (v == null || !Number.isFinite(v)) return '—';
    return '$' + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function fmtEffortNum(v) {
    if (v == null || !Number.isFinite(v)) return '—';
    return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  // CP13.6 Phase 2.4 format helpers for Phase 2.3 ratios.
  function fmtEffortPct(v) {
    if (v == null || !Number.isFinite(v)) return '—';
    return (v * 100).toFixed(1) + '%';
  }
  function fmtEffortHours(v) {
    if (v == null || !Number.isFinite(v)) return '—';
    if (v < 1) return (v * 60).toFixed(0) + 'm';
    if (v < 24) return v.toFixed(1) + 'h';
    return (v / 24).toFixed(1) + 'd';
  }

  async function fetchEffortJson(url) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (err) {
      return { _error: err.message };
    }
  }

  function escapeEffortHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // CP13.7 (parch #10812): map raw fetch errors to operator-calm copy. Never
  // surface raw "HTTP 500" / stack fragments on the glass — noise + minor leak.
  function sanitizeEffortError(msg) {
    const m = String(msg || '');
    if (/HTTP 40[13]/.test(m)) return 'Access denied for this view.';
    if (/HTTP 5\d\d/.test(m)) return 'Service error — please retry.';
    if (/Failed to fetch|NetworkError|ECONN|Load failed/i.test(m)) return 'Network unavailable — check the connection.';
    return 'Couldn’t load this data.';
  }

  // CP13.7: shared empty/loading/error state, mirroring the .chan-empty house
  // pattern. kind: 'loading' | 'empty' | 'error'. Returns a sanitized HTML
  // string (escaped throughout). When withRetry, an onclick hook id is emitted
  // so the caller can bind refreshEffortData (recovery affordance, WCAG 2.5.8).
  function effortStateHtml(kind, title, sub, withRetry) {
    const k = (kind === 'error' || kind === 'empty') ? kind : 'loading';
    let body = '';
    if (k === 'loading') body += '<div class="effort-skeleton"></div>';
    if (title) body += '<div class="es-title">' + escapeEffortHtml(title) + '</div>';
    if (sub) body += '<div class="es-sub">' + escapeEffortHtml(sub) + '</div>';
    if (k === 'error' && withRetry) {
      body += '<button type="button" class="es-retry" data-effort-retry="1">Retry</button>';
    }
    const live = k === 'loading' ? 'polite' : 'assertive';
    return '<div class="effort-state is-' + k + '" role="status" aria-live="' + live + '">' + body + '</div>';
  }

  // Bind any Retry button rendered by effortStateHtml to a fresh data fetch.
  function bindEffortRetry(container) {
    if (!container) return;
    const btn = container.querySelector('[data-effort-retry]');
    if (btn) btn.addEventListener('click', () => { refreshEffortData(); });
  }

  async function refreshEffortData() {
    const { audience, lens, period } = effortState;
    const readout = document.getElementById('effort-audience-readout');
    if (readout) readout.textContent = audience + '-default';

    const [ratios, coverage] = await Promise.all([
      fetchEffortJson('/api/v1/output/ratios?period=' + period + '&audience=' + audience),
      fetchEffortJson('/api/v1/output/coverage-gap?period=' + period),
    ]);

    // Tier-aware tile population (Phase 2.4): all tiles always populated; CSS
    // controls visibility per audience-tier class on #tab-effort. Hidden tiles
    // still get values written so audience-switching is instant (no re-fetch).
    const dpmpr = document.getElementById('tile-dpmpr');
    const dppm = document.getElementById('tile-dppm');
    const dpac = document.getElementById('tile-dpac');
    const pmr = document.getElementById('tile-pmr');
    const ttm = document.getElementById('tile-ttm');
    const cgap = document.getElementById('tile-cgap');
    const cgapSub = document.getElementById('tile-cgap-sub');
    if (dpmpr) dpmpr.textContent = fmtEffortMoney(ratios.dollar_per_merged_pr);
    if (dppm) dppm.textContent = fmtEffortMoney(ratios.dollar_per_pr_merged);
    if (dpac) dpac.textContent = fmtEffortMoney(ratios.dollar_per_agent_cycle);
    if (pmr) pmr.textContent = fmtEffortPct(ratios.pr_merge_rate);
    if (ttm) ttm.textContent = fmtEffortHours(ratios.time_to_merge_hours);
    if (cgap) cgap.textContent = coverage._error ? '—' : coverage.null_fallback_pct + '%';
    if (cgapSub) cgapSub.textContent = coverage._error
      ? sanitizeEffortError(coverage._error)
      : coverage.null_fallback_count + ' / ' + coverage.total_commits + ' commits';

    // Phase 2.3 ratio sub-text: cohort size for pr_merge_rate (substrate-honesty
    // discipline — show the denominator so operator sees data density).
    const pmrSub = document.getElementById('tile-pmr-sub');
    if (pmrSub && ratios._pr_opens_cohort_size != null) {
      pmrSub.textContent = ratios._pr_cohort_merged + ' / ' + ratios._pr_opens_cohort_size + ' opened';
    }
    const ttmSub = document.getElementById('tile-ttm-sub');
    if (ttmSub && ratios._pr_merges_in_period != null) {
      ttmSub.textContent = 'p50 (n=' + ratios._pr_merges_in_period + ')';
    }
    const dppmSub = document.getElementById('tile-dppm-sub');
    if (dppmSub && ratios._pr_merges_in_period != null) {
      dppmSub.textContent = ratios._pr_merges_in_period + ' GitHub PR-merges';
    }

    const cmpr = document.getElementById('tile-cmpr');
    const tipr = document.getElementById('tile-tipr');
    const aepr = document.getElementById('tile-aepr');
    if (cmpr) cmpr.textContent = fmtEffortNum(ratios.coord_messages_per_merged_pr);
    if (tipr) tipr.textContent = fmtEffortNum(ratios.tool_invocations_per_merged_pr);
    if (aepr) aepr.textContent = fmtEffortNum(ratios.agents_engaged_per_merged_pr);

    if (lens === 'composition') {
      const tbody = document.getElementById('effort-composition-tbody');
      if (tbody) tbody.innerHTML = '<tr><td colspan="5">' + effortStateHtml('loading', null, 'Loading effort data…') + '</td></tr>';
      const comp = await fetchEffortJson('/api/v1/output/composition?period=' + period + '&by=agent');
      renderEffortComposition(comp);
    } else if (lens === 'anomaly') {
      const readout = document.getElementById('effort-anomaly-readout');
      if (readout) readout.innerHTML = effortStateHtml('loading', null, 'Loading anomaly data…');
      const anom = await fetchEffortJson('/api/v1/output/anomalies?lookback_days=7&threshold=2.0');
      renderEffortAnomaly(anom);
    }
  }

  function renderEffortComposition(comp) {
    const tbody = document.getElementById('effort-composition-tbody');
    if (!tbody) return;
    if (comp._error) {
      tbody.innerHTML = '<tr><td colspan="5">' + effortStateHtml('error',
        'Couldn’t load composition.', sanitizeEffortError(comp._error), true) + '</td></tr>';
      bindEffortRetry(tbody);
      return;
    }
    if (!comp.rows || comp.rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5">' + effortStateHtml('empty',
        'No agent activity in this period.', 'Try a wider period, or check back after the next merge cycle.') + '</td></tr>';
      return;
    }
    tbody.innerHTML = comp.rows.slice(0, 30).map((r) =>
      '<tr><td>' + escapeEffortHtml(r.agent_id) + '</td>'
      + '<td>' + r.coord_msgs + '</td>'
      + '<td>' + r.commits + '</td>'
      + '<td>' + r.merges + '</td>'
      + '<td>' + fmtEffortMoney(r.cost_usd) + '</td></tr>'
    ).join('');
  }

  function renderEffortAnomaly(anom) {
    const readout = document.getElementById('effort-anomaly-readout');
    if (!readout) return;
    if (anom._error) {
      readout.innerHTML = effortStateHtml('error',
        'Couldn’t load anomaly data.', sanitizeEffortError(anom._error), true);
      bindEffortRetry(readout);
      return;
    }
    // Insufficient history: no prior-window mean to compare against (e.g. a new
    // cluster with < lookback days of cost data). Distinct from an error.
    if (anom.ratio == null && anom.prior_mean_usd == null) {
      readout.innerHTML = effortStateHtml('empty',
        'Not enough history yet.', 'Anomaly detection needs a full prior window of cost data. Check back after more activity accrues.');
      return;
    }
    const ratio = anom.ratio == null ? '—' : anom.ratio.toFixed(2) + '×';
    const status = anom.is_spike ? '🔴 SPIKE' : '🟢 normal';
    readout.innerHTML = '<div class="effort-section-body">'
      + '<p>Today\'s cost: <strong>' + fmtEffortMoney(anom.today_cost_usd) + '</strong></p>'
      + '<p>Prior ' + anom.lookback_days + '-day mean: <strong>' + fmtEffortMoney(anom.prior_mean_usd) + '</strong></p>'
      + '<p>Ratio: <strong>' + ratio + '</strong> · threshold: ' + anom.threshold + '× · <strong>' + status + '</strong></p>'
      + '</div>';
  }
  if (location.hash === '#cost') ensureCostView();
  if (location.hash === '#audit') ensureAuditView();

  // Resize charts on window resize.
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { for (const c of charts) c.resize(); }, 100);
  });

  // ────────────────────────────────────────────────────────────────────
  // CP8 (2026-05-27): Bus feed — public live message stream.
  // BusStream singleton: one EventSource shared between the Live-tab
  // ticker (always-on once Live mounted) and the Bus tab (lazy-mounted).
  // Public-only (no auth); dmFilter unbound-path forces private=0 server-side.
  // ────────────────────────────────────────────────────────────────────

  const BUS_BUFFER_CAP = 200;
  const BUS_BACKFILL_LIMIT = 50;
  const BUS_TICKER_DISPLAY = 15;
  // Default-excluded channels: high-volume / low-signal. User can re-enable.
  const BUS_DEFAULT_EXCLUDED = new Set(['agents', '_diag']);
  // CP10.2 (2026-06-01): ticker now shows ALL channels except the always-noisy
  // ones in BUS_DEFAULT_EXCLUDED. Pre-CP10.2 it was whitelist=[handoff,status]
  // which hid the new lane-channels (#substrate, #gamedev, #aieng, #bizdev)
  // landed in parch's #7284 channel-decomp. Jon's flag: "agents are chatting
  // and working but we are not seeing it." Exclude-set approach preserves
  // the original intent (drop high-volume/low-signal) while including
  // lane-channels the swarm now uses.
  function tickerShows(channel) {
    return channel && !BUS_DEFAULT_EXCLUDED.has(channel);
  }

  function chanClass(channel) {
    if (!channel) return 'chan-other';
    if (channel === 'handoff' || channel === 'status' || channel === 'agents' || channel === '_diag') {
      return 'chan-' + channel;
    }
    return 'chan-other';
  }

  function busRow(msg, opts = {}) {
    // Build one .bus-row from a message object.
    const row = el('div', {
      class: 'bus-row',
      'data-channel': msg.channel || '',
      'data-sender': msg.sender || '',
      'data-msg-id': String(msg.id),
    });
    row.appendChild(el('span', { class: 'bus-chan ' + chanClass(msg.channel) }, msg.channel || '?'));

    const senderWrap = el('span', { class: 'bus-sender', title: msg.sender || '' });
    // Reuse the runtime badge from CP7.x — lookup runtime from registry/OTel cache.
    const runtime = resolveRuntime(msg.sender, null);
    const badge = runtime && runtimeBadge(runtime);
    if (badge) senderWrap.appendChild(badge);
    senderWrap.appendChild(document.createTextNode(msg.sender || '?'));
    row.appendChild(senderWrap);

    const age = msg.created_at ? fmtAge(msg.created_at) : '—';
    row.appendChild(el('span', { class: 'bus-age', title: msg.created_at || '' }, age));

    const body = (msg.body || '').replace(/\s+/g, ' ').trim();
    row.appendChild(el('span', { class: 'bus-body', title: body }, body));

    const mentions = (msg.mentions || []).filter(m => m && m !== 'everyone');
    if (mentions.length > 0) {
      const mWrap = el('span', { class: 'bus-mentions' });
      mWrap.appendChild(document.createTextNode('→ '));
      for (const m of mentions.slice(0, 8)) {
        mWrap.appendChild(el('span', { class: 'bus-mention' }, '@' + m));
      }
      if (mentions.length > 8) mWrap.appendChild(document.createTextNode(` +${mentions.length - 8}`));
      row.appendChild(mWrap);
    }

    // Click row to expand/collapse the body.
    row.addEventListener('click', () => row.classList.toggle('expanded'));
    return row;
  }

  class BusStream {
    constructor() {
      this.buffer = [];                // newest at end
      this.maxId = 0;
      this.subscribers = new Set();    // each: { onAdd(msg), onBackfill(arr), onError(err) }
      this.es = null;
      this.state = 'idle';             // idle | connecting | open | error | paused
      this.lastFrameMs = 0;
      this.channelCounts = new Map();  // channel → count seen
      // Cascade-prevention #10559 Q2: visibility-pause.
      this.paused = false;
    }
    subscribe(handler) {
      this.subscribers.add(handler);
      // Immediately replay current buffer to the new subscriber
      if (this.buffer.length > 0) handler.onBackfill?.(this.buffer);
      this._ensureConnection();
      return () => this.subscribers.delete(handler);
    }
    _ensureConnection() {
      if (this.es) return;
      this._backfillThenStream();
    }
    async _backfillThenStream() {
      this.state = 'connecting';
      this._notifyState();
      try {
        const res = await fetch('/api/v1/plexus/public/messages?limit=' + BUS_BACKFILL_LIMIT, { cache: 'no-store' });
        if (res.ok) {
          const body = await res.json();
          const msgs = body.messages || [];
          for (const m of msgs) this._ingest(m, /*notifySubs=*/false);
          for (const sub of this.subscribers) sub.onBackfill?.(this.buffer);
        }
      } catch (e) {
        // Backfill failure is non-fatal — SSE will still try
      }
      this._openSse();
    }
    _openSse() {
      if (this.paused) return;
      try {
        const url = '/api/v1/plexus/public/messages-stream' + (this.maxId > 0 ? `?since=${this.maxId}` : '');
        this.es = new EventSource(url);
      } catch (e) {
        this.state = 'error';
        this._notifyState();
        this._scheduleReconnect();
        return;
      }
      this.es.addEventListener('open', () => {
        this.state = 'open';
        this._notifyState();
      });
      this.es.addEventListener('message', (ev) => {
        this.lastFrameMs = Date.now();
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        this._ingest(m, /*notifySubs=*/true);
      });
      this.es.addEventListener('error', () => {
        this.state = 'error';
        this._notifyState();
        try { this.es.close(); } catch {}
        this.es = null;
        this._scheduleReconnect();
      });
    }
    _scheduleReconnect() {
      if (this.paused) return;
      setTimeout(() => this._openSse(), 4000);
    }
    pause() {
      if (this.paused) return;
      this.paused = true;
      if (this.es) { try { this.es.close(); } catch {} ; this.es = null; }
      this.state = 'paused';
      this._notifyState();
    }
    resume() {
      if (!this.paused) return;
      this.paused = false;
      // Re-open from current maxId; buffer is preserved so subscribers see no gap.
      this._openSse();
    }
    _ingest(msg, notifySubs) {
      if (!msg || typeof msg.id !== 'number') return;
      // Dedup
      if (this.buffer.some(m => m.id === msg.id)) return;
      this.buffer.push(msg);
      if (msg.id > this.maxId) this.maxId = msg.id;
      // Channel-count map (for the chip badge)
      const c = msg.channel || '?';
      this.channelCounts.set(c, (this.channelCounts.get(c) || 0) + 1);
      // Prune to cap
      while (this.buffer.length > BUS_BUFFER_CAP) this.buffer.shift();
      if (notifySubs) {
        for (const sub of this.subscribers) sub.onAdd?.(msg);
      }
    }

    // Task #264 Phase 2.6 (Jon-direct 2026-07-03): time-anchored historical
    // fetch. Pauses SSE + re-populates buffer from routes.js `before_ts_ms`
    // cursor. Subscribers see full onBackfill replay with historical window.
    // Return-to-Live: resumeLive() clears historical mode, re-opens SSE +
    // re-backfills fresh.
    async setHistoricalWindow(fromMs, toMs) {
      this.pause();
      const qs = new URLSearchParams({
        limit: String(BUS_BUFFER_CAP),
        before_ts_ms: String(toMs),
        after_ts_ms: String(fromMs),
      });
      try {
        const res = await fetch('/api/v1/plexus/public/messages?' + qs.toString(), { cache: 'no-store' });
        if (res.ok) {
          const body = await res.json();
          const msgs = body.messages || [];
          this.buffer = [];
          this.channelCounts.clear();
          this.maxId = 0;
          for (const m of msgs) this._ingest(m, /*notifySubs=*/false);
          for (const sub of this.subscribers) sub.onBackfill?.(this.buffer);
        }
      } catch (e) { /* keep prior state on error */ }
    }
    resumeLive() {
      // Clear historical, wipe buffer, notify subscribers of empty state,
      // then re-run backfill-then-stream (unsets paused; opens a fresh SSE).
      this.buffer = [];
      this.channelCounts.clear();
      this.maxId = 0;
      for (const sub of this.subscribers) sub.onBackfill?.(this.buffer);
      this.paused = false;
      if (this.es) { try { this.es.close(); } catch {} ; this.es = null; }
      this._backfillThenStream();
    }
    _notifyState() {
      for (const sub of this.subscribers) sub.onState?.(this.state);
    }
    knownChannels() {
      return [...this.channelCounts.entries()].sort((a, b) => b[1] - a[1]);
    }
  }
  const busStream = new BusStream();

  // Task #264 Phase 2.6 (Jon-direct 2026-07-03): Bus tab (+ Live tab ticker,
  // which shares the BusStream singleton) responds to dashboard picker.
  // Non-live: SSE paused, buffer replaced with historical window slice.
  // Live: fresh backfill + SSE resume. Both ticker + Bus tab body see the
  // same time-anchored view — consistent unified time-nav semantic.
  document.addEventListener('dashboardTimeRangeChange', (e) => {
    const preset = e.detail && e.detail.preset;
    const win = e.detail && e.detail.window;
    if (preset === 'live') {
      busStream.resumeLive();
    } else if (win) {
      busStream.setHistoricalWindow(win.fromMs, win.toMs);
    }
  });
  // Initial-load `#bus?range=<preset>` (or `#live?range=<preset>` — ticker
  // still shares the stream): apply historical window on mount if non-live.
  // Deferred so BusStream can subscribe first via the ticker mount path.
  setTimeout(() => {
    if (window.getDashboardTimeWindow) {
      const win = window.getDashboardTimeWindow();
      if (win) busStream.setHistoricalWindow(win.fromMs, win.toMs);
    }
  }, 100);

  // Cascade-prevention #10559 Q2: pause both SSE streamers when the tab is
  // hidden. Sister-shape to the refreshAuditHero visibility-pause above.
  // Sheds Prom-query + DB-read load on the server for background-tab dashboards.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      try { liveStream.pause(); } catch {}
      try { busStream.pause(); } catch {}
    } else {
      try { liveStream.resume(); } catch {}
      try { busStream.resume(); } catch {}
    }
  });

  // ── Ticker view (Live tab; always-on; whitelist filter; compact) ─────
  const tickerPane = document.getElementById('ticker-pane');
  const tickerMeta = document.getElementById('ticker-meta');
  if (tickerPane) {
    const renderTicker = () => {
      const filtered = busStream.buffer
        .filter(m => tickerShows(m.channel))
        .slice(-BUS_TICKER_DISPLAY);
      clearChildren(tickerPane);
      if (filtered.length === 0) {
        tickerPane.appendChild(el('div', { class: 'bus-empty' }, 'no recent bus traffic'));
      } else {
        // Newest first
        for (const m of filtered.reverse()) tickerPane.appendChild(busRow(m));
      }
      if (tickerMeta) {
        const excluded = [...BUS_DEFAULT_EXCLUDED].map(c => '#' + c).join(', ');
        tickerMeta.textContent = `last ${filtered.length} · ${busStream.buffer.length} buffered · all channels except ${excluded}`;
      }
    };
    busStream.subscribe({
      onBackfill: () => renderTicker(),
      onAdd: (m) => { if (tickerShows(m.channel)) renderTicker(); },
      onState: (s) => {
        if (s === 'connecting' && busStream.buffer.length === 0) {
          tickerPane.innerHTML = '<div class="bus-empty">connecting…</div>';
        }
      },
    });
    // 30s tick to refresh "ago" strings without new messages
    setInterval(renderTicker, 30000);
  }

  // ── Bus tab view (lazy-mounted; interactive chips/filter/pause) ──────
  let busTabMounted = false;
  // ────────────────────────────────────────────────────────────────────
  // CP9 (2026-06-01): Channels tab — sidebar listing + iMessage thread.
  // Phase 1: static-load per channel click; no per-channel SSE yet
  // (deferred to Phase 2). The Live-tab ticker keeps its own BusStream.
  // ────────────────────────────────────────────────────────────────────
  const SELF_AGENT_ID = 'yaklog-dev-agent';
  const THREAD_PAGE_LIMIT = 80;
  const CLUSTER_GAP_MS = 5 * 60 * 1000;   // 5 min gap = new cluster
  const DAY_DIVIDER_MS = 12 * 60 * 60 * 1000;

  function fmtClock(d) {
    return d.toTimeString().slice(0, 5);
  }
  function fmtDateSep(d) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const yest = new Date(today); yest.setDate(today.getDate() - 1);
    const dDay = new Date(d); dDay.setHours(0, 0, 0, 0);
    if (dDay.getTime() === today.getTime()) return 'today';
    if (dDay.getTime() === yest.getTime()) return 'yesterday';
    return d.toDateString();
  }
  function fmtChannelWhen(iso) {
    if (!iso) return '';
    const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
    const ms = Date.now() - d.getTime();
    if (ms < 60_000) return 'now';
    if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
    if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
    return `${Math.floor(ms / 86_400_000)}d`;
  }
  function parseIso(iso) {
    if (!iso) return null;
    return new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  }

  // Render one message body with @mentions as styled pills + self-callout.
  function renderBodyWithMentions(body, mentions) {
    const frag = document.createDocumentFragment();
    if (!body) { frag.appendChild(document.createTextNode('')); return frag; }
    // Cheap inline split on @-tokens; for richer rendering swap in a markdown
    // pass later. For Phase 1, plain text + mention pills is enough.
    frag.appendChild(document.createTextNode(body));
    if (mentions && mentions.length > 0) {
      const mWrap = el('span', { class: 'bubble-mentions' });
      for (const m of mentions) {
        const cls = (m === SELF_AGENT_ID || m === 'yaklog-dev') ? 'bubble-mention self' : 'bubble-mention';
        mWrap.appendChild(el('span', { class: cls }, '@' + m));
      }
      frag.appendChild(document.createElement('br'));
      frag.appendChild(mWrap);
    }
    return frag;
  }

  function buildCluster(msgs, isSelf) {
    // msgs: array of consecutive messages from same sender within CLUSTER_GAP_MS
    const cluster = el('div', { class: `chan-cluster ${isSelf ? 'from-self' : 'from-other'}` });
    const first = msgs[0];
    const senderId = first.sender || '?';
    const ac = agentColor(senderId);
    // Sender swatch as a tiny color dot next to name (also shown on self)
    const meta = el('div', { class: 'chan-cluster-meta' });
    const dot = el('span', {
      class: 'chan-cluster-dot',
      style: `background:${ac.hex}`,
      title: `${ac.name} · ${ac.hex} · ${ac.rgb}`,
    });
    meta.appendChild(dot);
    const senderEl = el('span', { class: 'sender-name' }, senderId);
    meta.appendChild(senderEl);
    const tEl = el('span', { class: 'cluster-time' }, fmtClock(parseIso(first.created_at)));
    meta.appendChild(tEl);
    cluster.appendChild(meta);
    for (const m of msgs) {
      // CP10.5.4 (2026-06-03): bubble bg now driven by .from-self / .from-other
      // CSS classes (iMessage-style: blue/slate). Agent identity color stays
      // on the .chan-cluster-dot in the meta row (the bullet next to name).
      //
      // CP16 Pillar 7 sub-pillar A (body-collapse): long bodies clamp to ~5 lines
      // by default; click bubble to expand. Auto-expand when mentioned. Per
      // `feedback_accessibility_is_structural_canon_not_polish`: full body stays
      // in DOM (CSS line-clamp only; no content truncation).
      const mentionsSelf = (m.mentions || []).some((x) => x === SELF_AGENT_ID);
      const bubble = el('div', {
        class: 'chan-bubble ' + (isSelf ? 'from-self' : 'from-other')
          + (m.private ? ' private' : '')
          + (mentionsSelf ? ' expanded' : ''),
        title: `#${m.id} · ${m.created_at || ''} · ${ac.name}`,
      });
      bubble.appendChild(el('span', { class: 'bubble-id' }, '#' + m.id));
      const bodyWrap = el('span', { class: 'bubble-body' });
      bodyWrap.appendChild(renderBodyWithMentions(m.body || '', m.mentions || []));
      bubble.appendChild(bodyWrap);
      bubble.addEventListener('click', () => bubble.classList.toggle('expanded'));
      cluster.appendChild(bubble);
    }
    // Post-mount: detect overflow per bubble (scrollHeight > clientHeight on
    // .bubble-body) and tag with .has-overflow so the expand hint pseudo-element
    // only appears on bubbles that actually overflow.
    requestAnimationFrame(() => {
      cluster.querySelectorAll('.chan-bubble').forEach((b) => {
        const body = b.querySelector('.bubble-body');
        if (!body) return;
        if (body.scrollHeight > body.clientHeight + 1) b.classList.add('has-overflow');
      });
    });
    return cluster;
  }

  function renderThread(bodyEl, messages) {
    clearChildren(bodyEl);
    if (!messages || messages.length === 0) {
      bodyEl.appendChild(el('div', { class: 'chan-empty' }, 'no messages on this channel yet.'));
      return;
    }
    // Oldest first
    const sorted = messages.slice().sort((a, b) => a.id - b.id);

    // Walk and group: emit date dividers + clusters by sender + cluster-gap.
    let prevTs = null;
    let prevSender = null;
    let bucket = [];
    let lastDayKey = null;

    const flushBucket = () => {
      if (bucket.length === 0) return;
      const isSelf = bucket[0].sender === SELF_AGENT_ID;
      bodyEl.appendChild(buildCluster(bucket, isSelf));
      bucket = [];
    };

    for (const m of sorted) {
      const ts = parseIso(m.created_at);
      const dayKey = ts ? ts.toDateString() : 'unknown';
      if (dayKey !== lastDayKey) {
        flushBucket();
        bodyEl.appendChild(el('div', { class: 'chan-divider' }, fmtDateSep(ts || new Date())));
        lastDayKey = dayKey;
        prevSender = null;
      }
      const gapBig = prevTs && (ts.getTime() - prevTs.getTime()) > CLUSTER_GAP_MS;
      const senderChanged = prevSender !== null && prevSender !== m.sender;
      if (gapBig || senderChanged) flushBucket();
      bucket.push(m);
      prevTs = ts;
      prevSender = m.sender;
    }
    flushBucket();

    // Auto-scroll to bottom (latest)
    requestAnimationFrame(() => { bodyEl.scrollTop = bodyEl.scrollHeight; });
  }

  function renderChannelList(listEl, countEl, channels, selectedName, onClick) {
    clearChildren(listEl);
    if (!channels || channels.length === 0) {
      listEl.appendChild(el('div', { class: 'chan-empty' }, 'no channels yet.'));
      countEl.textContent = '0';
      return;
    }
    countEl.textContent = String(channels.length);
    // Sort: by last_message_at DESC (most-recent activity first)
    const sorted = channels.slice().sort((a, b) => {
      const ta = parseIso(a.last_message_at)?.getTime() || 0;
      const tb = parseIso(b.last_message_at)?.getTime() || 0;
      return tb - ta;
    });
    for (const c of sorted) {
      const row = el('div', { class: 'chan-row' + (c.channel === selectedName ? ' active' : ''), 'data-channel': c.channel });
      const name = el('div', { class: 'chan-name' });
      name.appendChild(el('span', { class: 'chan-hash' }, '#'));
      name.appendChild(document.createTextNode(c.channel));
      row.appendChild(name);
      const meta = el('div', { class: 'chan-meta' });
      meta.appendChild(el('span', { class: 'chan-count' }, String(c.message_count) + ' msgs'));
      meta.appendChild(el('span', { class: 'chan-when' }, fmtChannelWhen(c.last_message_at)));
      row.appendChild(meta);
      row.addEventListener('click', () => onClick(c.channel));
      listEl.appendChild(row);
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // CP14 Operate / eyes-on-glass tab — v1 5-tile operator surface
  //
  // Per PLAN-OPERATE-EYES-ON-GLASS-VIEW.md trio-converged (#10904 / #10906
  // / #10908) + parch ratify #10925. Composition over existing endpoints:
  //   - /api/v1/presence/public        → red-state + active sessions
  //   - /api/v1/plexus/public/policy/violations?from=<60min>
  //   - /api/v1/plexus/public/audit/anchor-verify?day=<today>
  //   - /api/v1/cost/anomalies?period=7d&threshold=2.0&dim=agent_id
  //
  // Phase A (this ship): poll-only at 30s interval; per-tile state classes
  // (red/yellow/green/error); drill-through routes to existing detail
  // surfaces; AT-equivalent semantic HTML in place.
  //
  // Phase B (RATIFIED parch #11160 post substrate-correction #11159): bounded
  // browser-tier UX optimization. 4 elements:
  //   1. Page Visibility API integration (sister-shape PlexusLiveStream pause/resume)
  //   2. chain-integrity cadence-slow 30s → 5min (anchor publishes daily)
  //   3. Stale-data indicator (sister-shape sse-pill; >2× cadence → state-stale class)
  //   4. Two-tier cadence: presence-tiles 10s / aggregate-tiles 30s / chain 5min
  //
  // Phase C (gated on N-pressure trigger per parch #11158/#11160): server-side
  // presence-delta SSE channel — wire red-state + active-sessions as event-driven
  // listeners. Not in this ship (would be new server-side substrate).
  // ─────────────────────────────────────────────────────────────────────
  let operateTabMounted = false;
  let operatePresenceInterval = null;
  let operateAggregateInterval = null;
  let operateChainInterval = null;
  let operateStaleChecker = null;
  let operateVisibilityHandler = null;

  const OPERATE_PRESENCE_CADENCE_MS = 10000;        // 10s — presence-derived tiles (red-state + active)
  const OPERATE_AGGREGATE_CADENCE_MS = 30000;       // 30s — policy + cost-spikes
  const OPERATE_CHAIN_CADENCE_MS = 5 * 60 * 1000;   // 5min — anchor publishes daily; old 30s wasteful
  const OPERATE_STALE_FACTOR = 2;                   // stale = last refresh > 2× cadence

  // Per-tile-group last successful refresh wallclock (Date.now())
  const operateLastRefreshAt = { presence: 0, aggregate: 0, chain: 0 };

  const OPERATE_TILE_GROUP = {
    'red-state': 'presence',
    'active-sessions': 'presence',
    'policy-violations': 'aggregate',
    'cost-spikes': 'aggregate',
    'chain-integrity': 'chain',
  };
  const OPERATE_GROUP_CADENCE = {
    presence: OPERATE_PRESENCE_CADENCE_MS,
    aggregate: OPERATE_AGGREGATE_CADENCE_MS,
    chain: OPERATE_CHAIN_CADENCE_MS,
  };

  function _operateTabActive() { return !!document.querySelector('#tab-operate.active'); }
  function _operateShouldPoll() { return _operateTabActive() && document.visibilityState === 'visible'; }

  function mountOperateTab() {
    if (!operateTabMounted) {
      operateTabMounted = true;
      // Wire drill-through click+keyboard handlers per tile
      document.querySelectorAll('#operate-tile-grid .operate-tile').forEach((tile) => {
        const target = tile.dataset.drill;
        const handler = () => {
          if (target === 'live-filtered-red') { location.hash = '#live'; }
          else if (target === 'live') { location.hash = '#live'; }
          else if (target === 'audit-incident') { location.hash = '#audit'; }
          else if (target === 'audit-anchor') { location.hash = '#audit'; }
          else if (target === 'cost-anomaly') { location.hash = '#cost'; }
        };
        tile.addEventListener('click', handler);
        tile.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(); }
        });
      });
      // Page Visibility API: tab-hidden suspends intervals (cascade-prevention
      // sister-shape PlexusLiveStream lines 919-922 + 974-980). On-restore,
      // immediate-refresh + restart.
      operateVisibilityHandler = () => {
        if (document.visibilityState === 'visible' && _operateTabActive()) {
          _operateImmediateRefresh();
          _operateStartIntervals();
        } else {
          _operateClearIntervals();
        }
      };
      document.addEventListener('visibilitychange', operateVisibilityHandler);
    }
    // Immediate refresh + start intervals on every (re-)activation
    _operateImmediateRefresh();
    _operateStartIntervals();
    if (!operateStaleChecker) operateStaleChecker = setInterval(_operateCheckStaleness, 1000);
  }

  function _operateClearIntervals() {
    if (operatePresenceInterval) { clearInterval(operatePresenceInterval); operatePresenceInterval = null; }
    if (operateAggregateInterval) { clearInterval(operateAggregateInterval); operateAggregateInterval = null; }
    if (operateChainInterval) { clearInterval(operateChainInterval); operateChainInterval = null; }
  }

  function _operateStartIntervals() {
    _operateClearIntervals();
    operatePresenceInterval = setInterval(() => {
      if (_operateShouldPoll()) _refreshPresenceTiles(); else _operateClearIntervals();
    }, OPERATE_PRESENCE_CADENCE_MS);
    operateAggregateInterval = setInterval(() => {
      if (_operateShouldPoll()) _refreshAggregateTiles(); else _operateClearIntervals();
    }, OPERATE_AGGREGATE_CADENCE_MS);
    operateChainInterval = setInterval(() => {
      if (_operateShouldPoll()) _refreshChainIntegrity(); else _operateClearIntervals();
    }, OPERATE_CHAIN_CADENCE_MS);
  }

  async function _operateImmediateRefresh() {
    await Promise.all([_refreshPresenceTiles(), _refreshAggregateTiles(), _refreshChainIntegrity()]);
  }

  function _operateCheckStaleness() {
    if (!_operateTabActive()) return;
    const now = Date.now();
    for (const [tileId, group] of Object.entries(OPERATE_TILE_GROUP)) {
      const cadence = OPERATE_GROUP_CADENCE[group];
      const last = operateLastRefreshAt[group];
      const isStale = last > 0 && (now - last) > (cadence * OPERATE_STALE_FACTOR);
      const tile = document.querySelector(`.operate-tile[data-tile="${tileId}"]`);
      if (!tile) continue;
      tile.classList.toggle('state-stale', isStale);
      // a11y: append "[stale]" suffix to aria-label when stale (AT-equivalent
      // signal per [[feedback_accessibility_is_structural_canon_not_polish]]).
      const label = tile.getAttribute('aria-label') || '';
      const marked = label.endsWith(' [stale]');
      if (isStale && !marked) tile.setAttribute('aria-label', label + ' [stale]');
      else if (!isStale && marked) tile.setAttribute('aria-label', label.slice(0, -' [stale]'.length));
    }
    _updateOperateFooter();
  }

  function _setOperateTileState(tileId, state, value, sub, ariaSuffix) {
    const tile = document.querySelector(`.operate-tile[data-tile="${tileId}"]`);
    if (!tile) return;
    tile.classList.remove('state-red', 'state-yellow', 'state-green', 'state-error');
    if (state) tile.classList.add('state-' + state);
    const valEl = document.getElementById(`operate-tile-${tileId}-value`);
    const subEl = document.getElementById(`operate-tile-${tileId}-sub`);
    if (valEl) valEl.textContent = value;
    if (subEl) subEl.textContent = sub;
    const baseLabel = tile.getAttribute('aria-label')?.split(' — state: ')[0] || '';
    if (ariaSuffix) tile.setAttribute('aria-label', `${baseLabel} — state: ${ariaSuffix}`);
  }

  async function _refreshPresenceTiles() {
    try {
      const r = await fetch('/api/v1/presence/public');
      const j = await r.json();
      const rows = j.presence || j || [];
      const red = rows.filter((p) =>
        (p.runtime_state === 'quota_exhausted' || p.runtime_state === 'error') ||
        p.sse_stream_stale === true ||
        p.label === 'stalled'
      );
      const active = rows.filter((p) =>
        p.session_state === 'active' || p.session_state === 'tool_running'
      );
      _setOperateTileState('red-state',
        red.length === 0 ? 'green' : (red.length <= 2 ? 'yellow' : 'red'),
        String(red.length),
        red.length === 0 ? 'all agents healthy' : red.slice(0, 3).map((p) => p.agent_id).join(' · ') + (red.length > 3 ? ' +more' : ''),
        red.length === 0 ? 'healthy' : (red.length <= 2 ? 'warn' : 'critical'));
      _setOperateTileState('active-sessions', 'green',
        String(active.length),
        active.length === 0 ? 'cluster idle' : `${active.length} of ${rows.length} agents in active/tool_running`,
        'informational');
      operateLastRefreshAt.presence = Date.now();
    } catch (e) {
      _setOperateTileState('red-state', 'error', '?', `fetch error: ${e.message}`, 'unknown');
      _setOperateTileState('active-sessions', 'error', '?', `fetch error: ${e.message}`, 'unknown');
    }
    _updateOperateFooter();
  }

  async function _refreshAggregateTiles() {
    try {
      const from = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const r = await fetch(`/api/v1/plexus/public/policy/violations?from=${encodeURIComponent(from)}&limit=20`);
      const j = await r.json();
      const violations = j.violations || j.results || [];
      const pending = violations.filter((v) => v.disposition === 'pending' || !v.disposition);
      _setOperateTileState('policy-violations',
        pending.length === 0 ? 'green' : (pending.length <= 2 ? 'yellow' : 'red'),
        String(pending.length),
        pending.length === 0 ? 'no pending violations' : `${pending.length} pending of ${violations.length} total`,
        pending.length === 0 ? 'healthy' : (pending.length <= 2 ? 'warn' : 'critical'));
    } catch (e) {
      _setOperateTileState('policy-violations', 'error', '?', `fetch error: ${e.message}`, 'unknown');
    }
    try {
      const r = await fetch('/api/v1/cost/anomalies?period=7d&threshold=2.0&dim=agent_id');
      const j = await r.json();
      const anomalies = j.anomalies || [];
      const spikes = anomalies.filter((a) => a.is_spike === true);
      _setOperateTileState('cost-spikes',
        spikes.length === 0 ? 'green' : (spikes.length <= 2 ? 'yellow' : 'red'),
        String(spikes.length),
        spikes.length === 0 ? 'no spikes (7d vs mean)' : spikes.slice(0, 3).map((a) => a.dim_value).join(' · ') + (spikes.length > 3 ? ' +more' : ''),
        spikes.length === 0 ? 'healthy' : (spikes.length <= 2 ? 'warn' : 'critical'));
    } catch (e) {
      _setOperateTileState('cost-spikes', 'error', '?', `fetch error: ${e.message}`, 'unknown');
    }
    operateLastRefreshAt.aggregate = Date.now();
    _updateOperateFooter();
  }

  async function _refreshChainIntegrity() {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const r = await fetch(`/api/v1/plexus/public/audit/anchor-verify?day=${today}`);
      const j = await r.json();
      if (j.found === false) {
        _setOperateTileState('chain-integrity', 'yellow', '—', 'no anchor for today yet (publisher cadence)', 'awaiting publish');
      } else if (j.match === true) {
        _setOperateTileState('chain-integrity', 'green', '✓', `verified: ${(j.stored_digest || '').slice(0, 12)}…`, 'verified');
      } else if (j.match === false) {
        _setOperateTileState('chain-integrity', 'red', '✗', 'TAMPER DETECTED — investigate immediately', 'tamper-detected');
      } else {
        _setOperateTileState('chain-integrity', 'yellow', '?', j.note || 'verify state unclear', 'unknown-state');
      }
      operateLastRefreshAt.chain = Date.now();
    } catch (e) {
      _setOperateTileState('chain-integrity', 'error', '?', `fetch error: ${e.message}`, 'unknown');
    }
    _updateOperateFooter();
  }

  function _updateOperateFooter() {
    const metaEl = document.getElementById('operate-footer-meta');
    if (!metaEl) return;
    const now = Date.now();
    const parts = [];
    for (const [group, last] of Object.entries(operateLastRefreshAt)) {
      if (last === 0) continue;
      const age = Math.floor((now - last) / 1000);
      parts.push(`${group}: ${age}s`);
    }
    metaEl.textContent = parts.length === 0 ? 'awaiting refresh' : parts.join(' · ');
  }

  // Backward-compat alias for any external caller of refreshOperateTiles
  async function refreshOperateTiles() { return _operateImmediateRefresh(); }

  // ────────────────────────────────────────────────────────────────────
  // CP17.B Repos tab (Jon-direct 2026-07-07)
  // Consumes /api/v1/plexus/public/repos/{summary,heatmap,list,detail,by-agent}
  // + POST /api/v1/repos + POST /api/v1/repos/bare-git-request.
  // Sister-shape existing tab lazy-mount + Cost hero + AgentCard patterns.
  // Time-nav aware via Task #264 dashboardTimeRangeChange event.
  // ────────────────────────────────────────────────────────────────────
  let _reposMounted = false;
  const _reposState = {
    period: '30d',
    dim: 'commits',
    filterRepo: '',
    filterAgent: '',
    sort: 'activity',
    typeFilter: 'all',
    listCache: [],
  };

  function _reposCurrentPeriod() {
    // Prefer dashboard-picker window when non-live; else last-30d default.
    if (typeof window.getDashboardTimeWindow === 'function') {
      const w = window.getDashboardTimeWindow();
      if (w && w.preset) {
        const map = { '1h': 'today', '24h': 'today', '7d': '7d', '30d': '30d' };
        if (map[w.preset]) return map[w.preset];
      }
    }
    return _reposState.period;
  }

  function _reposReqUrl(pathAfterRepos) {
    const period = _reposCurrentPeriod();
    const sep = pathAfterRepos.includes('?') ? '&' : '?';
    return `/api/v1/plexus/public/repos${pathAfterRepos}${sep}period=${encodeURIComponent(period)}`;
  }

  // CP17.C Task 3: hash-param cross-nav primitive.
  // Reads #repos?agent=<id>&repo=<key> and applies to filter state on mount.
  // Sister-shape existing Task #264 URL-persistence discipline. Any URL-holder
  // can deep-link with the filter pre-applied.
  function _reposReadHashParams() {
    const hash = String(window.location.hash || '');
    const qIdx = hash.indexOf('?');
    if (qIdx < 0) return;
    const qs = new URLSearchParams(hash.slice(qIdx + 1));
    const agent = qs.get('agent');
    const repo = qs.get('repo');
    if (agent) _reposState.filterAgent = agent;
    if (repo) _reposState.filterRepo = repo;
  }

  // ADR-0041 v2 Increment 2 — analytical band pivot state (default 'repo').
  // Pivot re-pivots DATA only; hero + management widgets are pivot-independent.
  // Fold-B tier-gating travels via the existing ADR-0031 §3 audience-picker,
  // NOT this toggle (per plexus-ui #11950 chrome-decoupled precision).
  let _outputPivot = 'repo';

  async function _renderAgentPrimaryPanel() {
    const body = document.getElementById('output-agent-primary-body');
    if (!body) return;
    try {
      const r = await fetch('/api/v1/output/composition?by=agent&period=30d', { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      const rows = Array.isArray(data.rows) ? data.rows : [];
      clearChildren(body);
      if (rows.length === 0) {
        body.appendChild(el('div', { class: 'cost-loading' }, 'No agent activity in this window.'));
        return;
      }
      const table = el('table');
      const thead = el('thead');
      const trh = el('tr');
      ['Agent', 'Commits', 'Merges', 'Coord msgs'].forEach((label, i) => {
        trh.appendChild(el('th', { class: i > 0 ? 'num' : null }, label));
      });
      thead.appendChild(trh);
      table.appendChild(thead);
      const tbody = el('tbody');
      for (const row of rows.slice(0, 50)) {
        const tr = el('tr');
        tr.appendChild(el('td', null, row.agent_id || '(unattributed)'));
        tr.appendChild(el('td', { class: 'num' }, String(row.commits ?? 0)));
        tr.appendChild(el('td', { class: 'num' }, String(row.merges ?? 0)));
        tr.appendChild(el('td', { class: 'num' }, String(row.coord_msgs ?? 0)));
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      body.appendChild(table);
    } catch (err) {
      renderError(body, 'cost-loading', 'Couldn’t load agent-primary composition. Retry shortly.');
    }
  }

  function _setOutputPivot(dim) {
    if (dim !== 'agent' && dim !== 'repo') return;
    _outputPivot = dim;
    const panel = document.querySelector('.tab-panel[data-tab="output"]');
    if (panel) {
      panel.classList.toggle('pivot-agent', dim === 'agent');
      // hidden attribute for a11y — screen readers respect it even before CSS
      const agentSection = document.getElementById('output-agent-primary-section');
      if (agentSection) agentSection.hidden = (dim !== 'agent');
    }
    document.querySelectorAll('.output-pivot-toggle button').forEach((btn) => {
      btn.setAttribute('aria-selected', btn.dataset.pivot === dim ? 'true' : 'false');
    });
    if (dim === 'agent') _renderAgentPrimaryPanel();
  }

  function _wireOutputPivotToggle() {
    document.querySelectorAll('.output-pivot-toggle button').forEach((btn) => {
      btn.addEventListener('click', () => _setOutputPivot(btn.dataset.pivot));
      btn.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          _setOutputPivot(_outputPivot === 'repo' ? 'agent' : 'repo');
          const next = document.querySelector('.output-pivot-toggle button[aria-selected="true"]');
          if (next) next.focus();
        }
      });
    });
  }

  function mountReposTab() {
    if (_reposMounted) return;
    _reposMounted = true;
    _reposReadHashParams();
    _wireReposControls();
    _wireReposManagement();
    _wireOutputPivotToggle();
    _refreshReposAll();
    // Time-nav: rerender all bands on picker change.
    document.addEventListener('dashboardTimeRangeChange', () => {
      // Only render if Repos tab currently active (perf)
      const active = document.querySelector('.tab-panel[data-tab="output"]');
      if (active && active.classList.contains('active')) _refreshReposAll();
    });
    // 60s auto-refresh gated on isLiveMode() sister-shape Cost hero discipline.
    setInterval(() => {
      if (window.isDashboardLive && !window.isDashboardLive()) return;
      const active = document.querySelector('.tab-panel[data-tab="output"]');
      if (active && active.classList.contains('active')) _refreshReposAll();
    }, 60_000);
  }

  // ─── ADR-0041 P1: #output shared-hero tab ────────────────────────────────
  // Merged effort+repos surface. P1 = cross-tier-safe hero band only, fetched
  // from GET /output/hero-summary (Fold-B-by-construction: this endpoint carries
  // NO tier-gated fields, so the always-fetched hero cannot leak them). Tier-gated
  // tiles + the scoped analytical pivot arrive at P2/P3.
  let _outputMounted = false;
  function _outputRangeQuery() {
    // Inherit Task #264 time-nav: live → default period; windowed → from/to.
    const w = window.getDashboardTimeWindow && window.getDashboardTimeWindow();
    if (!w) return 'period=30d';
    const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
    return 'from=' + iso(w.fromMs) + '&to=' + iso(w.toMs);
  }
  async function _fetchOutputHero() {
    try {
      const r = await fetch('/api/v1/output/hero-summary?' + _outputRangeQuery(), { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (err) {
      return { _error: err.message };
    }
  }
  function _outputHeroState(kind, msg) {
    const strip = document.getElementById('output-hero-strip');
    if (!strip) return;
    // Preserve tiles; overlay a full-width state row (stable grid dims).
    const prev = strip.querySelector('.output-hero-state');
    if (prev) prev.remove();
    if (!kind) return;
    const row = el('div', { class: 'output-hero-state is-' + kind, role: 'status', 'aria-live': 'polite' }, msg);
    strip.appendChild(row);
  }
  function _fmtOutputNum(v) {
    if (v == null || !Number.isFinite(Number(v))) return '—';
    return Number(v).toLocaleString();
  }
  async function _renderOutputHero() {
    const data = await _fetchOutputHero();
    if (data._error) {
      // Honest microcopy — never leak raw HTTP/status to the glass.
      _outputHeroState('error', 'Couldn’t load output summary. Retry shortly.');
      return;
    }
    _outputHeroState(null);
    const set = (k, v) => {
      const node = document.querySelector('#output-hero-strip [data-hero="' + k + '"]');
      if (node) node.textContent = v;
    };
    const setSub = (k, v) => {
      const node = document.querySelector('#output-hero-strip [data-hero-sub="' + k + '"]');
      if (node) node.textContent = v;
    };
    set('repos_governed_total', _fmtOutputNum(data.repos_governed_total));
    setSub('repos_active', _fmtOutputNum(data.repo_count_active_window) + ' active this window');
    set('pr_merged_count_cumulative', _fmtOutputNum(data.pr_merged_count_cumulative));
    const pct = data.attribution_integrity_pct;
    set('attribution_integrity_pct', (pct == null || !Number.isFinite(Number(pct))) ? '—' : Number(pct).toFixed(0) + '%');
    setSub('attribution_gaps', _fmtOutputNum(data.attribution_gap_count) + ' unattributed');
    set('attributed_agents', _fmtOutputNum(data.attributed_agents));
    set('pending_bare_git_requests', _fmtOutputNum(data.pending_bare_git_requests));
  }
  function mountOutputTab() {
    if (_outputMounted) { _renderOutputHero(); return; }
    _outputMounted = true;
    _renderOutputHero();
    // Time-nav: re-render on picker change while the tab is active (perf-gated).
    document.addEventListener('dashboardTimeRangeChange', () => {
      const active = document.querySelector('.tab-panel[data-tab="output"]');
      if (active && active.classList.contains('active')) _renderOutputHero();
    });
    // 60s live refresh, gated on isLiveMode (sister-shape repos/cost discipline).
    setInterval(() => {
      if (window.isDashboardLive && !window.isDashboardLive()) return;
      const active = document.querySelector('.tab-panel[data-tab="output"]');
      if (active && active.classList.contains('active')) _renderOutputHero();
    }, 60_000);
  }

  function _wireReposControls() {
    const dimSel = document.getElementById('repos-heatmap-dim');
    if (dimSel) dimSel.addEventListener('change', () => { _reposState.dim = dimSel.value; _renderReposHeatmap(); });
    const repoSel = document.getElementById('repos-heatmap-filter-repo');
    if (repoSel) repoSel.addEventListener('change', () => { _reposState.filterRepo = repoSel.value; _renderReposHeatmap(); });
    const agentSel = document.getElementById('repos-heatmap-filter-agent');
    if (agentSel) agentSel.addEventListener('change', () => { _reposState.filterAgent = agentSel.value; _renderReposHeatmap(); });

    document.querySelectorAll('#repos-grid-sort button').forEach((b) => {
      b.addEventListener('click', () => {
        _reposState.sort = b.dataset.sort;
        document.querySelectorAll('#repos-grid-sort button').forEach((x) => x.classList.toggle('active', x === b));
        _renderReposGrid();
      });
    });
    document.querySelectorAll('#repos-grid-type button').forEach((b) => {
      b.addEventListener('click', () => {
        _reposState.typeFilter = b.dataset.type;
        document.querySelectorAll('#repos-grid-type button').forEach((x) => x.classList.toggle('active', x === b));
        _renderReposGrid();
      });
    });

    // Pending-mints tile → jump to Band 4 manage section
    const pendingTile = document.querySelector('[data-tile="pending-mints"]');
    if (pendingTile) {
      const jump = () => {
        const manage = document.getElementById('repos-manage-section');
        if (manage) {
          const details = manage.querySelector('.repos-manage-details');
          if (details) details.open = true;
          manage.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      };
      pendingTile.addEventListener('click', jump);
      pendingTile.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); jump(); }
      });
    }
  }

  async function _refreshReposAll() {
    await Promise.all([
      _renderReposSummary(),
      _renderReposHeatmap(),
      _renderReposList(),
      _renderReposActivityFeed(),
      _renderReposPendingQueue(),
    ]);
  }

  // CP17.C Task 2: activity feed live-refresh.
  // Chronological list of recent commits + PRs (window-scoped). Uses new
  // /activity-feed endpoint (UNION of output_commit + output_pr sorted DESC).
  // Live-refresh gated on isLiveMode() per Task #264 discipline.
  async function _renderReposActivityFeed() {
    const list = document.querySelector('#repos-activity-feed .repos-activity-feed-list');
    if (!list) return;
    try {
      const res = await fetch(_reposReqUrl('/activity-feed?limit=50'), { cache: 'no-store' });
      if (!res.ok) {
        list.innerHTML = '';
        list.appendChild(el('div', { class: 'view-empty' }, "Couldn't load activity feed. Retry shortly."));
        return;
      }
      const data = await res.json();
      list.innerHTML = '';
      const rows = data.activity || [];
      if (rows.length === 0) {
        list.appendChild(el('div', { class: 'view-empty' }, 'No activity in this window.'));
        return;
      }
      for (const r of rows) {
        const entry = el('div', { class: 'repos-activity-entry' });
        entry.appendChild(el('span', { class: 'ts', title: r.at_ts || '' },
          (r.at_ts || '').slice(0, 16).replace('T', ' ')));
        entry.appendChild(el('span', { class: 'actor' }, r.actor || 'unknown'));
        const actionLabel = ({
          'commit': ' committed to ',
          'pr_opened': ' opened PR in ',
          'pr_merged': ' merged PR in ',
        })[r.kind] || ` ${r.kind} in `;
        entry.appendChild(el('span', { class: 'action' }, actionLabel));
        entry.appendChild(el('span', null, r.repo_key || ''));
        if (r.summary) {
          const sub = el('div', { class: 'action', style: 'margin-left:0;font-size:10px;padding-left:0' },
            (r.summary || '').slice(0, 120));
          entry.appendChild(sub);
        }
        list.appendChild(entry);
      }
    } catch {
      list.innerHTML = '';
      list.appendChild(el('div', { class: 'view-empty' }, "Couldn't load activity feed. Retry shortly."));
    }
  }

  async function _renderReposSummary() {
    try {
      const res = await fetch(_reposReqUrl('/summary'), { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      const setV = (name, val) => {
        const el = document.querySelector(`[data-tile-value="${name}"]`);
        if (el) el.textContent = val;
      };
      const setSub = (name, val) => {
        const el = document.querySelector(`[data-tile-sub="${name}"]`);
        if (el) el.textContent = val;
      };
      setV('repo_count', data.repo_count || 0);
      setSub('repo_count_sub', ''); // subtype breakdown deferred to /list
      setV('commit_count', data.commit_count || 0);
      setSub('window_label', `${data.period || ''} (${data.from} → ${data.to})`);
      setV('pr_merged_count', data.pr_merged_count || 0);
      setV('engaged_agents', data.engaged_agents || 0);
      setV('attribution_gap_count', data.attribution_gap_count || 0);
      const gapTile = document.querySelector('[data-tile="attribution-gaps"]');
      if (gapTile) gapTile.classList.toggle('attribution-gap-flagged', (data.attribution_gap_count || 0) > 0);
      setV('pending_bare_git_requests', data.pending_bare_git_requests || 0);
    } catch { /* honest-microcopy discipline: silent on transient errors; tile shows last-fetched */ }
  }

  async function _renderReposHeatmap() {
    const body = document.getElementById('repos-heatmap-body');
    const legend = document.getElementById('repos-heatmap-legend');
    if (!body) return;
    try {
      const q = new URLSearchParams({ dim: _reposState.dim });
      if (_reposState.filterRepo) q.set('filter_repo', _reposState.filterRepo);
      if (_reposState.filterAgent) q.set('filter_agent', _reposState.filterAgent);
      const res = await fetch(_reposReqUrl(`/heatmap?${q.toString()}`), { cache: 'no-store' });
      if (!res.ok) {
        body.innerHTML = '';
        body.appendChild(el('div', { class: 'view-empty' }, "Couldn't load activity heatmap. Retry shortly."));
        return;
      }
      const data = await res.json();
      const cells = data.cells || [];
      body.innerHTML = '';
      if (cells.length === 0) {
        body.appendChild(el('div', { class: 'view-empty' }, 'No activity in this window.'));
        if (legend) legend.textContent = '';
        return;
      }
      const p95 = (data.scale && data.scale.p95) || 1;
      const grid = el('div', { class: 'repos-heatmap-grid', role: 'grid', 'aria-label': `Cluster activity heatmap by ${_reposState.dim}` });
      // CP17.C: cells get full a11y (RF1 per plexus-ui #11805) — aria-label +
      // role=button + tabindex + keydown all bundled with click-to-drill-in.
      // Sister-shape existing dashboard interactive-cell patterns.
      for (const c of cells) {
        const intensity = Math.min(1, (c.value || 0) / (p95 || 1));
        const alpha = 0.15 + intensity * 0.75;
        const color = `rgba(96,165,250,${alpha.toFixed(3)})`;
        const cellLabel = `${c.date}: ${c.value} ${_reposState.dim}`;
        const cell = el('div', {
          class: 'repos-heatmap-cell',
          role: 'button',
          tabindex: '0',
          'aria-label': cellLabel,
          title: cellLabel,
          'data-date': c.date,
          'data-value': String(c.value || 0),
          style: `background:${color}`,
        });
        const openDrill = () => _openHeatmapCellDetail(c.date);
        cell.addEventListener('click', openDrill);
        cell.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDrill(); }
        });
        grid.appendChild(cell);
      }
      body.appendChild(grid);
      if (legend) legend.textContent = `min ${data.scale.min} · p95 ${data.scale.p95} · max ${data.scale.max}`;
    } catch {
      body.innerHTML = '';
      body.appendChild(el('div', { class: 'view-empty' }, "Couldn't load activity heatmap. Retry shortly."));
    }
  }

  // CP17.C Task 1 (RF1 a11y bundled): heatmap cell click → detail modal.
  // Sister-shape existing Cost anomaly drill-in modal + accessible dialog
  // discipline (aria-modal + Esc-to-close + focus-trap + return-focus).
  async function _openHeatmapCellDetail(date) {
    // Close any existing modal
    const existing = document.getElementById('repos-heatmap-detail-modal');
    if (existing) existing.remove();

    const returnFocusEl = document.activeElement;
    const backdrop = el('div', {
      class: 'repos-heatmap-detail-backdrop',
      id: 'repos-heatmap-detail-modal',
    });
    const modal = el('div', {
      class: 'repos-heatmap-detail-modal',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'repos-heatmap-detail-title',
    });
    const closeBtn = el('button', {
      class: 'repos-heatmap-detail-close',
      'aria-label': 'Close activity detail',
    }, '×');
    const header = el('div', { class: 'repos-heatmap-detail-header' },
      el('h3', { id: 'repos-heatmap-detail-title' },
        `Activity on ${date}${_reposState.filterRepo ? ` · ${_reposState.filterRepo}` : ''}${_reposState.filterAgent ? ` · ${_reposState.filterAgent}` : ''}`),
      closeBtn);
    modal.appendChild(header);
    const bodyEl = el('div', { class: 'repos-heatmap-detail-body' },
      el('div', { class: 'cost-loading' }, 'loading…'));
    modal.appendChild(bodyEl);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    const closeModal = () => {
      backdrop.remove();
      if (returnFocusEl && returnFocusEl.focus) returnFocusEl.focus();
    };
    closeBtn.addEventListener('click', closeModal);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });
    const onKey = (e) => {
      if (e.key === 'Escape') { closeModal(); document.removeEventListener('keydown', onKey); }
    };
    document.addEventListener('keydown', onKey);
    // Move focus into modal per a11y dialog discipline
    setTimeout(() => closeBtn.focus(), 0);

    // Fetch the day's data via /repos/heatmap with a 1-day window (from=to=date)
    // + the current filters. Then aggregate the cell's underlying commit + PR
    // rows via /:repo_key/detail for each repo touched (best-effort within
    // v1 scope — full commit-list is CP17.C polish tier).
    try {
      const q = new URLSearchParams({
        from: date, to: date, dim: 'commits',
      });
      if (_reposState.filterRepo) q.set('filter_repo', _reposState.filterRepo);
      if (_reposState.filterAgent) q.set('filter_agent', _reposState.filterAgent);
      const sumRes = await fetch(`/api/v1/plexus/public/repos/heatmap?${q.toString()}`, { cache: 'no-store' });
      let summaryLine = '';
      if (sumRes.ok) {
        const sd = await sumRes.json();
        const total = (sd.cells || []).reduce((a, c) => a + (c.value || 0), 0);
        summaryLine = `${total} ${_reposState.dim} on this day`;
      }
      // If filtered to a specific repo, fetch the detail commit-list for drill-in.
      let listEls = [];
      if (_reposState.filterRepo) {
        const dRes = await fetch(`/api/v1/plexus/public/repos/${encodeURIComponent(_reposState.filterRepo)}/detail?from=${date}&to=${date}`, { cache: 'no-store' });
        if (dRes.ok) {
          const dd = await dRes.json();
          const commits = (dd.commits || []).slice(0, 50);
          if (commits.length > 0) {
            listEls.push(el('h4', null, 'Commits'));
            for (const c of commits) {
              const line = el('div', { class: 'repos-heatmap-detail-commit' },
                el('span', { class: 'commit-sha' }, (c.commit_sha || '').slice(0, 7)),
                el('span', { class: 'commit-agent' }, ` ${c.agent_attribution || 'unattributed'}`),
                el('span', { class: 'commit-subject' }, ` · ${(c.subject || '').slice(0, 80)}`));
              listEls.push(line);
            }
          }
          const prs = (dd.prs || []).slice(0, 20);
          if (prs.length > 0) {
            listEls.push(el('h4', null, 'PRs'));
            for (const p of prs) {
              const line = el('div', { class: 'repos-heatmap-detail-pr' },
                el('span', null, `#${p.pr_number} ${p.state}`),
                el('span', { class: 'pr-title' }, ` · ${(p.title || '').slice(0, 80)}`));
              listEls.push(line);
            }
          }
        }
      }
      bodyEl.innerHTML = '';
      if (summaryLine) bodyEl.appendChild(el('div', { class: 'repos-heatmap-detail-summary' }, summaryLine));
      if (listEls.length === 0) {
        bodyEl.appendChild(el('div', { class: 'view-empty' },
          _reposState.filterRepo ? 'No commit/PR detail for this cell.' :
            'Filter to a specific repo (click a repo card) to see commit + PR detail.'));
      } else {
        for (const e of listEls) bodyEl.appendChild(e);
      }
    } catch {
      bodyEl.innerHTML = '';
      bodyEl.appendChild(el('div', { class: 'view-empty' }, "Couldn't load activity detail. Retry shortly."));
    }
  }

  // CP17.C Task 4: attribution-gap triage — modal showing unattributed
  // commits for a repo. Sister-shape _openHeatmapCellDetail structure (same
  // a11y dialog canon: role=dialog + aria-modal + Esc/backdrop close +
  // focus-move + return-focus).
  async function _openAttributionGapTriage(repoKey) {
    const existing = document.getElementById('repos-attribution-triage-modal');
    if (existing) existing.remove();
    const returnFocusEl = document.activeElement;
    const backdrop = el('div', {
      class: 'repos-heatmap-detail-backdrop',
      id: 'repos-attribution-triage-modal',
    });
    const modal = el('div', {
      class: 'repos-heatmap-detail-modal repos-attribution-triage-modal',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'repos-attribution-triage-title',
    });
    const closeBtn = el('button', {
      class: 'repos-heatmap-detail-close',
      'aria-label': 'Close attribution triage',
    }, '×');
    modal.appendChild(el('div', { class: 'repos-heatmap-detail-header' },
      el('h3', { id: 'repos-attribution-triage-title' },
        `Attribution triage — ${repoKey}`),
      closeBtn));
    const bodyEl = el('div', { class: 'repos-heatmap-detail-body' },
      el('div', { class: 'cost-loading' }, 'loading…'));
    modal.appendChild(bodyEl);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    const closeModal = () => {
      backdrop.remove();
      if (returnFocusEl && returnFocusEl.focus) returnFocusEl.focus();
    };
    closeBtn.addEventListener('click', closeModal);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });
    const onKey = (e) => {
      if (e.key === 'Escape') { closeModal(); document.removeEventListener('keydown', onKey); }
    };
    document.addEventListener('keydown', onKey);
    setTimeout(() => closeBtn.focus(), 0);

    // Query the detail endpoint + filter to unattributed commits client-side.
    // Uses current dashboard window range.
    try {
      const period = _reposCurrentPeriod();
      const res = await fetch(
        `/api/v1/plexus/public/repos/${encodeURIComponent(repoKey)}/detail?period=${encodeURIComponent(period)}`,
        { cache: 'no-store' },
      );
      if (!res.ok) {
        bodyEl.innerHTML = '';
        bodyEl.appendChild(el('div', { class: 'view-empty' }, "Couldn't load attribution detail. Retry shortly."));
        return;
      }
      const data = await res.json();
      const unattributed = (data.commits || []).filter(c => !c.agent_attribution || c.agent_attribution === 'unattributed');
      bodyEl.innerHTML = '';
      if (unattributed.length === 0) {
        bodyEl.appendChild(el('div', { class: 'view-empty' },
          'No unattributed commits in this window (attribution_gap_count is stale; rollup will refresh nightly).'));
        return;
      }
      bodyEl.appendChild(el('div', { class: 'repos-heatmap-detail-summary' },
        `${unattributed.length} unattributed commit${unattributed.length === 1 ? '' : 's'} in window`));
      bodyEl.appendChild(el('h4', null, 'Unattributed commits'));
      for (const c of unattributed.slice(0, 50)) {
        const line = el('div', { class: 'repos-heatmap-detail-commit' },
          el('span', { class: 'commit-sha' }, (c.commit_sha || '').slice(0, 7)),
          el('span', { class: 'commit-agent', style: 'color:var(--amber, #eab308)' }, ` ${c.author_name || 'unknown author'}`),
          el('span', { class: 'commit-subject' }, ` · ${(c.subject || '').slice(0, 80)}`),
          el('span', { class: 'ts', style: 'color:var(--muted);font-size:10px;margin-left:6px' },
            (c.occurred_at || '').slice(0, 16).replace('T', ' ')));
        bodyEl.appendChild(line);
      }
    } catch {
      bodyEl.innerHTML = '';
      bodyEl.appendChild(el('div', { class: 'view-empty' }, "Couldn't load attribution detail. Retry shortly."));
    }
  }

  async function _renderReposList() {
    const grid = document.getElementById('repos-grid');
    if (!grid) return;
    try {
      const res = await fetch(_reposReqUrl('/list'), { cache: 'no-store' });
      if (!res.ok) {
        grid.innerHTML = '';
        grid.appendChild(el('div', { class: 'view-empty' }, "Couldn't load repo list. Retry shortly."));
        return;
      }
      const data = await res.json();
      _reposState.listCache = data.repos || [];
      _renderReposGrid();
      _populateReposFilterOptions();
    } catch {
      grid.innerHTML = '';
      grid.appendChild(el('div', { class: 'view-empty' }, "Couldn't load repo list. Retry shortly."));
    }
  }

  function _renderReposGrid() {
    const grid = document.getElementById('repos-grid');
    if (!grid) return;
    grid.innerHTML = '';
    let rows = _reposState.listCache.slice();
    if (_reposState.typeFilter !== 'all') {
      rows = rows.filter((r) => r.type === _reposState.typeFilter);
    }
    switch (_reposState.sort) {
      case 'last_activity': rows.sort((a, b) => (b.last_activity_at || '').localeCompare(a.last_activity_at || '')); break;
      case 'engagement':   rows.sort((a, b) => (b.engaged_agents_count || 0) - (a.engaged_agents_count || 0)); break;
      case 'name':         rows.sort((a, b) => (a.repo_key || '').localeCompare(b.repo_key || '')); break;
      default: /* activity */ rows.sort((a, b) => (b.commit_count || 0) - (a.commit_count || 0));
    }
    if (rows.length === 0) {
      grid.appendChild(el('div', { class: 'view-empty' }, 'No repos in this window.'));
      return;
    }
    for (const r of rows) {
      const card = el('div', { class: 'repos-repo-card', 'data-repo': r.repo_key });
      card.appendChild(el('div', { class: 'repos-repo-card-name' }, r.repo_key));
      const meta = el('div', { class: 'repos-repo-card-meta' });
      meta.appendChild(el('span', { class: 'badge-type' }, r.type || 'unknown'));
      if ((r.attribution_gap_count || 0) > 0) {
        // CP17.C Task 4: attribution-gap triage. Click amber badge → modal
        // shows unattributed commits list for this repo. Sister-shape existing
        // heatmap detail modal + honest-microcopy discipline.
        const gapBadge = el('span', {
          class: 'badge-gap',
          title: `Click to triage ${r.attribution_gap_count} unattributed commits`,
          role: 'button',
          tabindex: '0',
          'aria-label': `${r.attribution_gap_count} attribution gaps on ${r.repo_key}; click to triage`,
        }, `⚠ ${r.attribution_gap_count}`);
        const openTriage = (e) => {
          e.stopPropagation();  // don't trigger the card-level heatmap filter
          _openAttributionGapTriage(r.repo_key);
        };
        gapBadge.addEventListener('click', openTriage);
        gapBadge.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openTriage(e); }
        });
        meta.appendChild(gapBadge);
      }
      if (r.last_activity_at) meta.appendChild(el('span', null, `last: ${r.last_activity_at}`));
      card.appendChild(meta);
      const stats = el('div', { class: 'repos-repo-card-stats' });
      stats.appendChild(el('span', null, `commits: `));
      stats.appendChild(el('span', { class: 'stat-num' }, String(r.commit_count || 0)));
      stats.appendChild(el('span', null, ` · PRs: `));
      stats.appendChild(el('span', { class: 'stat-num' }, String(r.pr_merged_count || 0)));
      stats.appendChild(el('span', null, ` · agents: `));
      stats.appendChild(el('span', { class: 'stat-num' }, String(r.engaged_agents_count || 0)));
      card.appendChild(stats);
      card.addEventListener('click', () => {
        // Filter heatmap to this repo
        _reposState.filterRepo = r.repo_key;
        const sel = document.getElementById('repos-heatmap-filter-repo');
        if (sel) sel.value = r.repo_key;
        _renderReposHeatmap();
      });
      grid.appendChild(card);
    }
  }

  function _populateReposFilterOptions() {
    const repoSel = document.getElementById('repos-heatmap-filter-repo');
    if (repoSel) {
      const cur = _reposState.filterRepo;
      repoSel.innerHTML = '';
      repoSel.appendChild(el('option', { value: '' }, 'All repos'));
      for (const r of _reposState.listCache) {
        const opt = el('option', { value: r.repo_key }, r.repo_key);
        if (r.repo_key === cur) opt.selected = true;
        repoSel.appendChild(opt);
      }
    }
    // Agent filter dropdown enumeration (Task 6): distinct agents in window
    // from /agents-in-window endpoint. Sorted by commit_count DESC; capped
    // at 100 rows per endpoint discipline.
    _fetchReposAgentOptions().catch(() => {});
  }

  async function _fetchReposAgentOptions() {
    const agentSel = document.getElementById('repos-heatmap-filter-agent');
    if (!agentSel) return;
    try {
      const res = await fetch(_reposReqUrl('/agents-in-window'), { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      const cur = _reposState.filterAgent;
      agentSel.innerHTML = '';
      agentSel.appendChild(el('option', { value: '' }, 'All agents'));
      for (const a of (data.agents || [])) {
        const label = `${a.agent_id} (${a.commit_count} commits · ${a.repo_count} repos)`;
        const opt = el('option', { value: a.agent_id }, label);
        if (a.agent_id === cur) opt.selected = true;
        agentSel.appendChild(opt);
      }
    } catch { /* silent; dropdown falls back to All agents only */ }
  }

  async function _renderReposPendingQueue() {
    const list = document.getElementById('repos-pending-queue-list');
    if (!list) return;
    // Pending count comes with /summary; details need a dedicated endpoint OR
    // an ops-key call — for v1, MVP shows only the count-tile (updated via
    // summary refresh). Pending-queue detail is CP17.C polish.
    list.innerHTML = '';
    list.appendChild(el('div', { class: 'repos-activity-entry meta' },
      'Requester detail via ops-key; count visible in top-strip tile.'));
  }

  function _wireReposManagement() {
    const addForm = document.getElementById('repos-add-github-form');
    if (addForm) addForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = document.querySelector('[data-msg="add-github"]');
      const fd = new FormData(addForm);
      try {
        const res = await fetch('/api/v1/repos', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            github_owner_repo: fd.get('github_owner_repo'),
            bare_git_path: fd.get('bare_git_path') || undefined,
          }),
        });
        const body = await res.json();
        if (res.ok) {
          msg.className = 'repos-manage-msg ok';
          msg.textContent = `Now tracking ${body.github_owner_repo}.`;
          addForm.reset();
          _renderReposList();
          _renderReposSummary();
        } else {
          msg.className = 'repos-manage-msg err';
          msg.textContent = body.message || "Couldn't add repo. Check the owner/repo format.";
        }
      } catch {
        msg.className = 'repos-manage-msg err';
        msg.textContent = "Couldn't add repo. Retry shortly.";
      }
    });

    const bareForm = document.getElementById('repos-bare-git-request-form');
    if (bareForm) bareForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = document.querySelector('[data-msg="bare-git-request"]');
      const fd = new FormData(bareForm);
      try {
        const res = await fetch('/api/v1/repos/bare-git-request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            repo_name: fd.get('repo_name'),
            purpose: fd.get('purpose') || undefined,
          }),
        });
        const body = await res.json();
        if (res.ok) {
          msg.className = 'repos-manage-msg ok';
          msg.textContent = `Request submitted (id ${body.request_id}); admin will complete shortly.`;
          bareForm.reset();
          _renderReposSummary();  // refresh pending-mints tile
        } else {
          msg.className = 'repos-manage-msg err';
          msg.textContent = body.message || "Couldn't submit request. Check the name format.";
        }
      } catch {
        msg.className = 'repos-manage-msg err';
        msg.textContent = "Couldn't submit request. Retry shortly.";
      }
    });
  }

  function mountBusTab() {
    if (busTabMounted) return;
    busTabMounted = true;
    const listEl = document.getElementById('chan-list');
    const countEl = document.getElementById('chan-sidebar-count');
    const headEl = document.getElementById('chan-thread-head');
    const bodyEl = document.getElementById('chan-thread-body');
    if (!listEl || !bodyEl) return;

    let channels = [];
    let selectedChannel = null;

    async function loadChannels() {
      try {
        const r = await fetch('/api/v1/plexus/public/channels?limit=100');
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        channels = j.channels || [];
        renderChannelList(listEl, countEl, channels, selectedChannel, selectChannel);
      } catch (err) {
        clearChildren(listEl);
        listEl.appendChild(el('div', { class: 'chan-empty' }, 'failed to load channels: ' + err.message));
      }
    }

    // CP16 Pillar 7 sub-B (bus-tab pagination per PLAN-CP16 §10.5.2 + trio-ratified Q3):
    // Initial load fetches newest N; "Load older" button at thread top fetches
    // next page via before_id cursor. Sister-shape sub-A body-collapse (#10925
    // ratified scope; both browser-tier rendering optimizations). Per-channel
    // pagination state lives in a Map so revisiting a channel preserves what's
    // already loaded.
    const threadPaginationState = new Map();  // channel → {oldestId, allLoaded}

    async function loadThread(channel, opts = {}) {
      const isPaginate = opts.paginate === true;
      const state = threadPaginationState.get(channel) || { oldestId: null, allLoaded: false };
      let url = `/api/v1/plexus/public/messages?channel=${encodeURIComponent(channel)}&limit=${THREAD_PAGE_LIMIT}`;
      if (isPaginate && state.oldestId !== null) {
        url += `&before_id=${state.oldestId}`;
      }
      if (!isPaginate) {
        clearChildren(bodyEl);
        bodyEl.appendChild(el('div', { class: 'chan-empty' }, `loading #${channel}…`));
        threadPaginationState.set(channel, { oldestId: null, allLoaded: false });
      }
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        const newMsgs = j.messages || [];
        if (isPaginate) {
          // Prepend older messages to existing loaded set; preserve scroll position
          const scrollHeightBefore = bodyEl.scrollHeight;
          const scrollTopBefore = bodyEl.scrollTop;
          // Drop the existing load-older button before re-render
          const oldBtn = bodyEl.querySelector('.chan-load-older');
          if (oldBtn) oldBtn.remove();
          // Merge: collect existing rendered messages (data-msg-id attrs) + prepend new
          const existingIds = new Set(Array.from(bodyEl.querySelectorAll('[data-msg-id]')).map((n) => Number(n.dataset.msgId)));
          const merged = [...newMsgs.filter((m) => !existingIds.has(m.id))];
          // Re-fetch current rendered messages would require re-store; simpler: just
          // re-render full set by combining new + cached references via re-fetch.
          // For Phase B simplification: re-renderThread with the merged historical
          // pull would lose context; for this iteration we just prepend the new page
          // ABOVE the existing DOM (cluster boundaries may briefly mis-align until
          // next selectChannel refresh; acceptable v1 trade-off).
          const newFragment = document.createDocumentFragment();
          // Build a temp container for renderThread to populate, then prepend its children
          const tempContainer = document.createElement('div');
          renderThread(tempContainer, merged);
          while (tempContainer.firstChild) newFragment.appendChild(tempContainer.firstChild);
          bodyEl.insertBefore(newFragment, bodyEl.firstChild);
          // Restore scroll position so user stays in place
          requestAnimationFrame(() => {
            bodyEl.scrollTop = scrollTopBefore + (bodyEl.scrollHeight - scrollHeightBefore);
          });
        } else {
          renderThread(bodyEl, newMsgs);
        }
        // Update pagination state from newest fetch's oldest id
        const oldestInPage = newMsgs.length > 0 ? Math.min(...newMsgs.map((m) => m.id)) : null;
        const allLoaded = newMsgs.length < THREAD_PAGE_LIMIT;
        threadPaginationState.set(channel, {
          oldestId: oldestInPage !== null ? Math.min(oldestInPage, state.oldestId || Infinity) : state.oldestId,
          allLoaded,
        });
        // Add "Load older" button at top if more available
        if (!allLoaded && threadPaginationState.get(channel).oldestId !== null) {
          const existing = bodyEl.querySelector('.chan-load-older');
          if (existing) existing.remove();
          const btn = el('button', { class: 'chan-load-older', type: 'button', 'aria-label': 'Load older messages' }, '↑ Load older');
          btn.addEventListener('click', () => loadThread(channel, { paginate: true }));
          bodyEl.insertBefore(btn, bodyEl.firstChild);
        }
      } catch (err) {
        if (!isPaginate) {
          clearChildren(bodyEl);
          bodyEl.appendChild(el('div', { class: 'chan-empty' }, `failed to load #${channel}: ${err.message}`));
        }
      }
    }

    function selectChannel(channel) {
      selectedChannel = channel;
      const chMeta = channels.find(c => c.channel === channel);
      // Refresh sidebar active-state
      for (const row of listEl.querySelectorAll('.chan-row')) {
        row.classList.toggle('active', row.dataset.channel === channel);
      }
      // Update thread head
      clearChildren(headEl);
      const title = el('span', { class: 'chan-thread-title' });
      title.appendChild(el('span', { class: 'chan-hash' }, '#'));
      title.appendChild(document.createTextNode(channel));
      if (chMeta) {
        title.appendChild(el('span', { class: 'chan-meta-inline' },
          `${chMeta.message_count} msgs · last ${fmtChannelWhen(chMeta.last_message_at)}`));
      }
      headEl.appendChild(title);
      const refresh = el('button', { class: 'chan-thread-refresh' }, '↻ refresh');
      refresh.addEventListener('click', () => { loadThread(channel); loadChannels(); });
      headEl.appendChild(refresh);
      // Hash routing for deep-link
      if (location.hash !== `#bus/${channel}`) {
        history.replaceState(null, '', `#bus/${channel}`);
      }
      loadThread(channel);
    }

    loadChannels().then(() => {
      // Deep-link: #bus/<channel>
      const hash = location.hash || '';
      const m = hash.match(/^#bus\/(.+)$/);
      if (m && channels.some(c => c.channel === m[1])) {
        selectChannel(m[1]);
      } else if (channels.length > 0) {
        // Default-select the most-recent channel
        const sorted = channels.slice().sort((a, b) =>
          (parseIso(b.last_message_at)?.getTime() || 0) - (parseIso(a.last_message_at)?.getTime() || 0));
        selectChannel(sorted[0].channel);
      }
    });
    // Periodic channel-list refresh (lightweight, keeps last-activity hints fresh)
    setInterval(loadChannels, 30000);
  }
  // If page loaded directly at #bus or #bus/<channel>, mount immediately
  if ((location.hash || '').startsWith('#bus')) mountBusTab();

  // ────────────────────────────────────────────────────────────────────
  // CP9.1 (2026-06-01): Agent color legend modal.
  // Populated from /presence (all known agents) at open-time so newly-added
  // agents appear without a hard refresh. Click row → copy hex to clipboard.
  // ────────────────────────────────────────────────────────────────────
  function openLegendModal() {
    const modal = document.getElementById('legend-modal');
    const listEl = document.getElementById('legend-list');
    const searchEl = document.getElementById('legend-search');
    if (!modal || !listEl) return;
    modal.classList.add('open');
    listEl.innerHTML = '<div class="chan-empty">loading…</div>';

    fetch('/api/v1/plexus/public/presence?limit=200').then(r => r.json()).then(j => {
      const agents = (j.presence || []).map(p => p.agent_id).filter(Boolean).sort();
      // Augment with the static SELF id in case it isn't in /presence
      if (!agents.includes(SELF_AGENT_ID)) agents.unshift(SELF_AGENT_ID);
      renderLegendList(listEl, agents, searchEl.value || '');
    }).catch(err => {
      listEl.innerHTML = '';
      listEl.appendChild(el('div', { class: 'chan-empty' }, 'failed: ' + err.message));
    });
    searchEl.oninput = () => {
      const q = (searchEl.value || '').toLowerCase().trim();
      for (const row of listEl.querySelectorAll('.legend-row')) {
        const agentId = row.dataset.agent || '';
        const cname = row.dataset.colorName || '';
        row.style.display = (!q || agentId.toLowerCase().includes(q) || cname.includes(q)) ? '' : 'none';
      }
    };
    searchEl.focus();
  }
  function closeLegendModal() {
    const modal = document.getElementById('legend-modal');
    if (modal) modal.classList.remove('open');
  }
  function renderLegendList(listEl, agents, filter) {
    clearChildren(listEl);
    if (!agents || agents.length === 0) {
      listEl.appendChild(el('div', { class: 'chan-empty' }, 'no agents.'));
      return;
    }
    const q = (filter || '').toLowerCase().trim();
    for (const id of agents) {
      const ac = agentColor(id);
      const matches = !q || id.toLowerCase().includes(q) || ac.name.includes(q);
      const row = el('div', {
        class: 'legend-row',
        'data-agent': id,
        'data-color-name': ac.name,
        style: matches ? '' : 'display:none',
        title: 'click to copy hex',
      });
      row.appendChild(el('span', { class: 'swatch', style: `background:${ac.hex}` }));
      row.appendChild(el('span', { class: 'legend-agent' }, id));
      row.appendChild(el('span', { class: 'legend-name' }, ac.name));
      row.appendChild(el('span', { class: 'legend-hex' }, ac.hex));
      row.appendChild(el('span', { class: 'legend-rgb' }, ac.rgb));
      row.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(ac.hex);
          row.classList.add('copied');
          setTimeout(() => row.classList.remove('copied'), 800);
        } catch (_) { /* clipboard denied — non-fatal */ }
      });
      listEl.appendChild(row);
    }
  }
  // Wire button + close + Esc
  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('chan-legend-btn');
    const closeBtn = document.getElementById('legend-close');
    const modal = document.getElementById('legend-modal');
    if (btn) btn.addEventListener('click', openLegendModal);
    if (closeBtn) closeBtn.addEventListener('click', closeLegendModal);
    if (modal) modal.addEventListener('click', e => { if (e.target === modal) closeLegendModal(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLegendModal(); });
  });
  // If DOMContentLoaded already fired (defer-loaded script), wire immediately
  if (document.readyState !== 'loading') {
    const btn = document.getElementById('chan-legend-btn');
    if (btn && !btn._legendWired) {
      btn.addEventListener('click', openLegendModal);
      btn._legendWired = true;
      const closeBtn = document.getElementById('legend-close');
      if (closeBtn) closeBtn.addEventListener('click', closeLegendModal);
      const modal = document.getElementById('legend-modal');
      if (modal) modal.addEventListener('click', e => { if (e.target === modal) closeLegendModal(); });
      document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLegendModal(); });
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // CP10.1 (2026-06-01): Alerts engine + bell dropdown.
  // Human-only operator surface; never crosses to swarm bus per
  // feedback_dashboard_alerts_are_human_only. Phase 1: 4 predicates,
  // in-memory state, dedupe by (type, agent_id), auto-resolve on next
  // poll when the predicate goes false. State lives in browser only.
  // ────────────────────────────────────────────────────────────────────
  const REGISTRATION_STUCK_HOURS = {
    PENDING_FERRY: 24,
    PENDING_ACTIVATION: 48,
    APPROVED_PENDING_FERRY: 24,
  };
  const COST_SPIKE_RATIO = 2.0;  // matches existing ANOMALY_RATIO

  class AlertEngine {
    constructor() {
      this.alerts = new Map();   // key → { key, type, agentId, ts, msg, severity, state }
      this.listeners = [];
      this.lastHigh = 0;  // count of firing-high last we notified — drives bell pulse
    }
    _fire(key, type, agentId, severity, msg) {
      const existing = this.alerts.get(key);
      if (existing && existing.state !== 'resolved') {
        // already firing or acked — dedupe; update message if it drifted (e.g. blocked_until time)
        if (existing.msg !== msg) existing.msg = msg;
        return;
      }
      this.alerts.set(key, { key, type, agentId, ts: Date.now(), msg, severity, state: 'firing' });
      this._emit();
    }
    _autoResolve(seenKeys) {
      let changed = false;
      for (const [key, a] of this.alerts) {
        if (a.state !== 'resolved' && !seenKeys.has(key)) {
          a.state = 'resolved';
          a.resolvedTs = Date.now();
          changed = true;
        }
      }
      if (changed) this._emit();
    }
    ack(key) {
      const a = this.alerts.get(key);
      if (a && a.state === 'firing') { a.state = 'acked'; this._emit(); }
    }
    ackAll() {
      let changed = false;
      for (const a of this.alerts.values()) {
        if (a.state === 'firing') { a.state = 'acked'; changed = true; }
      }
      if (changed) this._emit();
    }
    // Drop resolved alerts older than 5 minutes (keep recent ones for context).
    purgeOld() {
      const cutoff = Date.now() - 5 * 60_000;
      let changed = false;
      for (const [key, a] of this.alerts) {
        if (a.state === 'resolved' && (a.resolvedTs || a.ts) < cutoff) {
          this.alerts.delete(key);
          changed = true;
        }
      }
      if (changed) this._emit();
    }
    list() {
      // Sort: firing-high → firing-medium → firing-low → acked → resolved; then by ts desc
      const order = { firing: 0, acked: 1, resolved: 2 };
      const sevOrder = { high: 0, medium: 1, low: 2 };
      return [...this.alerts.values()].sort((a, b) => {
        const so = order[a.state] - order[b.state]; if (so) return so;
        const sv = sevOrder[a.severity] - sevOrder[b.severity]; if (sv) return sv;
        return b.ts - a.ts;
      });
    }
    counts() {
      let firing = 0, firingHigh = 0;
      for (const a of this.alerts.values()) {
        if (a.state === 'firing') {
          firing++;
          if (a.severity === 'high') firingHigh++;
        }
      }
      return { firing, firingHigh };
    }
    onChange(fn) { this.listeners.push(fn); }
    _emit() { for (const fn of this.listeners) fn(this); }

    // PREDICATE: evaluate presence rows for stop_failure + quota_exhausted.
    evaluatePresence(rows) {
      if (!Array.isArray(rows)) return;
      const seen = new Set();
      for (const p of rows) {
        if (!p || !p.agent_id) continue;
        if (p.label === 'stop_failure') {
          const k = `stop_failure::${p.agent_id}`;
          seen.add(k);
          this._fire(k, 'stop_failure', p.agent_id, 'high',
            `${p.agent_id}: session terminated (stop_failure)`);
        }
        if (p.runtime_state === 'quota_exhausted') {
          const k = `quota_exhausted::${p.agent_id}`;
          seen.add(k);
          const until = p.runtime_blocked_until ? ` until ${p.runtime_blocked_until.slice(0, 16).replace('T', ' ')}` : '';
          this._fire(k, 'quota_exhausted', p.agent_id, 'medium',
            `${p.agent_id}: quota exhausted${until}`);
        }
      }
      // Auto-resolve only THIS predicate family — don't clobber registration / cost.
      this._autoResolveFamily('stop_failure', seen);
      this._autoResolveFamily('quota_exhausted', seen);
    }
    _autoResolveFamily(typePrefix, seenKeys) {
      let changed = false;
      for (const [key, a] of this.alerts) {
        if (a.type === typePrefix && a.state !== 'resolved' && !seenKeys.has(key)) {
          a.state = 'resolved';
          a.resolvedTs = Date.now();
          changed = true;
        }
      }
      if (changed) this._emit();
    }
    evaluateRegistrations(rows) {
      if (!Array.isArray(rows)) return;
      const seen = new Set();
      const now = Date.now();
      for (const r of rows) {
        if (!r || r.is_terminal) continue;
        const threshold = REGISTRATION_STUCK_HOURS[r.status];
        if (!threshold) continue;
        const updated = new Date(r.updated_at || r.created_at || 0).getTime();
        if (!Number.isFinite(updated)) continue;
        const ageH = (now - updated) / 3_600_000;
        if (ageH < threshold) continue;
        const k = `registration_stuck::${r.agent_id || r.registration_id}`;
        seen.add(k);
        this._fire(k, 'registration_stuck', r.agent_id || r.registration_id, 'medium',
          `${r.agent_id || 'reg-' + r.registration_id}: stuck in ${r.status} for ${ageH.toFixed(0)}h`);
      }
      this._autoResolveFamily('registration_stuck', seen);
    }
    // Cost-spike fed externally from the cost-tab anomaly compute path
    // (where the 2x-7d-mean comparison is already done). Phase 1 limitation
    // noted: only fires when cost-tab has been rendered at least once.
    pushCostSpike(agentId, ratio, meanPerHr, currentPerHr) {
      if (!agentId || !Number.isFinite(ratio) || ratio < COST_SPIKE_RATIO) return;
      const k = `cost_spike::${agentId}`;
      this._fire(k, 'cost_spike', agentId, 'medium',
        `${agentId}: cost spike ${ratio.toFixed(1)}× 7d mean ($${currentPerHr.toFixed(4)}/hr vs $${meanPerHr.toFixed(4)}/hr)`);
    }
    // Caller invokes after a full cost-tab refresh with the set of agents
    // currently flagged; un-flagged agents auto-resolve.
    syncCostSpikes(currentlyFlaggedSet) {
      this._autoResolveFamily('cost_spike', new Set(
        [...currentlyFlaggedSet].map(id => `cost_spike::${id}`)
      ));
    }
  }

  const alertEngine = new AlertEngine();

  // Hook presence-poll → alertEngine.evaluatePresence
  function evalAlertsFromLastData() {
    if (lastData && Array.isArray(lastData.presence)) {
      alertEngine.evaluatePresence(lastData.presence);
    }
  }
  // Re-evaluate every time renderCards runs (presence poll cadence ~1s on lastData).
  // We hook at the tail by patching the tick (less invasive than touching renderCards).
  setInterval(evalAlertsFromLastData, 5_000);

  // Background registrations fetch (every 60s) — independent of Register tab visit.
  async function fetchRegistrationsForAlerts() {
    try {
      const r = await fetch('/api/v1/plexus/public/registrations?limit=200');
      if (!r.ok) return;
      const j = await r.json();
      alertEngine.evaluateRegistrations(j.registrations || []);
    } catch (_) { /* non-fatal */ }
  }
  fetchRegistrationsForAlerts();
  setInterval(fetchRegistrationsForAlerts, 60_000);

  // Periodic purge of stale-resolved alerts so the dropdown doesn't grow.
  setInterval(() => alertEngine.purgeOld(), 30_000);

  // ─── Alerts UI ───
  function fmtAlertTs(ms) {
    const ago = (Date.now() - ms) / 1000;
    if (ago < 60) return Math.floor(ago) + 's';
    if (ago < 3600) return Math.floor(ago / 60) + 'm';
    if (ago < 86400) return Math.floor(ago / 3600) + 'h';
    return Math.floor(ago / 86400) + 'd';
  }
  function renderAlertsBell() {
    const bell = document.getElementById('alerts-bell');
    const count = document.getElementById('alerts-bell-count');
    if (!bell || !count) return;
    const { firing, firingHigh } = alertEngine.counts();
    bell.classList.toggle('has-firing', firing > 0);
    bell.classList.toggle('has-firing-high', firingHigh > 0);
    if (firing > 0) {
      count.textContent = String(firing);
      count.hidden = false;
    } else {
      count.hidden = true;
    }
    // Browser title-bar badge so closed-bell still surfaces count
    if (firing > 0) {
      if (!document.title.startsWith('(')) document.title = `(${firing}) ${document.title}`;
      else document.title = document.title.replace(/^\(\d+\)/, `(${firing})`);
    } else {
      document.title = document.title.replace(/^\(\d+\)\s*/, '');
    }
  }
  function renderAlertsDropdown() {
    const list = document.getElementById('alerts-dropdown-list');
    if (!list) return;
    const alerts = alertEngine.list();
    clearChildren(list);
    if (alerts.length === 0) {
      list.appendChild(el('div', { class: 'alerts-empty' }, 'No alerts. Cluster healthy.'));
      return;
    }
    for (const a of alerts) {
      const row = el('div', {
        class: `alerts-row severity-${a.severity} ${a.state === 'acked' ? 'acked' : ''} ${a.state === 'resolved' ? 'resolved' : ''}`,
        'data-alert-key': a.key,
        title: `${a.type} · ${a.state} · ${new Date(a.ts).toLocaleTimeString()}`,
      });
      row.appendChild(el('span', { class: 'sev-dot' }));
      const msgCol = el('div');
      msgCol.appendChild(el('div', { class: 'alert-msg' }, a.msg));
      msgCol.appendChild(el('div', { class: 'alert-ts' }, fmtAlertTs(a.ts) + (a.state === 'resolved' ? ' · resolved' : '')));
      row.appendChild(msgCol);
      const ackBtn = el('button', { class: 'alert-ack', type: 'button' }, 'ack');
      ackBtn.addEventListener('click', (e) => { e.stopPropagation(); alertEngine.ack(a.key); });
      row.appendChild(ackBtn);
      // Click row body → jump to agent card (Live tab) + flash
      row.addEventListener('click', () => jumpToAgentCard(a.agentId));
      list.appendChild(row);
    }
  }
  function jumpToAgentCard(agentId) {
    if (!agentId) return;
    // Switch to Live tab
    const liveBtn = document.querySelector('.tab-btn[data-tab="live"]');
    if (liveBtn) liveBtn.click();
    // Close dropdown
    const dd = document.getElementById('alerts-dropdown'); if (dd) dd.hidden = true;
    // Scroll + flash
    requestAnimationFrame(() => {
      const card = document.querySelector(`.agent-card[data-agent-id="${CSS.escape(agentId)}"]`);
      if (!card) return;
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.classList.remove('alert-flash');
      void card.offsetWidth;  // restart animation
      card.classList.add('alert-flash');
    });
  }
  alertEngine.onChange(() => { renderAlertsBell(); renderAlertsDropdown(); });
  setInterval(renderAlertsDropdown, 30_000);  // refresh ts ticks

  function wireAlertsBell() {
    const bell = document.getElementById('alerts-bell');
    const dd = document.getElementById('alerts-dropdown');
    const ackAll = document.getElementById('alerts-ack-all');
    if (!bell || !dd || bell._wired) return;
    bell._wired = true;
    bell.addEventListener('click', (e) => {
      e.stopPropagation();
      dd.hidden = !dd.hidden;
      if (!dd.hidden) renderAlertsDropdown();
    });
    if (ackAll) ackAll.addEventListener('click', (e) => { e.stopPropagation(); alertEngine.ackAll(); });
    document.addEventListener('click', (e) => {
      if (!dd.contains(e.target) && e.target !== bell) dd.hidden = true;
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') dd.hidden = true; });
    renderAlertsBell();
  }
  if (document.readyState !== 'loading') wireAlertsBell();
  else document.addEventListener('DOMContentLoaded', wireAlertsBell);

  // ────────────────────────────────────────────────────────────────────
  // CP8.2 (2026-05-27): Audit tab — DM audit log reader + reveal modal.
  // Public-trust (network-isolation only) for v1; auth comes Stage 2.5+.
  // ────────────────────────────────────────────────────────────────────
  let auditTabMounted = false;
  let revealCurrent = { id: null, body: null, sender: null };

  function fmtAuditTs(iso) {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      const hh = String(d.getUTCHours()).padStart(2,'0');
      const mm = String(d.getUTCMinutes()).padStart(2,'0');
      const ss = String(d.getUTCSeconds()).padStart(2,'0');
      const mo = String(d.getUTCMonth()+1).padStart(2,'0');
      const dd = String(d.getUTCDate()).padStart(2,'0');
      return `${mo}-${dd} ${hh}:${mm}:${ss}Z`;
    } catch { return iso; }
  }

  function openRevealModal(messageId, meta) {
    const modal = document.getElementById('audit-reveal-modal');
    const metaEl = document.getElementById('audit-modal-meta');
    const bodyEl = document.getElementById('audit-modal-body');
    revealCurrent = { id: messageId, body: null, sender: meta.sender || '?' };
    metaEl.textContent = `message #${messageId} · ${meta.sender || '?'} → [${(meta.recipients || []).join(', ')}] · channel: ${meta.channel || '?'}`;
    bodyEl.textContent = '[BODY HIDDEN — click Reveal text]';
    bodyEl.classList.add('audit-body-redacted');
    modal.setAttribute('aria-hidden', 'false');
    // Fetch body now (writes audit entry server-side); reveal action just displays.
    fetch(`/api/v1/plexus/public/messages/${messageId}`, { cache: 'no-store' })
      .then(r => r.ok ? r.json() : Promise.reject(r))
      .then(d => { revealCurrent.body = (d.message && d.message.body) || ''; })
      .catch(() => { revealCurrent.body = '(failed to fetch body — message may have been deleted)'; });
  }

  function closeRevealModal() {
    document.getElementById('audit-reveal-modal').setAttribute('aria-hidden', 'true');
    revealCurrent = { id: null, body: null, sender: null };
  }

  function mountAuditTab() {
    if (auditTabMounted) return;
    auditTabMounted = true;

    const listEl = document.getElementById('audit-list');
    const statusEl = document.getElementById('audit-status');
    const fSender = document.getElementById('audit-f-sender');
    const fRecipient = document.getElementById('audit-f-recipient');
    const fMsgid = document.getElementById('audit-f-msgid');
    const fOpsKey = document.getElementById('audit-f-opskey');
    const applyBtn = document.getElementById('audit-apply');
    const clearBtn = document.getElementById('audit-clear');

    function buildAuditRow(e) {
      const row = el('div', { class: 'audit-row' });
      row.appendChild(el('span', { class: 'audit-ts', title: e.ts }, fmtAuditTs(e.ts)));
      const keyDisplay = e.ops_key_id === 'public-dashboard' ? 'dashboard' : (e.ops_key_id || '?');
      const keySpan = el('span', { class: 'audit-key', title: e.ops_key_id }, keyDisplay);
      if (e.via === 'dashboard') {
        keySpan.appendChild(el('span', { class: 'audit-via' }, 'via=dashboard'));
      }
      row.appendChild(keySpan);
      const flow = el('span', { class: 'audit-flow' });
      flow.appendChild(document.createTextNode(e.sender || '?'));
      flow.appendChild(el('span', { class: 'arrow' }, '→'));
      flow.appendChild(document.createTextNode('[' + (e.recipients || []).join(', ') + ']'));
      if (e.channel) {
        flow.appendChild(el('span', { class: 'audit-via' }, '#' + e.channel));
      }
      row.appendChild(flow);
      row.appendChild(el('span', { class: 'audit-msgid' }, '#' + e.message_id));
      const revealBtn = el('button', { class: 'audit-reveal' }, '🔒 reveal body');
      revealBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        openRevealModal(e.message_id, {
          sender: e.sender, recipients: e.recipients, channel: e.channel,
        });
      });
      row.appendChild(revealBtn);
      return row;
    }

    async function fetchAndRender() {
      const params = new URLSearchParams({ limit: '200' });
      if (fSender.value.trim())     params.set('sender', fSender.value.trim());
      if (fRecipient.value.trim())  params.set('recipient', fRecipient.value.trim());
      if (fMsgid.value.trim())      params.set('message_id', fMsgid.value.trim());
      if (fOpsKey.value.trim())     params.set('ops_key_id', fOpsKey.value.trim());
      statusEl.textContent = 'loading…';
      try {
        const r = await fetch('/api/v1/plexus/public/dm-audit-log?' + params.toString(), { cache: 'no-store' });
        if (!r.ok) {
          statusEl.textContent = `error HTTP ${r.status}`;
          return;
        }
        const d = await r.json();
        clearChildren(listEl);
        if (!d.exists) {
          listEl.appendChild(el('div', { class: 'bus-empty' },
            'audit log file does not exist yet — no ops-key reads have happened. Try the reveal-body flow once to populate.'));
          statusEl.textContent = 'no audit entries';
          return;
        }
        if (d.entries.length === 0) {
          listEl.appendChild(el('div', { class: 'bus-empty' }, 'no audit entries match current filters'));
          statusEl.textContent = `0 of ${d.total_matched || 0} matched`;
          return;
        }
        for (const e of d.entries) listEl.appendChild(buildAuditRow(e));
        statusEl.textContent = `${d.entries.length} entries · ${d.total_matched || d.entries.length} matched`;
      } catch (err) {
        statusEl.textContent = `error: ${err.message}`;
      }
    }

    applyBtn.addEventListener('click', fetchAndRender);
    clearBtn.addEventListener('click', () => {
      fSender.value = ''; fRecipient.value = ''; fMsgid.value = ''; fOpsKey.value = '';
      fetchAndRender();
    });
    for (const inp of [fSender, fRecipient, fMsgid, fOpsKey]) {
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') fetchAndRender(); });
    }

    // Reveal modal wiring (one-time on first audit tab mount).
    document.getElementById('audit-modal-close').addEventListener('click', closeRevealModal);
    document.getElementById('audit-reveal-modal').addEventListener('click', (e) => {
      if (e.target.id === 'audit-reveal-modal') closeRevealModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeRevealModal();
    });
    document.getElementById('audit-modal-reveal').addEventListener('click', () => {
      const bodyEl = document.getElementById('audit-modal-body');
      if (revealCurrent.body == null) {
        bodyEl.textContent = '(still fetching…)';
        return;
      }
      bodyEl.textContent = revealCurrent.body;
      bodyEl.classList.remove('audit-body-redacted');
    });
    document.getElementById('audit-modal-copy').addEventListener('click', async () => {
      if (revealCurrent.body == null) return;
      try {
        await navigator.clipboard.writeText(revealCurrent.body);
        const btn = document.getElementById('audit-modal-copy');
        const orig = btn.textContent;
        btn.textContent = 'Copied ✓';
        setTimeout(() => btn.textContent = orig, 1500);
      } catch {}
    });
    document.getElementById('audit-modal-download').addEventListener('click', () => {
      if (revealCurrent.body == null) return;
      const blob = new Blob([revealCurrent.body], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `dm-${revealCurrent.id}-from-${revealCurrent.sender}.txt`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });

    fetchAndRender();
  }

  // If page loaded directly at #audit, mount immediately
  if (location.hash === '#audit') mountAuditTab();

  // ────────────────────────────────────────────────────────────────────
  // CP8.5 (2026-05-27): Register tab — ADR-0025 agent-registration state
  // machine admin surface. Public-mirror data (sanitized server-side; no
  // ciphertext_b64 or token-hashes ever reach the browser).
  // ────────────────────────────────────────────────────────────────────
  let registerTabMounted = false;
  const REGISTRATION_STATES = [
    'NEW', 'SUBMITTED', 'PARCH_REVIEW', 'JON_RATIFY',
    'APPROVED_PENDING_FERRY', 'FERRIED', 'PENDING_ACTIVATION',
    'ACTIVE', 'REJECTED', 'REVOKED',
  ];
  const REGISTRATION_TERMINAL = new Set(['ACTIVE', 'REJECTED', 'REVOKED']);

  function regLastAction(r) {
    // Pick the most recently-set "actor + action" tuple from the row.
    // Order matters: ACTIVE > FERRIED > JON_RATIFY > SUBMITTED.
    if (r.activated_at)        return { when: r.activated_at, actor: '(activated)',          label: 'activated' };
    if (r.revoked_at)          return { when: r.revoked_at,   actor: r.revoked_reason || '(revoked)', label: 'revoked' };
    if (r.rejected_reason)     return { when: r.updated_at,   actor: r.rejected_reason,      label: 'rejected' };
    if (r.ferried_at)          return { when: r.ferried_at,   actor: r.ferried_by || '?',    label: 'ferried by' };
    if (r.ratified_at)         return { when: r.ratified_at,  actor: r.ratified_by || '?',   label: 'ratified by' };
    return { when: r.created_at, actor: '(submitted)', label: 'submitted' };
  }

  function mountRegisterTab() {
    if (registerTabMounted) return;
    registerTabMounted = true;

    const listEl = document.getElementById('reg-list');
    const statusEl = document.getElementById('reg-status');
    const chipsEl = document.getElementById('reg-status-chips');
    const refreshBtn = document.getElementById('reg-refresh');
    const includeTerminalEl = document.getElementById('reg-include-terminal');

    const enabledStatuses = new Set();
    // Defaults: all non-terminal on, terminal off (operator sees "what's pending" first)
    for (const s of REGISTRATION_STATES) {
      if (!REGISTRATION_TERMINAL.has(s)) enabledStatuses.add(s);
    }

    // Build chips for every known state. Counts populate after fetch.
    for (const s of REGISTRATION_STATES) {
      const chip = el('span', { class: 'bus-chip' + (enabledStatuses.has(s) ? ' on' : ''), 'data-status': s });
      chip.appendChild(document.createTextNode(s));
      const cnt = el('span', { class: 'count' }, '0');
      chip.appendChild(cnt);
      chip.addEventListener('click', () => {
        if (enabledStatuses.has(s)) enabledStatuses.delete(s);
        else enabledStatuses.add(s);
        chip.classList.toggle('on', enabledStatuses.has(s));
        render();
      });
      chipsEl.appendChild(chip);
    }

    includeTerminalEl.addEventListener('change', () => {
      for (const s of REGISTRATION_TERMINAL) {
        if (includeTerminalEl.checked) enabledStatuses.add(s);
        else enabledStatuses.delete(s);
        const c = chipsEl.querySelector(`.bus-chip[data-status="${s}"]`);
        if (c) c.classList.toggle('on', enabledStatuses.has(s));
      }
      render();
    });

    let cached = null;   // last fetched registrations
    function render() {
      if (!cached) return;
      // Update chip counts
      const countsByStatus = new Map();
      for (const r of cached) countsByStatus.set(r.status, (countsByStatus.get(r.status) || 0) + 1);
      chipsEl.querySelectorAll('.bus-chip').forEach((chip) => {
        const s = chip.dataset.status;
        const c = chip.querySelector('.count');
        if (c) c.textContent = String(countsByStatus.get(s) || 0);
      });
      // Filter + render rows
      const visible = cached.filter(r => enabledStatuses.has(r.status));
      clearChildren(listEl);
      if (visible.length === 0) {
        listEl.appendChild(el('div', { class: 'bus-empty' },
          cached.length === 0
            ? 'no registrations in the database yet'
            : 'no registrations match current filters'));
        statusEl.textContent = `0 of ${cached.length} visible`;
        return;
      }
      for (const r of visible) {
        const last = regLastAction(r);
        const row = el('div', { class: 'reg-row', 'data-reg-id': r.registration_id });
        row.appendChild(el('span', { class: 'reg-status s-' + r.status }, r.status));
        row.appendChild(el('span', { class: 'reg-agent' }, r.agent_id));
        const idShort = (r.registration_id || '').slice(0, 8);
        row.appendChild(el('span', { class: 'reg-id', title: r.registration_id }, idShort));
        const actionSpan = el('span', { class: 'reg-last-action' });
        actionSpan.appendChild(document.createTextNode(last.label + ' '));
        actionSpan.appendChild(el('span', { class: 'actor' }, last.actor));
        row.appendChild(actionSpan);
        row.appendChild(el('span', { class: 'reg-age', title: r.updated_at }, fmtAge(r.updated_at)));
        row.addEventListener('click', () => {
          row.classList.toggle('expanded');
        });
        listEl.appendChild(row);
        // Detail row (hidden until expanded — CSS adjacent-sibling selector)
        const detail = el('div', { class: 'reg-row-detail' });
        const dl = el('dl');
        const fields = [
          ['registration_id', r.registration_id],
          ['agent_id', r.agent_id],
          ['status', r.status],
          ['created_at', r.created_at],
          ['updated_at', r.updated_at],
          ['ratified_by', r.ratified_by],
          ['ratified_at', r.ratified_at],
          ['ferried_by', r.ferried_by],
          ['ferried_at', r.ferried_at],
          ['activated_at', r.activated_at],
          ['revoked_at', r.revoked_at],
          ['revoked_reason', r.revoked_reason],
          ['rejected_reason', r.rejected_reason],
          ['justification', r.justification_json],
          ['submission',    r.submission_json],
        ];
        for (const [k, v] of fields) {
          if (v == null || v === '') continue;
          dl.appendChild(el('dt', null, k));
          // Pretty-print JSON-shaped fields
          let display = v;
          if (k === 'justification' || k === 'submission') {
            try { display = JSON.stringify(JSON.parse(v), null, 2); } catch {}
          }
          dl.appendChild(el('dd', null, display));
        }
        detail.appendChild(dl);
        listEl.appendChild(detail);
      }
      statusEl.textContent = `${visible.length} of ${cached.length} visible`;
    }

    async function fetchAndRender() {
      statusEl.textContent = 'loading…';
      try {
        const r = await fetch('/api/v1/plexus/public/registrations?limit=500', { cache: 'no-store' });
        if (!r.ok) {
          statusEl.textContent = `error HTTP ${r.status}`;
          return;
        }
        const d = await r.json();
        cached = d.registrations || [];
        render();
      } catch (e) {
        statusEl.textContent = `error: ${e.message}`;
      }
    }

    refreshBtn.addEventListener('click', fetchAndRender);
    fetchAndRender();
  }

  // If page loaded directly at #register, mount immediately
  if (location.hash === '#register') mountRegisterTab();

  // ────────────────────────────────────────────────────────────────────
  // CP8.3 (2026-05-27): card-grid filter wireup. cardFilter state is
  // defined up by renderCards; chips + search input update it and trigger
  // a re-render off the cached lastData.presence.
  // ────────────────────────────────────────────────────────────────────
  function rerenderCardsWithFilter() {
    if (lastData && lastData.presence) renderCards(lastData.presence);
  }
  const searchEl = document.getElementById('cards-search');
  if (searchEl) {
    searchEl.addEventListener('input', () => {
      cardFilter.search = searchEl.value;
      rerenderCardsWithFilter();
    });
  }
  document.querySelectorAll('.cards-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const status = chip.dataset.status;
      const runtime = chip.dataset.runtime;
      if (status) {
        if (cardFilter.statuses.has(status)) cardFilter.statuses.delete(status);
        else cardFilter.statuses.add(status);
        chip.classList.toggle('on', cardFilter.statuses.has(status));
      } else if (runtime) {
        if (cardFilter.runtimes.has(runtime)) cardFilter.runtimes.delete(runtime);
        else cardFilter.runtimes.add(runtime);
        chip.classList.toggle('on', cardFilter.runtimes.has(runtime));
      }
      rerenderCardsWithFilter();
    });
  });
  const resetBtn = document.getElementById('cards-filter-reset');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      cardFilter.search = '';
      cardFilter.statuses = new Set(['online', 'stalled', 'offline']);
      cardFilter.runtimes = new Set(['claude_code', 'gemini', 'codex', 'ptah']);
      if (searchEl) searchEl.value = '';
      document.querySelectorAll('.cards-chip').forEach(c => c.classList.add('on'));
      rerenderCardsWithFilter();
    });
  }

  // ────────────────────────────────────────────────────────────────────
  // PLAN-DASHBOARD-OPERATOR-DM Phase A: operator-class DM affordance
  // (Jon-direct via parch #10470; ADR-0040 §4.2 + ADR-0026 v1 extension;
  // PLAN v2 ratified at parch #10507 + secops #10514 Gate (1) re-confirm).
  //
  // sessionStorage holds operator-bearer at Phase 1 (HttpOnly cookie HARD
  // GATE at Phase 2 per secops FLAG-1). XSS-defense: dashboard CSP
  // `default-src 'self'; script-src 'self'` blocks inline scripts +
  // cross-origin script sources; sessionStorage scope is browser-tab.
  // ────────────────────────────────────────────────────────────────────
  const PlexusOperatorDM = (function () {
    const STORAGE_KEY = 'plexus_operator_bearer';
    const STORAGE_OP_KEY = 'plexus_operator_id';
    const loginModal = document.getElementById('dm-login-modal');
    const composeModal = document.getElementById('dm-compose-modal');
    let pendingRecipient = null;  // agent_id captured at click; opened after login

    function getBearer() { return sessionStorage.getItem(STORAGE_KEY) || null; }
    function getOperatorId() { return sessionStorage.getItem(STORAGE_OP_KEY) || null; }
    function setSession(token, opId) {
      sessionStorage.setItem(STORAGE_KEY, token);
      sessionStorage.setItem(STORAGE_OP_KEY, opId);
    }
    function clearSession() {
      sessionStorage.removeItem(STORAGE_KEY);
      sessionStorage.removeItem(STORAGE_OP_KEY);
    }

    function openModal(m) { if (m) { m.classList.add('visible'); m.setAttribute('aria-hidden', 'false'); } }
    function closeModal(m) {
      if (!m) return;
      m.classList.remove('visible');
      m.setAttribute('aria-hidden', 'true');
      // Reset transient state
      const msg = m.querySelector('.dm-modal-msg');
      if (msg) { msg.textContent = ''; msg.className = 'dm-modal-msg'; }
      const inputs = m.querySelectorAll('input, textarea');
      inputs.forEach((i) => { if (i.type === 'password' || i.tagName === 'TEXTAREA') i.value = ''; });
    }

    function openLogin() {
      openModal(loginModal);
      const tokenInput = document.getElementById('dm-login-token');
      if (tokenInput) setTimeout(() => tokenInput.focus(), 50);
    }

    function openCompose(recipientAgentId) {
      if (!getBearer()) {
        pendingRecipient = recipientAgentId;
        openLogin();
        return;
      }
      pendingRecipient = null;
      const recipEl = document.getElementById('dm-compose-recipient');
      const opEl = document.getElementById('dm-compose-operator');
      const bodyEl = document.getElementById('dm-compose-body');
      if (recipEl) recipEl.textContent = '@' + recipientAgentId;
      if (opEl) opEl.textContent = getOperatorId() || '(unknown)';
      composeModal.dataset.recipientAgentId = recipientAgentId;
      if (bodyEl) {
        bodyEl.value = '@' + recipientAgentId + ' ';
        setTimeout(() => { bodyEl.focus(); bodyEl.setSelectionRange(bodyEl.value.length, bodyEl.value.length); }, 50);
      }
      openModal(composeModal);
    }

    async function handleLogin() {
      const tokenInput = document.getElementById('dm-login-token');
      const msgEl = document.getElementById('dm-login-msg');
      const submitBtn = document.getElementById('dm-login-submit');
      if (!tokenInput || !msgEl || !submitBtn) return;
      const token = tokenInput.value.trim();
      if (!token) {
        msgEl.textContent = 'Enter a bearer token.';
        msgEl.className = 'dm-modal-msg error';
        return;
      }
      submitBtn.disabled = true;
      msgEl.textContent = 'Authenticating...';
      msgEl.className = 'dm-modal-msg';
      try {
        const r = await fetch('/dashboard/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        if (r.status === 200) {
          const data = await r.json();
          setSession(token, data.operator_id);
          msgEl.textContent = 'Logged in as ' + data.operator_id;
          msgEl.className = 'dm-modal-msg success';
          setTimeout(() => {
            closeModal(loginModal);
            if (pendingRecipient) {
              const recip = pendingRecipient;
              pendingRecipient = null;
              openCompose(recip);
            }
          }, 400);
        } else if (r.status === 429) {
          msgEl.textContent = 'Too many failed attempts. Try again later.';
          msgEl.className = 'dm-modal-msg error';
        } else {
          msgEl.textContent = 'Invalid credentials.';
          msgEl.className = 'dm-modal-msg error';
        }
      } catch (e) {
        msgEl.textContent = 'Network error. Try again.';
        msgEl.className = 'dm-modal-msg error';
      } finally {
        submitBtn.disabled = false;
      }
    }

    async function handleCompose() {
      const bodyEl = document.getElementById('dm-compose-body');
      const msgEl = document.getElementById('dm-compose-msg');
      const submitBtn = document.getElementById('dm-compose-submit');
      const recipient = composeModal.dataset.recipientAgentId;
      if (!bodyEl || !msgEl || !submitBtn || !recipient) return;
      const body = bodyEl.value.trim();
      if (!body || !body.includes('@' + recipient)) {
        msgEl.textContent = 'Body must include @' + recipient + ' mention.';
        msgEl.className = 'dm-modal-msg error';
        return;
      }
      submitBtn.disabled = true;
      msgEl.textContent = 'Sending...';
      msgEl.className = 'dm-modal-msg';
      try {
        const r = await fetch('/api/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + getBearer(),
          },
          body: JSON.stringify({
            channel: 'dm',
            // sender is ignored — server overrides from operator-bearer per
            // PLAN §2.3 Block-1 sister-canon. Include for shape compliance.
            sender: getOperatorId(),
            body,
            private: true,
          }),
        });
        if (r.status === 201) {
          const data = await r.json();
          msgEl.textContent = 'DM #' + data.message.id + ' sent to @' + recipient;
          msgEl.className = 'dm-modal-msg success';
          setTimeout(() => closeModal(composeModal), 800);
        } else if (r.status === 401) {
          msgEl.textContent = 'Session expired. Logging in again...';
          msgEl.className = 'dm-modal-msg error';
          clearSession();
          setTimeout(() => { closeModal(composeModal); openLogin(); }, 600);
        } else {
          let errMsg = 'Send failed (HTTP ' + r.status + ')';
          try { const j = await r.json(); errMsg = j.message || errMsg; } catch {}
          msgEl.textContent = errMsg;
          msgEl.className = 'dm-modal-msg error';
        }
      } catch (e) {
        msgEl.textContent = 'Network error. Try again.';
        msgEl.className = 'dm-modal-msg error';
      } finally {
        submitBtn.disabled = false;
      }
    }

    // Wire up event handlers (close buttons, submit buttons, Escape key)
    document.querySelectorAll('#dm-login-modal .dm-modal-close, #dm-compose-modal .dm-modal-close')
      .forEach((btn) => btn.addEventListener('click', (e) => {
        const modal = e.target.closest('.dm-modal');
        if (modal) closeModal(modal);
      }));
    document.querySelectorAll('#dm-login-modal .dm-modal-backdrop, #dm-compose-modal .dm-modal-backdrop')
      .forEach((bd) => bd.addEventListener('click', (e) => {
        const modal = e.target.closest('.dm-modal');
        if (modal) closeModal(modal);
      }));
    const loginSubmit = document.getElementById('dm-login-submit');
    if (loginSubmit) loginSubmit.addEventListener('click', handleLogin);
    const composeSubmit = document.getElementById('dm-compose-submit');
    if (composeSubmit) composeSubmit.addEventListener('click', handleCompose);
    // Enter submits login
    const loginInput = document.getElementById('dm-login-token');
    if (loginInput) loginInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); handleLogin(); }
    });
    // Cmd/Ctrl+Enter submits compose
    const composeBody = document.getElementById('dm-compose-body');
    if (composeBody) composeBody.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleCompose(); }
    });
    // Escape closes
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (composeModal && composeModal.classList.contains('visible')) closeModal(composeModal);
        else if (loginModal && loginModal.classList.contains('visible')) closeModal(loginModal);
      }
    });

    return { openCompose, openLogin, getOperatorId, clearSession };
  })();
  // Expose globally for AgentCard click handlers (renderHead injects ✉ DM btn)
  window.PlexusOperatorDM = PlexusOperatorDM;

  // Kick off presence polling (unchanged from v0.5.7).
  poll();
})();
