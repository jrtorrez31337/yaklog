(() => {
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
    agent_id: 'agent_id',
    daemon_state: 'daemon',
    session_state: 'session',
    label: 'label',
    current_model: 'model',
    current_tool: 'tool',
    subagent_active_count: 'subs',
    last_hook_at: 'last hook',
    last_heartbeat_at: 'last heartbeat',
    cursor_position: 'cursor'
  };

  // v0.5.7: shorten model strings for column-width sanity.
  // claude-sonnet-4-6 -> sonnet-4-6; claude-opus-4-7 -> opus-4-7; etc.
  function shortenModel(m) {
    if (!m) return '';
    return m.replace(/^claude-/, '');
  }

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
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null) continue;
        if (k === 'class') node.className = v;
        else if (k === 'title') node.setAttribute('title', v);
        else node.setAttribute(k, v);
      }
    }
    for (const c of children) {
      if (c == null) continue;
      if (typeof c === 'string') node.appendChild(document.createTextNode(c));
      else node.appendChild(c);
    }
    return node;
  }

  function clearChildren(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function makeRow(r) {
    const labelStr = r.label || '';
    const tr = el('tr', { class: 'label-' + labelStr });

    tr.appendChild(el('td', { class: 'agent' }, r.agent_id || ''));
    tr.appendChild(el('td', null, r.daemon_state || ''));
    tr.appendChild(el('td', null, r.session_state || ''));

    const labelTd = el('td', { class: 'label-cell' });
    labelTd.appendChild(el('span', { class: 'badge' }, labelStr));
    tr.appendChild(labelTd);

    // v0.5.7: model column — short form. Pre-v0.5.7 daemons: blank "—".
    const modelStr = shortenModel(r.current_model);
    tr.appendChild(el('td', {
      class: 'model' + (modelStr ? ' has-value' : ''),
      title: r.current_model || 'pre-v0.5.7 daemon, or never reported SessionStart'
    }, modelStr || '—'));

    // v0.5.7: tool column — currently-running tool (Pre→Post). Falls back to
    // last completed tool (with err-coloring) when no tool is currently running.
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

    // v0.5.7: subagent count — show value when >0, otherwise hyphen.
    const subN = r.subagent_active_count;
    const subTd = el('td', {
      class: 'subagents' + (subN > 0 ? ' active' : ''),
      style: 'text-align: right;',
      title: subN == null ? 'pre-v0.5.7 daemon' : `${subN} active subagent dispatch(es)`
    }, subN == null || subN === 0 ? '—' : String(subN));
    tr.appendChild(subTd);

    tr.appendChild(el('td', {
      class: 'ts ' + ageClass(r.last_hook_at),
      title: r.last_hook_at || ''
    }, fmtAge(r.last_hook_at)));

    tr.appendChild(el('td', {
      class: 'ts ' + ageClass(r.last_heartbeat_at),
      title: r.last_heartbeat_at || ''
    }, fmtAge(r.last_heartbeat_at)));

    tr.appendChild(el('td', { class: 'cursor' },
      r.cursor_position == null ? '—' : String(r.cursor_position)));

    return tr;
  }

  function render(payload) {
    // Defensive: hwm badge is optional (older cached dashboard.html lacks it).
    // Don't let a missing element TypeError abort the whole render.
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
      // v0.5.7: stop_failure is a distinct category (sticky red-bordered
      // badge; signals API/rate-limit termination, vs natural-idle stop).
      if (r.label === 'stop_failure' || r.session_state === 'stop_failure') counts.stop_failure++;
      else if (r.label && r.label.startsWith('online')) counts.online++;
      else if (r.label === 'daemon_only') counts.daemon_only++;
      else if (r.label === 'stalled' || r.label === 'unknown') counts.stalled++;
      else if (r.label === 'offline') counts.offline++;
    }
    const countsNode = $('counts');
    clearChildren(countsNode);
    countsNode.appendChild(el('span', { class: 'count online' }, counts.online + ' online'));
    if (counts.daemon_only > 0) {
      countsNode.appendChild(el('span', { class: 'count daemon_only' }, counts.daemon_only + ' daemon_only'));
    }
    countsNode.appendChild(el('span', { class: 'count stalled' }, counts.stalled + ' stalled'));
    if (counts.stop_failure > 0) {
      countsNode.appendChild(el('span', { class: 'count offline', title: 'sessions terminated by API/rate-limit error (v0.5.7)' }, counts.stop_failure + ' stop_failure'));
    }
    countsNode.appendChild(el('span', { class: 'count offline' }, counts.offline + ' offline'));

    const rowsNode = $('rows');
    clearChildren(rowsNode);
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
        setStatus('ok', 'live');
        setBanner(null);
      } else if (res.ok) {
        lastEtag = res.headers.get('ETag');
        lastData = await res.json();
        render(lastData);
        $('last-update').textContent = 'updated ' + new Date().toLocaleTimeString();
        setStatus('ok', 'live');
        setBanner(null);
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

  poll();
})();
