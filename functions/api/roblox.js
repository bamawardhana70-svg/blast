// Cloudflare Pages Function: stateless proxy ke Roblox Open Cloud.
// Browser tidak bisa memanggil apis.roblox.com langsung (CORS), jadi request
// diteruskan lewat sini. API key dikirim per request lewat header, TIDAK disimpan,
// TIDAK dilog, dan dibersihkan dari pesan error.

const BASE_URL = 'https://apis.roblox.com';
const PERMISSIONS_PATH = '/asset-permissions-api/v1/assets/permissions';
const TIMEOUT_MS = 25000;
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });

const redact = (t, k) => (k ? String(t == null ? '' : t).split(k).join('[redacted]') : String(t == null ? '' : t));

function parseRetryAfter(headers) {
  const raw = headers.get('retry-after');
  if (!raw) return null;
  const s = Number(raw);
  if (Number.isFinite(s) && s >= 0) return Math.min(s, 120) * 1000;
  const d = Date.parse(raw);
  return Number.isNaN(d) ? null : Math.min(Math.max(d - Date.now(), 0), 120000);
}

function extractMessage(body, raw) {
  if (body && typeof body === 'object') {
    if (body.error && typeof body.error === 'object') {
      const e = body.error;
      return [e.code, e.message].filter(Boolean).join(': ') || JSON.stringify(body.error);
    }
    if (body.errorMessage) return [body.errorCode, body.errorMessage].filter(Boolean).join(': ');
    if (body.message) return String(body.message);
    if (body.detail || body.title) return [body.title, body.detail].filter(Boolean).join(': ');
    if (Array.isArray(body.errors) && body.errors.length) return JSON.stringify(body.errors).slice(0, 300);
  }
  const t = String(raw || '').trim();
  return t ? t.slice(0, 300) : 'No error message returned by Roblox';
}

async function callRoblox(method, path, apiKey, payload) {
  try {
    const res = await fetch(BASE_URL + path, {
      method,
      headers: {
        'x-api-key': apiKey,
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json' } : {}),
      },
      body: payload ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const raw = await res.text();
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch (_) { body = null; }
    return {
      status: res.status,
      body,
      message: redact(extractMessage(body, raw), apiKey),
      retryAfterMs: parseRetryAfter(res.headers),
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { status: 0, body: null, networkError: timedOut ? 'Request timed out; outcome unknown' : redact((err && err.message) || 'Network error', apiKey) };
  }
}

const validId = (v) => {
  const s = String(v == null ? '' : v).trim();
  return /^\d{1,16}$/.test(s) && Number(s) > 0 ? String(Number(s)) : null;
};

export async function onRequestPost({ request }) {
  if (request.headers.get('x-baxde-client') !== '1') return json({ error: 'Missing client header' }, 403);
  const origin = request.headers.get('origin');
  if (origin) {
    try {
      if (new URL(origin).host !== new URL(request.url).host) return json({ error: 'Cross-origin request blocked' }, 403);
    } catch (_) {
      return json({ error: 'Invalid origin' }, 403);
    }
  }

  const apiKey = (request.headers.get('x-baxde-key') || '').trim();
  if (apiKey.length < 20 || apiKey.length > 4096 || !/^[\x21-\x7E]+$/.test(apiKey)) {
    return json({ error: 'API key looks invalid (printable characters only, 20 or more).' }, 400);
  }

  let body;
  try { body = await request.json(); } catch (_) { return json({ error: 'Bad JSON body' }, 400); }

  if (body.op === 'probe') {
    const universeId = validId(body.universeId) || '1';
    return json(await callRoblox('PATCH', PERMISSIONS_PATH, apiKey, { subjectType: 'Universe', subjectId: universeId, action: 'Use', requests: [] }));
  }

  if (body.op === 'grant') {
    const universeId = validId(body.universeId);
    if (!universeId) return json({ error: 'Universe ID must be a positive number.' }, 400);
    const ids = Array.isArray(body.assetIds) ? body.assetIds.map(validId) : [];
    if (!ids.length || ids.length > 50 || ids.some((x) => !x)) return json({ error: 'assetIds must contain 1-50 valid IDs.' }, 400);
    return json(await callRoblox('PATCH', PERMISSIONS_PATH, apiKey, {
      subjectType: 'Universe', subjectId: universeId, action: 'Use',
      requests: ids.map((id) => ({ assetId: Number(id) })),
    }));
  }

  if (body.op === 'type') {
    const id = validId(body.assetId);
    if (!id) return json({ error: 'Invalid asset ID.' }, 400);
    const r = await callRoblox('GET', `/assets/v1/assets/${id}`, apiKey);
    const type = r.status === 200 && r.body && r.body.assetType ? String(r.body.assetType) : null;
    return json({ status: r.status, type });
  }

  return json({ error: 'Unknown operation.' }, 400);
}

export const onRequest = () => json({ error: 'Method not allowed' }, 405);
