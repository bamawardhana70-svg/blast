'use strict';

const robloxApi = require('./roblox-api');

const MAX_RETRIES_429 = 5;
const MAX_RETRIES_TRANSIENT = 2;

// Hints are appended AFTER the raw Roblox error code, never instead of it.
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

function failAll(assetIds, message) {
  return assetIds.map((assetId) => ({ assetId, status: 'Failed', message }));
}

function interpret(res, assetIds) {
  if (res.networkError) return failAll(assetIds, `Network error: ${res.networkError}`);
  if (res.status !== 200) return failAll(assetIds, `HTTP ${res.status}: ${res.message}`);

  const body = res.body || {};
  const granted = new Set((body.successAssetIds || []).map(String));
  const errors = new Map((body.errors || []).map((e) => [String(e.assetId), e]));

  return assetIds.map((assetId) => {
    const key = String(assetId);
    if (granted.has(key)) {
      return { assetId, status: 'Success', message: 'Permission granted (confirmed in successAssetIds)' };
    }
    if (errors.has(key)) {
      const code = errors.get(key).code || 'UnknownError';
      const hint = ERROR_HINTS[code];
      return { assetId, status: 'Failed', message: hint ? `${code} - ${hint}` : String(code) };
    }
    // HTTP 200 alone is not proof. Roblox documents that a key without the right
    // scope may return success without applying anything.
    return {
      assetId,
      status: 'Failed',
      message: 'Not confirmed: Roblox returned HTTP 200 but did not list this asset in successAssetIds',
    };
  });
}

/**
 * Sends one batch (max 50 ids, enforced by the queue) and retries safely.
 * Returns { cancelled: true } or { results, http }.
 */
async function grantBatch({ apiKey, universeId, assetIds, control }) {
  let rateAttempts = 0;
  let transientAttempts = 0;

  for (;;) {
    if (control.isCancelled()) return { cancelled: true };

    const res = await robloxApi.grantPermissions({ apiKey, universeId, assetIds });

    if (res.status === 429) {
      if (rateAttempts >= MAX_RETRIES_429) {
        return { results: failAll(assetIds, `HTTP 429: rate limit persisted after ${MAX_RETRIES_429} retries`), http: 429 };
      }
      rateAttempts += 1;
      const waitMs = res.retryAfterMs != null ? res.retryAfterMs : Math.min(60000, 1000 * 2 ** rateAttempts);
      control.onWait(`Rate limited (429). Retry ${rateAttempts}/${MAX_RETRIES_429} in ${Math.ceil(waitMs / 1000)}s`);
      await control.sleep(waitMs);
      continue;
    }

    if ((res.networkError || res.status >= 500) && transientAttempts < MAX_RETRIES_TRANSIENT) {
      transientAttempts += 1;
      const waitMs = 2000 * transientAttempts;
      control.onWait(`Transient error. Retry ${transientAttempts}/${MAX_RETRIES_TRANSIENT} in ${waitMs / 1000}s`);
      await control.sleep(waitMs);
      continue;
    }

    return { results: interpret(res, assetIds), http: res.status };
  }
}

async function testConnection({ apiKey, universeId }) {
  const res = await robloxApi.probeConnection({ apiKey, universeId });
  if (res.networkError) return { state: 'error', http: 0, message: `Cannot reach Roblox: ${res.networkError}` };
  if (res.status === 401) return { state: 'invalid', http: 401, message: `API key rejected (401): ${res.message}` };
  if (res.status === 403) {
    return {
      state: 'denied',
      http: 403,
      message: `Access denied (403): ${res.message}. Check the scope asset-permissions:write and the IP allowlist.`,
    };
  }
  if (res.status === 429) return { state: 'limited', http: 429, message: 'Rate limited (429). Try again shortly.' };
  if (res.status === 200 || res.status === 400) {
    return {
      state: 'connected',
      http: res.status,
      message:
        `Roblox accepted the key (HTTP ${res.status} on an empty, non-mutating probe). ` +
        'Scope and asset ownership can only be confirmed by a real grant.',
    };
  }
  return { state: 'error', http: res.status, message: `Unexpected response (${res.status}): ${res.message}` };
}

module.exports = { grantBatch, testConnection };
