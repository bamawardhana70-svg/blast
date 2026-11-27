'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const ROW_LIMIT = 500;

  const state = {
    hasKey: false,
    job: null,
    jobId: '',
    jobVersion: -1,
    clockOffset: 0,
    filter: 'all',
    parsed: { valid: [], invalid: [], duplicates: 0 },
    wasActive: false,
    detail: null,
  };

  // ---- helpers -------------------------------------------------------------
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Baxde-Client': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch (_) { /* empty body */ }
    if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
    return data;
  }

  function parseIds(text) {
    const valid = [];
    const invalid = [];
    const seen = new Set();
    let duplicates = 0;
    for (const raw of text.split(/[\s,;]+/)) {
      const t = raw.trim();
      if (!t) continue;
      if (!/^\d{1,16}$/.test(t) || Number(t) <= 0) { invalid.push(t); continue; }
      const n = String(Number(t));
      if (seen.has(n)) { duplicates += 1; continue; }
      seen.add(n);
      valid.push(n);
    }
    return { valid, invalid, duplicates };
  }

  const fmtTime = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${h ? `${h}:` : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(s % 60).padStart(2, '0')}`;
  };
  const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString() : '-');

  function download(name, text, mime) {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function reportTxt(meta, items) {
    const head = [
      'BaxdeStudio Asset Permission Blaster - Report',
      `Universe ID : ${meta.universeId}`,
      `Started     : ${fmtDate(meta.startedAt)}`,
      `Finished    : ${fmtDate(meta.finishedAt)}`,
      `Status      : ${meta.status}`,
      `Total ${meta.total} | Success ${meta.success} | Failed ${meta.failed} | Skipped ${meta.skipped}`,
      '',
      'Asset ID\tType\tStatus\tResponse',
    ];
    return head.concat(items.map((i) => `${i.assetId}\t${i.type}\t${i.status}\t${i.message}`)).join('\n') + '\n';
  }

  function reportCsv(items) {
    const q = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    return ['Asset ID,Type,Status,Response'].concat(items.map((i) => [i.assetId, i.type, i.status, i.message].map(q).join(','))).join('\n') + '\n';
  }

  function metaFromJob(job) {
    const t = job.totals;
    return { universeId: job.universeId, startedAt: job.startedAt, finishedAt: job.finishedAt, status: job.status, total: t.total, success: t.success, failed: t.failed, skipped: t.skipped };
  }

  function rowsHtml(items) {
    return items.map((i) =>
      `<tr><td>${esc(i.assetId)}</td><td>${esc(i.type)}</td><td><span class="badge ${esc(i.status)}">${esc(i.status)}</span></td><td>${esc(i.message)}</td></tr>`
    ).join('');
  }

  // ---- API key / config ----------------------------------------------------
  function setPill(stateName, text) {
    $('apiPill').dataset.state = stateName;
    $('apiPillText').textContent = text;
  }

  function applyConfig(cfg) {
    state.hasKey = cfg.hasKey;
    $('savedKey').textContent = cfg.hasKey ? `Stored on the server (memory only): ${cfg.maskedKey}` : 'No key stored on the server.';
    if (!cfg.hasKey) setPill('', 'API key not set');
    else if ($('apiPill').dataset.state !== 'connected') setPill('saved', 'Key saved, not tested');
    updateButtons();
  }

  $('toggleKey').addEventListener('click', () => {
    const input = $('apiKey');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    $('toggleKey').textContent = show ? 'Hide' : 'Show';
  });

  $('saveKey').addEventListener('click', async () => {
    const input = $('apiKey');
    try {
      applyConfig(await api('POST', '/api/config/key', { apiKey: input.value }));
      input.value = '';
      input.type = 'password';
      $('toggleKey').textContent = 'Show';
      $('testResult').textContent = 'Key saved. Run the connection test to check it.';
      setPill('saved', 'Key saved, not tested');
    } catch (e) {
      $('testResult').textContent = e.message;
    }
  });

  $('testKey').addEventListener('click', async () => {
    $('testResult').textContent = 'Testing...';
    try {
      const r = await api('POST', '/api/config/test', { universeId: $('universeId').value });
      $('testResult').textContent = r.message;
      if (r.state === 'connected') setPill('connected', `Connected (HTTP ${r.http})`);
      else setPill('bad', r.state === 'limited' ? 'Rate limited' : 'Connection problem');
    } catch (e) {
      $('testResult').textContent = e.message;
      setPill('bad', 'Connection problem');
    }
  });

  $('clearKey').addEventListener('click', async () => {
    try {
      applyConfig(await api('DELETE', '/api/config/key'));
      $('apiKey').value = '';
      $('testResult').textContent = 'Key cleared from server memory.';
    } catch (e) {
      $('testResult').textContent = e.message;
    }
  });

  // ---- asset input ---------------------------------------------------------
  function refreshInput() {
    const p = parseIds($('assetInput').value);
    state.parsed = p;
    $('assetCount').textContent = `${p.valid.length} asset${p.valid.length === 1 ? '' : 's'}`;
    const batches = Math.ceil(p.valid.length / 50);
    const parts = [`${p.valid.length} valid`, `${batches} batch${batches === 1 ? '' : 'es'} of up to 50`];
    if (p.duplicates) parts.push(`${p.duplicates} duplicate${p.duplicates === 1 ? '' : 's'} ignored`);
    if (p.invalid.length) parts.push(`${p.invalid.length} invalid: ${p.invalid.slice(0, 3).join(', ')}${p.invalid.length > 3 ? ' ...' : ''}`);
    $('assetStats').textContent = p.valid.length || p.invalid.length ? parts.join(' | ') : 'Paste IDs or import a TXT file.';
    updateButtons();
  }

  function cleanList() {
    $('assetInput').value = state.parsed.valid.join('\n');
    refreshInput();
  }

  $('assetInput').addEventListener('input', refreshInput);
  $('assetInput').addEventListener('paste', () => setTimeout(cleanList, 0));
  $('cleanList').addEventListener('click', cleanList);
  $('clearList').addEventListener('click', () => { $('assetInput').value = ''; refreshInput(); });
  $('importTxt').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', async (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    const text = await file.text();
    const cur = $('assetInput').value.trim();
    $('assetInput').value = cur ? `${cur}\n${text}` : text;
    ev.target.value = '';
    refreshInput();
    cleanList();
  });
  $('universeId').addEventListener('input', updateButtons);

  // ---- job rendering -------------------------------------------------------
  const TILES = [
    ['universe', 'Target Universe'], ['total', 'Total Asset ID'], ['batches', 'Total Batch'],
    ['success', 'Total Success'], ['failed', 'Total Failed'], ['pending', 'Total Pending'],
    ['progress', 'Progress'], ['elapsed', 'Elapsed time'],
  ];
  $('tiles').innerHTML = TILES.map(([k, l]) => `<div class="tile"><span>${l}</span><strong id="t_${k}">-</strong></div>`).join('');
  const setTile = (k, v) => { $(`t_${k}`).textContent = v; };

  function elapsedMs(job) {
    if (!job || !job.startedAt) return 0;
    const end = job.finishedAt || Date.now() + state.clockOffset;
    return end - job.startedAt;
  }

  function renderJob() {
    const job = state.job;
    if (!job) {
      ['universe', 'total', 'batches', 'success', 'failed', 'pending', 'progress', 'elapsed'].forEach((k) => setTile(k, '-'));
      $('barFill').style.width = '0';
      $('jobStatus').textContent = 'Idle';
      $('apiStatus').textContent = 'API status: waiting';
      $('resultBody').innerHTML = '';
      $('resultNote').textContent = 'No results yet. Start a blast to see each asset here.';
      updateButtons();
      return;
    }
    const t = job.totals;
    setTile('universe', job.universeId);
    setTile('total', t.total);
    setTile('batches', `${t.batchesDone}/${t.batches}`);
    setTile('success', t.success);
    setTile('failed', t.failed);
    setTile('pending', t.pending + t.processing);
    setTile('progress', `${t.progress}%`);
    setTile('elapsed', fmtTime(elapsedMs(job)));
    $('barFill').style.width = `${t.progress}%`;
    const label = job.status === 'paused' && job.inFlight ? 'Pausing after the current batch' : job.status.charAt(0).toUpperCase() + job.status.slice(1);
    $('jobStatus').textContent = label;
    $('apiStatus').textContent = `API status: ${job.apiStatus}`;
    renderResults();
    updateButtons();
  }

  function renderResults() {
    const job = state.job;
    if (!job) return;
    const f = state.filter;
    const items = job.items.filter((i) => (f === 'all' ? true : f === 'Pending' ? i.status === 'Pending' || i.status === 'Processing' : i.status === f));
    $('resultBody').innerHTML = rowsHtml(items.slice(0, ROW_LIMIT));
    $('resultNote').textContent = items.length > ROW_LIMIT
      ? `Showing ${ROW_LIMIT} of ${items.length} rows. Export the report to get every row.`
      : `${items.length} row${items.length === 1 ? '' : 's'} shown.`;
  }

  function updateButtons() {
    const job = state.job;
    const active = Boolean(job && (job.status === 'running' || job.status === 'paused'));
    const canStart = !active && state.hasKey && state.parsed.valid.length > 0 && /^\d+$/.test($('universeId').value.trim());
    $('btnStart').disabled = !canStart;
    $('btnPause').disabled = !(job && job.status === 'running');
    $('btnResume').disabled = !(job && job.status === 'paused');
    $('btnCancel').disabled = !active;
    $('btnReset').disabled = !job || active;
    $('retryFailed').disabled = !job || job.totals.failed === 0;
    $('exportTxt').disabled = !job;
    $('exportCsv').disabled = !job;
    $('clearKey').disabled = active;
    if (active) setPill('connected', 'Blasting');
  }

  async function act(fn) {
    $('actionError').textContent = '';
    try {
      const r = await fn();
      if (r && r.job !== undefined) { state.job = r.job; state.jobId = r.job ? r.job.id : ''; state.jobVersion = r.job ? r.job.version : -1; }
      renderJob();
    } catch (e) {
      $('actionError').textContent = e.message;
    }
  }

  $('btnStart').addEventListener('click', () => act(() => api('POST', '/api/jobs', {
    universeId: $('universeId').value.trim(),
    assetIds: state.parsed.valid,
    detectTypes: $('detectTypes').checked,
  })));
  $('btnPause').addEventListener('click', () => act(() => api('POST', '/api/jobs/current/pause')));
  $('btnResume').addEventListener('click', () => act(() => api('POST', '/api/jobs/current/resume')));
  $('btnCancel').addEventListener('click', () => act(() => api('POST', '/api/jobs/current/cancel')));
  $('btnReset').addEventListener('click', () => act(() => api('POST', '/api/jobs/current/reset')));

  $('filters').addEventListener('click', (ev) => {
    const b = ev.target.closest('.filter');
    if (!b) return;
    state.filter = b.dataset.filter;
    document.querySelectorAll('.filter').forEach((x) => x.classList.toggle('active', x === b));
    renderResults();
  });

  $('exportTxt').addEventListener('click', () => state.job && download(`blast-${state.job.universeId}.txt`, reportTxt(metaFromJob(state.job), state.job.items), 'text/plain'));
  $('exportCsv').addEventListener('click', () => state.job && download(`blast-${state.job.universeId}.csv`, reportCsv(state.job.items), 'text/csv'));
  $('retryFailed').addEventListener('click', () => {
    if (!state.job) return;
    $('assetInput').value = state.job.items.filter((i) => i.status === 'Failed').map((i) => i.assetId).join('\n');
    refreshInput();
  });

  // ---- history -------------------------------------------------------------
  async function loadHistory() {
    try {
      const { entries } = await api('GET', '/api/history');
      const box = $('historyList');
      if (!entries.length) { box.innerHTML = '<p class="empty">No blasts recorded yet.</p>'; return; }
      box.innerHTML = entries.map((e) => `
        <div class="h-item">
          <p><strong>Universe ${esc(e.universeId)}</strong><br>${esc(fmtDate(e.startedAt))}<br>
          ${e.total} assets | ${e.success} success | ${e.failed} failed | ${esc(e.status)}</p>
          <div class="row wrap flush">
            <button class="btn ghost small" data-view="${esc(e.id)}" type="button">View details</button>
            <button class="btn ghost small" data-export="${esc(e.id)}" type="button">Export report</button>
          </div>
        </div>`).join('');
    } catch (e) {
      $('historyList').innerHTML = `<p class="empty">${esc(e.message)}</p>`;
    }
  }

  async function fetchEntry(id) { return (await api('GET', `/api/history/${encodeURIComponent(id)}`)).entry; }

  $('historyList').addEventListener('click', async (ev) => {
    const view = ev.target.closest('[data-view]');
    const exp = ev.target.closest('[data-export]');
    try {
      if (view) {
        const e = await fetchEntry(view.dataset.view);
        state.detail = e;
        $('detailTitle').textContent = `Universe ${e.universeId}`;
        $('detailMeta').textContent = `${fmtDate(e.startedAt)} | ${e.total} assets | ${e.success} success | ${e.failed} failed | ${e.skipped} skipped | ${e.status}${e.items.length > ROW_LIMIT ? ` | showing first ${ROW_LIMIT}, export for all` : ''}`;
        $('detailBody').innerHTML = rowsHtml(e.items.slice(0, ROW_LIMIT));
        $('detailDialog').showModal();
      } else if (exp) {
        const e = await fetchEntry(exp.dataset.export);
        download(`report-${e.universeId}-${e.startedAt}.txt`, reportTxt(e, e.items), 'text/plain');
      }
    } catch (e) { $('actionError').textContent = e.message; }
  });

  $('detailClose').addEventListener('click', () => $('detailDialog').close());
  $('detailTxt').addEventListener('click', () => state.detail && download(`report-${state.detail.universeId}.txt`, reportTxt(state.detail, state.detail.items), 'text/plain'));
  $('detailCsv').addEventListener('click', () => state.detail && download(`report-${state.detail.universeId}.csv`, reportCsv(state.detail.items), 'text/csv'));
  $('clearHistory').addEventListener('click', async () => {
    if (!confirm('Delete all blast history? This cannot be undone.')) return;
    try { await api('DELETE', '/api/history'); loadHistory(); } catch (e) { $('actionError').textContent = e.message; }
  });

  // ---- polling -------------------------------------------------------------
  async function poll() {
    try {
      const d = await api('GET', `/api/jobs/current?id=${encodeURIComponent(state.jobId)}&v=${state.jobVersion}`);
      if (typeof d.serverNow === 'number') state.clockOffset = d.serverNow - Date.now();
      if (!d.unchanged) {
        state.job = d.job;
        state.jobId = d.job ? d.job.id : '';
        state.jobVersion = d.job ? d.job.version : -1;
        renderJob();
      }
      const active = Boolean(state.job && (state.job.status === 'running' || state.job.status === 'paused'));
      if (state.wasActive && !active) { loadHistory(); setPill(state.hasKey ? 'saved' : '', state.hasKey ? 'Key saved' : 'API key not set'); }
      state.wasActive = active;
    } catch (_) {
      setPill('bad', 'Server unreachable');
    } finally {
      setTimeout(poll, 1000);
    }
  }

  setInterval(() => {
    if (state.job && (state.job.status === 'running' || state.job.status === 'paused')) setTile('elapsed', fmtTime(elapsedMs(state.job)));
  }, 500);

  // ---- boot ----------------------------------------------------------------
  (async () => {
    refreshInput();
    try { applyConfig(await api('GET', '/api/config')); } catch (_) { setPill('bad', 'Server unreachable'); }
    loadHistory();
    poll();
  })();
})();
