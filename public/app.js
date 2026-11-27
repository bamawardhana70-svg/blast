'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const ROW_LIMIT = 500;
  const BATCH_SIZE = 50;
  const MAX_ASSETS_PER_JOB = 5000;
  const BATCH_DELAY_MS = 800;
  const TYPE_DELAY_MS = 150;
  const HISTORY_KEY = 'baxdev.blast.history';
  const KEY_STORE = 'baxdev.blast.key'; // sessionStorage (tab only), cleared when the tab closes

  const state = { apiKey: '', job: null, filter: 'all', parsed: { valid: [], invalid: [], duplicates: 0 }, wasActive: false, detail: null, runner: null };

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- Roblox via Cloudflare Pages Function (stateless proxy) ----------------
  async function proxy(payload) {
    let res;
    try {
      res = await fetch('/api/roblox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Baxde-Client': '1', 'X-Baxde-Key': state.apiKey },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      return { status: 0, networkError: 'Cannot reach the server function' };
    }
    let data = null;
    try { data = await res.json(); } catch (_) { /* ignore */ }
    if (!data) return { status: 0, networkError: res.status === 404 ? 'API function not deployed (404). Deploy with the functions/ folder.' : `Server returned HTTP ${res.status}` };
    if (data.error && data.status === undefined) return { status: res.status, message: data.error, body: null };
    return data;
  }

  const ERROR_HINTS = {
    AssetNotFound: 'asset does not exist',
    CannotManageAsset: 'API key owner does not own or manage this asset',
    PublicAssetCannotBeGrantedTo: 'asset is already public, no grant needed',
    CannotManageSubject: 'API key owner cannot manage this Universe',
    SubjectNotFound: 'Universe ID not found',
    AssetTypeNotEnabled: 'this asset type does not support the Use permission',
    PermissionLimitReached: 'permission limit reached for this asset',
    DependenciesLimitReached: 'dependency limit reached',
    InvalidRequest: 'Roblox rejected the request format',
  };
  const failAll = (ids, message) => ids.map((assetId) => ({ assetId, status: 'Failed', message }));

  function interpret(res, ids) {
    if (res.networkError) return failAll(ids, `Network error: ${res.networkError}`);
    if (res.status !== 200) return failAll(ids, `HTTP ${res.status}: ${res.message}`);
    const body = res.body || {};
    const granted = new Set((body.successAssetIds || []).map(String));
    const errors = new Map((body.errors || []).map((e) => [String(e.assetId), e]));
    return ids.map((assetId) => {
      const k = String(assetId);
      if (granted.has(k)) return { assetId, status: 'Success', message: 'Permission granted (confirmed in successAssetIds)' };
      if (errors.has(k)) {
        const code = errors.get(k).code || 'UnknownError';
        return { assetId, status: 'Failed', message: ERROR_HINTS[code] ? `${code} - ${ERROR_HINTS[code]}` : String(code) };
      }
      return { assetId, status: 'Failed', message: 'Not confirmed: Roblox returned HTTP 200 but did not list this asset in successAssetIds' };
    });
  }

  // ---- Blast job (runs in the browser, batches strictly sequential) ----------
  class BlastJob {
    constructor(universeId, assetIds, detectTypes, onChange, onFinish) {
      this.id = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now());
      this.universeId = String(universeId);
      this.detectTypes = detectTypes;
      this.onChange = onChange;
      this.onFinish = onFinish;
      this.items = assetIds.map((assetId) => ({ assetId, type: '-', status: 'Pending', message: '' }));
      this.batches = [];
      for (let i = 0; i < this.items.length; i += BATCH_SIZE) this.batches.push({ index: this.batches.length + 1, items: this.items.slice(i, i + BATCH_SIZE), status: 'Pending' });
      this.status = 'idle';
      this.paused = false;
      this.cancelled = false;
      this.inFlight = false;
      this.typeLookupUnavailable = false;
      this.apiStatus = 'Waiting to start';
      this.startedAt = null;
      this.finishedAt = null;
      this.resumeResolver = null;
      this.sleepResolver = null;
    }
    get active() { return this.status === 'running' || this.status === 'paused'; }
    touch() { this.onChange(); }
    start() { this.status = 'running'; this.startedAt = Date.now(); this.touch(); this.run(); }
    pause() { if (this.status !== 'running') return false; this.paused = true; this.status = 'paused'; this.touch(); return true; }
    resume() { if (this.status !== 'paused') return false; this.paused = false; this.status = 'running'; if (this.resumeResolver) this.resumeResolver(); this.touch(); return true; }
    cancel() {
      if (!this.active) return false;
      this.cancelled = true; this.paused = false;
      if (this.resumeResolver) this.resumeResolver();
      if (this.sleepResolver) this.sleepResolver();
      this.apiStatus = this.inFlight ? 'Cancelling after the request in flight' : 'Cancelling';
      this.touch();
      return true;
    }
    sleep(ms) {
      return new Promise((resolve) => {
        const t = setTimeout(done, ms);
        const self = this;
        function done() { clearTimeout(t); self.sleepResolver = null; resolve(); }
        this.sleepResolver = done;
      });
    }
    async waitIfPaused() {
      while (this.paused && !this.cancelled) {
        await new Promise((r) => { this.resumeResolver = r; });
        this.resumeResolver = null;
      }
    }
    async detect(items) {
      for (const item of items) {
        if (this.cancelled || this.typeLookupUnavailable) return;
        const r = await proxy({ op: 'type', assetId: item.assetId });
        if (r.type) {
          item.type = r.type;
          if (r.type === 'Place') { item.status = 'Skipped'; item.message = 'Place assets do not support the Use action (Roblox docs list Download / CopyFromRcc / UpdateFromRcc)'; }
        } else {
          item.type = 'Unknown';
          if (r.status === 401 || r.status === 403) { this.typeLookupUnavailable = true; this.apiStatus = 'Type detection unavailable: API key lacks asset:read. Continuing without it'; }
        }
        this.touch();
        await this.sleep(TYPE_DELAY_MS);
      }
    }
    async grantBatch(ids) {
      let rate = 0; let transient = 0;
      for (;;) {
        if (this.cancelled) return { cancelled: true };
        const res = await proxy({ op: 'grant', universeId: this.universeId, assetIds: ids });
        if (res.status === 429) {
          if (rate >= 5) return { results: failAll(ids, 'HTTP 429: rate limit persisted after 5 retries'), http: 429 };
          rate += 1;
          const wait = res.retryAfterMs != null ? res.retryAfterMs : Math.min(60000, 1000 * 2 ** rate);
          this.apiStatus = `Rate limited (429). Retry ${rate}/5 in ${Math.ceil(wait / 1000)}s`; this.touch();
          await this.sleep(wait);
          continue;
        }
        if ((res.networkError || res.status >= 500) && transient < 2) {
          transient += 1;
          const wait = 2000 * transient;
          this.apiStatus = `Transient error. Retry ${transient}/2 in ${wait / 1000}s`; this.touch();
          await this.sleep(wait);
          continue;
        }
        return { results: interpret(res, ids), http: res.status };
      }
    }
    async processBatch(batch, total) {
      batch.status = 'Processing'; this.inFlight = true;
      batch.items.forEach((i) => { i.status = 'Processing'; });
      this.apiStatus = `Sending batch ${batch.index}/${total}`; this.touch();
      if (this.detectTypes && !this.typeLookupUnavailable) await this.detect(batch.items);
      const toSend = batch.items.filter((i) => i.status === 'Processing');
      if (toSend.length && !this.cancelled) {
        const out = await this.grantBatch(toSend.map((i) => i.assetId));
        if (out.cancelled) {
          toSend.forEach((i) => { i.status = 'Skipped'; i.message = 'Cancelled before Roblox confirmed this request'; });
        } else {
          const byId = new Map(out.results.map((r) => [r.assetId, r]));
          toSend.forEach((i) => { const r = byId.get(i.assetId); i.status = r.status; i.message = r.message; });
          this.apiStatus = out.http === 200 ? `Connected. Batch ${batch.index} answered HTTP 200` : `Batch ${batch.index} answered HTTP ${out.http || 'network error'}`;
        }
      } else if (this.cancelled) {
        toSend.forEach((i) => { i.status = 'Skipped'; i.message = 'Cancelled before Roblox confirmed this request'; });
      }
      batch.status = 'Done'; this.inFlight = false; this.touch();
    }
    async run() {
      try {
        for (let i = 0; i < this.batches.length; i += 1) {
          await this.waitIfPaused();
          if (this.cancelled) break;
          await this.processBatch(this.batches[i], this.batches.length);
          if (this.cancelled) break;
          if (i < this.batches.length - 1) await this.sleep(BATCH_DELAY_MS);
        }
      } catch (err) {
        this.apiStatus = 'Internal error while processing';
        this.items.forEach((i) => { if (i.status === 'Processing') { i.status = 'Failed'; i.message = `Internal error: ${err && err.message ? err.message : 'unknown'}`; } });
      }
      this.items.forEach((i) => { if (i.status === 'Pending' || i.status === 'Processing') { i.status = 'Skipped'; i.message = this.cancelled ? 'Cancelled by user' : 'Not processed'; } });
      this.inFlight = false;
      this.status = this.cancelled ? 'cancelled' : 'completed';
      this.finishedAt = Date.now();
      this.apiStatus = this.cancelled ? 'Cancelled' : 'Finished';
      this.touch();
      try { this.onFinish(this.toHistoryEntry()); } catch (_) { /* history must not break the job */ }
    }
    totals() {
      const t = { total: this.items.length, success: 0, failed: 0, pending: 0, processing: 0, skipped: 0 };
      for (const i of this.items) {
        if (i.status === 'Success') t.success += 1; else if (i.status === 'Failed') t.failed += 1;
        else if (i.status === 'Pending') t.pending += 1; else if (i.status === 'Processing') t.processing += 1; else if (i.status === 'Skipped') t.skipped += 1;
      }
      t.batches = this.batches.length;
      t.batchesDone = this.batches.filter((b) => b.status === 'Done').length;
      t.progress = t.total ? Math.round(((t.success + t.failed + t.skipped) / t.total) * 100) : 0;
      return t;
    }
    toHistoryEntry() {
      const t = this.totals();
      return { id: this.id, universeId: this.universeId, startedAt: this.startedAt, finishedAt: this.finishedAt, status: this.status, total: t.total, success: t.success, failed: t.failed, skipped: t.skipped, batches: t.batches, items: this.items.map(({ assetId, type, status, message }) => ({ assetId, type, status, message })) };
    }
  }

  // ---- history (localStorage, never contains the API key) --------------------
  function readHistory() { try { const a = JSON.parse(localStorage.getItem(HISTORY_KEY)); return Array.isArray(a) ? a : []; } catch (_) { return []; } }
  function writeHistory(list) {
    let l = list.slice(0, 30);
    for (;;) {
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify(l)); return; } catch (_) {
        if (l.length <= 1) return;
        l = l.slice(0, l.length - 1);
      }
    }
  }

  // ---- helpers ---------------------------------------------------------------
  function parseIds(text) {
    const valid = []; const invalid = []; const seen = new Set(); let duplicates = 0;
    for (const raw of text.split(/[\s,;]+/)) {
      const t = raw.trim();
      if (!t) continue;
      if (!/^\d{1,16}$/.test(t) || Number(t) <= 0) { invalid.push(t); continue; }
      const n = String(Number(t));
      if (seen.has(n)) { duplicates += 1; continue; }
      seen.add(n); valid.push(n);
    }
    return { valid, invalid, duplicates };
  }
  const fmtTime = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); return `${h ? `${h}:` : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(s % 60).padStart(2, '0')}`; };
  const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString() : '-');
  function download(name, text, mime) {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function reportTxt(meta, items) {
    const head = ['BaxdeStudio Asset Permission Blaster - Report', `Universe ID : ${meta.universeId}`, `Started     : ${fmtDate(meta.startedAt)}`, `Finished    : ${fmtDate(meta.finishedAt)}`, `Status      : ${meta.status}`, `Total ${meta.total} | Success ${meta.success} | Failed ${meta.failed} | Skipped ${meta.skipped}`, '', 'Asset ID\tType\tStatus\tResponse'];
    return head.concat(items.map((i) => `${i.assetId}\t${i.type}\t${i.status}\t${i.message}`)).join('\n') + '\n';
  }
  function reportCsv(items) {
    const q = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    return ['Asset ID,Type,Status,Response'].concat(items.map((i) => [i.assetId, i.type, i.status, i.message].map(q).join(','))).join('\n') + '\n';
  }
  function metaFromJob(job) { const t = job.totals(); return { universeId: job.universeId, startedAt: job.startedAt, finishedAt: job.finishedAt, status: job.status, total: t.total, success: t.success, failed: t.failed, skipped: t.skipped }; }
  const rowsHtml = (items) => items.map((i) => `<tr><td>${esc(i.assetId)}</td><td>${esc(i.type)}</td><td><span class="baxdev-badge ${esc(i.status)}">${esc(i.status)}</span></td><td>${esc(i.message)}</td></tr>`).join('');

  // ---- API key ---------------------------------------------------------------
  const maskKey = (k) => `${'*'.repeat(12)}${k.slice(-4)}`;
  const validKey = (v) => { const s = String(v || '').trim(); return s.length >= 20 && s.length <= 4096 && /^[\x21-\x7E]+$/.test(s) ? s : null; };
  function setPill(s, text) { $('apiPill').dataset.state = s; $('apiPillText').textContent = text; }
  function applyKey() {
    $('savedKey').textContent = state.apiKey ? `Stored in this browser tab only: ${maskKey(state.apiKey)}` : 'No key stored.';
    if (!state.apiKey) setPill('', 'API key not set');
    else if ($('apiPill').dataset.state !== 'connected') setPill('saved', 'Key saved, not tested');
    updateButtons();
  }
  $('toggleKey').addEventListener('click', () => { const i = $('apiKey'); const show = i.type === 'password'; i.type = show ? 'text' : 'password'; $('toggleKey').textContent = show ? 'Hide' : 'Show'; });
  $('saveKey').addEventListener('click', () => {
    const k = validKey($('apiKey').value);
    if (!k) { $('testResult').textContent = 'API key looks invalid (printable characters only, 20 or more).'; return; }
    state.apiKey = k;
    try { sessionStorage.setItem(KEY_STORE, k); } catch (_) { /* memory only */ }
    $('apiKey').value = ''; $('apiKey').type = 'password'; $('toggleKey').textContent = 'Show';
    $('testResult').textContent = 'Key saved. Run the connection test to check it.';
    setPill('saved', 'Key saved, not tested'); applyKey();
  });
  $('testKey').addEventListener('click', async () => {
    if (!state.apiKey) { $('testResult').textContent = 'Save an API key first.'; return; }
    $('testResult').textContent = 'Testing...';
    const r = await proxy({ op: 'probe', universeId: $('universeId').value.trim() });
    let st; let msg;
    if (r.networkError) { st = 'error'; msg = `Cannot reach Roblox: ${r.networkError}`; }
    else if (r.status === 401) { st = 'invalid'; msg = `API key rejected (401): ${r.message}`; }
    else if (r.status === 403) { st = 'denied'; msg = `Access denied (403): ${r.message}. Check the scope asset-permissions:write and the IP allowlist (Cloudflare uses many IPs: use 0.0.0.0/0 if you accept the risk).`; }
    else if (r.status === 429) { st = 'limited'; msg = 'Rate limited (429). Try again shortly.'; }
    else if (r.status === 200 || r.status === 400) { st = 'connected'; msg = `Roblox accepted the key (HTTP ${r.status} on an empty, non-mutating probe). Scope and asset ownership can only be confirmed by a real grant.`; }
    else { st = 'error'; msg = `Unexpected response (${r.status}): ${r.message || ''}`; }
    $('testResult').textContent = msg;
    if (st === 'connected') setPill('connected', `Connected (HTTP ${r.status})`); else setPill('bad', st === 'limited' ? 'Rate limited' : 'Connection problem');
  });
  $('clearKey').addEventListener('click', () => {
    if (state.job && state.job.active) return;
    state.apiKey = ''; try { sessionStorage.removeItem(KEY_STORE); } catch (_) { /* ignore */ }
    $('apiKey').value = ''; $('testResult').textContent = 'Key cleared.'; applyKey();
  });

  // ---- asset input -----------------------------------------------------------
  function refreshInput() {
    const p = parseIds($('assetInput').value); state.parsed = p;
    $('assetCount').textContent = `${p.valid.length} asset${p.valid.length === 1 ? '' : 's'}`;
    const b = Math.ceil(p.valid.length / BATCH_SIZE);
    const parts = [`${p.valid.length} valid`, `${b} batch${b === 1 ? '' : 'es'} of up to 50`];
    if (p.duplicates) parts.push(`${p.duplicates} duplicate${p.duplicates === 1 ? '' : 's'} ignored`);
    if (p.invalid.length) parts.push(`${p.invalid.length} invalid: ${p.invalid.slice(0, 3).join(', ')}${p.invalid.length > 3 ? ' ...' : ''}`);
    $('assetStats').textContent = p.valid.length || p.invalid.length ? parts.join(' | ') : 'Paste IDs or import a TXT file.';
    updateButtons();
  }
  function cleanList() { $('assetInput').value = state.parsed.valid.join('\n'); refreshInput(); }
  $('assetInput').addEventListener('input', refreshInput);
  $('assetInput').addEventListener('paste', () => setTimeout(cleanList, 0));
  $('cleanList').addEventListener('click', cleanList);
  $('clearList').addEventListener('click', () => { $('assetInput').value = ''; refreshInput(); });
  $('importTxt').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', async (ev) => {
    const f = ev.target.files[0]; if (!f) return;
    const text = await f.text(); const cur = $('assetInput').value.trim();
    $('assetInput').value = cur ? `${cur}\n${text}` : text; ev.target.value = ''; refreshInput(); cleanList();
  });
  $('universeId').addEventListener('input', updateButtons);

  // ---- rendering -------------------------------------------------------------
  const TILES = [['universe', 'Target Universe'], ['total', 'Total Asset ID'], ['batches', 'Total Batch'], ['success', 'Total Success'], ['failed', 'Total Failed'], ['pending', 'Total Pending'], ['progress', 'Progress'], ['elapsed', 'Elapsed time']];
  $('tiles').innerHTML = TILES.map(([k, l]) => `<div class="baxdev-tile"><span>${l}</span><strong id="t_${k}">-</strong></div>`).join('');
  const setTile = (k, v) => { $(`t_${k}`).textContent = v; };
  const elapsedMs = (j) => (j && j.startedAt ? (j.finishedAt || Date.now()) - j.startedAt : 0);

  let renderQueued = false;
  function scheduleRender() { if (renderQueued) return; renderQueued = true; requestAnimationFrame(() => { renderQueued = false; renderJob(); }); }

  function renderJob() {
    const job = state.job;
    if (!job) {
      ['universe', 'total', 'batches', 'success', 'failed', 'pending', 'progress', 'elapsed'].forEach((k) => setTile(k, '-'));
      $('barFill').style.width = '0'; $('jobStatus').textContent = 'Idle'; $('apiStatus').textContent = 'API status: waiting';
      $('resultBody').innerHTML = ''; $('resultNote').textContent = 'No results yet. Start a blast to see each asset here.';
      updateButtons(); return;
    }
    const t = job.totals();
    setTile('universe', job.universeId); setTile('total', t.total); setTile('batches', `${t.batchesDone}/${t.batches}`);
    setTile('success', t.success); setTile('failed', t.failed); setTile('pending', t.pending + t.processing);
    setTile('progress', `${t.progress}%`); setTile('elapsed', fmtTime(elapsedMs(job)));
    $('barFill').style.width = `${t.progress}%`;
    $('jobStatus').textContent = job.status === 'paused' && job.inFlight ? 'Pausing after the current batch' : job.status.charAt(0).toUpperCase() + job.status.slice(1);
    $('apiStatus').textContent = `API status: ${job.apiStatus}`;
    renderResults(); updateButtons();
    const active = job.active;
    if (state.wasActive && !active) { loadHistory(); setPill(state.apiKey ? 'saved' : '', state.apiKey ? 'Key saved' : 'API key not set'); }
    state.wasActive = active;
  }
  function renderResults() {
    const job = state.job; if (!job) return;
    const f = state.filter;
    const items = job.items.filter((i) => (f === 'all' ? true : f === 'Pending' ? i.status === 'Pending' || i.status === 'Processing' : i.status === f));
    $('resultBody').innerHTML = rowsHtml(items.slice(0, ROW_LIMIT));
    $('resultNote').textContent = items.length > ROW_LIMIT ? `Showing ${ROW_LIMIT} of ${items.length} rows. Export the report to get every row.` : `${items.length} row${items.length === 1 ? '' : 's'} shown.`;
  }
  function updateButtons() {
    const job = state.job;
    const active = Boolean(job && job.active);
    $('btnStart').disabled = !(!active && state.apiKey && state.parsed.valid.length > 0 && /^\d+$/.test($('universeId').value.trim()));
    $('btnPause').disabled = !(job && job.status === 'running');
    $('btnResume').disabled = !(job && job.status === 'paused');
    $('btnCancel').disabled = !active;
    $('btnReset').disabled = !job || active;
    $('retryFailed').disabled = !job || job.totals().failed === 0;
    $('exportTxt').disabled = !job; $('exportCsv').disabled = !job;
    $('clearKey').disabled = active;
    if (active) setPill('connected', 'Blasting');
  }

  function startBlast() {
    $('actionError').textContent = '';
    if (!state.apiKey) { $('actionError').textContent = 'Save an API key first.'; return; }
    if (state.job && state.job.active) { $('actionError').textContent = 'A blast is already running.'; return; }
    const uid = $('universeId').value.trim();
    if (!/^\d{1,16}$/.test(uid) || Number(uid) <= 0) { $('actionError').textContent = 'Universe ID must be a positive number.'; return; }
    if (state.parsed.invalid.length) { $('actionError').textContent = `Invalid Asset IDs: ${state.parsed.invalid.slice(0, 5).join(', ')}`; return; }
    if (!state.parsed.valid.length) { $('actionError').textContent = 'Add at least one Asset ID.'; return; }
    if (state.parsed.valid.length > MAX_ASSETS_PER_JOB) { $('actionError').textContent = `Maximum ${MAX_ASSETS_PER_JOB} assets per job.`; return; }
    state.job = new BlastJob(String(Number(uid)), state.parsed.valid.map(Number), $('detectTypes').checked, scheduleRender, (entry) => { writeHistory([entry].concat(readHistory())); });
    state.job.start();
  }
  const jobAct = (name) => () => { $('actionError').textContent = ''; const j = state.job; if (!j) { $('actionError').textContent = 'No job.'; return; } if (!j[name]()) $('actionError').textContent = `Cannot ${name} while the job is ${j.status}.`; renderJob(); };
  $('btnStart').addEventListener('click', startBlast);
  $('btnPause').addEventListener('click', jobAct('pause'));
  $('btnResume').addEventListener('click', jobAct('resume'));
  $('btnCancel').addEventListener('click', jobAct('cancel'));
  $('btnReset').addEventListener('click', () => { if (state.job && state.job.active) { $('actionError').textContent = 'Cancel the running blast first.'; return; } state.job = null; state.wasActive = false; renderJob(); });

  $('filters').addEventListener('click', (ev) => {
    const b = ev.target.closest('.baxdev-filter'); if (!b) return;
    state.filter = b.dataset.filter;
    document.querySelectorAll('.baxdev-filter').forEach((x) => x.classList.toggle('active', x === b));
    renderResults();
  });
  $('exportTxt').addEventListener('click', () => state.job && download(`blast-${state.job.universeId}.txt`, reportTxt(metaFromJob(state.job), state.job.items), 'text/plain'));
  $('exportCsv').addEventListener('click', () => state.job && download(`blast-${state.job.universeId}.csv`, reportCsv(state.job.items), 'text/csv'));
  $('retryFailed').addEventListener('click', () => { if (!state.job) return; $('assetInput').value = state.job.items.filter((i) => i.status === 'Failed').map((i) => i.assetId).join('\n'); refreshInput(); });

  // ---- history UI ------------------------------------------------------------
  function loadHistory() {
    const entries = readHistory(); const box = $('historyList');
    if (!entries.length) { box.innerHTML = '<p class="baxdev-empty">No blasts recorded yet.</p>'; return; }
    box.innerHTML = entries.map((e) => `
      <div class="baxdev-h-item">
        <p><strong>Universe ${esc(e.universeId)}</strong><br>${esc(fmtDate(e.startedAt))}<br>
        ${e.total} assets | ${e.success} success | ${e.failed} failed | ${esc(e.status)}</p>
        <div class="baxdev-row wrap flush">
          <button class="baxdev-button ghost small" data-view="${esc(e.id)}" type="button">View details</button>
          <button class="baxdev-button ghost small" data-export="${esc(e.id)}" type="button">Export report</button>
        </div>
      </div>`).join('');
  }
  const findEntry = (id) => readHistory().find((e) => e.id === id) || null;
  $('historyList').addEventListener('click', (ev) => {
    const view = ev.target.closest('[data-view]'); const exp = ev.target.closest('[data-export]');
    if (view) {
      const e = findEntry(view.dataset.view); if (!e) return;
      state.detail = e;
      $('detailTitle').textContent = `Universe ${e.universeId}`;
      $('detailMeta').textContent = `${fmtDate(e.startedAt)} | ${e.total} assets | ${e.success} success | ${e.failed} failed | ${e.skipped} skipped | ${e.status}${e.items.length > ROW_LIMIT ? ` | showing first ${ROW_LIMIT}, export for all` : ''}`;
      $('detailBody').innerHTML = rowsHtml(e.items.slice(0, ROW_LIMIT));
      $('detailDialog').showModal();
    } else if (exp) {
      const e = findEntry(exp.dataset.export); if (e) download(`report-${e.universeId}-${e.startedAt}.txt`, reportTxt(e, e.items), 'text/plain');
    }
  });
  $('detailClose').addEventListener('click', () => $('detailDialog').close());
  $('detailTxt').addEventListener('click', () => state.detail && download(`report-${state.detail.universeId}.txt`, reportTxt(state.detail, state.detail.items), 'text/plain'));
  $('detailCsv').addEventListener('click', () => state.detail && download(`report-${state.detail.universeId}.csv`, reportCsv(state.detail.items), 'text/csv'));
  $('clearHistory').addEventListener('click', () => { if (!confirm('Delete all blast history? This cannot be undone.')) return; try { localStorage.removeItem(HISTORY_KEY); } catch (_) { /* ignore */ } loadHistory(); });

  // warn before leaving mid-blast (the queue lives in this tab)
  window.addEventListener('beforeunload', (e) => { if (state.job && state.job.active) { e.preventDefault(); e.returnValue = ''; } });
  setInterval(() => { if (state.job && state.job.active) setTile('elapsed', fmtTime(elapsedMs(state.job))); }, 500);

  // ---- boot ------------------------------------------------------------------
  try { state.apiKey = sessionStorage.getItem(KEY_STORE) || ''; } catch (_) { state.apiKey = ''; }
  refreshInput(); applyKey(); loadHistory(); renderJob();
})();
