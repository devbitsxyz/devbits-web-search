#!/usr/bin/env node
/** Offline integration check against an installed DeepSeek Harness runtime. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';

const require = createRequire(import.meta.url);
const runtimeRequire = process.env.DSH_RUNTIME_DIR
  ? createRequire(path.join(path.resolve(process.env.DSH_RUNTIME_DIR), '__smoke__.cjs'))
  : require;

async function runtimeImport(name) {
  return import(pathToFileURL(runtimeRequire.resolve(name)).href);
}

let runtime;
try {
  runtime = await Promise.all([
    runtimeImport('@deepseek-ai/cordis'),
    runtimeImport('@deepseek-ai/cordis-plugin-loader'),
    runtimeImport('@deepseek-ai/dsh-system-prompt'),
    runtimeImport('@deepseek-ai/dsh-tools'),
    runtimeImport('@deepseek-ai/dsh-web'),
    runtimeImport('@deepseek-ai/dsh-tool-web'),
    runtimeImport('@deepseek-ai/dsh-settings'),
    runtimeImport('@deepseek-ai/dsh-client-connection'),
    runtimeImport('@deepseek-ai/dsh-host-webserver')
  ]);
} catch (cause) {
  throw new Error(
    'Cannot load DeepSeek Harness. Set DSH_RUNTIME_DIR to the node_modules directory of an installed Harness runtime, then rerun this script.',
    { cause }
  );
}

const [{ Context, Service }, { Loader }, { SystemPrompt }, { ToolRuntime }, { WebRuntime }, toolWeb, { SettingsForms }, connectionPlugin, { WebServer }] = runtime;
const pluginRoot = process.env.DSH_PLUGIN_DIR ? path.resolve(process.env.DSH_PLUGIN_DIR) : fileURLToPath(new URL('../', import.meta.url));
const pluginRequire = createRequire(path.join(pluginRoot, 'package.json'));
const plugin = pluginRequire('devbits-web-search');
const axios = pluginRequire('axios');
const originalGet = axios.get;
const originalPost = axios.post;
const requests = [];
let replyOverride;

// Exercise the native authentication, RPC envelope and Node-to-Fetch bridge
// using in-memory streams. No TCP listener or user credential store is needed.
class MemoryResponse extends EventEmitter {
  status = 200;
  headers = {};
  chunks = [];
  writableEnded = false;
  destroyed = false;
  writeHead(status, headers = {}) { this.status = status; this.headers = headers; }
  write(chunk) { this.chunks.push(Buffer.from(chunk)); return true; }
  end(chunk) {
    if (chunk !== undefined) this.write(chunk);
    this.writableEnded = true;
  }
  destroy() { this.destroyed = true; this.emit('close'); }
  get body() { return Buffer.concat(this.chunks).toString('utf8'); }
}

async function createRpcTransport(ctx) {
  const records = new Map();
  // Retain native service tracing, routing and disposal while replacing only
  // the listen lifecycle so this offline test never binds a TCP socket.
  class MemoryWebServer extends WebServer { async [Service.init]() {} }
  await ctx.plugin(MemoryWebServer, { host: '127.0.0.1', port: 0, compression: 'none' });
  const webServer = ctx.get('webServer');
  const routes = webServer.prefixes;
  ctx.provide('credentials', {
    async modifyRecord(key, change) {
      const replacement = await change(records.get(key));
      if (replacement !== undefined) records.set(key, replacement);
      return records.get(key);
    }
  });
  await ctx.plugin(connectionPlugin, {});
  await ctx.fiber.await();
  for (const runtime of ctx.registry.values()) for (const fiber of runtime.fibers) {
    if (fiber.state === 3) await fiber.await();
  }
  const connection = ctx.get('connection');
  const login = new URL(connection.authenticatedUrl('http://localhost/'));
  const loginResponse = new MemoryResponse();
  assert.equal(connection.authorizeIndex({ method: 'GET', url: login.pathname + login.search, headers: { host: 'localhost' } }, loginResponse), false);
  assert.equal(loginResponse.status, 303);
  const cookie = loginResponse.headers['set-cookie'].split(';', 1)[0];
  let browserModule;
  runInNewContext(await readFile(runtimeRequire.resolve('@deepseek-ai/dsh-client-connection/client'), 'utf8'), {
    window: { __ModuleLoader__: { load(module) { browserModule = module; } } },
    crypto: webcrypto,
    setTimeout, clearTimeout,
  });
  const nativeBrowser = browserModule.factory(() => { throw new Error('Unexpected browser dependency'); });
  let browserConnection;
  nativeBrowser.installConnection({ provide(name, value) { assert.equal(name, 'connection'); browserConnection = value; } }, {
    transport: {
      async fetch(input, init) {
        const pathname = new URL(input, 'http://localhost/').pathname;
        const route = webServer.match(pathname);
        if (!route) return new Response('not found', { status: 404 });
        const request = Readable.from([Buffer.from(init.body)]);
        request.url = pathname;
        request.method = init.method;
        request.headers = { host: 'localhost', cookie, ...init.headers };
        const response = new MemoryResponse();
        const abort = () => response.destroy();
        init.signal?.addEventListener('abort', abort, { once: true });
        try {
          await route.handler(request, response);
          return new Response(response.body, { status: response.status, headers: response.headers });
        } finally {
          init.signal?.removeEventListener('abort', abort);
        }
      }
    }
  });
  let correlation = 0;
  return {
    routes,
    browserRpc: browserConnection.rpc,
    async call(payload, { endpoint = 'test-search', authenticated = true, origin, signal } = {}) {
      const route = routes.get('/devbits-web-search');
      assert.ok(route, 'plugin must register its own authenticated Connection channel');
      const rpcId = `smoke-${++correlation}`;
      const request = Readable.from([Buffer.from(JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload }))]);
      request.url = `/devbits-web-search/${endpoint}`;
      request.method = 'POST';
      request.headers = { host: 'localhost', 'content-type': 'application/json', ...(authenticated ? { cookie } : {}), ...(origin ? { origin } : {}) };
      const response = new MemoryResponse();
      const abort = () => response.destroy();
      signal?.addEventListener('abort', abort, { once: true });
      try {
        await route.handler(request, response);
        if (response.status !== 200 || response.destroyed) return response;
        const envelope = JSON.parse(response.body);
        assert.equal(envelope.type, 'server-response');
        assert.equal(envelope.rpcId, rpcId);
        return { ...response, result: envelope.result };
      } finally {
        signal?.removeEventListener('abort', abort);
      }
    }
  };
}

// Only the network boundary is stubbed; plugin loading and tool dispatch are real.
axios.get = async (url, options) => {
  requests.push({ url, options });
  assert.ok(options.signal instanceof AbortSignal, 'tool cancellation must reach HTTP');
  if (replyOverride) return replyOverride(url, options);
  if (new URL(url).hostname === 'api.search.brave.com') {
    assert.equal(options.headers['X-Subscription-Token'], 'fixture-brave-token');
    return { data: { web: { results: [{ title: 'Brave fixture', url: 'https://example.com/brave', description: 'Brave search fixture.' }] } } };
  }
  assert.equal(new URL(url).hostname, 'api.duckduckgo.com');
  return {
    data: {
      Heading: 'Cordis',
      AbstractText: 'Cordis is a plugin framework.',
      AbstractURL: 'https://example.com/cordis',
      RelatedTopics: [
        { FirstURL: 'https://example.com/plugins', Text: 'Plugins - Cordis plugins' },
        { FirstURL: 'https://example.com/services', Text: 'Services - Cordis services' }
      ]
    }
  };
};
axios.post = async (url, body, options) => {
  requests.push({ url, body, options });
  assert.ok(options.signal instanceof AbortSignal, 'tool cancellation must reach POST requests');
  if (replyOverride) return replyOverride(url, options);
  const host = new URL(url).hostname;
  if (host === 'api.tavily.com') {
    assert.equal(options.headers.Authorization, 'Bearer fixture-tavily-token');
    assert.equal(body.search_depth, 'basic');
    assert.equal(body.auto_parameters, false);
    assert.equal(body.max_results, 2);
    return { data: { results: [{ title: 'Tavily fixture', url: 'https://example.com/tavily', content: 'Tavily excerpt.' }] } };
  }
  if (host === 'api.keenable.ai') {
    assert.equal(url, 'https://api.keenable.ai/v1/search/public', 'Keenable without a saved key must use the public endpoint');
    assert.equal(options.headers['X-Keenable-Title'], 'DevBits Web Search');
    assert.equal(options.headers['X-API-Key'], undefined);
    assert.equal(body.max_results, 2);
    return { data: { results: [{ title: 'Keenable fixture', url: 'https://example.com/keenable', description: '', snippet: 'Keenable\nexcerpt.' }] } };
  }
  assert.equal(host, 'api.exa.ai');
  assert.equal(options.headers['x-api-key'], 'fixture-exa-token');
  assert.equal(body.type, 'auto');
  assert.equal(body.numResults, 2);
  return { data: { results: [{ title: 'Exa fixture', url: 'https://example.com/exa', highlights: ['Exa highlight.'] }] } };
};

const ctx = new Context();
const tempHome = await mkdtemp(path.join(tmpdir(), 'devbits-web-search-smoke-'));
try {
  await ctx.plugin(Loader, { baseUrl: pathToFileURL(pluginRoot + path.sep).href });
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime, { mode: 'native' });
  await ctx.plugin(WebRuntime, { searchProvider: plugin.PROVIDER_ID });
  await ctx.plugin(toolWeb, { fetch: false, searchMaxResults: 2 });

  const loader = ctx.get('loader');
  const entryId = await loader.create({
    id: 'devbits-web-search',
    name: 'devbits-web-search',
    config: { minIntervalMs: 0 }
  });
  await loader.await();
  let entry = loader.resolve(entryId);
  assert.ok(entry.fiber, 'Cordis Loader must import the package entry point');
  await entry.fiber.await();
  assert.equal(entry.fiber.state, 2, 'plugin must be active, not pending or failed');

  const tools = ctx.get('tools');
  assert.ok(tools.schemas().some((tool) => tool.name === 'web_search'), 'native model tool must be visible');
  const result = await tools.execute({
    callId: 'devbits-web-search-smoke',
    name: 'web_search',
    arguments: { queries: ['Cordis'] },
    signal: new AbortController().signal
  });
  assert.equal(result.isError, false, JSON.stringify(result));
  const text = result.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
  assert.match(text, /https:\/\/example\.com\/cordis/);
  assert.match(text, /Instant Answers/i);
  assert.match(text, /untrusted data/i);
  assert.equal(result.meta.sources.length, 2, 'tool result limit must be enforced');
  assert.equal(result.meta.truncated, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.params.q, 'Cordis');

  // Exercise the real settings form projection and mutation, with an in-memory
  // config editor so no user profile or credentials are read or written.
  ctx.provide('profileContext', { home: tempHome, name: 'devbits-web-search-smoke' });
  ctx.provide('configEditor', {
    documentPath: path.join(tempHome, 'cordis.patch.yml'),
    entries: () => [entry],
    configuration: () => [{ entry, inherited: {}, override: entry.options.config }],
    async edit(target, change) {
      await loader.update(target.id, { config: change(target.options.config, {}) });
      await loader.await();
    }
  });
  await ctx.plugin(SettingsForms);
  const settings = ctx.get('settings');
  const before = settings.describe({ redactSecrets: true }).find((form) => form.ns === entryId);
  assert.ok(before, 'plugin settings must be discoverable by Harness');
  assert.equal(before.autoGenerate, false, 'the custom bundle page must replace the duplicate generated row form');
  assert.equal(before.applies, 'live');
  assert.equal(before.value.defaultEngine, 'duckduckgo');
  const previousFiber = entry.fiber;
  await settings.update(entryId, { defaultEngine: 'brave' }, before.revision);
  await assert.rejects(ctx.get('web').search({ query: 'missing key' }), {
    code: 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE'
  }, 'a paid provider without a key must be unavailable');
  await settings.update(entryId, {
    braveApiKey: 'fixture-brave-token',
    tavilyApiKey: 'fixture-tavily-token',
    exaApiKey: 'fixture-exa-token',
    googleApiKey: 'fixture-google-token',
    googleSearchEngineId: 'fixture-search-engine-id'
  });
  assert.equal(entry.fiber, previousFiber, 'live settings must not remount the provider');
  const redacted = settings.describe({ redactSecrets: true }).find((form) => form.ns === entryId);
  assert.equal(redacted.value.defaultEngine, 'brave');
  assert.ok(!JSON.stringify(redacted).includes('fixture-brave-token'), 'settings responses must redact API keys');
  assert.ok(!JSON.stringify(redacted).includes('fixture-google-token'), 'settings must also redact inactive engine keys');
  for (const engine of ['tavily', 'exa']) {
    assert.ok(!JSON.stringify(redacted).includes(`fixture-${engine}-token`), `${engine} API key must be redacted`);
    assert.ok(redacted.secrets.some(secret => secret.path.join('.') === `${engine}ApiKey` && secret.set), `${engine} saved-key status must be visible without the key`);
  }
  const changed = await tools.execute({
    callId: 'devbits-web-search-live-settings-smoke',
    name: 'web_search',
    arguments: { queries: ['changed engine'] },
    signal: new AbortController().signal
  });
  assert.equal(changed.isError, false, JSON.stringify(changed));
  assert.equal(changed.meta.sources[0].url, 'https://example.com/brave', 'the next search must use the new engine');
  assert.equal(requests.length, 2);

  for (const engine of ['tavily', 'exa', 'keenable']) {
    await settings.update(entryId, { defaultEngine: engine });
    assert.equal(entry.fiber, previousFiber, 'new engines must also apply without remounting');
    const searched = await tools.execute({
      callId: `devbits-web-search-${engine}-smoke`,
      name: 'web_search',
      arguments: { queries: ['changed engine'] },
      signal: new AbortController().signal
    });
    assert.equal(searched.isError, false, JSON.stringify(searched));
    assert.equal(searched.meta.sources[0].url, `https://example.com/${engine}`);
  }
  assert.equal(requests.length, 5);

  const transport = await createRpcTransport(ctx);
  const currentRevision = () => settings.describe({ redactSecrets: true }).find(form => form.ns === entryId).revision;
  const diagnose = async (query = 'Cordis', options) => {
    const payload = { query, revision: currentRevision() };
    if (options) return transport.call(payload, options);
    return { result: await transport.browserRpc.call('/devbits-web-search', 'test-search', payload, new AbortController().signal) };
  };
  let countBefore = requests.length;
  assert.equal((await diagnose('unauthenticated', { authenticated: false })).status, 401);
  assert.equal((await diagnose('cross-origin', { origin: 'https://example.org' })).status, 403);
  assert.equal(requests.length, countBefore, 'authentication must precede provider requests');
  assert.equal((await transport.call({ query: 'Cordis', revision: currentRevision(), apiKey: 'must-not-be-accepted' })).result.error.code, 'INVALID_ARGUMENT');
  assert.equal((await transport.call({ query: 'Cordis', revision: currentRevision() + 1 })).result.error.code, 'SETTINGS_CONFLICT');
  assert.equal((await diagnose('Cordis', { endpoint: 'unknown' })).result.error.code, 'NOT_FOUND');
  assert.equal(requests.length, countBefore, 'invalid or stale diagnostics must not contact a provider');

  await settings.update(entryId, { defaultEngine: 'duckduckgo', maxResults: 1 });
  const diagnostic = (await diagnose()).result;
  assert.equal(diagnostic.ok, true, JSON.stringify(diagnostic));
  assert.equal(diagnostic.value.engine, 'duckduckgo');
  assert.equal(diagnostic.value.revision, currentRevision());
  assert.equal(diagnostic.value.count, 1, 'diagnostics must obey the saved result cap');
  assert.equal(diagnostic.value.sources[0].url, 'https://example.com/cordis');
  assert.equal(diagnostic.value.truncated, true);
  assert.match(diagnostic.value.notice, /Instant Answers/);
  assert.ok(diagnostic.value.elapsedMs >= 0);
  assert.ok(Number.isFinite(Date.parse(diagnostic.value.testedAt)));
  const cappedTool = await tools.execute({
    callId: 'devbits-web-search-profile-result-cap', name: 'web_search',
    arguments: { queries: ['Cordis'] }, signal: new AbortController().signal
  });
  assert.equal(cappedTool.isError, false);
  assert.equal(cappedTool.meta.sources.length, 1, 'model searches must use the same profile result cap');
  assert.equal(cappedTool.meta.truncated, true);

  await settings.update(entryId, { defaultEngine: 'brave', braveApiKey: '' });
  countBefore = requests.length;
  const missing = (await diagnose()).result;
  assert.equal(missing.error.code, 'MISSING_CREDENTIALS');
  assert.equal(requests.length, countBefore, 'missing credentials must not spend request budget');

  await settings.update(entryId, { braveApiKey: 'fixture-brave-token', maxRequestsPerMinute: requests.length + 1 });
  replyOverride = async () => {
    throw Object.assign(new Error('private provider failure fixture-brave-token'), {
      response: { status: 401, data: { message: 'invalid fixture-brave-token' } }
    });
  };
  const rejectedKey = (await diagnose()).result;
  assert.equal(rejectedKey.error.code, 'INVALID_CREDENTIALS');
  assert.equal(rejectedKey.error.details.status, 401);
  assert.ok(!JSON.stringify(rejectedKey).includes('fixture-brave-token'), 'diagnostic failures must never expose credentials');

  await settings.update(entryId, { defaultEngine: 'duckduckgo', maxRequestsPerMinute: 600 });
  replyOverride = async () => ({ data: { RelatedTopics: [], Results: [], AbstractText: '' } });
  const empty = (await diagnose()).result;
  assert.equal(empty.ok, true, 'an empty Instant Answer is a successful provider response');
  assert.equal(empty.value.count, 0);

  const started = Promise.withResolvers();
  replyOverride = async (_url, options) => {
    started.resolve(options.signal);
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new axios.CanceledError('fixture cancellation')), { once: true }));
  };
  const disconnected = new AbortController();
  const canceledRequest = diagnose('cancelled test', { signal: disconnected.signal });
  const providerSignal = await started.promise;
  disconnected.abort();
  const canceledResponse = await canceledRequest;
  assert.equal(providerSignal.aborted, true, 'closing the native RPC response must cancel the provider request');
  assert.equal(canceledResponse.destroyed, true);

  const revisionStarted = Promise.withResolvers();
  const revisionReply = Promise.withResolvers();
  replyOverride = async () => { revisionStarted.resolve(); return revisionReply.promise; };
  const staleRequest = diagnose('settings change during a request');
  await revisionStarted.promise;
  const queuedStaleRequest = diagnose('settings change before a queued request starts');
  // Let the in-memory HTTP bridge parse and queue the second request.
  await new Promise(resolve => setImmediate(resolve));
  countBefore = requests.length;
  await settings.update(entryId, { maxResults: 2 });
  revisionReply.resolve({ data: { RelatedTopics: [], Results: [], AbstractText: '' } });
  assert.equal((await staleRequest).result.error.code, 'SETTINGS_CONFLICT', 'a completed request must not certify changed settings');
  assert.equal((await queuedStaleRequest).result.error.code, 'SETTINGS_CONFLICT');
  assert.equal(requests.length, countBefore, 'a stale queued test must not contact a provider');
  replyOverride = undefined;

  // A missing-key test and a stale queued test consumed no starts. Leave exactly
  // one slot above the observed HTTP count and verify that slot remains usable.
  await settings.update(entryId, { maxRequestsPerMinute: requests.length + 1 });
  assert.equal((await diagnose()).result.ok, true, 'preflight failures must not consume provider request budget');

  // Persist filters and instance authentication through the real settings service.
  await settings.update(entryId, { maxRequestsPerMinute: 600, blockedDomains: 'example.com' });
  const filtered = (await diagnose()).result;
  assert.equal(filtered.value.count, 0);
  assert.equal(filtered.value.filteredCount, 3);
  assert.match(filtered.value.notice, /source filters/);
  await settings.update(entryId, { blockedDomains: '', dateRange: 'week' });
  countBefore = requests.length;
  assert.equal((await diagnose()).result.error.code, 'UNSUPPORTED_FILTER');
  assert.equal(requests.length, countBefore);
  await settings.update(entryId, { defaultEngine: 'searxng', dateRange: 'day', searxngInstanceUrl: 'http://localhost:8080/base',
    searxngAuth: 'bearer', searxngToken: 'fixture-instance-token', searxngUsername: 'fixture-instance-user', searxngPassword: 'fixture-instance-password' });
  assert.equal(entry.fiber, previousFiber);
  assert.ok(!JSON.stringify(settings.describe({ redactSecrets: true })).includes('fixture-instance-'));
  replyOverride = async (url, options) => {
    assert.equal(url, 'http://localhost:8080/base/search');
    assert.equal(options.headers.Authorization, 'Bearer fixture-instance-token');
    assert.equal(options.params.time_range, 'day');
    return { data: { results: [{ title: 'SearXNG fixture', url: 'https://example.com/searxng', content: 'Excerpt.' }], unresponsive_engines: [['fixture', 'failed']] } };
  };
  const instanceDiagnostic = (await diagnose()).result;
  assert.equal(instanceDiagnostic.ok, true, JSON.stringify(instanceDiagnostic));
  assert.equal(instanceDiagnostic.value.partialFailureCount, 1);
  assert.match(instanceDiagnostic.value.notice, /limited coverage/);
  const instanceTool = await tools.execute({ callId: 'searxng-tool', name: 'web_search', arguments: { queries: ['instance search'] }, signal: new AbortController().signal });
  assert.equal(instanceTool.isError, false, JSON.stringify(instanceTool));
  assert.equal(instanceTool.meta.sources[0].url, 'https://example.com/searxng');
  assert.match(JSON.stringify(instanceTool.content), /limited coverage/);
  await settings.update(entryId, { defaultEngine: 'duckduckgo', dateRange: 'any' });
  replyOverride = undefined;

  // Native model searches and diagnostics share consumed history, including
  // failed and cancelled requests. Live edits must not reset that history.
  await settings.update(entryId, { maxRequestsPerMinute: requests.length });
  countBefore = requests.length;
  const limited = (await diagnose()).result;
  assert.equal(limited.error.code, 'RATE_LIMITED');
  assert.ok(limited.error.details.retryAfterMs > 0);
  const limitedTool = await tools.execute({
    callId: 'devbits-web-search-shared-budget', name: 'web_search',
    arguments: { queries: ['shared limit'] }, signal: new AbortController().signal
  });
  assert.equal(limitedTool.isError, true, 'the same budget must stop model requests');
  assert.equal(requests.length, countBefore);

  await settings.update(entryId, { maxRequestsPerMinute: 600, minIntervalMs: 60000, timeoutMs: 20 });
  const timedOut = (await diagnose()).result;
  assert.equal(timedOut.error.code, 'TIMEOUT', 'the timeout must include pacing time');
  assert.equal(requests.length, countBefore, 'a timeout during pacing must not contact the provider');
  await settings.update(entryId, { minIntervalMs: 0, timeoutMs: 15000, defaultEngine: 'brave' });
  replyOverride = async () => {
    throw Object.assign(new Error('fixture provider limit'), {
      response: { status: 429, headers: { 'retry-after': '60' }, data: { message: 'rate limited' } }
    });
  };
  const providerLimited = (await diagnose()).result;
  assert.equal(providerLimited.error.code, 'RATE_LIMITED');
  assert.equal(providerLimited.error.details.status, 429);
  assert.ok(providerLimited.error.details.retryAfterMs > 0);
  countBefore = requests.length;
  assert.equal((await diagnose()).result.error.code, 'RATE_LIMITED');
  assert.equal(requests.length, countBefore, 'Retry-After must prevent another outbound request');
  assert.equal(entry.fiber, previousFiber, 'all configuration changes must stay live');

  await entry.fiber.dispose();
  assert.equal(transport.routes.has('/devbits-web-search'), false, 'disposing the plugin must remove its diagnostic route');
  await assert.rejects(ctx.get('web').search({ query: 'Cordis' }), {
    code: 'WEB_PROVIDER_CONFIGURED_MISSING'
  }, 'disposing the plugin must unregister its provider');

  // Production web profiles usually provide Connection and settings before
  // loading this bundle. Verify that order as well as services arriving later.
  loader.remove(entryId);
  await loader.await();
  await loader.create({ id: entryId, name: 'devbits-web-search', config: { minIntervalMs: 0 } });
  await loader.await();
  entry = loader.resolve(entryId);
  await entry.fiber.await();
  replyOverride = undefined;
  assert.equal(entry.fiber.state, 2);
  assert.equal((await diagnose()).result.ok, true, 'diagnostics must also register when all optional services already exist');
  await entry.fiber.dispose();

  console.log('PASS: native loading and model search; live secret-safe settings; native browser-to-host authenticated diagnostic RPC, cancellation and revision checks; shared request/result limits and provider cooldown; both service load orders and scoped disposal. No external requests or user-profile writes.');
} finally {
  axios.get = originalGet;
  axios.post = originalPost;
  await ctx.fiber.dispose();
  await rm(tempHome, { recursive: true, force: true });
}
