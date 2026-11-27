'use strict';

const crypto = require('crypto');
const { chunk, MAX_ASSETS_PER_BATCH } = require('./validator');
const permissionService = require('./permission-service');
const robloxApi = require('./roblox-api');

const BATCH_DELAY_MS = Math.max(0, Number(process.env.BATCH_DELAY_MS) || 800);
const TYPE_LOOKUP_DELAY_MS = 150;

/**
 * One blast = one BlastJob. Batches run strictly one after another (never in
 * parallel). The API key lives in a private field so it can never be serialized.
 */
class BlastJob {
  #apiKey;
  #onFinish;
  #resumeResolver = null;
  #sleepResolver = null;

  constructor({ apiKey, universeId, assetIds, detectTypes, onFinish }) {
    this.#apiKey = apiKey;
    this.#onFinish = onFinish;
    this.id = crypto.randomUUID();
    this.universeId = String(universeId);
    this.detectTypes = Boolean(detectTypes);
    this.items = assetIds.map((assetId) => ({ assetId, type: '-', status: 'Pending', message: '' }));
    this.batches = chunk(this.items, MAX_ASSETS_PER_BATCH).map((items, i) => ({
      index: i + 1,
      items,
      status: 'Pending',
    }));
    this.status = 'idle'; // idle | running | paused | completed | cancelled
    this.paused = false;
    this.cancelled = false;
    this.inFlight = false;
    this.typeLookupUnavailable = false;
    this.apiStatus = 'Waiting to start';
    this.startedAt = null;
    this.finishedAt = null;
    this.version = 0;
  }

  get active() {
    return this.status === 'running' || this.status === 'paused';
  }

  start() {
    this.status = 'running';
    this.startedAt = Date.now();
    this.#touch();
    this.#run().catch(() => {});
  }

  pause() {
    if (this.status !== 'running') return false;
    this.paused = true;
    this.status = 'paused';
    this.#touch();
    return true;
  }

  resume() {
    if (this.status !== 'paused') return false;
    this.paused = false;
    this.status = 'running';
    if (this.#resumeResolver) this.#resumeResolver();
    this.#touch();
    return true;
  }

  cancel() {
    if (!this.active) return false;
    this.cancelled = true;
    this.paused = false;
    if (this.#resumeResolver) this.#resumeResolver();
    if (this.#sleepResolver) this.#sleepResolver();
    this.apiStatus = this.inFlight ? 'Cancelling after the request in flight' : 'Cancelling';
    this.#touch();
    return true;
  }

  #touch() {
    this.version += 1;
  }

  #sleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      const self = this;
      function done() {
        clearTimeout(timer);
        self.#sleepResolver = null;
        resolve();
      }
      this.#sleepResolver = done;
    });
  }

  async #waitIfPaused() {
    while (this.paused && !this.cancelled) {
      await new Promise((resolve) => {
        this.#resumeResolver = resolve;
      });
      this.#resumeResolver = null;
    }
  }

  async #detectTypes(items) {
    for (const item of items) {
      if (this.cancelled || this.typeLookupUnavailable) return;
      const { type, status } = await robloxApi.getAssetType({ apiKey: this.#apiKey, assetId: item.assetId });
      if (type) {
        item.type = type;
        if (type === 'Place') {
          item.status = 'Skipped';
          item.message = 'Place assets do not support the Use action (Roblox docs list Download / CopyFromRcc / UpdateFromRcc)';
        }
      } else {
        item.type = 'Unknown';
        if (status === 401 || status === 403) {
          this.typeLookupUnavailable = true;
          this.apiStatus = 'Type detection unavailable: API key lacks asset:read. Continuing without it';
        }
      }
      this.#touch();
      await this.#sleep(TYPE_LOOKUP_DELAY_MS);
    }
  }

  async #processBatch(batch, total) {
    batch.status = 'Processing';
    this.inFlight = true;
    batch.items.forEach((item) => {
      item.status = 'Processing';
    });
    this.apiStatus = `Sending batch ${batch.index}/${total}`;
    this.#touch();

    if (this.detectTypes && !this.typeLookupUnavailable) await this.#detectTypes(batch.items);

    const toSend = batch.items.filter((item) => item.status === 'Processing');
    if (toSend.length > 0 && !this.cancelled) {
      const outcome = await permissionService.grantBatch({
        apiKey: this.#apiKey,
        universeId: this.universeId,
        assetIds: toSend.map((i) => i.assetId),
        control: {
          isCancelled: () => this.cancelled,
          sleep: (ms) => this.#sleep(ms),
          onWait: (msg) => {
            this.apiStatus = msg;
            this.#touch();
          },
        },
      });

      if (outcome.cancelled) {
        toSend.forEach((item) => {
          item.status = 'Skipped';
          item.message = 'Cancelled before Roblox confirmed this request';
        });
      } else {
        const byId = new Map(outcome.results.map((r) => [r.assetId, r]));
        toSend.forEach((item) => {
          const r = byId.get(item.assetId);
          item.status = r.status;
          item.message = r.message;
        });
        this.apiStatus =
          outcome.http === 200
            ? `Connected. Batch ${batch.index} answered HTTP 200`
            : `Batch ${batch.index} answered HTTP ${outcome.http || 'network error'}`;
      }
    }

    batch.status = 'Done';
    this.inFlight = false;
    this.#touch();
  }

  async #run() {
    try {
      for (let i = 0; i < this.batches.length; i += 1) {
        await this.#waitIfPaused();
        if (this.cancelled) break;
        await this.#processBatch(this.batches[i], this.batches.length);
        if (this.cancelled) break;
        if (i < this.batches.length - 1) await this.#sleep(BATCH_DELAY_MS);
      }
    } catch (err) {
      this.apiStatus = 'Internal error while processing';
      this.items.forEach((item) => {
        if (item.status === 'Processing') {
          item.status = 'Failed';
          item.message = `Internal error: ${err && err.message ? err.message : 'unknown'}`;
        }
      });
    }

    this.items.forEach((item) => {
      if (item.status === 'Pending' || item.status === 'Processing') {
        item.status = 'Skipped';
        item.message = this.cancelled ? 'Cancelled by user' : 'Not processed';
      }
    });
    this.inFlight = false;
    this.status = this.cancelled ? 'cancelled' : 'completed';
    this.finishedAt = Date.now();
    this.apiStatus = this.cancelled ? 'Cancelled' : 'Finished';
    this.#touch();
    try {
      await this.#onFinish(this.toHistoryEntry());
    } catch (_) {
      /* history failure must not break the job */
    }
  }

  totals() {
    const t = { total: this.items.length, success: 0, failed: 0, pending: 0, processing: 0, skipped: 0 };
    for (const item of this.items) {
      if (item.status === 'Success') t.success += 1;
      else if (item.status === 'Failed') t.failed += 1;
      else if (item.status === 'Pending') t.pending += 1;
      else if (item.status === 'Processing') t.processing += 1;
      else if (item.status === 'Skipped') t.skipped += 1;
    }
    t.batches = this.batches.length;
    t.batchesDone = this.batches.filter((b) => b.status === 'Done').length;
    t.progress = t.total ? Math.round(((t.success + t.failed + t.skipped) / t.total) * 100) : 0;
    return t;
  }

  snapshot() {
    return {
      id: this.id,
      version: this.version,
      universeId: this.universeId,
      status: this.status,
      paused: this.paused,
      inFlight: this.inFlight,
      apiStatus: this.apiStatus,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      serverNow: Date.now(),
      totals: this.totals(),
      items: this.items,
    };
  }

  toHistoryEntry() {
    const t = this.totals();
    return {
      id: this.id,
      universeId: this.universeId,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      status: this.status,
      total: t.total,
      success: t.success,
      failed: t.failed,
      skipped: t.skipped,
      batches: t.batches,
      items: this.items.map(({ assetId, type, status, message }) => ({ assetId, type, status, message })),
    };
  }
}

module.exports = { BlastJob };
