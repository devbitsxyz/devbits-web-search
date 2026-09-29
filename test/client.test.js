const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/client.js'), 'utf8');
const ENTRY_ID = 'devbits-web-search';

/** A small hook runner tests event and lifecycle behavior without a DOM package. */
function loadClient({ clipboard } = {}) {
  const hooks = [];
  const effects = [];
  let cursor = 0;
  let module;
  let registration;
  let requestRender = () => {};
  const depsEqual = (left, right) => left && right && left.length === right.length
    && left.every((value, index) => Object.is(value, right[index]));
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial;
      return [hooks[index], (next) => { hooks[index] = typeof next === 'function' ? next(hooks[index]) : next; }];
    },
    useRef(initial) {
      const index = cursor++;
      return hooks[index] ||= { current: initial };
    },
    useCallback(callback, deps) {
      const index = cursor++;
      if (!depsEqual(hooks[index]?.deps, deps)) hooks[index] = { callback, deps };
      return hooks[index].callback;
    },
    useEffect(callback, deps) {
      const index = cursor++;
      if (!depsEqual(hooks[index]?.deps, deps)) effects.push(() => {
        hooks[index]?.cleanup?.();
        hooks[index] = { deps, cleanup: callback() };
      });
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      React.useEffect(() => subscribe(() => requestRender()), [subscribe]);
      return getSnapshot();
    },
  };
  const modules = { react: React, '@deepseek-ai/dsh-client-ui-primitives': { Input: 'input', Button: 'button' } };
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load(value) { module = value; } } },
    AbortController, URL,
    navigator: clipboard ? { clipboard } : {},
  }, { filename: 'src/client.js' });
  const plugin = module.factory((name) => {
    if (!Object.hasOwn(modules, name)) throw new Error(`Unexpected browser dependency: ${name}`);
    return modules[name];
  });

  function mount(remote, form, { freshRemoteProxy = false, connection = { rpc: { call: jest.fn() } } } = {}) {
    const disposers = [];
    const subscribers = new Set();
    let currentForm = form;
    const controller = {
      getSnapshot: () => currentForm.state,
      mutate: (ops, revision) => currentForm.mutate(ops, revision),
      subscribe: jest.fn((listener) => {
        subscribers.add(listener);
        return () => subscribers.delete(listener);
      }),
    };
    const ctx = {
      // Cordis may wrap a service on each ctx property access. Those wrappers
      // refer to the same service and must not reset an editor on parent renders.
      get remote() { return freshRemoteProxy ? { settings: remote.settings } : remote; },
      get connection() { return freshRemoteProxy ? { rpc: connection.rpc } : connection; },
      configForms: { get: jest.fn(() => controller) },
      slots: {
        inject: jest.fn((name, callback) => { disposers.push(callback()); }),
        register: jest.fn((spec, component) => {
          registration = { spec, component };
          return jest.fn();
        }),
      },
    };
    plugin.apply(ctx);
    const page = registration.component({ view: 'page' });
    let props = page.props;
    let tree;
    function render(nextProps) {
      props = nextProps ? { ...props, ...nextProps } : props;
      cursor = 0;
      tree = page.type(props);
      while (effects.length) effects.shift()();
      return tree;
    }
    requestRender = render;
    const nodes = () => {
      const result = [];
      function visit(node) {
        if (Array.isArray(node)) return node.forEach(visit);
        if (node && typeof node === 'object') {
          result.push(node);
          visit(node.props?.children);
        }
      }
      visit(tree);
      return result;
    };
    const byId = (id) => nodes().find((node) => node.props.id === id);
    const textContent = (node) => Array.isArray(node) ? node.map(textContent).join(' ')
      : node && typeof node === 'object' ? textContent(node.props.children)
        : typeof node === 'string' ? node : '';
    const text = (node = tree) => textContent(node);
    const button = (label) => nodes().find((node) => node.type === 'button' && text(node) === label);
    render();
    return {
      ctx, render, nodes, byId, text, button, controller, subscribers,
      publish() { subscribers.forEach((listener) => listener()); },
      registration: () => registration,
      renderSlot(nextForm) {
        currentForm = nextForm;
        subscribers.forEach((listener) => listener());
        return render(registration.component({ view: 'page' }).props);
      },
      async settled() {
        // Drain cross-realm await continuations and their error handlers.
        await new Promise(setImmediate);
        return render();
      },
      edit(id, value) {
        byId(id).props.onChange({ target: { value } });
        render();
      },
      click(label) {
        const result = button(label).props.onClick();
        render();
        return result;
      },
      async save() {
        await tree.props.onSubmit({ preventDefault: jest.fn() });
        render();
      },
      unmount() {
        hooks.forEach((hook) => hook?.cleanup?.());
        disposers.forEach((dispose) => dispose?.());
      },
    };
  }
  return { module, plugin, mount };
}

function fixture() {
  const descriptor = {
    ns: ENTRY_ID,
    autoGenerate: false,
    schema: {},
    applies: 'live',
    revision: 7,
    value: { defaultEngine: 'duckduckgo', timeoutMs: 15000, googleSearchEngineId: 'existing-cx' },
    secrets: ['braveApiKey', 'tavilyApiKey', 'exaApiKey', 'googleApiKey'].map((field) => ({ path: [field], set: true })),
  };
  // Generated remote methods wrap controller values in their success envelope.
  const remote = { settings: { describe: jest.fn(async () => ({ ok: true, value: {
    writable: true,
    hasDocument: true,
    namespaces: [{ ns: 'unrelated', revision: 99, value: { defaultEngine: 'google' } }, structuredClone(descriptor)],
  } })) } };
  const form = { state: { status: 'ready', writable: true, revision: 7 }, mutate: jest.fn(async (ops, expectedRevision) => {
    if (expectedRevision !== descriptor.revision) return false;
    for (const { path: [field], value } of ops) {
      const secret = descriptor.secrets.find((entry) => entry.path[0] === field);
      if (secret) secret.set = Boolean(value);
      else descriptor.value[field] = value;
    }
    descriptor.revision++;
    form.state.revision = descriptor.revision;
    return true;
  }) };
  return { descriptor, remote, form };
}

function diagnosticSuccess(overrides = {}) {
  return { ok: true, value: {
    engine: 'duckduckgo', revision: 7, elapsedMs: 123, testedAt: '2026-09-29T12:00:00.000Z',
    count: 1, truncated: false,
    sources: [{ title: 'Ada Lovelace', url: 'https://example.org/ada', snippet: 'An example result.' }],
    ...overrides,
  } };
}

describe('Harness browser settings module', () => {
  test('registers its native module and exact package/entry slot without server-only dependencies', () => {
    const client = loadClient();
    const { remote, form } = fixture();
    const page = client.mount(remote, form);
    expect(client.module.id).toBe(ENTRY_ID);
    expect(page.ctx.slots.inject).toHaveBeenCalledWith('plugins.bundle.config', expect.any(Function));
    expect(page.registration().spec).toEqual({ name: 'plugins.bundle.config', key: ENTRY_ID });
    expect(page.ctx.configForms.get).toHaveBeenCalledWith(ENTRY_ID);
    expect(page.ctx.configForms.get).toHaveBeenCalledTimes(1);
    expect(page.controller.subscribe).toHaveBeenCalledTimes(1);
    expect(page.subscribers.size).toBe(1);
    page.unmount();
    expect(page.subscribers.size).toBe(0);
  });

  test('never prefills password inputs, even if a caller passes unredacted values', () => {
    const { plugin } = loadClient();
    expect(plugin.draftFromValues({ braveApiKey: 'saved-brave', tavilyApiKey: 'saved-tavily', exaApiKey: 'saved-exa', googleApiKey: 'saved-google', searxngToken: 'private-token', searxngUsername: 'private-user', searxngPassword: 'private-password' })).toEqual({
      defaultEngine: 'duckduckgo', timeoutMs: '15000', googleSearchEngineId: '',
      maxRequestsPerMinute: '20', minIntervalMs: '1000', maxResults: '8',
      braveApiKey: '', tavilyApiKey: '', exaApiKey: '', keenableApiKey: '', googleApiKey: '',
      allowedDomains: '', blockedDomains: '', dateRange: 'any', searxngInstanceUrl: '', searxngAuth: 'none',
      searxngToken: '', searxngUsername: '', searxngPassword: '',
    });
  });

  test('shows only the selected provider credentials and keeps unsaved keys across switches', async () => {
    const client = loadClient();
    const { remote, form } = fixture();
    const page = client.mount(remote, form);
    await page.settled();
    expect(page.nodes().filter((node) => node.type === 'option').map((node) => node.props.value)).toEqual(expect.arrayContaining([
      'duckduckgo', 'keenable', 'brave', 'tavily', 'exa', 'google',
    ]));
    expect(page.text()).toContain('No API key needed');
    expect(page.byId('web-search-braveApiKey')).toBeUndefined();
    expect(page.byId('web-search-googleApiKey')).toBeUndefined();
    expect(page.byId('web-search-googleSearchEngineId')).toBeUndefined();
    page.edit('web-search-engine', 'brave');
    expect(page.text()).toContain('API key saved');
    expect(page.byId('web-search-googleApiKey')).toBeUndefined();
    page.edit('web-search-braveApiKey', 'new-brave-token');
    expect(page.text()).toContain('API key entered');
    page.edit('web-search-engine', 'google');
    expect(page.byId('web-search-braveApiKey')).toBeUndefined();
    expect(page.text()).toContain('Configuration saved');
    page.edit('web-search-googleApiKey', 'new-google-token');
    page.edit('web-search-engine', 'duckduckgo');
    expect(page.byId('web-search-googleApiKey')).toBeUndefined();
    page.edit('web-search-engine', 'brave');
    expect(page.byId('web-search-braveApiKey').props.value).toBe('new-brave-token');
    page.edit('web-search-engine', 'google');
    expect(page.byId('web-search-googleApiKey').props.value).toBe('new-google-token');
  });

  test.each(['tavily', 'exa'])('%s supports isolated credentials and retains its key draft across engine switches', async (engine) => {
    const client = loadClient();
    const { remote, form } = fixture();
    const page = client.mount(remote, form);
    await page.settled();
    page.edit('web-search-engine', engine);
    expect(page.nodes().filter((node) => node.props.type === 'password').map((node) => node.props.id)).toEqual([
      `web-search-${engine}ApiKey`,
    ]);
    expect(page.text()).toContain('API key saved');
    page.edit(`web-search-${engine}ApiKey`, ` replacement-${engine} `);
    page.edit('web-search-engine', 'duckduckgo');
    expect(page.byId(`web-search-${engine}ApiKey`)).toBeUndefined();
    page.edit('web-search-engine', engine);
    expect(page.byId(`web-search-${engine}ApiKey`).props.value).toBe(` replacement-${engine} `);
    await page.save();
    const keyOps = form.mutate.mock.calls[0][0].filter((op) => /ApiKey$/.test(op.path[0]));
    expect(keyOps).toEqual([{ op: 'set', path: [`${engine}ApiKey`], value: `replacement-${engine}` }]);
    expect(page.byId(`web-search-${engine}ApiKey`).props.value).toBe('');
    page.click('Remove saved key');
    await page.save();
    expect(form.mutate.mock.calls[1][0].filter((op) => /ApiKey$/.test(op.path[0]))).toEqual([
      { op: 'set', path: [`${engine}ApiKey`], value: '' },
    ]);
  });

  test('Keenable needs no key, and its optional key saves and removes like the others', async () => {
    const client = loadClient();
    const { descriptor, remote, form } = fixture();
    descriptor.secrets.push({ path: ['keenableApiKey'], set: false });
    const page = client.mount(remote, form);
    await page.settled();
    page.edit('web-search-engine', 'keenable');
    expect(page.text()).toContain('No API key needed');
    expect(page.text()).toContain('Optional. Searches work without a key.');
    expect(page.byId('web-search-keenableApiKey').props.placeholder).toBe('Optional');
    const keyOps = (call) => form.mutate.mock.calls[call][0].filter((op) => /ApiKey$/.test(op.path[0]));
    await page.save();
    expect(descriptor.value.defaultEngine).toBe('keenable');
    expect(keyOps(0)).toEqual([]);
    page.edit('web-search-keenableApiKey', ' keenable-token ');
    expect(page.text()).toContain('API key entered');
    await page.save();
    expect(keyOps(1)).toEqual([{ op: 'set', path: ['keenableApiKey'], value: 'keenable-token' }]);
    expect(page.text()).toContain('API key saved');
    page.click('Remove saved key');
    await page.save();
    expect(keyOps(2)).toEqual([{ op: 'set', path: ['keenableApiKey'], value: '' }]);
    expect(page.text()).toContain('No API key needed');
  });

  test('explains missing credentials and updates readiness as a provider is configured', async () => {
    const client = loadClient();
    const { descriptor, remote, form } = fixture();
    descriptor.secrets.forEach((secret) => { secret.set = false; });
    descriptor.value.googleSearchEngineId = '';
    const page = client.mount(remote, form);
    await page.settled();
    page.edit('web-search-engine', 'brave');
    expect(page.text()).toContain('API key required');
    page.edit('web-search-braveApiKey', 'brave-token');
    expect(page.text()).toContain('API key entered');
    page.edit('web-search-engine', 'google');
    expect(page.text()).toContain('Setup required');
    page.edit('web-search-googleApiKey', 'google-token');
    expect(page.text()).toContain('Setup required');
    page.edit('web-search-googleSearchEngineId', 'new-cx');
    expect(page.text()).toContain('Configuration entered');
  });

  test('Save changes follows meaningful edits and timeout seconds persist as milliseconds', async () => {
    const client = loadClient();
    const { remote, form } = fixture();
    const page = client.mount(remote, form);
    await page.settled();
    expect(page.button('Save changes').props.disabled).toBe(true);
    await page.save();
    expect(form.mutate).not.toHaveBeenCalled();
    expect(Number(page.byId('web-search-timeoutSeconds').props.value)).toBe(15);
    page.edit('web-search-timeoutSeconds', '15.000');
    expect(page.button('Save changes').props.disabled).toBe(true);
    page.edit('web-search-timeoutSeconds', '30.125');
    expect(page.button('Save changes').props.disabled).toBe(false);
    await page.save();
    expect(form.mutate.mock.calls[0][0]).toContainEqual({ op: 'set', path: ['timeoutMs'], value: 30125 });
    expect(Number(page.byId('web-search-timeoutSeconds').props.value)).toBe(30.125);
    expect(page.button('Save changes').props.disabled).toBe(true);
  });

  test('discard resets all drafts locally while preserving saved credential metadata', async () => {
    const client = loadClient();
    const { remote, form } = fixture();
    const page = client.mount(remote, form);
    await page.settled();
    page.edit('web-search-engine', 'brave');
    page.click('Remove saved key');
    page.edit('web-search-engine', 'google');
    page.edit('web-search-googleApiKey', 'discarded-token');
    page.edit('web-search-googleSearchEngineId', 'discarded-cx');
    page.edit('web-search-timeoutSeconds', '60');
    page.click('Discard changes');
    expect(form.mutate).not.toHaveBeenCalled();
    expect(remote.settings.describe).toHaveBeenCalledTimes(1);
    expect(page.byId('web-search-engine').props.value).toBe('duckduckgo');
    expect(Number(page.byId('web-search-timeoutSeconds').props.value)).toBe(15);
    expect(page.button('Save changes').props.disabled).toBe(true);
    page.edit('web-search-engine', 'brave');
    expect(page.byId('web-search-braveApiKey').props.value).toBe('');
    expect(page.text()).toContain('API key saved');
    page.edit('web-search-engine', 'google');
    expect(page.byId('web-search-googleApiKey').props.value).toBe('');
    expect(page.byId('web-search-googleSearchEngineId').props.value).toBe('existing-cx');
    await page.save();
    expect(form.mutate.mock.calls[0][0].some((op) => /ApiKey$/.test(op.path[0]))).toBe(false);
  });

  test('blank password text and undone removal leave saved settings pristine', async () => {
    const client = loadClient();
    const { descriptor, remote, form } = fixture();
    descriptor.value.defaultEngine = 'brave';
    const page = client.mount(remote, form);
    await page.settled();
    page.edit('web-search-braveApiKey', '  ');
    expect(page.button('Save changes').props.disabled).toBe(true);
    page.click('Remove saved key');
    expect(page.button('Save changes').props.disabled).toBe(false);
    page.click('Undo removal');
    expect(page.button('Save changes').props.disabled).toBe(true);
  });

  test('readonly and stale states guard event handlers as well as disabled buttons', async () => {
    const client = loadClient();
    const { remote, form } = fixture();
    const page = client.mount(remote, form);
    await page.settled();
    page.edit('web-search-engine', 'brave');
    page.edit('web-search-braveApiKey', 'kept-draft');
    form.state.writable = false;
    page.render();
    expect(page.byId('web-search-engine').props.disabled).toBe(true);
    page.edit('web-search-engine', 'google');
    page.click('Remove saved key');
    page.click('Discard changes');
    await page.save();
    expect(form.mutate).not.toHaveBeenCalled();
    expect(page.byId('web-search-engine').props.value).toBe('brave');
    expect(page.byId('web-search-braveApiKey').props.value).toBe('kept-draft');
    form.state.writable = true;
    form.state.revision = 8;
    page.render();
    expect(page.button('Save changes').props.disabled).toBe(true);
    expect(page.button('Discard changes')).toBeUndefined();
    expect(page.button('Reload settings')).toBeDefined();
    await page.save();
    expect(form.mutate).not.toHaveBeenCalled();
    expect(page.byId('web-search-braveApiKey').props.value).toBe('kept-draft');
  });

  test('distinguishes unready native form snapshots from a confirmed readonly connection', async () => {
    const client = loadClient();
    const { remote, form } = fixture();
    // These are the native form controller's initial values before its mirror loads.
    form.state.status = 'loading';
    form.state.writable = false;
    const page = client.mount(remote, form);
    await page.settled();
    expect(page.text()).toContain('Loading settings controls');
    expect(page.text()).not.toContain('This connection cannot edit');
    form.state.status = 'unavailable';
    page.render();
    expect(page.text()).toContain('settings form is unavailable');
    expect(page.text()).not.toContain('This connection cannot edit');
    form.state.status = 'ready';
    page.render();
    expect(page.text()).toContain('This connection cannot edit');
    expect(page.button('Save changes').props.disabled).toBe(true);
  });

  test('saving blank password controls preserves keys and sends the captured revision', async () => {
    const client = loadClient();
    const { remote, form } = fixture();
    const page = client.mount(remote, form);
    await page.settled();
    expect(page.byId('web-search-engine').props.value).toBe('duckduckgo');
    page.edit('web-search-engine', 'brave');
    expect(page.byId('web-search-braveApiKey').props.value).toBe('');
    page.edit('web-search-braveApiKey', '   ');
    await page.save();
    expect(form.mutate).toHaveBeenCalledWith([
      { op: 'set', path: ['defaultEngine'], value: 'brave' },
      { op: 'set', path: ['timeoutMs'], value: 15000 },
      { op: 'set', path: ['googleSearchEngineId'], value: 'existing-cx' },
      { op: 'set', path: ['allowedDomains'], value: '' },
      { op: 'set', path: ['blockedDomains'], value: '' },
      { op: 'set', path: ['dateRange'], value: 'any' },
      { op: 'set', path: ['searxngInstanceUrl'], value: '' },
      { op: 'set', path: ['searxngAuth'], value: 'none' },
      { op: 'set', path: ['maxRequestsPerMinute'], value: 20 },
      { op: 'set', path: ['minIntervalMs'], value: 1000 },
      { op: 'set', path: ['maxResults'], value: 8 },
    ], 7);
    expect(page.text()).toContain('Saved. The next search uses these settings.');
  });

  test('explicit key removal is staged until Save and shadows any inherited key', async () => {
    const client = loadClient();
    const { remote, form } = fixture();
    const page = client.mount(remote, form);
    await page.settled();
    page.edit('web-search-engine', 'brave');
    page.click('Remove saved key');
    expect(form.mutate).not.toHaveBeenCalled();
    expect(page.byId('web-search-braveApiKey').props.placeholder).toContain('removed');
    await page.save();
    const ops = form.mutate.mock.calls[0][0];
    expect(ops).toContainEqual({ op: 'set', path: ['braveApiKey'], value: '' });
    expect(ops.some((op) => op.path[0] === 'googleApiKey')).toBe(false);
  });

  test('undoing removal keeps saved keys and newly entered keys are trimmed', async () => {
    const client = loadClient();
    const { remote, form } = fixture();
    const page = client.mount(remote, form);
    await page.settled();
    page.edit('web-search-engine', 'brave');
    page.click('Remove saved key');
    page.click('Undo removal');
    page.edit('web-search-engine', 'google');
    page.edit('web-search-googleApiKey', ' replacement-google ');
    await page.save();
    const ops = form.mutate.mock.calls[0][0];
    expect(ops.some((op) => op.path[0] === 'braveApiKey')).toBe(false);
    expect(ops).toContainEqual({ op: 'set', path: ['googleApiKey'], value: 'replacement-google' });
    expect(page.byId('web-search-googleApiKey').props.value).toBe('');
  });

  test('a rejected revision preserves the draft and tells the user to reload', async () => {
    const client = loadClient();
    const { remote, form } = fixture();
    form.mutate.mockResolvedValue(false);
    const page = client.mount(remote, form);
    await page.settled();
    page.edit('web-search-engine', 'brave');
    page.edit('web-search-braveApiKey', 'unsaved-token');
    await page.save();
    expect(form.mutate.mock.calls[0][1]).toBe(7);
    expect(page.byId('web-search-braveApiKey').props.value).toBe('unsaved-token');
    expect(page.text()).toContain('Reload settings before trying again.');
    expect(remote.settings.describe).toHaveBeenCalledTimes(1);
    form.state.revision = 8;
    page.render();
    expect(page.button('Save changes').props.disabled).toBe(true);
    expect(page.text()).toContain('Settings changed elsewhere.');
  });

  test.each([false, true])('native parent rerenders retain a pending save and its outcome (accepted: %s)', async (accepted) => {
    const client = loadClient();
    const { descriptor, remote, form } = fixture();
    const persist = form.mutate.getMockImplementation();
    const snapshot = () => ({ state: { ...form.state }, mutate: (ops, revision) => form.mutate(ops, revision) });
    let settleMutation;
    let page;
    form.mutate.mockImplementation((...args) => new Promise((resolve) => {
      settleMutation = async () => {
        if (accepted) await persist(...args);
        // The real config mirror publishes a new snapshot before mutate settles.
        page.renderSlot(snapshot());
        resolve(accepted);
      };
    }));
    page = client.mount(remote, snapshot(), { freshRemoteProxy: true });
    await page.settled();
    page.edit('web-search-engine', 'tavily');
    page.edit('web-search-tavilyApiKey', 'pending-token');
    const save = page.save();
    page.renderSlot(snapshot());
    await page.settled();
    expect(page.byId('web-search-engine').props.value).toBe('tavily');
    expect(page.byId('web-search-tavilyApiKey').props.value).toBe('pending-token');
    expect(page.button('Saving…')).toBeDefined();
    expect(remote.settings.describe).toHaveBeenCalledTimes(1);
    await settleMutation();
    await save;
    await page.settled();
    expect(page.byId('web-search-engine').props.value).toBe('tavily');
    if (accepted) {
      expect(descriptor.value.defaultEngine).toBe('tavily');
      expect(page.byId('web-search-tavilyApiKey').props.value).toBe('');
      expect(page.text()).toContain('Saved. The next search uses these settings.');
      expect(page.button('Save changes').props.disabled).toBe(true);
    } else {
      expect(descriptor.value.defaultEngine).toBe('duckduckgo');
      expect(page.byId('web-search-tavilyApiKey').props.value).toBe('pending-token');
      expect(page.text()).toContain('save was refused');
      expect(page.button('Reload settings')).toBeDefined();
    }
  });

  test('successful persistence clears password drafts even if its follow-up read fails', async () => {
    const client = loadClient();
    const { remote, form } = fixture();
    const page = client.mount(remote, form);
    await page.settled();
    page.edit('web-search-engine', 'brave');
    page.edit('web-search-braveApiKey', 'new-token');
    remote.settings.describe.mockRejectedValueOnce(new Error('Disconnected'));
    await page.save();
    expect(page.byId('web-search-braveApiKey').props.value).toBe('');
    expect(page.text()).toContain('Settings were saved, but their status could not be refreshed.');
    expect(page.text()).not.toContain('Settings changed elsewhere.');
    expect(page.byId('web-search-braveApiKey').props.disabled).toBe(true);
    expect(page.button('Remove saved key')).toBeUndefined();
    await page.click('Reload settings');
    await page.settled();
    expect(page.byId('web-search-braveApiKey').props.disabled).toBe(false);
    expect(page.button('Save changes').props.disabled).toBe(true);
    expect(page.text()).toContain('API key saved');
  });

  test('invalid timeout prevents mutation and read-only state disables controls', async () => {
    const client = loadClient();
    const { remote, form } = fixture();
    const page = client.mount(remote, form);
    await page.settled();
    page.edit('web-search-timeoutSeconds', '0');
    await page.save();
    expect(form.mutate).not.toHaveBeenCalled();
    expect(page.text()).toMatch(/timeout.*0\.001.*120/i);
    form.state.writable = false;
    page.render();
    expect(page.button('Save changes').props.disabled).toBe(true);
    expect(page.byId('web-search-engine').props.disabled).toBe(true);
  });

  test('a pending settings read cannot update an unmounted page', async () => {
    const client = loadClient();
    const { descriptor, remote, form } = fixture();
    let resolve;
    remote.settings.describe.mockReturnValue(new Promise((done) => { resolve = done; }));
    const page = client.mount(remote, form);
    page.unmount();
    resolve({ ok: true, value: { writable: true, namespaces: [{ ...descriptor, value: { defaultEngine: 'google' } }] } });
    await page.settled();
    expect(page.byId('web-search-engine').props.value).toBe('duckduckgo');
    expect(page.button('Save changes').props.disabled).toBe(true);
  });

  test('a remote error envelope shows a recoverable loading failure', async () => {
    const client = loadClient();
    const { remote, form } = fixture();
    remote.settings.describe.mockResolvedValueOnce({ ok: false, error: { code: 'UNAVAILABLE', message: 'Settings unavailable' } });
    const page = client.mount(remote, form);
    await page.settled();
    expect(page.button('Save changes').props.disabled).toBe(true);
    expect(page.text()).toContain('Could not load plugin settings');
    await page.click('Reload settings');
    await page.settled();
    expect(page.button('Save changes').props.disabled).toBe(true);
    expect(page.byId('web-search-engine').props.disabled).toBe(false);
  });

  test('a newer connection read wins when the previous response arrives late', async () => {
    const client = loadClient();
    const { descriptor, remote, form } = fixture();
    let resolveOld;
    remote.settings.describe.mockReturnValue(new Promise((done) => { resolveOld = done; }));
    const page = client.mount(remote, form);
    const currentRemote = { settings: { describe: jest.fn().mockResolvedValue({ ok: true, value: {
      writable: true,
      hasDocument: true,
      namespaces: [{ ...descriptor, value: { ...descriptor.value, defaultEngine: 'brave' } }],
    } }) } };
    page.render({ remote: currentRemote, form });
    await page.settled();
    expect(page.byId('web-search-engine').props.value).toBe('brave');
    resolveOld({ ok: true, value: { writable: true, namespaces: [{ ...descriptor, value: { defaultEngine: 'google' } }] } });
    await page.settled();
    expect(page.byId('web-search-engine').props.value).toBe('brave');
  });

  test('request limits validate independently and seconds persist exactly, including zero interval', async () => {
    const client = loadClient();
    const { remote, form } = fixture();
    const page = client.mount(remote, form);
    await page.settled();
    page.edit('web-search-maxRequestsPerMinute', '0');
    await page.save();
    expect(form.mutate).not.toHaveBeenCalled();
    expect(page.text()).toContain('Requests per minute must be a whole number from 1 to 600');
    page.edit('web-search-maxRequestsPerMinute', '40');
    page.edit('web-search-intervalSeconds', '1.001');
    page.edit('web-search-maxResults', '21');
    await page.save();
    expect(form.mutate).not.toHaveBeenCalled();
    expect(page.text()).toContain('Results per search must be a whole number from 1 to 20');
    page.edit('web-search-maxResults', '2');
    await page.save();
    expect(form.mutate.mock.calls[0][0]).toEqual(expect.arrayContaining([
      { op: 'set', path: ['maxRequestsPerMinute'], value: 40 },
      { op: 'set', path: ['minIntervalMs'], value: 1001 },
      { op: 'set', path: ['maxResults'], value: 2 },
    ]));
    page.edit('web-search-intervalSeconds', '');
    await page.save();
    expect(form.mutate).toHaveBeenCalledTimes(1);
    page.edit('web-search-intervalSeconds', '0');
    await page.save();
    expect(form.mutate.mock.calls[1][0]).toContainEqual({ op: 'set', path: ['minIntervalMs'], value: 0 });
  });

  test('testing is explicit, uses saved revision, and shows provider, time, count and safe links', async () => {
    const client = loadClient();
    const { remote, form } = fixture();
    const connection = { rpc: { call: jest.fn().mockResolvedValue(diagnosticSuccess()) } };
    const page = client.mount(remote, form, { connection });
    await page.settled();
    expect(connection.rpc.call).not.toHaveBeenCalled();
    expect(page.byId('web-search-testQuery').props.value).toBe('Ada Lovelace');
    expect(page.button('Test search').props.type).toBe('button');
    await page.click('Test search');
    await page.settled();
    expect(connection.rpc.call).toHaveBeenCalledWith('/devbits-web-search', 'test-search', {
      query: 'Ada Lovelace', revision: 7,
    }, expect.any(AbortSignal));
    expect(page.text()).toContain('Test completed · DuckDuckGo Instant Answers · 1 result · 123 ms');
    expect(page.nodes().find((node) => node.type === 'a' && node.props.href === 'https://example.org/ada').props).toMatchObject({
      target: '_blank', rel: 'noopener noreferrer', referrerPolicy: 'no-referrer',
    });
    expect(form.mutate).not.toHaveBeenCalled();
  });

  test.each(['', '0.0001', 'invalid'])('invalid interval %p stays dirty and cannot overwrite a saved zero', async (value) => {
    const client = loadClient();
    const { descriptor, remote, form } = fixture();
    descriptor.value.minIntervalMs = 0;
    const page = client.mount(remote, form);
    await page.settled();
    expect(page.byId('web-search-intervalSeconds').props.value).toBe('0');
    expect(page.button('Save changes').props.disabled).toBe(true);
    page.edit('web-search-intervalSeconds', value);
    expect(page.button('Save changes').props.disabled).toBe(false);
    expect(page.button('Test search').props.disabled).toBe(true);
    await page.save();
    expect(form.mutate).not.toHaveBeenCalled();
    expect(page.text()).toContain('Enter a time between requests from 0 to 60 seconds');
    page.edit('web-search-intervalSeconds', '0');
    expect(page.button('Save changes').props.disabled).toBe(true);
  });

  test.each(['https://user:password@example.org/ada', 'https://user@example.org/ada', 'javascript:alert(1)'])('result URL %s is rendered as text without a link', async (url) => {
    const client = loadClient();
    const { remote, form } = fixture();
    const connection = { rpc: { call: jest.fn().mockResolvedValue(diagnosticSuccess({
      sources: [{ title: 'Result title', url, snippet: 'Result snippet.' }],
    })) } };
    const page = client.mount(remote, form, { connection });
    await page.settled();
    await page.click('Test search');
    await page.settled();
    expect(page.text()).toContain('Result title');
    expect(page.nodes().some((node) => node.type === 'a' && node.props.href === url)).toBe(false);
  });

  test('dirty or conflicting settings cannot issue a test, including direct handler calls', async () => {
    const client = loadClient();
    const { remote, form } = fixture();
    const connection = { rpc: { call: jest.fn() } };
    const page = client.mount(remote, form, { connection });
    await page.settled();
    page.edit('web-search-maxResults', '4');
    expect(page.button('Test search').props.disabled).toBe(true);
    await page.click('Test search');
    expect(connection.rpc.call).not.toHaveBeenCalled();
    page.click('Discard changes');
    form.state.revision = 8;
    page.publish();
    expect(page.button('Test search').props.disabled).toBe(true);
    await page.click('Test search');
    expect(connection.rpc.call).not.toHaveBeenCalled();
  });

  test('queries are trimmed and length-checked before issuing a request', async () => {
    const client = loadClient();
    const { remote, form } = fixture();
    const connection = { rpc: { call: jest.fn().mockResolvedValue(diagnosticSuccess()) } };
    const page = client.mount(remote, form, { connection });
    await page.settled();
    for (const query of ['  ', 'x'.repeat(601)]) {
      page.edit('web-search-testQuery', query);
      await page.click('Test search');
      expect(connection.rpc.call).not.toHaveBeenCalled();
      await page.settled();
      expect(page.text()).toContain('Enter a search query from 1 to 600 characters');
    }
    page.edit('web-search-testQuery', '  Ada Lovelace  ');
    await page.click('Test search');
    expect(connection.rpc.call.mock.calls[0][2]).toEqual({ query: 'Ada Lovelace', revision: 7 });
  });

  test('cancel aborts the request and late completion cannot publish results', async () => {
    const client = loadClient();
    const { remote, form } = fixture();
    let resolve;
    const connection = { rpc: { call: jest.fn(() => new Promise((done) => { resolve = done; })) } };
    const page = client.mount(remote, form, { connection });
    await page.settled();
    const pending = page.click('Test search');
    expect(page.button('Testing…').props.disabled).toBe(true);
    await page.click('Testing…');
    expect(connection.rpc.call).toHaveBeenCalledTimes(1);
    page.click('Cancel test');
    expect(connection.rpc.call.mock.calls[0][3].aborted).toBe(true);
    resolve(diagnosticSuccess());
    await pending;
    await page.settled();
    expect(page.text()).toContain('Search test canceled');
    expect(page.text()).not.toContain('Test completed');
    expect(page.button('Test search').props.disabled).toBe(false);
  });

  test.each(['edit', 'revision', 'unmount'])('%s cancels an in-flight test and rejects its stale result', async (action) => {
    const client = loadClient();
    const { remote, form } = fixture();
    let resolve;
    const connection = { rpc: { call: jest.fn(() => new Promise((done) => { resolve = done; })) } };
    const page = client.mount(remote, form, { connection });
    await page.settled();
    const pending = page.click('Test search');
    if (action === 'edit') page.edit('web-search-maxResults', '6');
    if (action === 'revision') {
      form.state = { ...form.state, revision: 8 };
      page.publish();
    }
    if (action === 'unmount') page.unmount();
    expect(connection.rpc.call.mock.calls[0][3].aborted).toBe(true);
    resolve(diagnosticSuccess());
    await pending;
    await page.settled();
    expect(page.text()).not.toContain('Test completed');
  });

  test('completed results clear on a settings revision change and editing settings', async () => {
    const client = loadClient();
    const { remote, form } = fixture();
    const connection = { rpc: { call: jest.fn().mockResolvedValue(diagnosticSuccess()) } };
    const page = client.mount(remote, form, { connection });
    await page.settled();
    await page.click('Test search');
    await page.settled();
    expect(page.text()).toContain('Test completed');
    page.edit('web-search-maxResults', '5');
    expect(page.text()).not.toContain('Test completed');
    page.click('Discard changes');
    await page.click('Test search');
    await page.settled();
    form.state = { ...form.state, revision: 8 };
    page.publish();
    await page.settled();
    expect(page.text()).not.toContain('Test completed');
  });

  test('provider refusals show actionable text and retry timing without automatic retries', async () => {
    const client = loadClient();
    const { remote, form } = fixture();
    const connection = { rpc: { call: jest.fn().mockResolvedValue({ ok: false, error: {
      code: 'RATE_LIMITED', message: 'Wait before trying again, or review request limits.',
      details: { retryAfterMs: 2500, status: 429 },
    } }) } };
    const page = client.mount(remote, form, { connection });
    await page.settled();
    await page.click('Test search');
    await page.settled();
    expect(page.text()).toContain('Wait before trying again');
    expect(page.text()).toContain('Wait at least 3 seconds');
    expect(connection.rpc.call).toHaveBeenCalledTimes(1);
    expect(page.button('Test search').props.disabled).toBe(false);
  });

  test.each([
    [404, 'The search test endpoint is unavailable (HTTP 404). Restart Harness after updating the plugin.'],
    [405, 'The search test endpoint is unavailable (HTTP 405). Restart Harness after updating the plugin.'],
    [401, 'Harness denied the search test (HTTP 401). Reopen Harness using its current launch link.'],
    [403, 'Harness denied the search test (HTTP 403). Reopen Harness using its current launch link.'],
  ])('HTTP %i transport failures explain recovery and copy only safe status metadata', async (status, message) => {
    const clipboard = { writeText: jest.fn().mockResolvedValue() };
    const client = loadClient({ clipboard });
    const { remote, form } = fixture();
    const error = Object.assign(new Error(`Request failed https://example.org/?token=private-token: HTTP ${status}`), {
      code: 'private-code', request: { headers: { Authorization: 'private-token' } },
      cause: new Error('private-cause'),
    });
    const connection = { rpc: { call: jest.fn().mockRejectedValue(error) } };
    const page = client.mount(remote, form, { connection });
    await page.settled();
    page.edit('web-search-testQuery', 'private-query');
    await page.click('Test search');
    await page.settled();
    expect(page.text()).toContain(message);
    expect(page.text()).not.toMatch(/private-token|private-code|private-cause|Request failed/);
    expect(page.button('Test search').props.disabled).toBe(false);
    await page.click('Copy diagnostics');
    const copied = clipboard.writeText.mock.calls[0][0];
    expect(JSON.parse(copied)).toEqual({ plugin: ENTRY_ID, outcome: 'error', status, code: 'SEARCH_FAILED' });
    expect(copied).not.toContain('private');
    expect(connection.rpc.call).toHaveBeenCalledTimes(1);
  });

  test.each([
    'private-token provider message',
    'private-token: HTTP 403 plus more text',
    'private-token: HTTP 099',
    'private-token: HTTP 999',
  ])('unknown transport errors never expose their raw message or an invalid HTTP status: %s', async (message) => {
    const clipboard = { writeText: jest.fn().mockResolvedValue() };
    const client = loadClient({ clipboard });
    const { remote, form } = fixture();
    const connection = { rpc: { call: jest.fn().mockRejectedValue(Object.assign(new Error(message), {
      code: 'private-code', status: 403, response: { data: 'private-payload' },
    })) } };
    const page = client.mount(remote, form, { connection });
    await page.settled();
    await page.click('Test search');
    await page.settled();
    expect(page.text()).toContain('Could not complete the test. Check the Harness connection');
    expect(page.text()).not.toMatch(/private-|HTTP 099|HTTP 999|HTTP 403/);
    await page.click('Copy diagnostics');
    expect(JSON.parse(clipboard.writeText.mock.calls[0][0])).toEqual({
      plugin: ENTRY_ID, outcome: 'error', code: 'SEARCH_FAILED',
    });
    expect(connection.rpc.call).toHaveBeenCalledTimes(1);
  });

  test('other valid HTTP failures retain their status without exposing transport text', async () => {
    const clipboard = { writeText: jest.fn().mockResolvedValue() };
    const client = loadClient({ clipboard });
    const { remote, form } = fixture();
    const connection = { rpc: { call: jest.fn().mockRejectedValue(new Error('private-token: HTTP 503')) } };
    const page = client.mount(remote, form, { connection });
    await page.settled();
    await page.click('Test search');
    await page.settled();
    expect(page.text()).toContain('Could not complete the test. Check the Harness connection');
    expect(page.text()).not.toContain('private-token');
    await page.click('Copy diagnostics');
    expect(JSON.parse(clipboard.writeText.mock.calls[0][0])).toEqual({
      plugin: ENTRY_ID, outcome: 'error', status: 503, code: 'SEARCH_FAILED',
    });
  });

  test.each([99, 600, 999, 403.5, '403', Infinity, NaN])('copied diagnostics exclude invalid status %p', (status) => {
    const { plugin } = loadClient();
    expect(plugin.diagnosticMetadata({ ok: false, error: { code: 'SEARCH_FAILED', details: { status } } })).toEqual({
      plugin: ENTRY_ID, outcome: 'error', code: 'SEARCH_FAILED',
    });
  });

  test('server revision conflicts require reload; mismatched successes never appear verified', async () => {
    const client = loadClient();
    const { remote, form } = fixture();
    const connection = { rpc: { call: jest.fn()
      .mockResolvedValueOnce(diagnosticSuccess({ revision: 8 }))
      .mockResolvedValueOnce({ ok: false, error: { code: 'SETTINGS_CONFLICT', message: 'Reload settings before testing again.', details: {} } }) } };
    const page = client.mount(remote, form, { connection });
    await page.settled();
    await page.click('Test search');
    await page.settled();
    expect(page.text()).not.toContain('Test completed');
    await page.click('Test search');
    await page.settled();
    expect(page.button('Reload settings')).toBeDefined();
    expect(page.button('Test search').props.disabled).toBe(true);
    expect(page.text()).toContain('Reload settings before testing again');
  });

  test('clipboard diagnostics whitelist metadata and exclude query, results, messages and secrets', async () => {
    const clipboard = { writeText: jest.fn().mockResolvedValue() };
    const client = loadClient({ clipboard });
    const { remote, form } = fixture();
    const connection = { rpc: { call: jest.fn().mockResolvedValue(diagnosticSuccess({
      apiKey: 'private-key', query: 'private-query', notice: 'private-notice',
      sources: [{ title: 'private-title', url: 'https://example.org/private', snippet: 'private-snippet' }],
    })) } };
    const page = client.mount(remote, form, { connection });
    await page.settled();
    page.edit('web-search-testQuery', 'private-query');
    await page.click('Test search');
    await page.settled();
    await page.click('Copy diagnostics');
    await page.settled();
    const copied = clipboard.writeText.mock.calls[0][0];
    expect(copied).not.toContain('private');
    expect(JSON.parse(copied)).toEqual({
      plugin: ENTRY_ID, outcome: 'success', engine: 'duckduckgo', revision: 7,
      elapsedMs: 123, count: 1, truncated: false, testedAt: '2026-09-29T12:00:00.000Z',
    });
    expect(client.plugin.diagnosticMetadata({ ok: false, error: {
      code: 'private-key', message: 'private-message', details: { engine: 'private-key', retryAfterMs: 1000, headers: { key: 'private-key' } },
    } })).toEqual({ plugin: ENTRY_ID, outcome: 'error', retryAfterMs: 1000, code: 'SEARCH_FAILED' });
    expect(page.text()).toContain('Diagnostics copied');
  });
});

describe('source filters and SearXNG settings', () => {
  test('persists normalized domains and keeps incompatible ranges visible on provider switch', async () => {
    const client = loadClient(); const { remote, form } = fixture(); const page = client.mount(remote, form); await page.settled();
    page.edit('web-search-engine', 'brave');
    page.edit('web-search-allowedDomains', 'EXAMPLE.com., bücher.de');
    page.edit('web-search-blockedDomains', 'ads.example.com');
    page.edit('web-search-dateRange', 'week');
    page.edit('web-search-engine', 'searxng');
    expect(page.byId('web-search-dateRange').props.value).toBe('week');
    await page.save(); expect(form.mutate).not.toHaveBeenCalled();
    expect(page.text()).toContain('does not support the selected date range');
    page.edit('web-search-dateRange', 'day');
    page.edit('web-search-searxngInstanceUrl', 'http://host.docker.internal:8080');
    await page.save();
    expect(form.mutate.mock.calls[0][0]).toEqual(expect.arrayContaining([
      { op: 'set', path: ['allowedDomains'], value: 'example.com\nxn--bcher-kva.de' },
      { op: 'set', path: ['dateRange'], value: 'day' },
      { op: 'set', path: ['searxngInstanceUrl'], value: 'http://host.docker.internal:8080' },
    ]));
    page.unmount();
  });
  test('SearXNG credentials are conditional, secret, preserved when blank and explicitly removable', async () => {
    const client = loadClient(); const { remote, form, descriptor } = fixture();
    descriptor.value = { defaultEngine: 'searxng', searxngInstanceUrl: 'https://search.example.com', searxngAuth: 'basic' };
    descriptor.secrets.push(...['searxngUsername','searxngPassword','searxngToken'].map(field => ({ path: [field], set: true })));
    const page = client.mount(remote, form); await page.settled();
    expect(page.byId('web-search-searxngToken')).toBeUndefined();
    expect(page.byId('web-search-searxngPassword').props).toMatchObject({ type: 'password', value: '' });
    page.edit('web-search-searxngPassword', ' password with spaces ');
    await page.save();
    expect(form.mutate.mock.calls[0][0]).toContainEqual({ op: 'set', path: ['searxngPassword'], value: ' password with spaces ' });
    expect(form.mutate.mock.calls[0][0].some(op => op.path[0] === 'searxngUsername')).toBe(false);
    expect(page.byId('web-search-searxngPassword').props.value).toBe('');
    page.click('Remove saved password'); await page.save();
    expect(form.mutate.mock.calls[1][0]).toContainEqual({ op: 'set', path: ['searxngPassword'], value: '' });
    page.unmount();
  });
  test('rejects invalid domains and insecure remote instance URLs before saving', () => {
    const { plugin } = loadClient();
    for (const update of [{ allowedDomains: 'https://example.com' }, { blockedDomains: '*.example.com' }, { searxngInstanceUrl: 'http://remote.example.com' }, { searxngInstanceUrl: 'https://user:password@example.com' }]) {
      expect(() => plugin.createSettingsOperations({ ...plugin.draftFromValues(), ...update })).toThrow();
    }
  });
  test.each(['10.search.example.com', '127.search.example.com', '192.168.search.example.com', '172.16.search.example.com'])('requires HTTPS for public hostnames resembling private IPs: %s', host => {
    const { plugin } = loadClient();
    const draft = { ...plugin.draftFromValues(), searxngInstanceUrl: `http://${host}` };
    expect(() => plugin.createSettingsOperations(draft)).toThrow('Use HTTPS');
    expect(() => plugin.createSettingsOperations({ ...draft, searxngInstanceUrl: `https://${host}` })).not.toThrow();
  });
  test('filtered empty diagnostics show the filter explanation and do not claim the provider was empty', async () => {
    const client = loadClient(); const { remote, form } = fixture();
    const connection = { rpc: { call: jest.fn(async () => diagnosticSuccess({ count: 0, sources: [], filteredCount: 2, notice: 'No results matched your source filters.' })) } };
    const page = client.mount(remote, form, { connection }); await page.settled(); await page.click('Test search'); await page.settled();
    expect(page.text()).toContain('No results matched your source filters.');
    expect(page.text()).not.toContain('The provider returned no results');
    page.unmount();
  });
});
