/* Browser entry for Harness's module registry; shipped directly without a build. */
window.__ModuleLoader__.load({
  id: 'devbits-web-search',
  factory(require) {
    'use strict';

    const React = require('react');
    const { Button, Input } = require('@deepseek-ai/dsh-client-ui-primitives');
    const h = React.createElement;
    const ENTRY_ID = 'devbits-web-search';
    const secretFields = ['braveApiKey', 'googleApiKey', 'tavilyApiKey', 'exaApiKey', 'searxngToken', 'searxngUsername', 'searxngPassword'];
    const providers = {
      searxng: { name: 'SearXNG' },
      duckduckgo: { name: 'DuckDuckGo Instant Answers' },
      brave: {
        name: 'Brave Search', field: 'braveApiKey', keyLabel: 'Brave API key',
        description: 'Search the web with Brave’s index. Requires a Brave Search API key.',
        setup: 'https://api-dashboard.search.brave.com/app/keys',
        docs: 'https://api-dashboard.search.brave.com/app/documentation/web-search/get-started',
      },
      google: { name: 'Google Custom Search', field: 'googleApiKey', keyLabel: 'Google API key' },
      tavily: {
        name: 'Tavily', field: 'tavilyApiKey', keyLabel: 'Tavily API key',
        description: 'Web results with relevant page excerpts, using Tavily’s basic search. Requires a Tavily API key.',
        setup: 'https://app.tavily.com/',
        docs: 'https://docs.tavily.com/documentation/api-reference/endpoint/search',
      },
      exa: {
        name: 'Exa', field: 'exaApiKey', keyLabel: 'Exa API key',
        description: 'Web results with page highlights, using Exa’s standard auto search. Requires an Exa API key.',
        setup: 'https://dashboard.exa.ai/api-keys',
        docs: 'https://exa.ai/docs/reference/search',
      },
    };
    const formStyle = { display: 'grid', gap: 20, maxWidth: 640, minWidth: 0 };
    const fieldStyle = { display: 'grid', gap: 8 };
    const hintStyle = { color: 'var(--dsw-alias-label-secondary)', fontSize: 13, margin: 0 };
    const rowStyle = { display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' };
    const panelStyle = {
      display: 'grid', gap: 16, padding: 16, borderRadius: 10,
      border: '1px solid var(--dsw-alias-border-l3)',
      background: 'var(--dsw-alias-bg-layer-2)',
    };
    const selectStyle = {
      color: 'var(--dsw-alias-label-primary)',
      background: 'var(--dsw-alias-bg-layer-2)',
      border: '1px solid var(--dsw-alias-border-l3)',
      borderRadius: 8,
      padding: '10px 12px',
      font: 'inherit',
    };

    function draftFromValues(value = {}) {
      return {
        defaultEngine: value.defaultEngine ?? 'duckduckgo',
        timeoutMs: String(value.timeoutMs ?? 15000),
        maxRequestsPerMinute: String(value.maxRequestsPerMinute ?? 20),
        minIntervalMs: String(value.minIntervalMs ?? 1000),
        maxResults: String(value.maxResults ?? 8),
        googleSearchEngineId: value.googleSearchEngineId ?? '',
        allowedDomains: value.allowedDomains ?? '',
        blockedDomains: value.blockedDomains ?? '',
        dateRange: value.dateRange ?? 'any',
        searxngInstanceUrl: value.searxngInstanceUrl ?? '',
        searxngAuth: value.searxngAuth ?? 'none',
        searxngToken: '', searxngUsername: '', searxngPassword: '',
        braveApiKey: '',
        googleApiKey: '',
        tavilyApiKey: '',
        exaApiKey: '',
      };
    }

    /** Parse decimal seconds exactly, avoiding floating-point millisecond drift. */
    function timeoutSecondsToMilliseconds(value) {
      const match = /^(?:(\d+)(?:\.(\d{0,3}))?|\.(\d{1,3}))$/.exec(String(value).trim());
      if (!match) return null;
      const milliseconds = Number(match[1] || 0) * 1000
        + Number((match[2] || match[3] || '').padEnd(3, '0'));
      return Number.isSafeInteger(milliseconds) ? milliseconds : null;
    }

    function isDraftDirty(draft, cleared = {}, value = {}) {
      const saved = draftFromValues(value);
      return draft.defaultEngine !== saved.defaultEngine
        || ['timeoutMs', 'maxRequestsPerMinute', 'minIntervalMs', 'maxResults'].some((field) =>
          !String(draft[field]).trim() || Number(draft[field]) !== Number(saved[field]))
        || draft.googleSearchEngineId.trim() !== saved.googleSearchEngineId.trim()
        || ['allowedDomains', 'blockedDomains', 'dateRange', 'searxngInstanceUrl', 'searxngAuth'].some(field => draft[field].trim() !== saved[field].trim())
        || secretFields.some((field) => cleared[field] || draft[field].trim());
    }

    function domainList(value) {
      const entries = value.split(/[\s,]+/u).filter(Boolean);
      if (entries.length > 100) throw new Error('Use at most 100 hostnames per domain list.');
      return [...new Set(entries.map(entry => {
        const text = entry.replace(/\.$/u, '');
        if (/[\s/:?#@*\\%]/u.test(text)) throw new Error('Enter hostnames without URLs, paths, ports, or wildcards.');
        let host;
        try { host = new URL(`https://${text}`).hostname; } catch { throw new Error('Enter a valid hostname.'); }
        if (host.length > 253 || !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) throw new Error('Enter a valid hostname.');
        return host.toLowerCase();
      }))].join('\n');
    }

    const dateLabels = { any: 'Any time', day: 'Past day', week: 'Past week', month: 'Past month', year: 'Past year' };
    const supportsDate = (engine, range) => Object.hasOwn(dateLabels, range)
      && (engine !== 'duckduckgo' || range === 'any') && (engine !== 'searxng' || range !== 'week');

    /** Blank password controls preserve keys; removal is an explicit edit. */
    function createSettingsOperations(draft, cleared = {}) {
      const timeoutMs = Number(draft.timeoutMs);
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) {
        throw new Error('Enter a timeout from 0.001 to 120 seconds, with up to 3 decimal places.');
      }
      if (!Object.hasOwn(providers, draft.defaultEngine)) {
        throw new Error('Choose a supported search engine.');
      }
      if (!supportsDate(draft.defaultEngine, draft.dateRange)) throw new Error('This provider does not support the selected date range. Choose Any time or a supported range.');
      if (!['none', 'bearer', 'basic'].includes(draft.searxngAuth)) throw new Error('Choose a supported instance authentication method.');
      if (draft.searxngInstanceUrl.trim()) {
        let url;
        try { url = new URL(draft.searxngInstanceUrl.trim()); } catch { throw new Error('Enter a valid SearXNG instance URL.'); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Use an instance URL without credentials, query parameters, or a fragment.');
        const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
        const local = host === '::1' || /^(fc|fd)[0-9a-f]{2}:/i.test(host)
          || (/^\d+\.\d+\.\d+\.\d+$/.test(host) && /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(host))
          || host.endsWith('.local') || ['host.docker.internal', 'gateway.docker.internal'].includes(host) || host.endsWith('.localhost') || /^[a-z][a-z0-9-]*$/i.test(host);
        if (url.protocol === 'http:' && !local) throw new Error('Use HTTPS for remote instances. HTTP is only for local hostnames and private IP addresses.');
        if (/%2f|%5c|%2e/i.test(url.pathname)) throw new Error('Use a plain instance path without encoded separators.');
      }
      if (['searxngToken', 'searxngUsername', 'searxngPassword'].some(field => /[\r\n\u0000]/u.test(draft[field]))) throw new Error('Instance credentials contain invalid characters.');
      if (draft.searxngUsername.includes(':')) throw new Error('A Basic authentication username cannot contain a colon.');
      const numeric = {};
      for (const [field, min, max, label] of [
        ['maxRequestsPerMinute', 1, 600, 'Requests per minute'],
        ['minIntervalMs', 0, 60000, 'Time between requests'],
        ['maxResults', 1, 20, 'Results per search'],
      ]) {
        const value = Number(draft[field]);
        if (!String(draft[field]).trim() || !Number.isInteger(value) || value < min || value > max) {
          throw new Error(field === 'minIntervalMs'
            ? 'Enter a time between requests from 0 to 60 seconds, with up to 3 decimal places.'
            : `${label} must be a whole number from ${min} to ${max}.`);
        }
        numeric[field] = value;
      }
      const ops = [
        { op: 'set', path: ['defaultEngine'], value: draft.defaultEngine },
        { op: 'set', path: ['timeoutMs'], value: timeoutMs },
        { op: 'set', path: ['googleSearchEngineId'], value: draft.googleSearchEngineId.trim() },
        ...Object.entries({ allowedDomains: domainList(draft.allowedDomains), blockedDomains: domainList(draft.blockedDomains),
          dateRange: draft.dateRange, searxngInstanceUrl: draft.searxngInstanceUrl.trim(), searxngAuth: draft.searxngAuth })
          .map(([field, value]) => ({ op: 'set', path: [field], value })),
        ...Object.entries(numeric).map(([field, value]) => ({ op: 'set', path: [field], value })),
      ];
      for (const field of secretFields) {
        if (cleared[field]) ops.push({ op: 'set', path: [field], value: '' });
        else if (draft[field].trim()) ops.push({ op: 'set', path: [field], value: field === 'searxngPassword' ? draft[field] : draft[field].trim() });
      }
      return ops;
    }

    const diagnosticCodes = new Set([
      'INVALID_FILTERS', 'UNSUPPORTED_FILTER', 'INVALID_INSTANCE', 'MISSING_INSTANCE', 'INSTANCE_ACCESS_DENIED', 'UPSTREAM_UNAVAILABLE',
      'INVALID_ARGUMENT', 'MISSING_CREDENTIALS', 'INVALID_CREDENTIALS',
      'QUOTA_EXCEEDED', 'RATE_LIMITED', 'QUEUE_FULL', 'TIMEOUT', 'ERR_CANCELED',
      'INVALID_RESPONSE', 'RESPONSE_TOO_LARGE', 'NETWORK_ERROR', 'PROVIDER_ERROR', 'SEARCH_FAILED',
      'SETTINGS_CONFLICT', 'SETTINGS_UNAVAILABLE', 'NOT_FOUND',
    ]);

    /** Only non-content metadata may leave the page through Copy diagnostics. */
    function diagnosticMetadata(outcome) {
      const details = outcome?.ok ? outcome.value : outcome?.error?.details;
      const safe = { plugin: ENTRY_ID, outcome: outcome?.ok ? 'success' : 'error' };
      if (Object.hasOwn(providers, details?.engine)) safe.engine = details.engine;
      for (const key of ['revision', 'elapsedMs', 'count', 'retryAfterMs', 'filteredCount', 'partialFailureCount']) {
        if (Number.isFinite(details?.[key]) && details[key] >= 0) safe[key] = details[key];
      }
      if (Number.isInteger(details?.status) && details.status >= 100 && details.status <= 599) safe.status = details.status;
      if (typeof details?.truncated === 'boolean') safe.truncated = details.truncated;
      if (typeof details?.testedAt === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(details.testedAt)
        && Number.isFinite(Date.parse(details.testedAt))) safe.testedAt = details.testedAt;
      if (!outcome?.ok) safe.code = diagnosticCodes.has(outcome?.error?.code) ? outcome.error.code : 'SEARCH_FAILED';
      return safe;
    }

    function safeSourceUrl(value) {
      try {
        const url = new URL(value);
        return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
      } catch { return null; }
    }

    function SettingsPage({ remote, connection, store }) {
      const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
      const form = { state, mutate: store.mutate };
      const [descriptor, setDescriptor] = React.useState(null);
      const [draft, setDraft] = React.useState(() => draftFromValues());
      const [timeoutSeconds, setTimeoutSeconds] = React.useState('15');
      const [intervalSeconds, setIntervalSeconds] = React.useState('1');
      const [cleared, setCleared] = React.useState({});
      const [phase, setPhase] = React.useState('loading');
      const [message, setMessage] = React.useState('');
      const [testQuery, setTestQuery] = React.useState('Ada Lovelace');
      const [testPhase, setTestPhase] = React.useState('idle');
      const [testOutcome, setTestOutcome] = React.useState(null);
      const [testMessage, setTestMessage] = React.useState('');
      const [copyMessage, setCopyMessage] = React.useState('');
      const mounted = React.useRef(false);
      const readGeneration = React.useRef(0);
      const busy = React.useRef(false);
      const testRequest = React.useRef(null);
      const testGeneration = React.useRef(0);

      const clearTest = React.useCallback(() => {
        testGeneration.current++;
        testRequest.current?.abort();
        testRequest.current = null;
        setTestPhase('idle');
        setTestOutcome(null);
        setTestMessage('');
        setCopyMessage('');
      }, []);

      const readSettings = React.useCallback(async () => {
        const generation = ++readGeneration.current;
        let response;
        try {
          response = await remote.settings.describe();
        } catch (error) {
          if (!mounted.current || generation !== readGeneration.current) return false;
          throw error;
        }
        if (!mounted.current || generation !== readGeneration.current) return false;
        // Typert client methods wrap successful values and host refusals. The
        // server implementation's return type alone does not describe this wire API.
        if (response.ok !== true || !Array.isArray(response.value?.namespaces)) {
          throw new Error('The Harness did not return plugin settings.');
        }
        const current = response.value.namespaces.find((entry) => entry.ns === ENTRY_ID);
        if (!current) throw new Error('Enable DevBits Web Search before configuring it.');
        setDescriptor(current);
        setDraft(draftFromValues(current.value));
        setTimeoutSeconds(String((current.value?.timeoutMs ?? 15000) / 1000));
        setIntervalSeconds(String((current.value?.minIntervalMs ?? 1000) / 1000));
        setCleared({});
        busy.current = false;
        setPhase('ready');
        return true;
      }, [remote]);

      React.useEffect(() => {
        mounted.current = true;
        busy.current = true;
        setPhase('loading');
        setMessage('');
        const generation = readGeneration.current + 1;
        readSettings().catch(() => {
          if (!mounted.current || generation !== readGeneration.current) return;
          busy.current = false;
          setMessage('Could not load plugin settings. Reload settings to try again.');
          setPhase('failed');
        });
        return () => {
          mounted.current = false;
          readGeneration.current++;
          testGeneration.current++;
          testRequest.current?.abort();
          testRequest.current = null;
        };
      }, [readSettings]);

      React.useEffect(() => { clearTest(); }, [state.revision, connection, clearTest]);

      const writable = form?.state?.writable === true && form.state.status === 'ready';
      const changedElsewhere = descriptor && form?.state?.revision !== undefined
        && descriptor.revision !== form.state.revision && !['saving', 'refresh-failed'].includes(phase);
      const disabled = phase !== 'ready' || !writable || Boolean(changedElsewhere);
      const dirty = descriptor && isDraftDirty(draft, cleared, descriptor.value);
      const canEdit = () => {
        const current = store.getSnapshot();
        return mounted.current && !busy.current && phase === 'ready' && descriptor
          && current.writable === true && current.status === 'ready'
          && (current.revision === undefined || current.revision === descriptor.revision);
      };

      const edit = (field, value) => {
        if (!canEdit()) return;
        clearTest();
        setDraft((previous) => ({ ...previous, [field]: value }));
        if (secretFields.includes(field)) setCleared((previous) => ({ ...previous, [field]: false }));
        setMessage('');
      };

      const reload = async () => {
        if (!mounted.current || busy.current) return;
        clearTest();
        busy.current = true;
        setPhase('loading');
        setMessage('');
        const generation = readGeneration.current + 1;
        try { await readSettings(); } catch {
          if (!mounted.current || generation !== readGeneration.current) return;
          busy.current = false;
          setPhase('failed');
          setMessage('Could not load plugin settings. Check the Harness connection and try again.');
        }
      };

      const discard = () => {
        if (!canEdit()) return;
        clearTest();
        setDraft(draftFromValues(descriptor.value));
        setTimeoutSeconds(String((descriptor.value?.timeoutMs ?? 15000) / 1000));
        setIntervalSeconds(String((descriptor.value?.minIntervalMs ?? 1000) / 1000));
        setCleared({});
        setMessage('');
      };

      const save = async (event) => {
        event.preventDefault();
        if (!canEdit() || !dirty) return;
        let ops;
        try { ops = createSettingsOperations(draft, cleared); } catch (error) {
          setMessage(error.message);
          return;
        }
        clearTest();
        busy.current = true;
        setPhase('saving');
        setMessage('');
        let generation = readGeneration.current;
        let persisted = false;
        try {
          const accepted = await form.mutate(ops, descriptor.revision);
          if (!mounted.current || generation !== readGeneration.current) return;
          if (!accepted) {
            busy.current = false;
            setPhase('failed');
            setMessage('The settings changed or the save was refused. Reload settings before trying again.');
            return;
          }
          persisted = true;
          // Clear password drafts as soon as persistence succeeds, even if the
          // following status read fails. Never put a saved key into page state.
          setDraft((previous) => ({ ...previous, ...Object.fromEntries(secretFields.map((field) => [field, ''])) }));
          setCleared({});
          generation = readGeneration.current + 1;
          const refreshed = await readSettings();
          if (refreshed && mounted.current) setMessage('Saved. The next search uses these settings.');
        } catch {
          if (!mounted.current || generation !== readGeneration.current) return;
          busy.current = false;
          setPhase(persisted ? 'refresh-failed' : 'failed');
          setMessage(persisted
            ? 'Settings were saved, but their status could not be refreshed. Reload settings to continue.'
            : 'Could not confirm the save. Reload settings to check the saved values before trying again.');
        }
      };

      const runTest = async () => {
        if (!canEdit() || dirty || testRequest.current) return;
        const query = testQuery.trim();
        if (!query || query.length > 600) {
          setTestMessage('Enter a search query from 1 to 600 characters.');
          return;
        }
        const revision = descriptor.revision;
        const generation = ++testGeneration.current;
        const controller = new AbortController();
        testRequest.current = controller;
        setTestPhase('running');
        setTestOutcome(null);
        setTestMessage('');
        setCopyMessage('');
        const current = () => mounted.current && generation === testGeneration.current
          && !controller.signal.aborted && store.getSnapshot().revision === revision;
        try {
          const response = await connection.rpc.call('/devbits-web-search', 'test-search', { query, revision }, controller.signal);
          if (!current()) return;
          if (response?.ok === true) {
            const value = response.value;
            if (!value || value.revision !== revision || value.engine !== (descriptor.value.defaultEngine ?? 'duckduckgo')
              || !Array.isArray(value.sources) || value.sources.length > 3
              || value.sources.some((source) => !source || typeof source.title !== 'string'
                || typeof source.url !== 'string' || typeof source.snippet !== 'string')
              || !Number.isInteger(value.count) || value.count < 0 || value.count > 3
              || !Number.isFinite(value.elapsedMs) || value.elapsedMs < 0
              || typeof value.testedAt !== 'string' || !Number.isFinite(Date.parse(value.testedAt))) {
              throw new Error('Invalid search diagnostics');
            }
            setTestOutcome({ ok: true, value });
          } else if (response?.ok === false && diagnosticCodes.has(response.error?.code)) {
            setTestOutcome({ ok: false, error: {
              code: response.error.code,
              message: typeof response.error.message === 'string' ? response.error.message.slice(0, 600)
                : 'The search test could not complete. Check the saved settings and try again.',
              details: response.error.details ?? {},
            } });
            if (['SETTINGS_CONFLICT', 'SETTINGS_UNAVAILABLE'].includes(response.error.code)) {
              setPhase('failed');
              setMessage('Reload settings before testing again.');
            }
          } else throw new Error('Invalid search diagnostics');
          setTestPhase('done');
        } catch (error) {
          if (!current()) return;
          const statusMatch = /: HTTP (\d{3})$/.exec(typeof error?.message === 'string' ? error.message : '');
          const parsedStatus = statusMatch ? Number(statusMatch[1]) : undefined;
          const status = parsedStatus >= 100 && parsedStatus <= 599 ? parsedStatus : undefined;
          const unreadable = error?.message === 'Invalid search diagnostics';
          setTestOutcome({ ok: false, error: {
            code: unreadable ? 'INVALID_RESPONSE' : 'SEARCH_FAILED',
            message: status === 404 || status === 405
              ? `The search test endpoint is unavailable (HTTP ${status}). Restart Harness after updating the plugin.`
              : status === 401 || status === 403
                ? `Harness denied the search test (HTTP ${status}). Reopen Harness using its current launch link.`
                : unreadable
                  ? 'Harness returned an unreadable test response. Restart Harness and reload the page after updating the plugin.'
                  : 'Could not complete the test. Check the Harness connection, and reload the page if you recently updated the plugin.',
            details: status ? { status } : {},
          } });
          setTestPhase('done');
        } finally {
          if (testRequest.current === controller) testRequest.current = null;
        }
      };

      const cancelTest = () => {
        if (!mounted.current || !testRequest.current) return;
        clearTest();
        setTestMessage('Search test canceled.');
      };

      const clipboardAvailable = typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function';
      const copyDiagnostics = async () => {
        if (!mounted.current || !testOutcome || !clipboardAvailable || changedElsewhere || dirty) return;
        const generation = testGeneration.current;
        try {
          await navigator.clipboard.writeText(JSON.stringify(diagnosticMetadata(testOutcome), null, 2));
          if (mounted.current && generation === testGeneration.current) setCopyMessage('Diagnostics copied. Search content and keys are excluded.');
        } catch {
          if (mounted.current && generation === testGeneration.current) setCopyMessage('Could not copy diagnostics. Check browser clipboard permissions.');
        }
      };

      const savedKey = (field) => descriptor?.secrets?.some((secret) => secret.path.length === 1
        && secret.path[0] === field && secret.set);
      const configured = (field) => !cleared[field] && (Boolean(draft[field].trim()) || savedKey(field));
      const textField = (field, label, hint, props = {}) => h('div', { style: fieldStyle, key: field },
        h('label', { htmlFor: `web-search-${field}` }, label),
        h(Input, {
          id: `web-search-${field}`, value: draft[field], disabled,
          onChange: (event) => edit(field, event.target.value), ...props,
        }),
        hint && h('p', { style: hintStyle }, hint));
      const secretField = (field, label) => h('div', { style: fieldStyle, key: field },
        h('label', { htmlFor: `web-search-${field}` }, label),
        h(Input, {
          id: `web-search-${field}`, type: 'password', value: draft[field], disabled,
          autoComplete: 'new-password', spellCheck: false,
          placeholder: field.startsWith('searxng') ? (savedKey(field) ? 'Leave blank to keep the saved value' : `Enter ${label.toLowerCase()}`) : phase === 'refresh-failed' ? 'Reload to confirm the saved key'
            : cleared[field] ? 'Key will be removed when you save'
            : savedKey(field) ? 'Leave blank to keep the saved key' : 'Enter an API key',
          onChange: (event) => edit(field, event.target.value),
        }),
        h('div', { style: rowStyle },
          h('span', { style: hintStyle }, field.startsWith('searxng') ? (cleared[field] ? 'This credential will be removed on save.' : 'Saved values stay hidden. Leave blank to keep them.') : phase === 'refresh-failed' ? 'Reload settings to refresh the saved key status.'
            : cleared[field] ? 'The saved key will be removed on save.'
            : draft[field].trim() ? 'New key entered. Save changes to use it.'
              : savedKey(field) ? 'Leave blank to keep your saved key.' : 'A key is required for this provider.'),
          phase !== 'refresh-failed' && savedKey(field) && h(Button, {
            type: 'button', variant: 'outline', size: 'sm', disabled,
            onClick: () => {
              if (!canEdit()) return;
              clearTest();
              setCleared((previous) => ({ ...previous, [field]: !previous[field] }));
              setDraft((previous) => ({ ...previous, [field]: '' }));
              setMessage('');
            },
          }, cleared[field] ? 'Undo removal' : field.startsWith('searxng') ? `Remove saved ${label.toLowerCase()}` : 'Remove saved key')));

      const link = (url, label) => h('a', {
        href: url, target: '_blank', rel: 'noopener noreferrer',
        style: { color: 'inherit', textUnderlineOffset: 3 },
      }, label);
      const keyStorage = h('p', { style: hintStyle }, 'Keys are saved in your active Harness profile and stay hidden in this form. They authorize the search service, not access to private websites.');
      const provider = providers[draft.defaultEngine] || providers.duckduckgo;
      const status = (() => {
        if (phase === 'failed' || phase === 'refresh-failed') return 'Settings unavailable';
        if (phase === 'loading') return 'Loading settings…';
        if (phase === 'saving') return 'Saving…';
        if (draft.defaultEngine === 'duckduckgo') return 'No API key needed';
        if (draft.defaultEngine === 'searxng') {
          if (!draft.searxngInstanceUrl.trim()) return 'Instance URL required';
          const missingBearer = draft.searxngAuth === 'bearer' && !configured('searxngToken');
          const missingBasic = draft.searxngAuth === 'basic' && (!configured('searxngUsername') || !configured('searxngPassword'));
          if (missingBearer || missingBasic) return 'Authentication required';
          return dirty ? 'Configuration entered — save to use' : 'Configuration saved';
        }
        if (draft.defaultEngine === 'google') {
          if (!configured('googleApiKey') || !draft.googleSearchEngineId.trim()) return 'Setup required';
          const newConfig = draft.googleApiKey.trim()
            || draft.googleSearchEngineId.trim() !== (descriptor?.value?.googleSearchEngineId ?? '').trim();
          return newConfig ? 'Configuration entered — save to use' : 'Configuration saved';
        }
        if (!configured(provider.field)) return 'API key required';
        return draft[provider.field].trim() ? 'API key entered — save to use' : 'API key saved';
      })();
      const timeoutMs = Number(draft.timeoutMs);
      const timeoutError = !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000;

      return h('form', { style: formStyle, onSubmit: save, 'aria-label': 'DevBits Web Search settings' },
        h('p', { style: hintStyle }, 'Choose a provider for web searches. Queries are sent to the selected search service.'),
        phase === 'loading' && h('p', { role: 'status' }, 'Loading settings…'),
        form?.state?.status === 'ready' && form.state.writable === false && phase !== 'loading'
          && h('p', { role: 'status' }, 'This connection cannot edit the active plugin settings.'),
        phase === 'ready' && form?.state?.status !== 'ready'
          && h('p', { role: 'status' }, !form?.state || form.state.status === 'loading'
            ? 'Loading settings controls…'
            : 'The Harness settings form is unavailable. Reopen this plugin’s settings to reconnect.'),
        h('div', { style: fieldStyle },
          h('label', { htmlFor: 'web-search-engine' }, 'Search engine'),
          h('select', {
            id: 'web-search-engine', value: draft.defaultEngine, disabled, style: selectStyle,
            onChange: (event) => edit('defaultEngine', event.target.value),
          },
          h('option', { value: 'duckduckgo' }, 'DuckDuckGo — no API key'),
          h('option', { value: 'brave' }, 'Brave Search'),
          h('option', { value: 'tavily' }, 'Tavily'),
          h('option', { value: 'exa' }, 'Exa'),
          h('option', { value: 'searxng' }, 'SearXNG — your own instance'),
          h('option', { value: 'google' }, 'Google Custom Search (existing customers)'))),
        h('section', { style: panelStyle, 'aria-label': 'Selected provider' },
          h('div', { style: { ...rowStyle, justifyContent: 'space-between' } },
            h('strong', { style: { fontSize: 14 } }, provider.name),
            h('span', { style: hintStyle, role: 'status' }, status)),
          draft.defaultEngine === 'duckduckgo' && h('p', { style: hintStyle },
            'The default, with no setup required. Returns topic summaries and related links, rather than a full results page. Some queries return no results.'),
          provider.setup && h(React.Fragment, null,
            h('p', { style: hintStyle }, provider.description, ' ',
              link(provider.setup, 'Get an API key'), ' · ', link(provider.docs, 'Setup guide')),
            secretField(provider.field, provider.keyLabel), keyStorage),
          draft.defaultEngine === 'searxng' && h(React.Fragment, null,
            h('p', { style: hintStyle }, 'Connect a SearXNG server you manage. It searches the engines enabled on that server. ', link('https://docs.searxng.org/dev/search_api.html', 'JSON setup guide')),
            textField('searxngInstanceUrl', 'Instance URL', 'Use an address reachable from the machine running Harness. JSON output must be enabled. Use HTTPS remotely; HTTP is supported for local hostnames and private IP addresses.', { autoComplete: 'off', spellCheck: false, placeholder: 'http://localhost:8080' }),
            h('label', { htmlFor: 'web-search-searxngAuth' }, 'Authentication'),
            h('select', { id: 'web-search-searxngAuth', value: draft.searxngAuth, disabled, style: selectStyle, onChange: event => edit('searxngAuth', event.target.value) },
              h('option', { value: 'none' }, 'None'), h('option', { value: 'bearer' }, 'Bearer token'), h('option', { value: 'basic' }, 'Username and password')),
            draft.searxngAuth === 'bearer' && secretField('searxngToken', 'Bearer token'),
            draft.searxngAuth === 'basic' && h(React.Fragment, null, secretField('searxngUsername', 'Username'), secretField('searxngPassword', 'Password')),
            h('p', { style: hintStyle }, 'Use credentials required by your instance or reverse proxy. Do not enter SearXNG’s server secret key. Queries reach the search engines configured on your instance.')),
          draft.defaultEngine === 'google' && h(React.Fragment, null,
            h('p', { style: hintStyle }, 'Search using your Programmable Search Engine. This legacy API is for existing Google Custom Search customers and is closed to new customers. ',
              link('https://developers.google.com/custom-search/v1/overview', 'Google setup guide')),
            secretField('googleApiKey', 'Google API key'),
            textField('googleSearchEngineId', 'Search engine ID (cx)', 'Find this ID in your Programmable Search Engine settings.', { autoComplete: 'off', spellCheck: false }),
            keyStorage)),
        h('section', { style: fieldStyle, 'aria-label': 'Source filters' },
          h('strong', { style: { fontSize: 14 } }, 'Source filters'),
          ...[['allowedDomains', 'Only these domains', 'Leave empty to allow any domain.'], ['blockedDomains', 'Blocked domains', 'Blocked domains take precedence.']].map(([field, label, hint]) =>
            h('div', { key: field, style: fieldStyle }, h('label', { htmlFor: `web-search-${field}` }, label),
              h('textarea', { id: `web-search-${field}`, value: draft[field], disabled, rows: 2, spellCheck: false, style: { ...selectStyle, resize: 'vertical' },
                placeholder: 'example.com', onChange: event => edit(field, event.target.value) }),
              h('p', { style: hintStyle }, hint, ' Includes subdomains. Separate hostnames with commas or new lines.'))),
          h('label', { htmlFor: 'web-search-dateRange' }, 'Date range'),
          h('select', { id: 'web-search-dateRange', value: draft.dateRange, disabled, style: selectStyle, onChange: event => edit('dateRange', event.target.value) },
            ...Object.entries(dateLabels).filter(([range]) => supportsDate(draft.defaultEngine, range) || draft.dateRange === range)
              .map(([range, label]) => h('option', { key: range, value: range, disabled: !supportsDate(draft.defaultEngine, range) }, label + (supportsDate(draft.defaultEngine, range) ? '' : ' — unsupported')))),
          !supportsDate(draft.defaultEngine, draft.dateRange) && h('p', { role: 'alert' }, 'Choose a supported date range before saving. Your previous selection has been kept.'),
          h('p', { style: hintStyle }, draft.defaultEngine === 'duckduckgo' ? 'Instant Answers does not support date filters. Domain rules apply to its returned links.'
            : draft.defaultEngine === 'searxng' ? 'Date filtering depends on the engines enabled on your instance; some may ignore the range. Past week is not supported.'
              : 'Dates are reported or estimated by the provider and may reflect updates. Filtering can reduce the number of results.')),
        h('details', { style: { borderTop: '1px solid var(--dsw-alias-border-l3)', paddingTop: 16 } },
          h('summary', { style: { cursor: 'pointer', fontSize: 14, fontWeight: 500 } }, 'Advanced settings'),
          h('div', { style: { ...fieldStyle, marginTop: 16 } },
            h('label', { htmlFor: 'web-search-timeoutSeconds' }, 'Search timeout (seconds)'),
            h(Input, {
              id: 'web-search-timeoutSeconds', type: 'number', min: 0.001, max: 120, step: 0.001,
              value: timeoutSeconds, disabled, 'aria-invalid': timeoutError,
              'aria-describedby': 'web-search-timeout-help',
              style: { maxWidth: 160 },
              onChange: (event) => {
                if (!canEdit()) return;
                const value = event.target.value;
                setTimeoutSeconds(value);
                const milliseconds = timeoutSecondsToMilliseconds(value);
                edit('timeoutMs', milliseconds === null ? '' : String(milliseconds));
              },
            }),
            h('p', { id: 'web-search-timeout-help', style: hintStyle }, timeoutError
              ? 'Enter a timeout from 0.001 to 120 seconds, with up to 3 decimal places.'
              : 'Maximum total wait, including the request queue and provider response. Default: 15 seconds.')),
          h('div', { style: { display: 'grid', gap: 16, marginTop: 20 } },
            textField('maxRequestsPerMinute', 'Requests per minute', 'Maximum started requests in any 60-second window. Default: 20.', { type: 'number', min: 1, max: 600, step: 1 }),
            h('div', { style: fieldStyle },
              h('label', { htmlFor: 'web-search-intervalSeconds' }, 'Time between requests (seconds)'),
              h(Input, {
                id: 'web-search-intervalSeconds', type: 'number', min: 0, max: 60, step: 0.001,
                value: intervalSeconds, disabled, style: { maxWidth: 160 },
                onChange: (event) => {
                  if (!canEdit()) return;
                  const value = event.target.value;
                  setIntervalSeconds(value);
                  const milliseconds = timeoutSecondsToMilliseconds(value);
                  edit('minIntervalMs', milliseconds === null ? '' : String(milliseconds));
                },
              }),
              h('p', { style: hintStyle }, 'Minimum gap between starting requests. Default: 1 second.')),
            textField('maxResults', 'Results per search', 'Maximum results returned to a model. Tests return up to 3. Default: 8.', { type: 'number', min: 1, max: 20, step: 1 }),
            h('p', { style: hintStyle }, 'Limits are shared by model searches and tests in this running profile. One request runs at a time, with up to ten waiting. Started requests count even if the provider fails. No automatic retries or fallback.'))),
        changedElsewhere && h('p', { role: 'alert' }, 'Settings changed elsewhere. Reload settings to discard this draft and read the latest values.'),
        message && h('p', { role: 'status', 'aria-live': 'polite' }, message),
        h('div', { style: rowStyle },
          h(Button, { type: 'submit', variant: 'primary', disabled: disabled || !dirty }, phase === 'saving' ? 'Saving…' : 'Save changes'),
          phase === 'failed' || phase === 'refresh-failed' || changedElsewhere
            ? h(Button, { type: 'button', variant: 'outline', disabled: phase === 'saving' || phase === 'loading', onClick: reload }, 'Reload settings')
            : dirty && h(Button, { type: 'button', variant: 'outline', disabled, onClick: discard }, 'Discard changes'),
          dirty && phase === 'ready' && !changedElsewhere && h('span', { style: hintStyle }, 'Unsaved changes')),
        h('section', { style: { ...fieldStyle, borderTop: '1px solid var(--dsw-alias-border-l3)', paddingTop: 20 }, 'aria-label': 'Test search' },
          h('strong', { style: { fontSize: 14 } }, 'Test search'),
          h('p', { style: hintStyle }, 'Send a query using your saved settings. This uses the same request limits and provider credits as a model search.'),
          h('label', { htmlFor: 'web-search-testQuery' }, 'Test query'),
          h(Input, {
            id: 'web-search-testQuery', value: testQuery, maxLength: 600,
            disabled: disabled || Boolean(dirty) || testPhase === 'running',
            onChange: (event) => {
              if (!canEdit() || dirty || testRequest.current) return;
              clearTest();
              setTestQuery(event.target.value);
            },
          }),
          dirty && h('p', { style: hintStyle }, 'Save or discard your changes before testing.'),
          h('div', { style: rowStyle },
            h(Button, {
              type: 'button', variant: 'outline', disabled: disabled || Boolean(dirty) || testPhase === 'running', onClick: runTest,
            }, testPhase === 'running' ? 'Testing…' : 'Test search'),
            testPhase === 'running' && h(Button, { type: 'button', variant: 'outline', onClick: cancelTest }, 'Cancel test'),
            testOutcome && clipboardAvailable && h(Button, {
              type: 'button', variant: 'outline', disabled: Boolean(changedElsewhere) || Boolean(dirty), onClick: copyDiagnostics,
            }, 'Copy diagnostics')),
          testMessage && h('p', { role: 'status', style: hintStyle }, testMessage),
          testOutcome?.ok === false && h('div', { role: 'alert', style: fieldStyle },
            h('p', { style: { margin: 0 } }, testOutcome.error.message),
            Number.isFinite(testOutcome.error.details.retryAfterMs) && testOutcome.error.details.retryAfterMs > 0
              && h('p', { style: hintStyle }, `Wait at least ${Math.ceil(testOutcome.error.details.retryAfterMs / 1000)} seconds before trying again.`)),
          testOutcome?.ok === true && h('div', { style: fieldStyle, 'aria-live': 'polite' },
            h('p', { role: 'status', style: { margin: 0 } }, `Test completed · ${providers[testOutcome.value.engine].name} · ${testOutcome.value.count} result${testOutcome.value.count === 1 ? '' : 's'} · ${Math.round(testOutcome.value.elapsedMs)} ms`),
            h('p', { style: hintStyle }, 'Tested at ', h('time', { dateTime: testOutcome.value.testedAt }, new Date(testOutcome.value.testedAt).toLocaleString())),
            testOutcome.value.count === 0 && !testOutcome.value.filteredCount && h('p', { style: hintStyle }, 'The provider returned no results for this query.'),
            typeof testOutcome.value.notice === 'string' && h('p', { style: hintStyle }, testOutcome.value.notice.slice(0, 600)),
            testOutcome.value.sources.map((source, index) => h('article', { key: index, style: { ...fieldStyle, gap: 4, paddingTop: 8 } },
              safeSourceUrl(source.url)
                ? h('a', { href: safeSourceUrl(source.url), target: '_blank', rel: 'noopener noreferrer', referrerPolicy: 'no-referrer', style: { color: 'inherit', overflowWrap: 'anywhere' } }, String(source.title || source.url).slice(0, 300))
                : h('span', null, String(source.title || 'Search result').slice(0, 300)),
              source.snippet && h('p', { style: hintStyle }, String(source.snippet).slice(0, 1200)))),
            testOutcome.value.truncated && h('p', { style: hintStyle }, 'Showing a limited sample of the results.')),
          copyMessage && h('p', { role: 'status', style: hintStyle }, copyMessage)));
    }

    function apply(ctx) {
      // Cordis returns a new traced service proxy on each property read. Keep
      // one for this injected plugin lifetime so ordinary form rerenders do not
      // look like a new connection and discard an in-progress settings draft.
      const remote = ctx.remote;
      const connection = ctx.connection;
      const controller = ctx.configForms.get(ENTRY_ID);
      const store = {
        subscribe: (listener) => controller.subscribe(listener),
        getSnapshot: () => controller.getSnapshot(),
        mutate: (ops, revision) => controller.mutate(ops, revision),
      };
      ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: ENTRY_ID,
      }, () => h(SettingsPage, { remote, connection, store })));
    }

    return {
      name: 'web-search-settings',
      inject: ['slots', 'remote', 'remote.settings', 'connection', 'configForms'],
      apply,
      createSettingsOperations,
      draftFromValues,
      isDraftDirty,
      timeoutSecondsToMilliseconds,
      diagnosticMetadata,
    };
  },
});
