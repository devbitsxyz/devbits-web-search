'use strict';

class SearchError extends Error {
  constructor(message, { code, engine, status, cause, retryAfterMs } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'SearchError';
    this.code = code || 'SEARCH_FAILED';
    if (engine) this.engine = engine;
    if (Number.isInteger(status)) this.status = status;
    if (Number.isSafeInteger(retryAfterMs) && retryAfterMs >= 0) this.retryAfterMs = retryAfterMs;
  }
}

module.exports = { SearchError };
