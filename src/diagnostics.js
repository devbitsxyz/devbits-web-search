'use strict';

const { resultNotice } = require('./notices');

const CHANNEL = '/devbits-web-search';
const ENTRY_ID = 'devbits-web-search';
const ENGINES = new Set(['duckduckgo', 'brave', 'tavily', 'exa', 'google', 'searxng']);
const MESSAGES = {
  INVALID_FILTERS: 'Check source filters: use at most 100 hostnames per list, without URLs, paths, ports, or wildcards.',
  UNSUPPORTED_FILTER: 'The selected provider does not support this date range. Choose Any time or a supported range.',
  INVALID_INSTANCE: 'Check the SearXNG instance URL and authentication fields. Use HTTPS remotely, or HTTP for a local hostname or private IP. Do not embed credentials or query parameters in the URL.',
  MISSING_INSTANCE: 'Save a SearXNG instance URL and any authentication required by that instance before testing.',
  INSTANCE_ACCESS_DENIED: 'The SearXNG instance denied access. Check instance credentials, access rules, and whether JSON output is enabled.',
  UPSTREAM_UNAVAILABLE: 'No results were returned, and upstream engines failed. Review the engines enabled on the SearXNG instance.',
  INVALID_ARGUMENT: 'Enter a search query from 1 to 600 characters. Brave also allows at most 75 words.',
  MISSING_CREDENTIALS: 'Save an API key for the selected provider before testing. Google also requires a search engine ID.',
  INVALID_CREDENTIALS: 'The provider rejected API access. Check the saved key and account permissions. Google also requires a valid search engine ID.',
  QUOTA_EXCEEDED: 'Search credits or quota are exhausted. Check usage and plan limits in the provider dashboard.',
  RATE_LIMITED: 'The search request limit has been reached. Wait before trying again, or review the request limits below.',
  QUEUE_FULL: 'Too many searches are waiting. Let current searches finish before testing again.',
  TIMEOUT: 'The search timed out while waiting or contacting the provider. Check connectivity, reduce traffic, or increase the timeout.',
  NETWORK_ERROR: 'Could not reach the search provider. Check the network connection and provider availability.',
  INVALID_RESPONSE: 'The provider returned an unreadable response. Try again later or choose another provider.',
  RESPONSE_TOO_LARGE: 'The provider response exceeded the 2 MiB limit. Try a more specific query.',
  PROVIDER_ERROR: 'The search provider could not complete the request. Check its service status and account settings.',
  SETTINGS_CONFLICT: 'Settings changed since this page was loaded. Reload settings before testing again.',
  SETTINGS_UNAVAILABLE: 'Plugin settings are unavailable. Enable the plugin and reload settings.',
  ERR_CANCELED: 'Search test canceled.',
  NOT_FOUND: 'This search test endpoint is unavailable. Reload the page after updating the plugin.',
  SEARCH_FAILED: 'The search test could not complete. Check the Harness connection and try again.',
};

function failure(code) {
  return Object.assign(new Error(MESSAGES[code]), { code });
}

/** Separate RPC channel: Harness supplies authentication and cancellation. */
function createDiagnostics({ settings, executeSearch, notice, now = Date.now }) {
  const revision = () => {
    const current = settings.describe({ redactSecrets: true }).find(entry => entry.ns === ENTRY_ID);
    if (!current) throw failure('SETTINGS_UNAVAILABLE');
    return current.revision;
  };
  return async (endpoint, payload, signal) => {
    const started = now();
    let engine;
    try {
      if (endpoint !== 'test-search') throw failure('NOT_FOUND');
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)
        || Object.keys(payload).some(key => !['query', 'revision'].includes(key))
        || typeof payload.query !== 'string' || !payload.query.trim() || payload.query.length > 600
        || !Number.isSafeInteger(payload.revision) || payload.revision < 0) {
        throw failure('INVALID_ARGUMENT');
      }
      const ensureRevision = () => {
        if (revision() !== payload.revision) throw failure('SETTINGS_CONFLICT');
      };
      ensureRevision();
      const result = await executeSearch({ query: payload.query, maxResults: 3 }, signal, ensureRevision);
      ensureRevision();
      engine = result.engine;
      return { ok: true, value: {
        engine,
        revision: payload.revision,
        elapsedMs: Math.max(0, now() - started),
        testedAt: new Date(now()).toISOString(),
        count: result.results.length,
        truncated: result.truncated,
        sources: result.results.map(({ title, url, snippet }) => ({ title, url, snippet })),
        ...(resultNotice(result, notice) ? { notice: resultNotice(result, notice) } : {}),
        ...(result.filteredCount ? { filteredCount: result.filteredCount } : {}),
        ...(result.partialFailureCount ? { partialFailureCount: result.partialFailureCount } : {}),
      } };
    } catch (error) {
      // Never send exception messages, causes, requests, or provider payloads.
      // Fixed messages make this safe even if an unexpected dependency throws.
      const code = error?.name === 'AbortError' ? 'ERR_CANCELED'
        : Object.hasOwn(MESSAGES, error?.code) ? error.code : 'SEARCH_FAILED';
      const details = { elapsedMs: Math.max(0, now() - started) };
      if (ENGINES.has(error?.engine ?? engine)) details.engine = error?.engine ?? engine;
      if (Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599) details.status = error.status;
      if (Number.isSafeInteger(error?.retryAfterMs) && error.retryAfterMs >= 0) details.retryAfterMs = error.retryAfterMs;
      const message = details.engine === 'searxng' && code === 'NETWORK_ERROR'
        ? 'Could not reach the SearXNG instance. Check the address from the machine running Harness.'
        : details.engine === 'searxng' && code === 'INVALID_RESPONSE'
          ? 'The instance returned a web page or unreadable search data. Check the instance URL and JSON settings.'
          : MESSAGES[code];
      return { ok: false, error: { code, message, details } };
    }
  };
}

module.exports = { CHANNEL, createDiagnostics };
