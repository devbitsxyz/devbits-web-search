'use strict';

const { SearchError } = require('./errors');

const DATE_RANGES = ['any', 'day', 'week', 'month', 'year'];
const DAYS = { day: 1, week: 7, month: 30, year: 365 };
const fail = message => { throw new SearchError(message, { code: 'INVALID_FILTERS' }); };

function normalizeDomains(value = []) {
  const entries = typeof value === 'string' ? value.split(/[\s,]+/u).filter(Boolean) : value;
  if (!Array.isArray(entries) || entries.length > 100) fail('Use at most 100 hostnames per domain list.');
  return [...new Set(entries.map(entry => {
    if (typeof entry !== 'string') fail('Domain lists must contain hostnames.');
    const text = entry.trim().replace(/\.$/u, '');
    if (!text || /[\s/:?#@*\\%]/u.test(text)) fail('Enter hostnames without URLs, paths, ports, or wildcards.');
    let hostname;
    try { hostname = new URL(`https://${text}`).hostname; } catch { fail('Enter a valid hostname.'); }
    if (hostname.length > 253 || !hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) {
      fail('Enter a valid hostname.');
    }
    return hostname.toLowerCase();
  }))];
}

function normalizeFilters(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('filters must be an object.');
  if (Object.keys(value).some(key => !['allowedDomains', 'blockedDomains', 'dateRange'].includes(key))) fail('Unknown source filter.');
  const dateRange = value.dateRange ?? 'any';
  if (!DATE_RANGES.includes(dateRange)) fail('Choose a supported date range.');
  return { allowedDomains: normalizeDomains(value.allowedDomains), blockedDomains: normalizeDomains(value.blockedDomains), dateRange };
}

function assertDateRange(engine, dateRange) {
  if ((engine === 'duckduckgo' && dateRange !== 'any') || (engine === 'searxng' && dateRange === 'week')) {
    throw new SearchError(`${engine} does not support this date range. Choose Any time or a supported range.`, { code: 'UNSUPPORTED_FILTER', engine });
  }
}

function allowsUrl(value, filters) {
  const host = new URL(value).hostname.toLowerCase().replace(/\.$/u, '');
  const matches = domain => host === domain || host.endsWith(`.${domain}`);
  return !filters.blockedDomains.some(matches) && (!filters.allowedDomains.length || filters.allowedDomains.some(matches));
}

/** Local URL checks enforce domains; provider parameters improve candidate recall. */
function applyProviderFilters(engine, filters, params, body, now = Date.now()) {
  const { allowedDomains, blockedDomains, dateRange } = filters;
  assertDateRange(engine, dateRange);
  if (engine === 'tavily') {
    if (allowedDomains.length) { body.include_domains = allowedDomains; body.include_domains_mode = 'restrict'; }
    if (blockedDomains.length) body.exclude_domains = blockedDomains;
    if (dateRange !== 'any') { body.time_range = dateRange; body.filter_by_published_date = true; }
  } else if (engine === 'exa') {
    if (allowedDomains.length) body.includeDomains = allowedDomains;
    if (blockedDomains.length) body.excludeDomains = blockedDomains;
    if (dateRange !== 'any') {
      body.startPublishedDate = new Date(now - DAYS[dateRange] * 86400000).toISOString();
      body.endPublishedDate = new Date(now).toISOString();
    }
  } else if (engine === 'keenable') {
    // Keenable takes a single site; lists and blocks rely on the local URL checks.
    if (allowedDomains.length === 1) body.site = allowedDomains[0];
    if (dateRange !== 'any') body.published_after = `${DAYS[dateRange]}d`;
  } else if (engine === 'brave' || engine === 'google') {
    const sites = allowedDomains.map(domain => `site:${domain}`);
    const parts = [params.q, ...(sites.length ? [sites.length === 1 ? sites[0] : `(${sites.join(' OR ')})`] : []),
      ...blockedDomains.map(domain => `-site:${domain}`)];
    params.q = parts.join(' ');
    if (dateRange !== 'any') {
      if (engine === 'brave') params.freshness = { day: 'pd', week: 'pw', month: 'pm', year: 'py' }[dateRange];
      else params.dateRestrict = { day: 'd1', week: 'w1', month: 'm1', year: 'y1' }[dateRange];
    }
  } else if (engine === 'searxng' && dateRange !== 'any') params.time_range = dateRange;
}

module.exports = { normalizeDomains, normalizeFilters, assertDateRange, allowsUrl, applyProviderFilters };
