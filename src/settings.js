'use strict';

const z = require('@deepseek-ai/schemastery');

// Volatile fields are editable through Harness settings without remounting the
// provider. Secret fields are omitted from settings responses and stay writable.
const Config = z.object({
  defaultEngine: z.union(['duckduckgo', 'brave', 'tavily', 'exa', 'keenable', 'google', 'searxng'])
    .default('duckduckgo')
    .description('Search engine. DuckDuckGo needs no key, but returns Instant Answers and related links rather than full web search results. Keenable returns web results without a key.')
    .volatile(),
  allowedDomains: z.string().default('').description('Only return these hostnames and their subdomains. Separate with commas or new lines.').volatile(),
  blockedDomains: z.string().default('').description('Never return these hostnames or their subdomains. Blocked domains take precedence.').volatile(),
  dateRange: z.union(['any', 'day', 'week', 'month', 'year']).default('any').description('Provider date filter. DuckDuckGo supports Any time only; SearXNG does not support Past week.').volatile(),
  searxngInstanceUrl: z.string().default('').description('SearXNG instance address reachable from the Harness server. JSON output must be enabled.').volatile(),
  searxngAuth: z.union(['none', 'bearer', 'basic']).default('none').description('Authentication required by your instance or its reverse proxy.').volatile(),
  searxngToken: z.string().role('secret').description('Instance bearer token; not the SearXNG server secret key.').volatile(),
  searxngUsername: z.string().role('secret').description('Instance Basic authentication username.').volatile(),
  searxngPassword: z.string().role('secret').description('Instance Basic authentication password.').volatile(),
  timeoutMs: z.number().step(1).min(1).max(120000)
    .default(15000)
    .description('Maximum time in milliseconds for one search, including queue and pacing delays.')
    .volatile(),
  maxRequestsPerMinute: z.number().step(1).min(1).max(600)
    .default(20)
    .description('Maximum search requests started in a rolling minute, shared by all chats and tests in this profile.')
    .volatile(),
  minIntervalMs: z.number().step(1).min(0).max(60000)
    .default(1000)
    .description('Minimum time in milliseconds between search requests. Requests run one at a time.')
    .volatile(),
  maxResults: z.number().step(1).min(1).max(20)
    .default(8)
    .description('Maximum results returned per search. A model or provider may use a lower limit.')
    .volatile(),
  braveApiKey: z.string().role('secret')
    .description('Brave Search API key. Leave unset when using DuckDuckGo.')
    .volatile(),
  tavilyApiKey: z.string().role('secret')
    .description('Tavily API key. Searches use basic depth with automatic parameter upgrades disabled.')
    .volatile(),
  exaApiKey: z.string().role('secret')
    .description('Exa API key. Searches use auto mode and return highlights without full page text.')
    .volatile(),
  keenableApiKey: z.string().role('secret')
    .description('Optional Keenable API key. Keenable searches work without one; a key lifts the shared per-IP rate limit.')
    .volatile(),
  googleApiKey: z.string().role('secret')
    .description('Google Custom Search JSON API key for an existing eligible account.')
    .volatile(),
  googleSearchEngineId: z.string()
    .description('Google Programmable Search Engine ID (cx). Required with the Google API key.')
    .volatile(),
});

/** Read one live configuration snapshot; plain values also support direct use. */
function resolveConfig(config = {}) {
  const read = (value) => value && typeof value.get === 'function' ? value.get() : value;
  const defaultEngine = read(config.defaultEngine) ?? 'duckduckgo';
  const timeoutMs = read(config.timeoutMs) ?? 15000;
  const braveApiKey = read(config.braveApiKey);
  const tavilyApiKey = read(config.tavilyApiKey);
  const exaApiKey = read(config.exaApiKey);
  const keenableApiKey = read(config.keenableApiKey);
  const googleApiKey = read(config.googleApiKey);
  const googleSearchEngineId = read(config.googleSearchEngineId);

  return {
    defaultEngine,
    timeoutMs,
    filters: {
      allowedDomains: read(config.allowedDomains) ?? '',
      blockedDomains: read(config.blockedDomains) ?? '',
      dateRange: read(config.dateRange) ?? 'any',
    },
    engines: {
      searxng: {
        instanceUrl: read(config.searxngInstanceUrl) ?? '',
        auth: read(config.searxngAuth) ?? 'none',
        token: read(config.searxngToken), username: read(config.searxngUsername), password: read(config.searxngPassword),
      },
      brave: { apiKey: braveApiKey },
      tavily: { apiKey: tavilyApiKey },
      exa: { apiKey: exaApiKey },
      keenable: { apiKey: keenableApiKey },
      google: { apiKey: googleApiKey, searchEngineId: googleSearchEngineId },
    },
  };
}

function resolveLimits(config = {}) {
  const limits = {};
  for (const [key, fallback, min, max] of [
    ['maxRequestsPerMinute', 20, 1, 600],
    ['minIntervalMs', 1000, 0, 60000],
    ['maxResults', 8, 1, 20],
  ]) {
    const cell = config[key];
    const value = (cell && typeof cell.get === 'function' ? cell.get() : cell) ?? fallback;
    if (!Number.isInteger(value) || value < min || value > max) {
      const error = new Error(`${key} must be an integer between ${min} and ${max}`);
      error.code = 'INVALID_ARGUMENT';
      throw error;
    }
    limits[key] = value;
  }
  return limits;
}

module.exports = { Config, resolveConfig, resolveLimits };
