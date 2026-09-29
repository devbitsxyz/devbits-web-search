'use strict';

const WebSearchPlugin = require('./index');
const { Config, resolveConfig, resolveLimits } = require('./settings');
const { RequestGovernor } = require('./request-limits');
const { CHANNEL, createDiagnostics } = require('./diagnostics');

const PROVIDER_ID = 'local-web-search';
const { INSTANT_ANSWER_NOTICE, resultNotice } = require('./notices');

/** Register a provider for the native Harness web_search tool. Cordis owns disposal. */
function apply(ctx, config = {}) {
  const createClient = () => new WebSearchPlugin(resolveConfig(config));
  // Fail invalid initial configuration during mounting, then snapshot live
  // settings per operation so a UI edit takes effect on the next request.
  createClient();
  const governor = new RequestGovernor(resolveLimits(config));
  ctx.effect(() => () => governor.dispose());

  const executeSearch = async (request, signal, beforeStart) => {
    const client = createClient();
    const engine = client.config.defaultEngine;
    const reject = (code, message) => { throw Object.assign(new Error(message), { code, engine }); };
    if (typeof request?.query !== 'string' || !request.query.trim()) {
      reject('INVALID_ARGUMENT', 'Enter a nonempty search query.');
    }
    client.assertReady(request.query);
    const limits = resolveLimits(config);
    const requested = request.maxResults ?? limits.maxResults;
    if (!Number.isInteger(requested) || requested < 1 || requested > 20) {
      reject('INVALID_ARGUMENT', 'maxResults must be an integer between 1 and 20.');
    }
    governor.configure(limits);
    const result = await governor.run(({ signal: governedSignal, timeoutMs }) => {
      return client.search(request.query, {
        num: Math.min(requested, limits.maxResults), signal: governedSignal, timeoutMs,
      });
    }, { signal, timeoutMs: client.config.timeoutMs, engine, beforeStart });
    return { ...result, truncated: result.truncated || requested > limits.maxResults };
  };

  // Optional UI services keep the search provider usable in CLI-only profiles.
  ctx.inject(['settings'], child => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber));
  });
  ctx.inject(['connection', 'webServer', 'settings'], child => {
    // Harness 0.1.7's RPC getter carries a traced context into registration.
    // Carry the injected server explicitly so that context can resolve it;
    // the derived context still belongs to this child's disposable lifetime.
    const routeContext = child.extend({ webServer: child.webServer });
    routeContext.connection.rpc.handle(CHANNEL, createDiagnostics({
      settings: child.settings, executeSearch, notice: INSTANT_ANSWER_NOTICE,
    }));
  });

  ctx.web.registerSearchProvider({
    id: PROVIDER_ID,
    available: () => createClient().isAvailable(),
    async search(request, signal) {
      const result = await executeSearch(request, signal);
      return {
        sources: result.results.map(({ url, title, snippet }) => ({ url, title, snippet })),
        truncated: result.truncated,
        ...(resultNotice(result) ? { content: resultNotice(result) } : {}),
      };
    },
  });
}

// Named exports form the Cordis plugin contract. The standalone client is also
// available for scripts that used the package's documented create() API.
exports.name = 'web-search';
exports.inject = ['web'];
exports.Config = Config;
exports.apply = apply;
exports.PROVIDER_ID = PROVIDER_ID;
exports.WebSearchPlugin = WebSearchPlugin;
exports.create = (config) => WebSearchPlugin.create(config);
