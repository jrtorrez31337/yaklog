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

  function fmtAge(iso) {
    if (!iso) return '—';
    const ms = Date.now() - new Date(iso).getTime();
    if (Number.isNaN(ms)) return iso;
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
    const ms = Date.now() - new Date(iso).getTime();
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
    for (const r of payload.presence) {
      if (r.label === 'stop_failure' || r.session_state === 'stop_failure') counts.stop_failure++;
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
      setBanner('yaklog server unreachable: ' + e.message + ' — retry in ' + (backoff / 1000) + 's');
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
    pollTimer = setTimeout(poll, backoff);
  }

  // CP6.3: 1s ticker re-renders cards so "last hook age" / freshness
  // counters tick without a server roundtrip.
  setInterval(() => { if (lastData) renderCards(lastData.presence); }, 1000);

  // ────────────────────────────────────────────────────────────────────
  // CP2: tab navigation (URL-fragment-persisted; #live default / #cost).
  // ────────────────────────────────────────────────────────────────────
  function activateTab(name) {
    if (!['live', 'cost', 'bus', 'audit', 'register'].includes(name)) name = 'live';
    document.querySelectorAll('.tab-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === name);
    });
    document.querySelectorAll('.tab-panel').forEach(p => {
      p.classList.toggle('active', p.dataset.tab === name);
    });
    if (location.hash !== '#' + name) {
      history.replaceState(null, '', '#' + name);
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
  }
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.addEventListener('click', () => activateTab(b.dataset.tab));
  });
  window.addEventListener('hashchange', () => activateTab(location.hash.slice(1)));
  activateTab(location.hash.slice(1) || 'live');

  // ────────────────────────────────────────────────────────────────────
  // CP2: PlexusChart — wraps uPlot with template-name + auto-refresh +
  // Prom-matrix → uPlot data conversion + multi-series legend.
  // ────────────────────────────────────────────────────────────────────

  // CP5: chart refresh cadence + lookback now owned server-side by
  // plexusStreamer.js (which polls Prom + pushes to SSE subscribers).
  // No client-side polling constants needed anymore.

  // Color palette for series. Cycles through a Plexus-themed set.
  const CHART_COLORS = [
    '#60a5fa', '#4ade80', '#facc15', '#c084fc', '#f472b6',
    '#f87171', '#22d3ee', '#a78bfa', '#fb923c', '#84cc16',
  ];
  function seriesColor(i) { return CHART_COLORS[i % CHART_COLORS.length]; }

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
      seriesDefs.push({
        label: seriesLabel(s.metric, otherFields, omitAgentPrefix),
        stroke: seriesColor(idx),
        width: 1.5,
        spanGaps: false,
        // uPlot value formatter for legend hover
        value: (u, v) => v == null ? '—' : v.toFixed(4),
      });
      seriesData.push(valuesAligned);
      agentIds.push(s.metric.plexus_agent_id || null);
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
            { stroke: '#8a93a6', grid: { stroke: 'rgba(255,255,255,0.04)' }, size: 56 },
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
      // 'connecting' (initial / reconnecting) | 'open' | 'error'
      this.state = 'connecting';
      this.lastFrameMs = 0;
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
      if (this.reconnectTimer) return;
      const delay = Math.min(30000, 1000 * Math.pow(2, this.reconnectAttempt));
      this.reconnectAttempt++;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (this.es) { try { this.es.close(); } catch {} ; this.es = null; }
        this.connect();
      }, delay);
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
  const otelServiceByAgent = new Map();
  const SERVICE_TO_RUNTIME = {
    'claude-code': 'claude_code',
    'gemini-cli': 'gemini',
  };
  const OTEL_LIVE_WINDOW_MS = 10 * 60 * 1000;   // 10 min = "recently emitted"
  function noteFrameOtelAgents(payload) {
    const now = Date.now();
    const result = payload && payload.data && payload.data.result;
    if (!result) return;
    for (const s of result) {
      const id = s.metric && s.metric.plexus_agent_id;
      if (id) otelLastSeen.set(id, now);
      const svc = s.metric && s.metric.service_name;
      if (id && svc) otelServiceByAgent.set(id, svc);
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
    _origOnFrame.call(this, payload);
    wireChartLegendPopovers(this);
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
    byAccount: _restored.byAccount ?? null,
    by: _restored.by || 'agent',
    lastFrameMs: _restored.lastFrameMs || 0,
  } : {
    today: null, sevend: null, mtd: null,
    topAgents: null, byAccount: null,
    by: 'agent',
    lastFrameMs: 0,
  };
  const fmtUSD = (v) => {
    if (v == null || Number.isNaN(v)) return '—';
    if (v >= 1000) return '$' + v.toFixed(0);
    if (v >= 1)    return '$' + v.toFixed(2);
    return '$' + v.toFixed(4);
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
    if (!result || result.length === 0) {
      body.appendChild(el('div', { class: 'chart-empty', style: 'padding: 20px 0;' }, `no ${acctState.by} cost data`));
      return;
    }
    const labelFor = (m) => acctState.by === 'agent'
      ? (m.plexus_agent_id || '(unknown)')
      : (m.user_email || m.user_account_id || '(unknown)');
    const rows = result.map(s => ({
      name: labelFor(s.metric),
      cost: parseFloat(s.value[1]) || 0,
    })).sort((a, b) => b.cost - a.cost);
    const max = rows[0].cost || 1;
    const table = el('table');
    const tbody = el('tbody');
    for (const r of rows) {
      const tr = el('tr');
      tr.appendChild(el('td', { class: 'driver-name' }, r.name));
      const barTd = el('td', { class: 'driver-bar-wrap' });
      const bar = el('div', { class: 'driver-bar' });
      const fill = el('div', { class: 'driver-bar-fill' });
      fill.style.width = ((r.cost / max) * 100).toFixed(1) + '%';
      bar.appendChild(fill); barTd.appendChild(bar); tr.appendChild(barTd);
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

  const VIEW_LABELS = ['Live', 'Activity', 'Cost', 'Identity', 'Runtime'];
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
      this.dotsEl = el('div', { class: 'agent-card-dots' });
      this.el.appendChild(this.headEl);
      this.el.appendChild(this.bodyEl);
      this.el.appendChild(this.dotsEl);
      this._buildDots();
    }
    _buildDots() {
      for (let i = 0; i < VIEW_LABELS.length; i++) {
        const btn = el('button', {
          type: 'button',
          'data-view': String(i),
          'data-view-label': VIEW_LABELS[i],
          'aria-label': `${VIEW_LABELS[i]} view`,
        }, i === 0 ? '●' : '○');
        if (i === 0) btn.classList.add('active');
        btn.addEventListener('click', () => this.setView(i));
        this.dotsEl.appendChild(btn);
      }
    }
    setView(idx) {
      if (idx === this.currentView) return;
      this.currentView = idx;
      const dots = this.dotsEl.querySelectorAll('button');
      dots.forEach((b, i) => {
        b.textContent = (i === idx) ? '●' : '○';
        b.classList.toggle('active', i === idx);
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
      // v0.5.8.2: runtime badge — OTel-derived first, server registry fallback.
      const runtime = resolveRuntime(this.agentId, r);
      const badge = runtime && runtimeBadge(runtime);
      if (badge) this.headEl.appendChild(badge);
      this.headEl.appendChild(el('span', { class: 'name' }, r.agent_id || this.agentId));
      const lbl = r.label || '';
      this.headEl.appendChild(el('span', {
        class: 'label-badge label-' + lbl,
        title: `daemon=${r.daemon_state || '?'} · session=${r.session_state || '?'}`,
      }, lbl));
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
        const tip = `daemon is pre-v${r.canonical_daemon_version || '0.5.7.4'} (pre-version-reporting); re-pull yaklog-sub from /update`;
        pills.appendChild(el('span', {
          class: 'stale-pill',
          title: tip,
        }, 'stale daemon'));
      }
      this.headEl.appendChild(pills);
      // CP6.5: status-color left border + dimmed offline cards
      // Strip prior status- classes, add the current one
      this.el.className = 'agent-card';
      if (r.label) this.el.classList.add('status-' + r.label);
      if (r.label === 'offline') this.el.classList.add('is-offline');
    }
    rerenderBody() {
      switch (this.currentView) {
        case 0: this._renderLive(); break;
        case 1: this._renderActivity(); break;
        case 2: this._renderCost(); break;
        case 3: this._renderIdentity(); break;
        case 4: this._renderRuntime(); break;
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
    }
    // CP6.10: Runtime view — technical detail for SREs / debuggers.
    // Four sections:
    //   1. Daemon process    pid / version / started_at / hostname / uid / gid
    //   2. Runtime fingerprint   OTel: CC version / os / arch / terminal /
    //                            service_name / query_source (moved here from
    //                            Identity per Jon-direct 2026-05-26)
    //   3. CC session            cwd / model / source / current_tool /
    //                            last_tool_name / last_tool_status
    //   4. Yaklog wire state     events_consumer_count / sse_connected /
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

      // ── Section 4: Yaklog wire state ─────────────────────────
      this.bodyEl.appendChild(el('h4', null, 'Yaklog wire state'));
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
  }

  // CP6.5: history-window toggle (1h / 6h / 24h / 7d).
  // Triggers rerender of any card currently showing Activity or Cost view.
  document.querySelectorAll('#cards-window-toggle button').forEach((btn) => {
    btn.addEventListener('click', () => {
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

  // CP8.3 (2026-05-27): card-grid filter state. Pure-client filter applied
  // in renderCards (cards re-render every presence poll = filter naturally
  // re-applies). All on by default.
  const cardFilter = {
    search: '',
    statuses: new Set(['online', 'stalled', 'offline']),
    runtimes: new Set(['claude_code', 'gemini', 'codex']),
  };
  function statusBucket(label) {
    if (!label) return 'offline';
    if (label.startsWith('online') || label === 'compacting' || label === 'stop_failure') return 'online';
    if (label === 'stalled') return 'stalled';
    return 'offline';   // includes 'offline', 'daemon_only', 'unknown', anything else
  }
  function passesCardFilter(r) {
    const q = cardFilter.search.trim().toLowerCase();
    if (q && !((r.agent_id || '').toLowerCase().includes(q))) return false;
    if (!cardFilter.statuses.has(statusBucket(r.label))) return false;
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
        for (const r of rows) {
          const tr = el('tr');
          if (r.rate && r.rate.ratio >= ANOMALY_RATIO) tr.classList.add('cost-anomaly');
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
          seriesDefs.push({
            label: labelStr,
            stroke: CHART_COLORS[idx % CHART_COLORS.length],
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
            { stroke: '#8a93a6', grid: { stroke: 'rgba(255,255,255,0.04)' }, size: 64 },
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
      this.refreshTimer = setInterval(() => this.refresh().catch(() => {}), COST_REFRESH_MS);
    }
    stop() {
      if (this.refreshTimer) clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  // Lazy-init Cost view on first activation (don't burn Prom queries unless
  // the user is actually looking at the Cost tab).
  let costView = null;
  function ensureCostView() {
    if (costView) return;
    costView = new CostView();
    bindOpts('#cost-dim-opts',    () => costView.refresh().catch(() => {}));
    bindOpts('#cost-window-opts', () => costView.refresh().catch(() => {}));
    costView.start();
  }
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.addEventListener('click', () => { if (b.dataset.tab === 'cost') ensureCostView(); });
  });
  window.addEventListener('hashchange', () => { if (location.hash === '#cost') ensureCostView(); });
  if (location.hash === '#cost') ensureCostView();

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
  // Ticker is whitelist (don't pollute the always-on Live-tab view with everything):
  const BUS_TICKER_WHITELIST = new Set(['handoff', 'status']);

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
      this.state = 'idle';             // idle | connecting | open | error
      this.lastFrameMs = 0;
      this.channelCounts = new Map();  // channel → count seen
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
      setTimeout(() => this._openSse(), 4000);
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
    _notifyState() {
      for (const sub of this.subscribers) sub.onState?.(this.state);
    }
    knownChannels() {
      return [...this.channelCounts.entries()].sort((a, b) => b[1] - a[1]);
    }
  }
  const busStream = new BusStream();

  // ── Ticker view (Live tab; always-on; whitelist filter; compact) ─────
  const tickerPane = document.getElementById('ticker-pane');
  const tickerMeta = document.getElementById('ticker-meta');
  if (tickerPane) {
    const renderTicker = () => {
      const filtered = busStream.buffer
        .filter(m => BUS_TICKER_WHITELIST.has(m.channel))
        .slice(-BUS_TICKER_DISPLAY);
      clearChildren(tickerPane);
      if (filtered.length === 0) {
        tickerPane.appendChild(el('div', { class: 'bus-empty' }, 'no recent #handoff / #status traffic'));
      } else {
        // Newest first
        for (const m of filtered.reverse()) tickerPane.appendChild(busRow(m));
      }
      if (tickerMeta) tickerMeta.textContent = `last ${filtered.length} · ${busStream.buffer.length} buffered · #handoff + #status only`;
    };
    busStream.subscribe({
      onBackfill: () => renderTicker(),
      onAdd: (m) => { if (BUS_TICKER_WHITELIST.has(m.channel)) renderTicker(); },
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
    const meta = el('div', { class: 'chan-cluster-meta' });
    if (!isSelf) {
      const senderEl = el('span', { class: 'sender-name' }, first.sender || '?');
      meta.appendChild(senderEl);
    }
    const tEl = el('span', { class: 'cluster-time' }, fmtClock(parseIso(first.created_at)));
    meta.appendChild(tEl);
    cluster.appendChild(meta);
    for (const m of msgs) {
      const bubble = el('div', {
        class: 'chan-bubble ' + (isSelf ? 'from-self' : 'from-other') + (m.private ? ' private' : ''),
        title: `#${m.id} · ${m.created_at || ''}`,
      });
      bubble.appendChild(el('span', { class: 'bubble-id' }, '#' + m.id));
      bubble.appendChild(renderBodyWithMentions(m.body || '', m.mentions || []));
      cluster.appendChild(bubble);
    }
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

    async function loadThread(channel) {
      clearChildren(bodyEl);
      bodyEl.appendChild(el('div', { class: 'chan-empty' }, `loading #${channel}…`));
      try {
        const r = await fetch(`/api/v1/plexus/public/messages?channel=${encodeURIComponent(channel)}&limit=${THREAD_PAGE_LIMIT}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        renderThread(bodyEl, j.messages || []);
      } catch (err) {
        clearChildren(bodyEl);
        bodyEl.appendChild(el('div', { class: 'chan-empty' }, `failed to load #${channel}: ${err.message}`));
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
      cardFilter.runtimes = new Set(['claude_code', 'gemini', 'codex']);
      if (searchEl) searchEl.value = '';
      document.querySelectorAll('.cards-chip').forEach(c => c.classList.add('on'));
      rerenderCardsWithFilter();
    });
  }

  // Kick off presence polling (unchanged from v0.5.7).
  poll();
})();
