'use strict';

const MAX_ASSETS_PER_BATCH = 50; // Hard limit required by the project spec
const MAX_ASSETS_PER_JOB = 5000;

function parseAssetIds(input) {
  const tokens = Array.isArray(input)
    ? input.map((v) => String(v))
    : String(input == null ? '' : input).split(/[\s,;]+/);

  const valid = [];
  const invalid = [];
  const seen = new Set();
  let duplicates = 0;

  for (const raw of tokens) {
    const token = raw.trim();
    if (!token) continue;
    if (!/^\d{1,16}$/.test(token)) {
      invalid.push(token);
      continue;
    }
    const n = Number(token);
    if (!Number.isSafeInteger(n) || n <= 0) {
      invalid.push(token);
      continue;
    }
    if (seen.has(n)) {
      duplicates += 1;
      continue;
    }
    seen.add(n);
    valid.push(n);
  }
  return { valid, invalid, duplicates };
}

function validateUniverseId(value) {
  const s = String(value == null ? '' : value).trim();
  if (!/^\d{1,16}$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return String(n);
}

function validateApiKey(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  // Printable ASCII only: prevents header injection and obvious garbage.
  if (s.length < 20 || s.length > 4096 || !/^[\x21-\x7E]+$/.test(s)) return null;
  return s;
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

module.exports = {
  MAX_ASSETS_PER_BATCH,
  MAX_ASSETS_PER_JOB,
  parseAssetIds,
  validateUniverseId,
  validateApiKey,
  chunk,
};
