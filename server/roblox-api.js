'use strict';

/*
 * Thin client for the Roblox Open Cloud endpoints used by this app.
 * Verified against https://create.roblox.com/docs/cloud/reference/domains/apis
 *
 *   PATCH /asset-permissions-api/v1/assets/permissions   (scope: asset-permissions:write)
 *   body: { subjectType, subjectId, action, requests: [{ assetId }] }
 *   200 : { successAssetIds: number[], errors: [{ assetId, code }] }
 *   rate limit: 100 requests / minute per API key owner
 *
 *   GET /assets/v1/assets/{assetId}                      (scope: asset:read, optional)
 */

const BASE_URL = 'https://apis.roblox.com';
const PERMISSIONS_PATH = '/asset-permissions-api/v1/assets/permissions';
const REQUEST_TIMEOUT_MS = 30000;

function redact(text, apiKey) {
  let out = String(text == null ? '' : text);
  if (apiKey) out = out.split(apiKey).join('[redacted]');
  return out;
}

function parseRetryAfter(headers) {
  const raw = headers.get('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 120) * 1000;
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), 120000);
  return null;
}

function extractMessage(body, rawText) {
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
  const text = String(rawText || '').trim();
  return text ? text.slice(0, 300) : 'No error message returned by Roblox';
}

async function request(method, path, apiKey, jsonBody) {
  try {
    const res = await fetch(BASE_URL + path, {
      method,
      headers: {
        'x-api-key': apiKey,
        Accept: 'application/json',
        ...(jsonBody ? { 'Content-Type': 'application/json' } : {}),
      },
      body: jsonBody ? JSON.stringify(jsonBody) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const rawText = await res.text();
    let body = null;
    try {
      body = rawText ? JSON.parse(rawText) : null;
    } catch (_) {
      body = null;
    }
    return {
      status: res.status,
      ok: res.ok,
      body,
      message: redact(extractMessage(body, rawText), apiKey),
      retryAfterMs: parseRetryAfter(res.headers),
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 0,
      ok: false,
      body: null,
      networkError: timedOut
        ? 'Request timed out; outcome unknown'
        : redact((err && err.cause && err.cause.code) || (err && err.message) || 'Network error', apiKey),
    };
  }
}

function grantPermissions({ apiKey, universeId, assetIds }) {
  return request('PATCH', PERMISSIONS_PATH, apiKey, {
    subjectType: 'Universe',
    subjectId: String(universeId),
    action: 'Use',
    requests: assetIds.map((assetId) => ({ assetId })),
  });
}

// Non-mutating probe: an empty grant list never changes any permission.
function probeConnection({ apiKey, universeId }) {
  return request('PATCH', PERMISSIONS_PATH, apiKey, {
    subjectType: 'Universe',
    subjectId: String(universeId || '1'),
    action: 'Use',
    requests: [],
  });
}

async function getAssetType({ apiKey, assetId }) {
  const res = await request('GET', `/assets/v1/assets/${assetId}`, apiKey);
  if (res.ok && res.body && res.body.assetType) return { type: String(res.body.assetType), status: res.status };
  return { type: null, status: res.status };
}

module.exports = { grantPermissions, probeConnection, getAssetType, redact };
