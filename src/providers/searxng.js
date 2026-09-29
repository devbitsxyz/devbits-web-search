'use strict';

const { isIP } = require('node:net');
const { SearchError } = require('../errors');
const fail = message => { throw new SearchError(message, { code: 'INVALID_INSTANCE', engine: 'searxng' }); };

function localHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === '::1' || /^(fc|fd)[0-9a-f]{2}:/i.test(host)) return true;
  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return isIP(host) === 0 && (host === 'localhost' || ['host.docker.internal', 'gateway.docker.internal'].includes(host) || host.endsWith('.localhost') || host.endsWith('.local') || /^[a-z][a-z0-9-]*$/i.test(host));
}

function normalizeInstance(config) {
  const instanceUrl = config.instanceUrl ?? '';
  if (typeof instanceUrl !== 'string') fail('Enter a SearXNG instance URL.');
  const auth = config.auth ?? 'none';
  if (!['none', 'bearer', 'basic'].includes(auth)) fail('Choose a supported instance authentication method.');
  for (const key of ['token', 'username', 'password']) {
    if (config[key] !== undefined && (typeof config[key] !== 'string' || /[\r\n\u0000]/u.test(config[key]))) fail('Instance credentials contain invalid characters.');
  }
  if (config.username?.includes(':')) fail('A Basic authentication username cannot contain a colon.');
  const result = { ...config, auth, instanceUrl: instanceUrl.trim(), baseUrl: '' };
  if (!result.instanceUrl) return result;
  let url;
  try { url = new URL(result.instanceUrl); } catch { fail('Enter a valid SearXNG instance URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    fail('Use an HTTP or HTTPS instance URL without embedded credentials, query parameters, or a fragment.');
  }
  if (url.protocol === 'http:' && !localHost(url.hostname)) fail('Use HTTPS for remote instances. HTTP is supported only for local hostnames and private IP addresses.');
  if (/%2f|%5c|%2e/i.test(url.pathname)) fail('Use a plain instance path without encoded separators.');
  url.pathname = `${url.pathname.replace(/\/+$/u, '').replace(/\/search$/u, '')}/search`;
  result.baseUrl = url.href;
  return result;
}

function isAvailable(config) {
  if (!config.baseUrl) return false;
  if (config.auth === 'bearer') return Boolean(config.token?.trim());
  if (config.auth === 'basic') return Boolean(config.username?.trim() && config.password);
  return true;
}

function headers(config) {
  if (config.auth === 'bearer') return { Authorization: `Bearer ${config.token.trim()}` };
  if (config.auth === 'basic') return { Authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`, 'utf8').toString('base64')}` };
  return {};
}

function parse(data) {
  if (!Array.isArray(data.results) || (data.unresponsive_engines !== undefined && !Array.isArray(data.unresponsive_engines))) {
    throw new SearchError('SearXNG returned an invalid search response. Check the instance URL and JSON output.', { code: 'INVALID_RESPONSE', engine: 'searxng' });
  }
  const failed = data.unresponsive_engines?.length ?? 0;
  if (!data.results.length && failed) {
    throw new SearchError('No results were returned, and upstream engines failed. Review the engines enabled on the instance.', { code: 'UPSTREAM_UNAVAILABLE', engine: 'searxng' });
  }
  return {
    items: data.results.filter(item => item && typeof item === 'object').map(item => ({ title: item.title, url: item.url, snippet: item.content })),
    ...(failed ? { partialFailureCount: Math.min(failed, 1000) } : {}),
  };
}

module.exports = { normalizeInstance, isAvailable, headers, parse };
