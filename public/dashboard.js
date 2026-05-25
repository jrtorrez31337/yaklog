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
    agent_id: 'agent_id', daemon_state: 'daemon', session_state: 'session',
    label: 'label', current_model: 'model', current_tool: 'tool',
    subagent_active_count: 'subs', last_hook_at: 'last hook',
    last_heartbeat_at: 'last heartbeat', cursor_position: 'cursor',
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

  function makeRow(r) {
    const labelStr = r.label || '';
    const tr = el('tr', { class: 'label-' + labelStr });
    tr.appendChild(el('td', { class: 'agent' }, r.agent_id || ''));
    tr.appendChild(el('td', null, r.daemon_state || ''));
    tr.appendChild(el('td', null, r.session_state || ''));
    const labelTd = el('td', { class: 'label-cell' });
    labelTd.appendChild(el('span', { class: 'badge' }, labelStr));
    tr.appendChild(labelTd);
    const modelStr = shortenModel(r.current_model);
    tr.appendChild(el('td', {
      class: 'model' + (modelStr ? ' has-value' : ''),
      title: r.current_model || 'pre-v0.5.7 daemon, or never reported SessionStart',
    }, modelStr || '—'));
    const toolTd = el('td', { class: 'tool' });
    if (r.current_tool) {
      toolTd.classList.add('has-value');
      toolTd.appendChild(el('span', { class: 'pill', title: 'currently running' }, r.current_tool));
    } else if (r.last_tool_name) {
      toolTd.classList.add('has-value');
      if (r.last_tool_status === 'error') toolTd.classList.add('error');
      toolTd.setAttribute('title', `last tool (${r.last_tool_status || '?'})`);
      toolTd.appendChild(document.createTextNode(r.last_tool_name));
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
    tr.appendChild(el('td', {
      class: 'ts ' + ageClass(r.last_hook_at),
      title: r.last_hook_at || '',
    }, fmtAge(r.last_hook_at)));
    tr.appendChild(el('td', {
      class: 'ts ' + ageClass(r.last_heartbeat_at),
      title: r.last_heartbeat_at || '',
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

    const rowsNode = $('rows'); clearChildren(rowsNode);
    for (const r of rows) rowsNode.appendChild(makeRow(r));

    document.querySelectorAll('#thead-row th[data-sort]').forEach(th => {
      const k = th.getAttribute('data-sort');
      clearChildren(th);
      th.appendChild(document.createTextNode(COLUMN_LABELS[k] || k));
      if (k === sort.key) {
        th.appendChild(document.createTextNode(' '));
        th.appendChild(el('span', { class: 'arrow' }, sort.dir === 'desc' ? '▼' : '▲'));
      }
    });
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

  document.querySelectorAll('#thead-row th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const k = th.getAttribute('data-sort');
      if (sort.key === k) sort.dir = sort.dir === 'desc' ? 'asc' : 'desc';
      else { sort.key = k; sort.dir = 'desc'; }
      if (lastData) render(lastData);
    });
  });

  setInterval(() => { if (lastData) render(lastData); }, 1000);

  // ────────────────────────────────────────────────────────────────────
  // CP2: tab navigation (URL-fragment-persisted; #live default / #cost).
  // ────────────────────────────────────────────────────────────────────
  function activateTab(name) {
    if (!['live', 'cost'].includes(name)) name = 'live';
    document.querySelectorAll('.tab-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === name);
    });
    document.querySelectorAll('.tab-panel').forEach(p => {
      p.classList.toggle('active', p.dataset.tab === name);
    });
    if (location.hash !== '#' + name) {
      history.replaceState(null, '', '#' + name);
    }
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

  const CHART_REFRESH_MS = 15000;        // matches Prom scrape interval
  const CHART_LOOKBACK_S = 3600;          // 1h default window
  const CHART_STEP = '15s';

  // Color palette for series. Cycles through a Plexus-themed set.
  const CHART_COLORS = [
    '#60a5fa', '#4ade80', '#facc15', '#c084fc', '#f472b6',
    '#f87171', '#22d3ee', '#a78bfa', '#fb923c', '#84cc16',
  ];
  function seriesColor(i) { return CHART_COLORS[i % CHART_COLORS.length]; }

  // Build the human-readable legend label for a Prom series given its metric labels.
  // Strategy: agent first; then any other interesting labels.
  function seriesLabel(metric, otherFields) {
    const agent = metric.plexus_agent_id || '(no agent)';
    const tail = (otherFields || [])
      .map(f => metric[f])
      .filter(v => v != null && v !== '')
      .join(' · ');
    return tail ? `${agent} · ${tail}` : agent;
  }

  // Convert Prom matrix result → uPlot data shape.
  // Prom matrix per-series: { metric: {…labels}, values: [[ts_seconds, "value_string"], …] }
  // uPlot wants: [ [t0, t1, …], [s0_v0, s0_v1, …], [s1_v0, s1_v1, …], … ]
  // Series timestamps may differ; we unify on the sorted union, fill missing as null.
  function promMatrixToUplot(result, otherFields) {
    if (!result || result.length === 0) return { data: [[]], series: [{ label: 'time' }] };

    const tsSet = new Set();
    for (const s of result) for (const [t] of s.values) tsSet.add(t);
    const tsList = [...tsSet].sort((a, b) => a - b);
    const tsIndex = new Map(tsList.map((t, i) => [t, i]));

    const seriesDefs = [{ label: 'time' }];
    const seriesData = [tsList];

    result.forEach((s, idx) => {
      const valuesAligned = new Array(tsList.length).fill(null);
      for (const [t, v] of s.values) {
        const parsed = parseFloat(v);
        valuesAligned[tsIndex.get(t)] = Number.isFinite(parsed) ? parsed : null;
      }
      seriesDefs.push({
        label: seriesLabel(s.metric, otherFields),
        stroke: seriesColor(idx),
        width: 1.5,
        spanGaps: false,
        // uPlot value formatter for legend hover
        value: (u, v) => v == null ? '—' : v.toFixed(4),
      });
      seriesData.push(valuesAligned);
    });
    return { data: seriesData, series: seriesDefs };
  }

  class PlexusChart {
    constructor(cardEl, opts) {
      this.cardEl = cardEl;
      this.bodyEl = cardEl.querySelector('.chart-card-body');
      this.statusEl = cardEl.querySelector('[data-chart-status]');
      this.template = opts.template;
      this.params = opts.params || {};
      this.otherFields = opts.otherFields || [];   // extra labels for legend
      this.valueFmt = opts.valueFmt || ((v) => v.toFixed(3));
      this.uplot = null;
      this.refreshTimer = null;
    }
    async start() {
      await this.refresh();
      this.refreshTimer = setInterval(() => this.refresh().catch(() => {}), CHART_REFRESH_MS);
    }
    stop() {
      if (this.refreshTimer) clearInterval(this.refreshTimer);
      this.refreshTimer = null;
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
    }
    renderError(msg) {
      clearChildren(this.bodyEl);
      this.bodyEl.appendChild(el('div', { class: 'chart-error' }, msg));
      if (this.uplot) { this.uplot.destroy(); this.uplot = null; }
    }
    async refresh() {
      try {
        const to = Math.floor(Date.now() / 1000);
        const from = to - CHART_LOOKBACK_S;
        const qs = new URLSearchParams({
          template: this.template,
          ...this.params,
          from: String(from),
          to: String(to),
          step: CHART_STEP,
        });
        const res = await fetch('/api/v1/plexus/public/query_range?' + qs.toString(), { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const cacheHdr = res.headers.get('X-Plexus-Cache');
        const body = await res.json();
        if (body.status !== 'success') throw new Error(body.error || 'prom returned non-success');

        const result = body.data && body.data.result;
        if (!result || result.length === 0) {
          this.renderEmpty('no data in window (no opted-in agents pushing?)');
          this.setStatus(`empty · ${new Date().toLocaleTimeString()}`);
          return;
        }

        const { data, series } = promMatrixToUplot(result, this.otherFields);
        if (this.uplot) {
          this.uplot.setData(data);
        } else {
          clearChildren(this.bodyEl);
          this.uplot = new uPlot({
            width: this.bodyEl.clientWidth - 8,
            height: 220,
            series,
            scales: { x: { time: true } },
            axes: [
              { stroke: 'var(--muted)', grid: { stroke: 'rgba(255,255,255,0.04)' } },
              { stroke: 'var(--muted)', grid: { stroke: 'rgba(255,255,255,0.04)' }, size: 56 },
            ],
            legend: { live: true },
            cursor: { drag: { x: true, y: false } },
          }, data, this.bodyEl);
        }
        this.setStatus(`${result.length} series · ${cacheHdr || '—'} · ${new Date().toLocaleTimeString()}`);
      } catch (e) {
        this.renderError('error: ' + e.message);
        this.setStatus('error', true);
      }
    }
    resize() {
      if (!this.uplot) return;
      this.uplot.setSize({ width: this.bodyEl.clientWidth - 8, height: 220 });
    }
  }

  // Instantiate the 3 Live-tab charts.
  const charts = [
    new PlexusChart(document.querySelector('[data-chart="tokens"]'), {
      template: 'tokens.rate.byAgent',
      otherFields: ['model', 'type'],
      valueFmt: (v) => v.toFixed(2) + ' tok/s',
    }),
    new PlexusChart(document.querySelector('[data-chart="cost"]'), {
      template: 'cost.rate.byAgent',
      otherFields: ['model'],
      valueFmt: (v) => '$' + v.toFixed(6) + '/s',
    }),
    new PlexusChart(document.querySelector('[data-chart="sessions"]'), {
      template: 'session.count.byAgent',
      otherFields: [],
      valueFmt: (v) => String(Math.round(v)),
    }),
  ];
  for (const c of charts) c.start();

  // Resize charts on window resize.
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { for (const c of charts) c.resize(); }, 100);
  });

  // Kick off presence polling (unchanged from v0.5.7).
  poll();
})();
