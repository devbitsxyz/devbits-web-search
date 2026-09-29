'use strict';

const axios = require('axios');
const { SearchError } = require('./errors');
const { normalizeFilters, assertDateRange, allowsUrl, applyProviderFilters } = require('./filters');
const searxng = require('./providers/searxng');

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TIMEOUT_MS = 120000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TITLE_LENGTH = 300;
const MAX_SNIPPET_LENGTH = 2000;
const BING_RETIRED = 'Bing Search APIs retired on August 11, 2025. Choose duckduckgo for limited Instant Answers, or configure Brave Search in the Harness plugin settings.';
// Keenable requires an application name on keyless requests and uses it for attribution.
const KEENABLE_TITLE = 'DevBits Web Search';
// Keenable excerpts are page text; ask for a search-result-sized excerpt instead of the default.
const KEENABLE_SNIPPET_LENGTH = 500;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalidArgument(message) {
  return new SearchError(message, { code: 'INVALID_ARGUMENT' });
}

function canceledError(name = 'AbortError') {
  const error = new Error('Search canceled');
  error.name = name;
  error.code = 'ERR_CANCELED';
  error.__CANCEL__ = true;
  return error;
}

function validateTimeout(value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
    throw invalidArgument(`timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}`);
  }
  return value;
}

function validateEngine(engine) {
  if (engine === 'bing') throw new SearchError(BING_RETIRED, { code: 'ENGINE_RETIRED', engine });
  if (!['google', 'duckduckgo', 'brave', 'tavily', 'exa', 'keenable', 'searxng'].includes(engine)) {
    throw invalidArgument(`Unsupported search engine: ${String(engine)}`);
  }
}

function validCredential(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateEndpoint(value, engine) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw invalidArgument(`The ${engine} baseUrl must be a valid HTTPS URL`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw invalidArgument(`The ${engine} baseUrl must be an HTTPS URL without credentials, query parameters, or a fragment`);
  }
  return url.href;
}

function requireArray(value, field, engine) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new SearchError(`Invalid ${engine} response: ${field} must be an array`, {
      code: 'INVALID_RESPONSE', engine
    });
  }
  return value;
}

function safeUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password
      ? url.href : null;
  } catch {
    return null;
  }
}

function boundedText(value, maxLength) {
  const text = typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim() : '';
  return { value: text.slice(0, maxLength), truncated: text.length > maxLength };
}

function retryAfter(headers) {
  const value = typeof headers?.get === 'function' ? headers.get('retry-after')
    : headers?.['retry-after'] ?? headers?.['Retry-After'];
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const text = String(value).trim();
  const milliseconds = /^\d+(?:\.\d+)?$/.test(text) ? Number(text) * 1000
    : /^[A-Za-z]{3},/.test(text) ? Date.parse(text) - Date.now() : NaN;
  const result = Math.ceil(Math.max(0, milliseconds));
  return Number.isSafeInteger(result) ? result : undefined;
}

/** Keenable sends page text in snippet, with line breaks; description is usually empty. */
function keenableSnippet(item) {
  const text = [item.snippet, item.description].find(value => typeof value === 'string' && value.trim());
  return text ? text.replace(/\s+/gu, ' ') : '';
}

function providerFailureCode(status, payload, detail) {
  const error = isObject(payload?.error) ? payload.error : {};
  const reasons = [payload?.tag, payload?.code, error.code, error.status,
    ...[error.errors, error.details].flatMap(items => Array.isArray(items)
      ? items.slice(0, 20).map(item => item?.reason) : [])]
    .filter(value => typeof value === 'string')
    .map(value => value.replace(/[^a-z]/gi, '').toLowerCase());
  const has = values => reasons.some(reason => values.includes(reason));
  if ([402, 432, 433].includes(status) || has([
    'quotalimited', 'quotaexceeded', 'dailylimitexceeded', 'dailylimitexceededunreg',
    'insufficientcredits', 'usagelimitexceeded', 'creditsexhausted'
  ]) || /\b(?:quota exceeded|daily limit exceeded|insufficient credits|usage limit|pay-as-you-go limit)\b/i.test(detail)) {
    return 'QUOTA_EXCEEDED';
  }
  if (status === 429 || has(['ratelimited', 'ratelimitexceeded', 'userratelimitexceeded'])) {
    return 'RATE_LIMITED';
  }
  if (status === 403 && has(['resourceexhausted'])) return 'QUOTA_EXCEEDED';
  if (status === 401 || status === 403 || has([
    'invalidapikey', 'apikeyinvalid', 'subscriptiontokeninvalid', 'subscriptiontokennotfound',
    'authenticationfailed', 'unauthenticated', 'keyinvalid'
  ])) return 'INVALID_CREDENTIALS';
  return 'PROVIDER_ERROR';
}

/** Search client shared by the native harness web provider and programmatic API. */
class WebSearchPlugin {
  constructor(config = {}) {
    if (!isObject(config)) throw invalidArgument('config must be an object');
    if (config.engines !== undefined && !isObject(config.engines)) {
      throw invalidArgument('engines must be an object');
    }

    const defaults = {
      duckduckgo: {
        name: 'DuckDuckGo Instant Answers',
        baseUrl: 'https://api.duckduckgo.com/'
      },
      brave: {
        name: 'Brave Search',
        baseUrl: 'https://api.search.brave.com/res/v1/web/search'
      },
      tavily: {
        name: 'Tavily Search',
        baseUrl: 'https://api.tavily.com/search'
      },
      exa: {
        name: 'Exa Search',
        baseUrl: 'https://api.exa.ai/search'
      },
      keenable: {
        name: 'Keenable',
        baseUrl: 'https://api.keenable.ai/v1/search',
        publicUrl: 'https://api.keenable.ai/v1/search/public'
      },
      searxng: { name: 'SearXNG', instanceUrl: '', auth: 'none' },
      google: {
        name: 'Google Custom Search (legacy)',
        baseUrl: 'https://www.googleapis.com/customsearch/v1'
      }
    };
    const engineOverrides = config.engines || {};
    for (const engine of Object.keys(engineOverrides)) {
      // Accept old Bing configuration without advertising or making requests to it.
      if (engine === 'bing') continue;
      validateEngine(engine);
      if (!isObject(engineOverrides[engine])) throw invalidArgument(`${engine} configuration must be an object`);
    }

    const engines = {};
    for (const [engine, defaultsForEngine] of Object.entries(defaults)) {
      const merged = { ...defaultsForEngine, ...engineOverrides[engine] };
      if (engine === 'searxng') engines[engine] = searxng.normalizeInstance(merged);
      else {
        merged.baseUrl = validateEndpoint(merged.baseUrl, engine);
        if (engine === 'keenable') merged.publicUrl = validateEndpoint(merged.publicUrl, engine);
        engines[engine] = merged;
      }
    }
    const defaultEngine = config.defaultEngine ?? 'duckduckgo';
    validateEngine(defaultEngine);
    this.config = {
      defaultEngine,
      timeoutMs: validateTimeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      engines,
      filters: normalizeFilters(config.filters),
    };
    this.searchEngines = new Map(Object.entries(engines));
  }

  getSupportedEngines() {
    return Array.from(this.searchEngines.keys());
  }

  isAvailable(engine = this.config.defaultEngine) {
    if (!this.searchEngines.has(engine)) return false;
    const config = this.searchEngines.get(engine);
    if (engine === 'searxng') return searxng.isAvailable(config);
    if (engine === 'google') return validCredential(config.apiKey) && validCredential(config.searchEngineId);
    // Keenable's public endpoint needs no key; a saved key lifts its shared rate limit.
    return engine === 'duckduckgo' || engine === 'keenable' || validCredential(config.apiKey);
  }

  assertReady(query, engine = this.config.defaultEngine) {
    if (typeof query !== 'string' || !query.trim()) throw invalidArgument('query must be a nonempty string');
    assertDateRange(engine, this.config.filters.dateRange);
    if (!this.isAvailable(engine)) {
      throw new SearchError(engine === 'searxng'
        ? 'Save a SearXNG instance URL and any required authentication in Harness settings.'
        : `${engine} requires a saved API key${engine === 'google' ? ' and search engine ID' : ''}. Configure the provider in Harness settings.`, {
        code: engine === 'searxng' ? 'MISSING_INSTANCE' : 'MISSING_CREDENTIALS', engine,
      });
    }
    if (engine === 'brave') {
      const params = { q: query.trim() };
      applyProviderFilters(engine, this.config.filters, params);
      if (params.q.length > 600 || params.q.split(/\s+/u).length > 75) {
        throw invalidArgument('Brave queries including domain filters must not exceed 600 characters or 75 words');
      }
    }
  }

  async search(query, options = {}) {
    if (typeof query !== 'string' || !query.trim()) throw invalidArgument('query must be a nonempty string');
    if (!isObject(options)) throw invalidArgument('options must be an object');
    const engine = options.engine ?? this.config.defaultEngine;
    validateEngine(engine);
    const num = options.num ?? 8;
    if (!Number.isInteger(num) || num < 1 || num > 20) {
      throw invalidArgument('num must be an integer between 1 and 20');
    }
    const timeout = validateTimeout(options.timeoutMs ?? this.config.timeoutMs);
    if (options.signal !== undefined && (
      !options.signal || typeof options.signal.aborted !== 'boolean' ||
      typeof options.signal.addEventListener !== 'function' || typeof options.signal.removeEventListener !== 'function'
    )) {
      throw invalidArgument('signal must be an AbortSignal');
    }
    if (options.signal?.aborted) {
      throw canceledError();
    }
    this.assertReady(query, engine);
    const normalizedQuery = query.trim();
    const limit = engine === 'google' ? Math.min(num, 10) : num;
    const config = this.searchEngines.get(engine);
    const headers = { Accept: 'application/json' };
    let params;
    let body;
    let endpoint = config.baseUrl;
    if (engine === 'google') {
      params = { key: config.apiKey, cx: config.searchEngineId, q: normalizedQuery, num: limit };
    } else if (engine === 'brave') {
      headers['X-Subscription-Token'] = config.apiKey;
      params = { q: normalizedQuery, count: limit, text_decorations: false, result_filter: 'web' };
    } else if (engine === 'tavily') {
      headers.Authorization = `Bearer ${config.apiKey}`;
      headers['Content-Type'] = 'application/json';
      body = {
        query: normalizedQuery,
        max_results: limit,
        search_depth: 'basic',
        auto_parameters: false,
        include_answer: false,
        include_raw_content: false,
        include_images: false
      };
    } else if (engine === 'exa') {
      headers['x-api-key'] = config.apiKey;
      headers['Content-Type'] = 'application/json';
      body = {
        query: normalizedQuery,
        numResults: limit,
        type: 'auto',
        contents: { highlights: true, text: false }
      };
    } else if (engine === 'keenable') {
      headers['Content-Type'] = 'application/json';
      headers['X-Keenable-Title'] = KEENABLE_TITLE;
      if (validCredential(config.apiKey)) headers['X-API-Key'] = config.apiKey;
      else endpoint = config.publicUrl;
      body = { query: normalizedQuery, max_results: limit, snippet_max_length: KEENABLE_SNIPPET_LENGTH };
    } else if (engine === 'searxng') {
      Object.assign(headers, searxng.headers(config));
      params = { q: normalizedQuery, format: 'json', pageno: 1, categories: 'general' };
    } else {
      params = { q: normalizedQuery, format: 'json', no_html: 1, no_redirect: 1 };
    }
    applyProviderFilters(engine, this.config.filters, params, body);
    let data;
    let response;
    try {
      const transport = {
        headers,
        timeout,
        signal: options.signal,
        maxContentLength: MAX_RESPONSE_BYTES,
        maxRedirects: 0,
        responseType: 'json'
      };
      response = body
        ? await axios.post(endpoint, body, transport)
        : await axios.get(endpoint, { ...transport, params });
      data = response?.data;
    } catch (error) {
      if (error?.code === 'ERR_CANCELED' || error?.name === 'AbortError') {
        throw canceledError(error.name === 'AbortError' ? 'AbortError' : 'CanceledError');
      }
      throw this.providerError(error, engine);
    }

    if (!isObject(data)) {
      throw new SearchError(engine === 'searxng' ? 'SearXNG returned a web page or unreadable data. Check the instance URL and JSON settings.' : `Invalid ${engine} response: expected a JSON object`, { code: 'INVALID_RESPONSE', engine });
    }
    if (data.error || data.errors || (engine === 'tavily' && data.detail)) {
      throw this.providerError({ response }, engine);
    }
    const instanceResult = engine === 'searxng' ? searxng.parse(data) : null;
    const items = instanceResult ? instanceResult.items : engine === 'google' ? this.googleItems(data)
      : engine === 'brave' ? this.braveItems(data)
        : engine === 'tavily' || engine === 'exa' || engine === 'keenable' ? this.contentItems(data, engine)
          : this.duckDuckGoItems(data);
    const seen = new Set();
    const results = [];
    let truncated = limit < num;
    let filteredCount = 0;
    for (const item of items) {
      if (!isObject(item)) continue;
      const url = safeUrl(item.url);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      if (!allowsUrl(url, this.config.filters)) { filteredCount++; continue; }
      if (results.length >= limit) {
        truncated = true;
        continue;
      }
      const title = boundedText(item.title, MAX_TITLE_LENGTH);
      const snippet = boundedText(item.snippet, MAX_SNIPPET_LENGTH);
      truncated ||= title.truncated || snippet.truncated;
      results.push({ title: title.value || url, url, snippet: snippet.value, engine });
    }
    return { query: normalizedQuery, engine, count: results.length, results, truncated,
      ...(filteredCount ? { filteredCount } : {}),
      ...(instanceResult?.partialFailureCount ? { partialFailureCount: instanceResult.partialFailureCount } : {}),
      ...(engine === 'searxng' && this.config.filters.dateRange !== 'any' ? { limitedDateFilter: true } : {}),
    };
  }

  googleItems(data) {
    // Successful responses identify their schema, including when there are no items.
    if (data.kind !== 'customsearch#search' && !Object.hasOwn(data, 'items') && !isObject(data.searchInformation)) {
      throw new SearchError('Invalid google response: missing search result fields', { code: 'INVALID_RESPONSE', engine: 'google' });
    }
    return requireArray(data.items, 'items', 'google')
      .filter(isObject)
      .map(item => ({ title: item.title, url: item.link, snippet: item.snippet }));
  }

  braveItems(data) {
    if (data.type !== 'search' && !isObject(data.web)) {
      throw new SearchError('Invalid brave response: missing web search fields', { code: 'INVALID_RESPONSE', engine: 'brave' });
    }
    if (data.web !== undefined && data.web !== null && !isObject(data.web)) {
      throw new SearchError('Invalid brave response: web must be an object', { code: 'INVALID_RESPONSE', engine: 'brave' });
    }
    return requireArray(data.web?.results, 'web.results', 'brave')
      .filter(isObject)
      .map(item => ({ title: item.title, url: item.url, snippet: item.description }));
  }

  contentItems(data, engine) {
    if (!Object.hasOwn(data, 'results')) {
      throw new SearchError(`Invalid ${engine} response: missing results`, { code: 'INVALID_RESPONSE', engine });
    }
    return requireArray(data.results, 'results', engine)
      .filter(isObject)
      .map(item => ({
        title: item.title,
        url: item.url,
        snippet: engine === 'tavily' ? item.content
          : engine === 'keenable' ? keenableSnippet(item)
            : requireArray(item.highlights, 'results[].highlights', engine)
              .filter(highlight => typeof highlight === 'string').join('\n')
      }));
  }

  duckDuckGoItems(data) {
    if (!['AbstractText', 'RelatedTopics', 'Results', 'Answer', 'Type'].some(key => Object.hasOwn(data, key))) {
      throw new SearchError('Invalid duckduckgo response: missing Instant Answer fields', {
        code: 'INVALID_RESPONSE', engine: 'duckduckgo'
      });
    }
    const items = [];
    if (data.AbstractURL && data.AbstractText) {
      items.push({ title: data.Heading, url: data.AbstractURL, snippet: data.AbstractText });
    }
    const roots = [
      ...requireArray(data.Results, 'Results', 'duckduckgo'),
      ...requireArray(data.RelatedTopics, 'RelatedTopics', 'duckduckgo')
    ];
    // Iteration handles arbitrarily nested topic groups without recursive stack growth.
    const stack = roots.reverse();
    while (stack.length > 0) {
      const item = stack.pop();
      if (!isObject(item)) continue;
      if (item.FirstURL) items.push({ title: item.Text, url: item.FirstURL, snippet: item.Text });
      if (item.Topics !== undefined) {
        const topics = requireArray(item.Topics, 'Topics', 'duckduckgo');
        for (let i = topics.length - 1; i >= 0; i -= 1) stack.push(topics[i]);
      }
    }
    return items;
  }

  providerError(error, engine) {
    const status = error?.response?.status;
    const payload = error?.response?.data;
    const detail = isObject(payload)
      ? payload.error?.message || payload.error?.detail || (typeof payload.error === 'string' ? payload.error : '')
        || payload.detail?.error || (typeof payload.detail === 'string' ? payload.detail : '')
        || (Array.isArray(payload.detail) ? payload.detail.slice(0, 3)
          .map(item => typeof item?.msg === 'string' ? item.msg : '').filter(Boolean).join('; ') : '')
      : '';
    let safeDetail = typeof detail === 'string' ? detail : '';
    for (const config of this.searchEngines.values()) {
      for (const secret of [config.apiKey, config.searchEngineId]) {
        if (validCredential(secret)) {
          safeDetail = safeDetail.split(secret).join('[REDACTED]');
          safeDetail = safeDetail.split(encodeURIComponent(secret)).join('[REDACTED]');
        }
      }
    }
    safeDetail = engine === 'searxng' ? '' : boundedText(safeDetail, 300).value;
    const timedOut = error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT';
    const oversized = typeof error?.message === 'string' && /maxContentLength size of \d+ exceeded/.test(error.message);
    const invalidJson = error?.code === 'ERR_BAD_RESPONSE' && error?.cause instanceof SyntaxError;
    let code = timedOut ? 'TIMEOUT' : oversized ? 'RESPONSE_TOO_LARGE' : invalidJson ? 'INVALID_RESPONSE'
      : Number.isInteger(status) || payload ? providerFailureCode(status, payload, detail) : 'NETWORK_ERROR';
    // The account-free endpoint cannot be repaired by supplying an API key.
    if (engine === 'duckduckgo' && code === 'INVALID_CREDENTIALS') code = 'PROVIDER_ERROR';
    if (engine === 'searxng' && [401, 403].includes(status)) code = 'INSTANCE_ACCESS_DENIED';
    const retryAfterMs = retryAfter(error?.response?.headers);
    const messages = {
      INSTANCE_ACCESS_DENIED: 'The SearXNG instance denied access. Check instance authentication, access rules, and whether JSON output is enabled.',
      TIMEOUT: `${engine} search timed out. Check connectivity or increase the timeout.`,
      RESPONSE_TOO_LARGE: `${engine} search response exceeded the 2 MiB limit`,
      INVALID_RESPONSE: `${engine} returned invalid JSON. Try again later or choose another provider.`,
      INVALID_CREDENTIALS: `${engine} rejected API access. Check the saved API key${engine === 'google' ? ', search engine ID,' : ''} and account permissions in Harness settings.`,
      QUOTA_EXCEEDED: `${engine} search quota or credits are exhausted. Check usage and plan limits in the provider dashboard.`,
      RATE_LIMITED: `${engine} is limiting search requests. ${retryAfterMs > 0
        ? `Wait ${Math.ceil(retryAfterMs / 1000)} seconds before trying again.`
        : 'Pause searches and check the provider rate limits.'}`,
      NETWORK_ERROR: `${engine} search could not reach the provider. Check the network connection and provider availability.`,
      PROVIDER_ERROR: `${engine} search failed. Check the provider status and request settings.`
    };
    if (engine === 'keenable' && !validCredential(this.searchEngines.get('keenable').apiKey)) {
      messages.RATE_LIMITED += ' Searches without an API key share a per-IP limit; saving a Keenable API key lifts it.';
    }
    if (engine === 'searxng') {
      messages.NETWORK_ERROR = 'Could not reach the SearXNG instance. Check the address from the machine running Harness.';
      messages.INVALID_RESPONSE = 'The SearXNG instance returned unreadable data. Check the instance URL and JSON output.';
    }
    const message = `${messages[code]}${Number.isInteger(status) ? ` (HTTP ${status})` : ''}${safeDetail ? ` ${safeDetail}` : ''}`;
    // Axios errors retain request headers and URLs. Keep diagnostic classification,
    // but never retain the original object, even as a non-enumerable cause.
    const cause = new Error(message);
    cause.code = code;
    if (Number.isInteger(status)) cause.status = status;
    return new SearchError(message, { code, engine, status, cause, retryAfterMs });
  }

  async query(query, options = {}) {
    return this.search(query, options);
  }

  static async create(config = {}) {
    return new WebSearchPlugin(config);
  }
}

module.exports = WebSearchPlugin;
