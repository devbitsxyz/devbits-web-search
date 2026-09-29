'use strict';

const WINDOW_MS = 60000;
const DEFAULTS = { maxRequestsPerMinute: 20, minIntervalMs: 1000, maxPending: 10 };

class RequestLimitError extends Error {
  constructor(message, { code, engine, retryAfterMs } = {}) {
    super(message);
    this.name = 'RequestLimitError';
    this.code = code;
    if (engine) this.engine = engine;
    if (Number.isSafeInteger(retryAfterMs) && retryAfterMs >= 0) this.retryAfterMs = retryAfterMs;
  }
}

function integer(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RequestLimitError(`${name} must be an integer between ${min} and ${max}`, { code: 'INVALID_ARGUMENT' });
  }
  return value;
}

function canceled(engine) {
  const error = new RequestLimitError('Search canceled', { code: 'ERR_CANCELED', engine });
  error.name = 'AbortError';
  error.__CANCEL__ = true;
  return error;
}

/** One instance belongs to one plugin; model searches and diagnostics share it. */
class RequestGovernor {
  constructor(config = {}, clock = {}) {
    this.now = clock.now || (() => Date.now());
    this.setTimer = clock.setTimeout || ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = clock.clearTimeout || (timer => clearTimeout(timer));
    this.queue = [];
    this.active = null;
    this.started = [];
    this.lastStartedAt = null;
    this.blockedUntil = 0;
    this.wakeTimer = null;
    this.disposed = false;
    this.config = { ...DEFAULTS };
    this.configure(config);
  }

  configure(config = {}) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new RequestLimitError('Request limits must be an object', { code: 'INVALID_ARGUMENT' });
    }
    const next = { ...this.config, ...config };
    this.config = {
      maxRequestsPerMinute: integer(next.maxRequestsPerMinute, 'maxRequestsPerMinute', 1, 600),
      minIntervalMs: integer(next.minIntervalMs, 'minIntervalMs', 0, 60000),
      maxPending: integer(next.maxPending, 'maxPending', 1, 100)
    };
    // Updating settings never clears consumed requests or a provider cooldown.
    this.pump();
  }

  async run(task, { signal, timeoutMs = 15000, engine, beforeStart } = {}) {
    if (typeof task !== 'function') {
      throw new RequestLimitError('Search task must be a function', { code: 'INVALID_ARGUMENT', engine });
    }
    integer(timeoutMs, 'timeoutMs', 1, 120000);
    if (beforeStart !== undefined && typeof beforeStart !== 'function') {
      throw new RequestLimitError('beforeStart must be a function', { code: 'INVALID_ARGUMENT', engine });
    }
    if (signal !== undefined && (!signal || typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) {
      throw new RequestLimitError('signal must be an AbortSignal', { code: 'INVALID_ARGUMENT', engine });
    }
    if (this.disposed || signal?.aborted) throw canceled(engine);
    const limited = this.rateError(engine);
    if (limited) throw limited;
    if (this.queue.length >= this.config.maxPending) {
      throw new RequestLimitError('The search queue is full. Wait for current searches to finish before trying again.', {
        code: 'QUEUE_FULL', engine
      });
    }

    return new Promise((resolve, reject) => {
      const job = {
        task, signal, engine, beforeStart, resolve, reject,
        deadline: this.now() + timeoutMs,
        controller: new AbortController(),
        settled: false
      };
      job.onAbort = () => this.cancel(job, canceled(engine));
      signal?.addEventListener('abort', job.onAbort, { once: true });
      job.deadlineTimer = this.setTimer(() => this.cancel(job, new RequestLimitError(
        'Search timed out while waiting or contacting the provider. Reduce queued work or increase the timeout.',
        { code: 'TIMEOUT', engine }
      )), timeoutMs);
      this.queue.push(job);
      this.pump();
    });
  }

  rateError(engine) {
    const now = this.now();
    this.started = this.started.filter(time => time > now - WINDOW_MS);
    let retryAfterMs = Math.max(0, this.blockedUntil - now);
    let reason = retryAfterMs > 0 ? 'The search provider requested a pause.' : '';
    if (this.started.length >= this.config.maxRequestsPerMinute) {
      // When the limit is lowered, enough older requests must expire, not just one.
      const expiresAt = this.started[this.started.length - this.config.maxRequestsPerMinute] + WINDOW_MS;
      retryAfterMs = Math.max(retryAfterMs, expiresAt - now);
      reason = 'The plugin search limit for the last minute has been reached.';
    }
    return retryAfterMs > 0 ? new RequestLimitError(
      `${reason} Try again in ${Math.ceil(retryAfterMs / 1000)} seconds.`,
      { code: 'RATE_LIMITED', engine, retryAfterMs: Math.ceil(retryAfterMs) }
    ) : null;
  }

  pump() {
    if (this.wakeTimer !== null) this.clearTimer(this.wakeTimer);
    this.wakeTimer = null;
    if (this.disposed || this.active || this.queue.length === 0) return;

    const limited = this.rateError();
    if (limited) {
      for (const job of this.queue.splice(0)) {
        this.settle(job, new RequestLimitError(limited.message, {
          code: limited.code, engine: job.engine, retryAfterMs: limited.retryAfterMs
        }));
      }
      return;
    }
    const wait = this.lastStartedAt === null ? 0 : this.lastStartedAt + this.config.minIntervalMs - this.now();
    if (wait > 0) {
      this.wakeTimer = this.setTimer(() => {
        this.wakeTimer = null;
        this.pump();
      }, wait);
      return;
    }

    const job = this.queue.shift();
    this.active = job;
    try {
      // Synchronous preflight can reject stale settings without spending a request.
      job.beforeStart?.();
    } catch (error) {
      this.settle(job, error);
      this.active = null;
      this.pump();
      return;
    }
    if (job.settled) {
      this.active = null;
      this.pump();
      return;
    }
    const remaining = Math.ceil(job.deadline - this.now());
    if (remaining <= 0) {
      this.cancel(job, new RequestLimitError('Search timed out before contacting the provider.', {
        code: 'TIMEOUT', engine: job.engine
      }));
      this.active = null;
      this.pump();
      return;
    }
    this.lastStartedAt = this.now();
    this.started.push(this.lastStartedAt);
    let result;
    try {
      result = job.task({ signal: job.controller.signal, timeoutMs: remaining });
    } catch (error) {
      this.complete(job, error);
      return;
    }
    Promise.resolve(result).then(
      value => this.complete(job, null, value),
      error => this.complete(job, error)
    );
  }

  complete(job, error, value) {
    if (Number.isSafeInteger(error?.retryAfterMs) && error.retryAfterMs > 0) {
      this.blockedUntil = Math.max(this.blockedUntil, Math.min(Number.MAX_SAFE_INTEGER, this.now() + error.retryAfterMs));
    }
    this.settle(job, error, value);
    if (this.active === job) this.active = null;
    this.pump();
  }

  settle(job, error, value) {
    if (job.settled) return;
    job.settled = true;
    this.clearTimer(job.deadlineTimer);
    job.signal?.removeEventListener('abort', job.onAbort);
    if (error) job.reject(error);
    else job.resolve(value);
  }

  cancel(job, error) {
    const index = this.queue.indexOf(job);
    if (index !== -1) this.queue.splice(index, 1);
    this.settle(job, error);
    job.controller.abort();
    // The active slot stays occupied until its task exits, even if it ignores abort.
    this.pump();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.wakeTimer !== null) this.clearTimer(this.wakeTimer);
    this.wakeTimer = null;
    for (const job of this.queue.splice(0)) this.cancel(job, canceled(job.engine));
    if (this.active) this.cancel(this.active, canceled(this.active.engine));
  }
}

module.exports = { RequestGovernor, RequestLimitError };
