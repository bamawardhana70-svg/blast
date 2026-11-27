'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const express = require('express');

const { BlastJob } = require('./queue');
const permissionService = require('./permission-service');
const history = require('./history');
const {
  MAX_ASSETS_PER_JOB,
  parseAssetIds,
  validateUniverseId,
  validateApiKey,
} = require('./validator');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';

// The API key exists only here, in process memory. It is never written to disk,
// never logged and never sent back to the browser (only the last 4 characters).
const session = { apiKey: validateApiKey(process.env.ROBLOX_API_KEY || '') };
let currentJob = null;

const maskKey = (key) => (key ? `${'*'.repeat(12)}${key.slice(-4)}` : null);
const fail = (res, status, message) => res.status(status).json({ error: message });

const app = express();
app.disable('x-powered-by');

// Security headers and local-only guards ------------------------------------
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// DNS-rebinding protection: only answer to loopback host names.
app.use((req, res, next) => {
  if (HOST !== '127.0.0.1' && HOST !== 'localhost') return next();
  const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  if (['localhost', '127.0.0.1', '[::1]'].includes(host)) return next();
  return fail(res, 403, 'Forbidden host');
});

// CSRF protection for state-changing calls.
app.use('/api', (req, res, next) => {
  if (req.method === 'GET') return next();
  if (req.get('x-baxde-client') !== '1') return fail(res, 403, 'Missing client header');
  const origin = req.get('origin');
  if (origin) {
    try {
      if (new URL(origin).host !== req.get('host')) return fail(res, 403, 'Cross-origin request blocked');
    } catch (_) {
      return fail(res, 403, 'Invalid origin');
    }
  }
  return next();
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Config ---------------------------------------------------------------------
app.get('/api/config', (req, res) => {
  res.json({ hasKey: Boolean(session.apiKey), maskedKey: maskKey(session.apiKey) });
});

app.post('/api/config/key', (req, res) => {
  const key = validateApiKey(req.body && req.body.apiKey);
  if (!key) return fail(res, 400, 'API key looks invalid (printable characters only, 20 or more).');
  session.apiKey = key;
  res.json({ hasKey: true, maskedKey: maskKey(key) });
});

app.delete('/api/config/key', (req, res) => {
  if (currentJob && currentJob.active) return fail(res, 409, 'A blast is running. Cancel it before clearing the key.');
  session.apiKey = null;
  res.json({ hasKey: false, maskedKey: null });
});

app.post('/api/config/test', async (req, res) => {
  if (!session.apiKey) return fail(res, 400, 'Save an API key first.');
  const universeId = validateUniverseId(req.body && req.body.universeId) || '1';
  res.json(await permissionService.testConnection({ apiKey: session.apiKey, universeId }));
});

// Jobs -----------------------------------------------------------------------
app.post('/api/jobs', (req, res) => {
  if (!session.apiKey) return fail(res, 400, 'Save an API key first.');
  if (currentJob && currentJob.active) return fail(res, 409, 'A blast is already running.');

  const body = req.body || {};
  const universeId = validateUniverseId(body.universeId);
  if (!universeId) return fail(res, 400, 'Universe ID must be a positive number.');

  const { valid, invalid } = parseAssetIds(body.assetIds);
  if (invalid.length) return fail(res, 400, `Invalid Asset IDs: ${invalid.slice(0, 5).join(', ')}${invalid.length > 5 ? ' ...' : ''}`);
  if (!valid.length) return fail(res, 400, 'Add at least one Asset ID.');
  if (valid.length > MAX_ASSETS_PER_JOB) return fail(res, 400, `Maximum ${MAX_ASSETS_PER_JOB} assets per job.`);

  currentJob = new BlastJob({
    apiKey: session.apiKey,
    universeId,
    assetIds: valid,
    detectTypes: body.detectTypes === true,
    onFinish: (entry) => history.add(entry),
  });
  currentJob.start();
  return res.status(202).json({ job: currentJob.snapshot() });
});

app.get('/api/jobs/current', (req, res) => {
  if (!currentJob) return res.json({ job: null, serverNow: Date.now() });
  if (String(currentJob.version) === String(req.query.v) && String(currentJob.id) === String(req.query.id)) {
    return res.json({ unchanged: true, serverNow: Date.now() });
  }
  return res.json({ job: currentJob.snapshot(), serverNow: Date.now() });
});

function jobAction(name, handler) {
  app.post(`/api/jobs/current/${name}`, (req, res) => {
    if (!currentJob) return fail(res, 404, 'No job.');
    if (!handler(currentJob)) return fail(res, 409, `Cannot ${name} while the job is ${currentJob.status}.`);
    return res.json({ job: currentJob.snapshot() });
  });
}
jobAction('pause', (j) => j.pause());
jobAction('resume', (j) => j.resume());
jobAction('cancel', (j) => j.cancel());

app.post('/api/jobs/current/reset', (req, res) => {
  if (currentJob && currentJob.active) return fail(res, 409, 'Cancel the running blast first.');
  currentJob = null;
  res.json({ job: null });
});

// History --------------------------------------------------------------------
app.get('/api/history', async (req, res) => res.json({ entries: await history.list() }));

app.get('/api/history/:id', async (req, res) => {
  const entry = await history.get(req.params.id);
  return entry ? res.json({ entry }) : fail(res, 404, 'History entry not found.');
});

app.delete('/api/history', async (req, res) => {
  await history.clear();
  res.json({ entries: [] });
});

app.use('/api', (req, res) => fail(res, 404, 'Unknown endpoint.'));

// Final error handler: never echo internals.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err && err.status >= 400 && err.status < 500 ? err.status : 500;
  fail(res, status, status === 500 ? 'Internal server error.' : 'Bad request.');
});

app.listen(PORT, HOST, () => {
  console.log(`BaxdeStudio Asset Permission Blaster running at http://${HOST}:${PORT}`);
});
