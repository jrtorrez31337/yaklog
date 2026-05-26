(() => {
  // Plan C Stage 4 CP7.1 — /update page renderer.
  // Fetches /api/v1/update/manifest + renders each artifact as a card.
  // Copy buttons stash the install_command to clipboard for one-shot
  // paste into a terminal.

  const $ = (id) => document.getElementById(id);

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k === 'class') node.className = v;
      else node.setAttribute(k, v);
    }
    for (const c of children) {
      if (c == null) continue;
      if (typeof c === 'string') node.appendChild(document.createTextNode(c));
      else node.appendChild(c);
    }
    return node;
  }
  function clearChildren(n) { while (n.firstChild) n.removeChild(n.firstChild); }

  function renderArtifact(a) {
    const card = el('div', { class: 'artifact' });
    const head = el('div', { class: 'artifact-head' });
    head.appendChild(el('span', { class: 'artifact-name' }, a.name));
    head.appendChild(el('span', { class: 'artifact-version' }, a.version || '—'));
    if (a.audience) head.appendChild(el('span', { class: 'artifact-audience' }, a.audience));
    card.appendChild(head);

    const body = el('div', { class: 'artifact-body' });
    const dl = el('dl');
    if (a.description) {
      dl.appendChild(el('dt', null, 'description'));
      dl.appendChild(el('dd', null, a.description));
    }
    if (a.source_repo || a.source_path) {
      dl.appendChild(el('dt', null, 'source'));
      const src = (a.source_repo || '') + (a.source_path ? ' / ' + a.source_path : '');
      dl.appendChild(el('dd', null, src));
    }
    if (a.changed_in) {
      dl.appendChild(el('dt', null, 'changed in'));
      dl.appendChild(el('dd', null, a.changed_in));
    }
    if (a.install_command) {
      dl.appendChild(el('dt', null, 'install'));
      const dd = el('dd');
      const row = el('div', { class: 'copy-row' });
      const pre = el('pre', null, a.install_command);
      const btn = el('button', { class: 'copy-btn', type: 'button' }, 'copy');
      btn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(a.install_command);
          btn.textContent = 'copied';
          btn.classList.add('copied');
          setTimeout(() => { btn.textContent = 'copy'; btn.classList.remove('copied'); }, 1500);
        } catch (e) {
          btn.textContent = 'copy failed';
          setTimeout(() => { btn.textContent = 'copy'; }, 1500);
        }
      });
      row.appendChild(pre);
      row.appendChild(btn);
      dd.appendChild(row);
      dl.appendChild(dd);
    }
    body.appendChild(dl);
    card.appendChild(body);
    return card;
  }

  async function load() {
    const host = $('artifacts');
    try {
      const res = await fetch('/api/v1/update/manifest', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const m = await res.json();
      clearChildren(host);
      $('generated-at').textContent = 'generated ' + new Date(m.generated_at).toLocaleString();
      for (const a of (m.artifacts || [])) {
        host.appendChild(renderArtifact(a));
      }
    } catch (e) {
      clearChildren(host);
      host.appendChild(el('div', { id: 'error' }, 'failed to load manifest: ' + e.message));
    }
  }

  load();
})();
