// Site Auditor dashboard. Plain script (CSP: script-src 'self'). Untrusted values are always set via textContent;
// only server-rendered, server-escaped HTML (report body, fix panel, tracking) is assigned with innerHTML.
(() => {
  const $ = (id) => document.getElementById(id);
  const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];
  /** replaceChildren that ignores null / false placeholders. */
  const fill = (el, ...kids) => el.replaceChildren(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));

  /** Tiny DOM builder: h('a', { class: 'x', href: '#', onclick: fn }, 'text', child) */
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    return el;
  }

  async function api(path, opts = {}) {
    const init = { ...opts };
    if (opts.json !== undefined) {
      init.method = init.method || 'POST';
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(opts.json);
      delete init.json;
    }
    const res = await fetch(path, init);
    const body = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
    if (!res.ok) throw new Error((body && body.error) || `Request failed (${res.status})`);
    return body;
  }

  function toast(msg, isErr = false) {
    const t = h('div', { class: `toast${isErr ? ' err' : ''}`, role: isErr ? 'alert' : 'status', text: msg });
    $('toasts').append(t);
    setTimeout(() => t.remove(), 3800);
  }

  function confirmDialog(title, text, okLabel = 'Delete') {
    const dlg = $('confirm');
    $('confirm-title').textContent = title;
    $('confirm-text').textContent = text;
    $('confirm-ok').textContent = okLabel;
    dlg.returnValue = '';
    dlg.showModal();
    return new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true }));
  }

  // ---------- formatting ----------
  const hostOf = (url) => {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  };
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  function ago(iso) {
    const s = (Date.parse(iso) - Date.now()) / 1000;
    const abs = Math.abs(s);
    if (abs < 60) return rtf.format(Math.round(s), 'second');
    if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute');
    if (abs < 86400) return rtf.format(Math.round(s / 3600), 'hour');
    if (abs < 86400 * 30) return rtf.format(Math.round(s / 86400), 'day');
    return new Date(iso).toLocaleDateString();
  }
  const scoreClass = (s) => (s == null ? 'na' : s >= 75 ? 'good' : s >= 50 ? 'mid' : 'bad');
  const gradeLabel = (s) => (s >= 90 ? 'Excellent' : s >= 75 ? 'Good' : s >= 60 ? 'Needs attention' : s >= 40 ? 'Poor' : 'Critical');
  const scoreBadge = (summary) => h('span', { class: `score ${scoreClass(summary?.score)}`, title: summary ? `${gradeLabel(summary.score)} · grade ${summary.grade}` : 'Not available', text: summary ? summary.score : '—' });
  function sevPills(summary) {
    if (!summary) return h('span', { class: 'muted', text: '—' });
    if (!summary.counts.verified) return h('span', { class: 'pill ok', text: 'No issues' });
    return h(
      'div',
      { class: 'findings' },
      summary.counts.High ? h('span', { class: 'pill h', text: `${summary.counts.High} High` }) : null,
      summary.counts.Medium ? h('span', { class: 'pill m', text: `${summary.counts.Medium} Med` }) : null,
      summary.counts.Low ? h('span', { class: 'pill l', text: `${summary.counts.Low} Low` }) : null,
    );
  }
  function statusPill(item) {
    if (item.status === 'running') return h('span', { class: 'pill run', text: 'Running' });
    if (item.status === 'queued') return h('span', { class: 'pill run', text: 'Queued' });
    if (item.status === 'failed') return h('span', { class: 'pill h', title: item.error || '', text: 'Failed' });
    const map = { Open: 'grey', 'In Progress': 'run', Resolved: 'ok', 'Unable to Verify': 'm' };
    return h('span', { class: `pill ${map[item.reportStatus] || 'grey'}`, text: item.reportStatus || 'Open' });
  }
  function ring(score, size = 108, label = 'HEALTH') {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 120 120');
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', score == null ? 'No score' : `Health score ${score} of 100`);
    const r = 50;
    const c = 2 * Math.PI * r;
    const mk = (tag, attrs) => {
      const el = document.createElementNS(ns, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      svg.append(el);
      return el;
    };
    mk('circle', { cx: 60, cy: 60, r, fill: 'none', stroke: '#e5e9f0', 'stroke-width': 11 });
    const color = { good: '#16a34a', mid: '#d97706', bad: '#dc2626', na: '#94a3b8' }[scoreClass(score)];
    mk('circle', { cx: 60, cy: 60, r, fill: 'none', stroke: color, 'stroke-width': 11, 'stroke-linecap': 'round', 'stroke-dasharray': c.toFixed(1), 'stroke-dashoffset': (c * (1 - (score ?? 0) / 100)).toFixed(1), transform: 'rotate(-90 60 60)' });
    mk('text', { x: 60, y: 62, 'text-anchor': 'middle', class: 'num' }).textContent = score ?? '—';
    mk('text', { x: 60, y: 82, 'text-anchor': 'middle', class: 'lbl' }).textContent = label;
    return svg;
  }

  // ---------- state ----------
  const state = {
    branding: null,
    list: { page: 1, pageSize: 20, q: '', view: 'active', status: '', lead: '', selected: new Set(), items: [] },
    currentId: null,
    currentJob: null,
    pollId: null,
  };
  let pollTimer = null;
  let trackTimer = null;
  let engineTimer = null;

  // ---------- branding ----------
  function applyBranding(b) {
    state.branding = b;
    if (/^#[0-9a-f]{6}$/i.test(b.accent)) document.documentElement.style.setProperty('--accent', b.accent);
    const brand = $('side-brand');
    fill(brand, b.logo ? h('img', { src: b.logo, alt: b.agencyName }) : h('span', { class: 'mark', 'aria-hidden': 'true' }), b.logo ? null : h('span', { text: b.agencyName }));
    document.title = `${b.agencyName} — Site Auditor`;
  }
  async function loadBranding() {
    try {
      applyBranding((await api('/api/settings')).branding);
    } catch {
      /* defaults stay */
    }
  }

  async function refreshEngine() {
    clearTimeout(engineTimer);
    try {
      const { queue } = await api('/api/investigations?page=1&pageSize=1&view=all');
      const busy = queue.running + queue.queued;
      $('engine-dot').className = `dot${busy ? ' busy' : ''}`;
      $('engine-text').textContent = busy ? `${queue.running} running · ${queue.queued} queued` : 'Engine ready';
      engineTimer = setTimeout(refreshEngine, busy ? 3000 : 15000);
    } catch {
      engineTimer = setTimeout(refreshEngine, 15000);
    }
  }

  // ---------- routing ----------
  const TITLES = { dashboard: ['Workspace', 'Dashboard'], new: ['Audits', 'New website audit'], reports: ['Audits', 'Reports'], report: ['Reports', 'Report'], settings: ['Workspace', 'Branding & settings'] };
  function showView(name) {
    for (const s of qsa('[data-view]')) s.hidden = s.dataset.view !== name;
    for (const a of qsa('[data-nav]')) a.classList.toggle('on', a.dataset.nav === name || (name === 'report' && a.dataset.nav === 'reports'));
    const [crumb, title] = TITLES[name] || TITLES.dashboard;
    $('crumb').textContent = crumb;
    $('page-title').textContent = title;
    $('top-new').hidden = name === 'new';
    $('sidebar').classList.remove('open');
    if (name !== 'report') {
      clearTimeout(trackTimer);
      state.currentId = null;
    }
  }

  function route() {
    const hash = location.hash.replace(/^#\/?/, '');
    if (/^[0-9a-f-]{36}$/.test(hash)) return void history.replaceState(null, '', `#/report/${hash}`), route();
    const [name, arg] = hash.split('/');
    window.scrollTo(0, 0);
    if (name === 'report' && /^[0-9a-f-]{36}$/.test(arg || '')) return openReport(arg);
    if (name === 'new') {
      showView('new');
      if (!state.pollId) {
        $('progress').hidden = true;
        $('start').hidden = false;
        setTimeout(() => $('url').focus(), 30);
      }
      return;
    }
    if (name === 'reports') {
      showView('reports');
      return loadReports();
    }
    if (name === 'settings') {
      showView('settings');
      return fillSettings();
    }
    showView('dashboard');
    return renderDashboard();
  }

  // ---------- dashboard ----------
  async function renderDashboard() {
    let stats;
    let recent;
    try {
      [stats, recent] = await Promise.all([api('/api/stats'), api('/api/investigations?page=1&pageSize=6&view=active')]);
    } catch (e) {
      toast(e.message, true);
      return;
    }
    $('setup-banner').hidden = !!stats.brandingComplete;
    const kpi = (k, v, s, cls = '') => h('div', { class: `kpi ${cls}` }, h('div', { class: 'k', text: k }), h('div', { class: 'v', text: v }), h('div', { class: 's', text: s }));
    fill($('kpis'), 
      kpi('Reports generated', stats.reports, `${stats.last7Days} in the last 7 days`),
      kpi('Websites analysed', stats.sites, `${stats.completed} completed audits`),
      kpi('Verified issues found', stats.issues.total, `${stats.issues.High} high priority`, stats.issues.High ? 'bad' : ''),
      kpi('Average health score', stats.averageScore ?? '—', stats.averageScore == null ? 'No audits yet' : gradeLabel(stats.averageScore)),
      kpi('Security threats', stats.securityThreats, 'Sites with malware / blacklist signs', stats.securityThreats ? 'bad' : ''),
    );
    const STAGE_CLS = { New: 'grey', Contacted: 'run', 'Proposal sent': 'm', Won: 'ok', Lost: 'h' };
    fill($('pipeline'), ...Object.entries(stats.pipeline).map(([stage, n]) => h('a', { class: `stage ${STAGE_CLS[stage] || ''}`, href: '#/reports', onclick: () => {
      state.list.lead = stage;
      $('lead-filter').value = stage;
    } }, h('b', { text: n }), h('span', { text: stage }))));
    $('share-stat').textContent = stats.shared.links ? `${stats.shared.links} shared report${stats.shared.links === 1 ? '' : 's'} · opened ${stats.shared.views}×` : 'Share a report link to see when prospects open it';

    const max = Math.max(1, ...stats.activity.map((a) => a.count));
    fill($('activity'), 
      ...stats.activity.map((a) => {
        const bar = h('i', { title: `${a.count} audit${a.count === 1 ? '' : 's'} on ${a.date}` });
        bar.style.height = `${Math.max(3, (a.count / max) * 100)}%`;
        return h('div', { class: `b${a.count ? '' : ' zero'}` }, bar, h('span', { text: a.date.slice(8) }));
      }),
    );

    const { High, Medium, Low, total } = stats.issues;
    const seg = (cls, n) => {
      const i = h('i', { class: cls, title: `${n}` });
      i.style.width = total ? `${(n / total) * 100}%` : '0';
      return i;
    };
    fill($('sevbar'), seg('h', High), seg('m', Medium), seg('l', Low));
    const leg = (label, n, color) => {
      const dot = h('i');
      dot.style.background = color;
      return h('li', {}, dot, label, h('b', { text: n }));
    };
    fill($('sev-legend'), leg('High priority', High, 'var(--bad)'), leg('Medium priority', Medium, 'var(--warn)'), leg('Low priority', Low, 'var(--info)'));

    fill($('leads'), 
      ...(stats.opportunities.length
        ? stats.opportunities.map((o) =>
            h('li', {}, h('a', { href: `#/report/${o.id}` }, scoreBadge({ score: o.score, grade: '' }), h('span', {}, h('span', { class: 'host', text: o.host }), h('span', { class: 'sub', text: `${o.clientName ? `${o.clientName} · ` : ''}${ago(o.createdAt)}` })), h('span', { class: 'lead-cell' }, o.security === 'threat' ? h('span', { class: 'pill h', title: 'Malware / blacklist signs', text: '⚠ security' }) : null, o.high ? h('span', { class: 'pill h', text: `${o.high} high` }) : null, h('span', { class: 'pill grey', text: o.leadStatus })))),
          )
        : [h('li', { class: 'empty-mini', text: 'Run audits to see your best sales opportunities here.' })]),
    );
    fill($('common'), 
      ...(stats.commonIssues.length
        ? stats.commonIssues.map((c) => h('li', {}, h('span', { class: `pill ${c.severity === 'High' ? 'h' : c.severity === 'Medium' ? 'm' : 'l'}`, text: c.severity }), h('span', { class: 't', text: c.title }), h('span', { class: 'c', text: `×${c.count}` })))
        : [h('li', { class: 'empty-mini', text: 'No issues recorded yet.' })]),
    );
    renderTable($('recent-table'), recent.items, { selectable: false });
    if (!recent.items.length) fill($('recent-table'), h('tbody', {}, h('tr', {}, h('td', { class: 'empty-mini', text: 'No reports yet — start your first audit.' }))));
  }

  // ---------- reports table ----------
  function renderTable(table, items, { selectable }) {
    const sel = state.list.selected;
    const allBox = selectable ? h('input', { type: 'checkbox', 'aria-label': 'Select all on this page', onchange: (e) => {
      for (const it of items) e.target.checked ? sel.add(it.id) : sel.delete(it.id);
      loadReportsRender();
    } }) : null;
    if (allBox) allBox.checked = items.length > 0 && items.every((i) => sel.has(i.id));
    const head = h('thead', {}, h('tr', {}, selectable ? h('th', {}, allBox) : null, h('th', { text: 'Website' }), h('th', { text: 'Health' }), h('th', { text: 'Findings' }), h('th', { text: 'Lead' }), h('th', { text: 'Status' }), h('th', { text: 'Created' }), h('th', { class: 'r', text: '' })));
    const body = h(
      'tbody',
      {},
      items.map((it) => {
        const host = it.summary?.host || hostOf(it.inputUrl);
        const box = selectable ? h('input', { type: 'checkbox', 'aria-label': `Select ${host}`, onchange: (e) => {
          e.target.checked ? sel.add(it.id) : sel.delete(it.id);
          e.target.closest('tr').classList.toggle('sel', e.target.checked);
          updateBulk();
          if (allBox) allBox.checked = items.every((i) => sel.has(i.id));
        } }) : null;
        if (box) box.checked = sel.has(it.id);
        const done = it.status === 'complete';
        return h(
          'tr',
          { class: box && box.checked ? 'sel' : '' },
          selectable ? h('td', {}, box) : null,
          h('td', {}, h('div', { class: 'site' }, h('span', { class: 'avatar', text: host.replace(/^www\./, '').charAt(0) }), h('span', {}, h('a', { class: 'host', href: `#/report/${it.id}`, text: host }), it.archived ? h('span', { class: 'archived-tag', text: 'Archived' }) : null, h('span', { class: 'sub', text: it.clientName || it.inputUrl })))),
          h('td', {}, scoreBadge(it.summary)),
          h('td', {}, h('div', { class: 'findings' }, it.summary?.security === 'threat' ? h('span', { class: 'pill h', title: 'Malware, blacklist or cloaking detected', text: '⚠ Security' }) : null, sevPills(it.summary))),
          h('td', {}, h('span', { class: `pill ${{ New: 'grey', Contacted: 'run', 'Proposal sent': 'm', Won: 'ok', Lost: 'h' }[it.leadStatus] || 'grey'}`, text: it.leadStatus || 'New' }), it.shareViews ? h('span', { class: 'sub', text: `opened ${it.shareViews}×` }) : null),
          h('td', {}, statusPill(it)),
          h('td', { class: 'muted', title: new Date(it.createdAt).toLocaleString(), text: ago(it.createdAt) }),
          h(
            'td',
            {},
            h(
              'div',
              { class: 'row-actions' },
              h('a', { class: 'btn ghost small', href: `#/report/${it.id}`, text: 'Open' }),
              done ? h('a', { class: 'btn ghost small', href: `/api/investigations/${it.id}/report.pdf`, title: 'Download client PDF', text: 'PDF' }) : null,
              h('button', { class: 'btn ghost small', type: 'button', text: it.archived ? 'Restore' : 'Archive', onclick: () => setArchived(it.id, !it.archived) }),
              h('button', { class: 'btn danger small', type: 'button', text: 'Delete', 'aria-label': `Delete report for ${host}`, onclick: () => deleteReport(it.id, host) }),
            ),
          ),
        );
      }),
    );
    fill(table, head, body);
  }

  function updateBulk() {
    const n = state.list.selected.size;
    $('bulkbar').hidden = n === 0;
    $('bulk-count').textContent = `${n} selected`;
  }

  function loadReportsRender() {
    const L = state.list;
    renderTable($('reports-table'), L.items, { selectable: true });
    updateBulk();
  }

  async function loadReports() {
    const L = state.list;
    const qs = new URLSearchParams({ page: L.page, pageSize: L.pageSize, view: L.view });
    if (L.q) qs.set('q', L.q);
    if (L.status) qs.set('status', L.status);
    if (L.lead) qs.set('lead', L.lead);
    const csv = new URLSearchParams({ view: L.view });
    if (L.q) csv.set('q', L.q);
    if (L.lead) csv.set('lead', L.lead);
    $('export-csv').href = `/api/export.csv?${csv}`;
    let data;
    try {
      data = await api(`/api/investigations?${qs}`);
    } catch (e) {
      toast(e.message, true);
      return;
    }
    const pages = Math.max(1, Math.ceil(data.total / L.pageSize));
    if (L.page > pages && data.total) {
      L.page = pages;
      return loadReports();
    }
    L.items = data.items;
    $('reports-empty').hidden = data.total > 0;
    $('reports-table').hidden = data.total === 0;
    $('pager').hidden = data.total === 0;
    loadReportsRender();
    const from = (L.page - 1) * L.pageSize + 1;
    $('pager-info').textContent = `Showing ${from}–${Math.min(data.total, L.page * L.pageSize)} of ${data.total}`;
    const nav = $('pager-nav');
    const go = (p) => () => {
      L.page = p;
      loadReports();
    };
    const btns = [h('button', { type: 'button', text: '‹ Prev', disabled: L.page <= 1, onclick: go(L.page - 1) })];
    const wanted = [...new Set([1, L.page - 1, L.page, L.page + 1, pages])].filter((p) => p >= 1 && p <= pages).sort((a, b) => a - b);
    let last = 0;
    for (const p of wanted) {
      if (p - last > 1) btns.push(h('span', { class: 'gap', text: '…' }));
      btns.push(h('button', { type: 'button', class: p === L.page ? 'on' : '', 'aria-current': p === L.page ? 'page' : null, text: p, onclick: go(p) }));
      last = p;
    }
    btns.push(h('button', { type: 'button', text: 'Next ›', disabled: L.page >= pages, onclick: go(L.page + 1) }));
    fill(nav, ...btns);
  }

  let searchTimer = null;
  $('q').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.list.q = e.target.value.trim();
      state.list.page = 1;
      loadReports();
    }, 250);
  });
  for (const b of qsa('[data-view-tab]')) {
    b.addEventListener('click', () => {
      for (const x of qsa('[data-view-tab]')) x.classList.toggle('on', x === b);
      state.list.view = b.dataset.viewTab;
      state.list.page = 1;
      state.list.selected.clear();
      loadReports();
    });
  }
  $('status-filter').addEventListener('change', (e) => {
    state.list.status = e.target.value;
    state.list.page = 1;
    loadReports();
  });
  $('lead-filter').addEventListener('change', (e) => {
    state.list.lead = e.target.value;
    state.list.page = 1;
    loadReports();
  });
  $('page-size').addEventListener('change', (e) => {
    state.list.pageSize = Number(e.target.value);
    state.list.page = 1;
    loadReports();
  });
  $('bulk-clear').addEventListener('click', () => {
    state.list.selected.clear();
    loadReportsRender();
  });
  for (const b of qsa('[data-bulk]')) {
    b.addEventListener('click', async () => {
      const action = b.dataset.bulk;
      const ids = [...state.list.selected];
      if (!ids.length) return;
      if (action === 'delete' && !(await confirmDialog(`Delete ${ids.length} report${ids.length === 1 ? '' : 's'}?`, 'Reports, screenshots and re-check history are removed permanently. This cannot be undone.'))) return;
      try {
        const r = await api('/api/investigations/bulk', { json: { ids, action } });
        toast(`${r.done} report${r.done === 1 ? '' : 's'} ${action === 'delete' ? 'deleted' : action === 'archive' ? 'archived' : 'restored'}${r.skipped ? ` · ${r.skipped} skipped (still running)` : ''}`);
        state.list.selected.clear();
        loadReports();
      } catch (e) {
        toast(e.message, true);
      }
    });
  }

  async function setArchived(id, archived) {
    try {
      await api(`/api/investigations/${id}/meta`, { json: { archived } });
      toast(archived ? 'Report archived — find it under “Archived”' : 'Report restored');
      refreshCurrent();
    } catch (e) {
      toast(e.message, true);
    }
  }

  async function deleteReport(id, host) {
    if (!(await confirmDialog('Delete this report?', `The audit of ${host}, its screenshots and re-check history will be removed permanently.`))) return;
    try {
      await api(`/api/investigations/${id}`, { method: 'DELETE' });
      state.list.selected.delete(id);
      toast('Report deleted');
      if (state.currentId === id) location.hash = '#/reports';
      else refreshCurrent();
    } catch (e) {
      toast(e.message, true);
    }
  }

  function refreshCurrent() {
    const view = qsa('[data-view]').find((s) => !s.hidden)?.dataset.view;
    if (view === 'reports') loadReports();
    else if (view === 'dashboard') renderDashboard();
    else if (view === 'report' && state.currentId) openReport(state.currentId, true);
  }

  // ---------- new audit / progress ----------
  const ICON = { pending: '', running: '', done: '✓', skipped: '–', failed: '!' };
  function renderSteps(steps) {
    fill($('steps'), 
      ...steps.map((s) =>
        h('li', { class: s.state }, h('span', { class: 'icon', text: ICON[s.state] || '' }), h('span', {}, h('span', { class: 'label', text: s.label }), s.detail && s.state !== 'pending' ? h('span', { class: 'detail', text: s.detail }) : null)),
      ),
    );
    const finished = steps.filter((s) => s.state === 'done' || s.state === 'skipped' || s.state === 'failed').length;
    const pct = steps.length ? Math.round((finished / steps.length) * 100) : 0;
    $('pct').textContent = `${pct}%`;
    $('progress-fill').style.width = `${pct}%`;
  }
  function showError(msg) {
    $('error').textContent = msg;
    $('error').hidden = !msg;
  }

  async function poll(id) {
    clearTimeout(pollTimer);
    state.pollId = id;
    let job;
    try {
      job = await api(`/api/investigations/${id}`);
    } catch (e) {
      state.pollId = null;
      showError(e.message);
      return;
    }
    if (job.status === 'complete') {
      state.pollId = null;
      $('progress').hidden = true;
      $('start').hidden = false;
      $('form').reset();
      $('submit').disabled = false;
      toast('Audit complete');
      location.hash = `#/report/${id}`;
      return;
    }
    if (job.status === 'failed') {
      state.pollId = null;
      $('progress').hidden = true;
      $('start').hidden = false;
      $('submit').disabled = false;
      showError(job.error || 'The audit failed.');
      return;
    }
    renderSteps(job.steps);
    const running = job.steps.find((s) => s.state === 'running');
    $('progress-title').textContent = running ? `${running.label}… — ${hostOf(job.inputUrl)}` : job.status === 'queued' ? 'Waiting in queue…' : `Auditing ${hostOf(job.inputUrl)}`;
    $('start').hidden = true;
    $('progress').hidden = false;
    pollTimer = setTimeout(() => poll(id), 1000);
  }

  let auditMode = 'single';
  for (const b of qsa('[data-mode]')) {
    b.addEventListener('click', () => {
      auditMode = b.dataset.mode;
      for (const x of qsa('[data-mode]')) x.classList.toggle('on', x === b);
      $('single-fields').hidden = auditMode !== 'single';
      $('bulk-fields').hidden = auditMode !== 'bulk';
      $('submit').textContent = auditMode === 'bulk' ? 'Queue audits' : 'Start audit';
      $('bulk-result').hidden = true;
    });
  }

  $('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    showError('');
    const focus = $('form').elements.focus.value;
    if (auditMode === 'bulk') {
      const urls = $('bulk-urls').value.split(/[\n,]+/).map((u) => u.trim()).filter(Boolean);
      if (!urls.length) return showError('Paste at least one website URL.');
      if (urls.length > 20) return showError('Up to 20 websites per batch.');
      $('submit').disabled = true;
      try {
        const r = await api('/api/investigations/batch', { json: { urls, focus } });
        fill($('bulk-result'),
          ...r.queued.map((q) => h('li', { class: 'ok' }, '✓ ', h('a', { href: `#/report/${q.id}`, text: hostOf(q.url) }), ' queued')),
          ...r.errors.map((x) => h('li', { class: 'err', text: `✕ ${x.url} — ${x.error}` })),
        );
        $('bulk-result').hidden = false;
        toast(`${r.queued.length} audit${r.queued.length === 1 ? '' : 's'} queued — they appear in Reports as they finish`);
        $('bulk-urls').value = '';
        refreshEngine();
      } catch (err) {
        showError(err.message);
      } finally {
        $('submit').disabled = false;
      }
      return;
    }
    const url = $('url').value.trim();
    if (!url) return showError('Please enter a website URL.');
    $('submit').disabled = true;
    try {
      const { id } = await api('/api/investigations', { json: { url, clientName: $('client').value.trim(), focus } });
      renderSteps([]);
      refreshEngine();
      poll(id);
    } catch (err) {
      $('submit').disabled = false;
      showError(err.message);
    }
  });

  // ---------- report view ----------
  async function openReport(id, quiet = false) {
    let job;
    try {
      job = await api(`/api/investigations/${id}`);
    } catch (e) {
      toast(e.message, true);
      location.hash = '#/reports';
      return;
    }
    if (job.status === 'queued' || job.status === 'running') {
      showView('new');
      poll(id);
      return;
    }
    if (job.status === 'failed') {
      toast(job.error || 'This audit failed.', true);
      location.hash = '#/reports';
      return;
    }
    showView('report');
    state.currentId = id;
    state.currentJob = job;
    const s = job.summary;
    $('page-title').textContent = s?.host || hostOf(job.inputUrl);
    fill($('rh-score'), ring(s?.score ?? null));
    $('rh-host').textContent = s?.host || hostOf(job.inputUrl);
    $('rh-client-input').value = job.clientName || '';
    fill($('rh-chips'), 
      s ? h('span', { class: `pill ${scoreClass(s.score) === 'good' ? 'ok' : scoreClass(s.score) === 'mid' ? 'm' : 'h'}`, text: `${gradeLabel(s.score)} · grade ${s.grade}` }) : null,
      s ? sevPills(s) : null,
      s?.wordpress ? h('span', { class: 'pill grey', text: 'WordPress' }) : null,
      s ? h('span', { class: 'pill grey', text: `${s.pages} pages` }) : null,
      h('span', { class: 'pill grey', text: new Date(job.createdAt).toLocaleDateString() }),
      job.archived ? h('span', { class: 'pill grey', text: 'Archived' }) : null,
    );
    $('dl-pdf').href = `/api/investigations/${id}/report.pdf`;
    $('dl-html').href = `/api/investigations/${id}/report.html`;
    $('preview-client').href = `/api/investigations/${id}/report.html?inline=1`;
    $('dl-analyst').href = `/api/investigations/${id}/analyst-report.html`;
    $('rh-archive').textContent = job.archived ? 'Restore' : 'Archive';
    renderSecurity(job);
    renderCommerce(job);
    renderSales(job);
    if (!quiet) selectTab('analyst');
    $('client-frame').removeAttribute('src');
    try {
      // Rendered server-side; every value from the audited site is HTML-escaped.
      $('report').innerHTML = await api(`/api/investigations/${id}/report-body?fix=0`);
    } catch (e) {
      toast(e.message, true);
    }
    setupFix(job);
  }

  const ROW_ICON = { ok: '✓', warn: '!', bad: '✕', na: '–' };
  function renderSecurity(job) {
    const sec = job.security;
    $('sec-card').hidden = !sec;
    if (!sec) return;
    const v = sec.verdict;
    $('sec-verdict').className = `verdict ${v.status}`;
    fill($('sec-verdict'), h('span', { class: 'v-icon', text: v.status === 'clean' ? '✓' : v.status === 'threat' ? '✕' : '!' }), h('strong', { text: v.label }));
    $('sec-sub').textContent = job.result?.focus === 'security' ? 'Security-only scan' : 'Part of the full audit';
    fill($('sec-rows'), ...sec.rows.map((r) => h('li', { class: r.status }, h('span', { class: 's-icon', text: ROW_ICON[r.status] }), h('span', {}, h('b', { text: r.label }), h('span', { class: 'sub', text: r.value })))));
  }

  function renderCommerce(job) {
    const c = job.result && job.result.commerce;
    $('cro-card').hidden = !c;
    if (!c) return;
    fill($('cro-ring'), ring(c.score, 96, 'SALES'));
    $('cro-sub').textContent = c.isStore ? `${c.platform || 'Online store'} · ${c.productPages.length} product page${c.productPages.length === 1 ? '' : 's'}` : 'No store detected';
    const failed = c.checks.filter((x) => x.pass === false);
    const passed = c.checks.filter((x) => x.pass === true).length;
    $('cro-line').textContent = `Conversion readiness ${c.score}/100 — ${passed} best practices in place, ${failed.length} missing.`;
    const ord = { High: 0, Medium: 1, Low: 2 };
    fill($('cro-list'), ...failed.sort((a, b) => ord[a.impact] - ord[b.impact]).map((x) => h('li', {}, h('span', { class: `pill ${x.impact === 'High' ? 'h' : x.impact === 'Medium' ? 'm' : 'l'}`, text: x.impact }), h('span', {}, h('b', { text: x.label }), h('span', { class: 'sub', text: x.detail })))));
  }

  function renderShare(share) {
    const box = $('share-state');
    if (!share) {
      fill(box, h('button', { type: 'button', class: 'btn ghost small', text: '🔗 Create share link', onclick: createShare }), h('span', { class: 'sub', text: 'Send a link instead of a PDF and see when it is opened.' }));
      return;
    }
    const url = `${location.origin}${share.path}`;
    fill(box,
      h('div', { class: 'share-actions' },
        h('button', { type: 'button', class: 'btn small', text: 'Copy link', onclick: (e) => copyText(url, e.currentTarget) }),
        h('a', { class: 'btn ghost small', href: share.path, target: '_blank', rel: 'noopener', text: 'Open' }),
        h('button', { type: 'button', class: 'btn danger small', text: 'Revoke', onclick: revokeShare }),
      ),
      h('span', { class: 'sub', text: share.views ? `Opened ${share.views}× · last ${ago(share.lastViewed)}` : 'Not opened yet' }),
    );
  }
  async function createShare() {
    try {
      const r = await api(`/api/investigations/${state.currentId}/share`, { method: 'POST' });
      renderShare({ path: r.path, views: r.views, lastViewed: null });
      await copyText(`${location.origin}${r.path}`);
      toast('Share link created and copied. Note: it only works where this dashboard is reachable by your client.');
    } catch (e) {
      toast(e.message, true);
    }
  }
  async function revokeShare() {
    if (!(await confirmDialog('Revoke this link?', 'Anyone with the current link will no longer be able to open the report.', 'Revoke'))) return;
    try {
      await api(`/api/investigations/${state.currentId}/share`, { method: 'DELETE' });
      renderShare(null);
      toast('Link revoked');
    } catch (e) {
      toast(e.message, true);
    }
  }

  function renderSales(job) {
    $('lead-status').value = job.leadStatus || 'New';
    $('lead-notes').value = job.notes || '';
    renderShare(job.share);
    const hist = (job.history || []).filter((x) => x.id !== job.id);
    $('history').hidden = hist.length === 0;
    fill($('history-list'), ...hist.map((x) => h('li', {}, h('a', { href: `#/report/${x.id}` }, scoreBadge({ score: x.score, grade: '' }), h('span', { text: ` ${new Date(x.createdAt).toLocaleDateString()} · ${x.verified} issue${x.verified === 1 ? '' : 's'}` })))));
  }

  $('lead-status').addEventListener('change', async (e) => {
    try {
      await api(`/api/investigations/${state.currentId}/meta`, { json: { leadStatus: e.target.value } });
      if (state.currentJob) state.currentJob.leadStatus = e.target.value;
      toast(`Lead moved to “${e.target.value}”`);
    } catch (err) {
      toast(err.message, true);
    }
  });
  $('save-notes').addEventListener('click', async () => {
    try {
      await api(`/api/investigations/${state.currentId}/meta`, { json: { notes: $('lead-notes').value } });
      toast('Notes saved');
    } catch (err) {
      toast(err.message, true);
    }
  });

  let draft = null;
  $('btn-outreach').addEventListener('click', async () => {
    try {
      draft = await api(`/api/investigations/${state.currentId}/outreach`);
      $('o-subject').value = draft.subject;
      $('o-body').value = draft.body;
      $('o-follow').value = draft.followUp;
      updateMailto();
      $('outreach').showModal();
    } catch (err) {
      toast(err.message, true);
    }
  });
  function updateMailto() {
    $('o-mailto').href = `mailto:?subject=${encodeURIComponent($('o-subject').value)}&body=${encodeURIComponent($('o-body').value)}`;
  }
  $('o-subject').addEventListener('input', updateMailto);
  $('o-body').addEventListener('input', updateMailto);
  $('outreach-close').addEventListener('click', () => $('outreach').close());
  $('o-copy-subject').addEventListener('click', (e) => copyText($('o-subject').value, e.currentTarget));
  $('o-copy-body').addEventListener('click', (e) => copyText($('o-body').value, e.currentTarget));
  $('o-copy-follow').addEventListener('click', (e) => copyText($('o-follow').value, e.currentTarget));

  function selectTab(name) {
    for (const t of qsa('[data-tab]')) t.classList.toggle('on', t.dataset.tab === name);
    for (const p of qsa('[data-tabpanel]')) p.hidden = p.dataset.tabpanel !== name;
    if (name === 'client' && state.currentId && !$('client-frame').getAttribute('src')) $('client-frame').src = `/api/investigations/${state.currentId}/report.html?inline=1`;
  }
  for (const t of qsa('[data-tab]')) t.addEventListener('click', () => selectTab(t.dataset.tab));

  $('rh-client-save').addEventListener('click', async () => {
    try {
      const r = await api(`/api/investigations/${state.currentId}/meta`, { json: { clientName: $('rh-client-input').value } });
      $('rh-client-input').value = r.clientName || '';
      toast('Client name saved — it appears on the client report cover');
      if ($('client-frame').getAttribute('src')) $('client-frame').src = `/api/investigations/${state.currentId}/report.html?inline=1&t=${Date.now()}`;
    } catch (e) {
      toast(e.message, true);
    }
  });
  $('rh-archive').addEventListener('click', () => state.currentJob && setArchived(state.currentId, !state.currentJob.archived));
  $('rh-delete').addEventListener('click', () => state.currentJob && deleteReport(state.currentId, state.currentJob.summary?.host || hostOf(state.currentJob.inputUrl)));

  // ---------- Fix Assistant / Re-check (private analyst tools) ----------
  let fixText = '';
  const fixPanel = $('fix-panel');
  const tracking = $('tracking');
  const fixError = (msg) => {
    $('fix-error').textContent = msg || '';
    $('fix-error').hidden = !msg;
  };
  const STATUS_CLASS = { Open: 'open', 'In Progress': 'progress', Resolved: 'resolved', 'Unable to Verify': '' };
  function setStatus(status) {
    const el = $('report-status');
    el.textContent = status;
    el.className = `status-pill ${STATUS_CLASS[status] || ''}`;
    $('btn-progress').hidden = status !== 'Open';
  }
  function setupFix(job) {
    clearTimeout(trackTimer);
    fixPanel.hidden = true;
    fill($('fix-body'), );
    fixText = '';
    fixError('');
    const primary = job.result && job.result.primary;
    $('fixbar').hidden = !primary;
    tracking.hidden = !primary;
    if (!primary) return;
    $('fix-title').textContent = primary.title;
    $('btn-fix').textContent = 'Fix This Issue';
    setStatus(job.reportStatus || 'Open');
    loadTracking();
  }
  async function openFix() {
    fixError('');
    if (!fixPanel.hidden) {
      fixPanel.hidden = true;
      $('btn-fix').textContent = 'Fix This Issue';
      return;
    }
    try {
      const fix = await api(`/api/investigations/${state.currentId}/fix`);
      fixText = fix.text;
      $('fix-body').innerHTML = fix.html;
      fixPanel.hidden = false;
      $('btn-fix').textContent = 'Hide Fix Instructions';
      fixPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      api(`/api/investigations/${state.currentId}/fix-log`, { method: 'POST' }).catch(() => undefined);
    } catch (e) {
      fixError(e.message);
    }
  }
  async function copyText(text, button) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = h('textarea');
      ta.value = text;
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    if (button) {
      const label = button.textContent;
      button.textContent = 'Copied';
      setTimeout(() => (button.textContent = label), 1500);
    }
  }
  async function loadTracking() {
    clearTimeout(trackTimer);
    if (!state.currentId) return;
    try {
      const t = await api(`/api/investigations/${state.currentId}/tracking`);
      tracking.innerHTML = t.html;
      setStatus(t.reportStatus);
      for (const id of ['btn-recheck', 'btn-recheck-2']) {
        $(id).disabled = t.running;
        $(id).textContent = t.running ? 'Re-checking…' : 'Re-check This Issue';
      }
      if (t.running) trackTimer = setTimeout(loadTracking, 1500);
    } catch (e) {
      fixError(e.message);
    }
  }
  async function recheck() {
    fixError('');
    try {
      await api(`/api/investigations/${state.currentId}/rechecks`, { method: 'POST' });
      tracking.hidden = false;
      tracking.scrollIntoView({ behavior: 'smooth', block: 'start' });
      loadTracking();
    } catch (e) {
      fixError(e.message);
    }
  }
  $('btn-fix').addEventListener('click', openFix);
  $('btn-view').addEventListener('click', () => {
    const target = qsa('h3', $('fix-body')).find((x) => /Step 3/.test(x.textContent));
    (target || $('fix-body')).scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('btn-copy').addEventListener('click', (e) => copyText(fixText, e.currentTarget));
  $('btn-recheck').addEventListener('click', recheck);
  $('btn-recheck-2').addEventListener('click', recheck);
  $('btn-progress').addEventListener('click', async () => {
    try {
      const r = await api(`/api/investigations/${state.currentId}/status`, { json: { status: 'In Progress' } });
      setStatus(r.reportStatus);
      loadTracking();
    } catch (e) {
      fixError(e.message);
    }
  });
  fixPanel.addEventListener('click', (e) => {
    const btn = e.target.closest('button.copy[data-copy-target]');
    if (!btn) return;
    const src = document.getElementById(btn.dataset.copyTarget);
    if (src) copyText(src.textContent, btn);
  });

  // ---------- settings ----------
  const form = $('settings-form');
  let pendingLogo;
  const FIELDS = ['agencyName', 'consultantName', 'tagline', 'email', 'phone', 'website', 'bookingUrl', 'ctaHeadline', 'ctaMessage', 'offer', 'accent'];
  function logoPreview(src) {
    fill($('logo-box'), src ? h('img', { src, alt: 'Logo' }) : h('span', { text: 'Logo' }));
  }
  let integrations = null;
  function renderIntegrations() {
    const i = integrations;
    const el = $('sb-state');
    if (!i) return fill(el);
    fill(el,
      i.safeBrowsingConfigured ? h('span', { class: 'pill ok', text: `Configured (${i.safeBrowsingKeyHint})` }) : h('span', { class: 'pill grey', text: 'Not configured — blacklist checks are skipped' }),
      i.safeBrowsingConfigured ? h('button', { type: 'button', class: 'btn danger small', text: 'Remove key', onclick: removeKey }) : null,
    );
  }
  async function removeKey() {
    try {
      const r = await api('/api/settings', { method: 'PUT', json: { integrations: { safeBrowsingKey: null } } });
      integrations = r.integrations;
      renderIntegrations();
      toast('API key removed');
    } catch (e) {
      toast(e.message, true);
    }
  }
  async function fillSettings() {
    try {
      integrations = (await api('/api/settings')).integrations;
    } catch {
      integrations = null;
    }
    form.elements.safeBrowsingKey.value = '';
    renderIntegrations();
    await loadBranding();
    const b = state.branding;
    if (!b) return;
    for (const f of FIELDS) form.elements[f].value = b[f] ?? '';
    form.elements.showScore.checked = !!b.showScore;
    pendingLogo = undefined;
    logoPreview(b.logo);
    $('settings-error').hidden = true;
    $('settings-status').textContent = '';
    updatePreview();
  }
  function updatePreview() {
    const v = (f) => form.elements[f].value.trim();
    const logo = pendingLogo === undefined ? state.branding?.logo : pendingLogo;
    fill($('cp-brand'), logo ? h('img', { src: logo, alt: '' }) : null, h('span', { text: v('agencyName') || 'Your Agency' }));
    $('cp-head').textContent = v('ctaHeadline') || 'Let’s fix these issues for you';
    $('cp-msg').textContent = v('ctaMessage');
    $('cta-preview').style.setProperty('--accent', v('accent') || '#2563eb');
    const acts = [];
    if (v('bookingUrl')) acts.push(h('span', { class: 'primary', text: v('offer') || 'Book a call' }));
    if (v('email')) acts.push(h('span', { text: `✉ ${v('email')}` }));
    if (v('phone')) acts.push(h('span', { text: `☎ ${v('phone')}` }));
    if (v('website')) acts.push(h('span', { text: `⌂ ${v('website').replace(/^https?:\/\//, '')}` }));
    if (!acts.length) acts.push(h('span', { text: 'Add contact details to show buttons here' }));
    fill($('cp-actions'), ...acts);
  }
  form.addEventListener('input', updatePreview);
  $('logo-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) return toast('Please choose a PNG, JPEG or WebP image', true);
    if (file.size > 400 * 1024) return toast('Logo must be smaller than 400 KB', true);
    const reader = new FileReader();
    reader.onload = () => {
      pendingLogo = String(reader.result);
      logoPreview(pendingLogo);
      updatePreview();
    };
    reader.readAsDataURL(file);
  });
  $('logo-remove').addEventListener('click', () => {
    pendingLogo = null;
    logoPreview(null);
    updatePreview();
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    $('settings-error').hidden = true;
    const branding = Object.fromEntries(FIELDS.map((f) => [f, form.elements[f].value]));
    branding.showScore = form.elements.showScore.checked;
    if (pendingLogo !== undefined) branding.logo = pendingLogo;
    const key = form.elements.safeBrowsingKey.value.trim();
    $('settings-save').disabled = true;
    try {
      const r = await api('/api/settings', { method: 'PUT', json: { branding, ...(key ? { integrations: { safeBrowsingKey: key } } : {}) } });
      applyBranding(r.branding);
      integrations = r.integrations;
      form.elements.safeBrowsingKey.value = '';
      renderIntegrations();
      pendingLogo = undefined;
      $('settings-status').textContent = 'Saved — new client reports use these details.';
      toast('Branding saved');
    } catch (err) {
      $('settings-error').textContent = err.message;
      $('settings-error').hidden = false;
    } finally {
      $('settings-save').disabled = false;
    }
  });

  // ---------- shell ----------
  $('menu-btn').addEventListener('click', () => $('sidebar').classList.toggle('open'));
  document.addEventListener('click', (e) => {
    const sb = $('sidebar');
    if (sb.classList.contains('open') && !sb.contains(e.target) && !$('menu-btn').contains(e.target)) sb.classList.remove('open');
  });
  window.addEventListener('hashchange', route);
  loadBranding().then(route);
  refreshEngine();
})();
