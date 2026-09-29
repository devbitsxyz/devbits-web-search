#!/usr/bin/env node
/** Verify the actual npm tarball without publishing or installing packages. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const temp = await mkdtemp(path.join(tmpdir(), 'devbits-package-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

try {
  const [packed] = JSON.parse(execFileSync(npm, ['pack', '--json', '--pack-destination', temp], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { ...process.env, npm_config_cache: path.join(temp, 'npm-cache') },
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  assert.equal(packed.name, 'devbits-web-search');
  const tarball = path.join(temp, packed.filename);
  const archiveEntries = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
    .trim().split(/\r?\n/).filter(Boolean);
  assert.ok(archiveEntries.every((entry) => entry.startsWith('package/') && !entry.split('/').includes('..')));
  execFileSync('tar', ['-xzf', tarball, '-C', temp]);
  const packageRoot = path.join(temp, 'package');
  const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  const included = new Set(archiveEntries.filter((entry) => !entry.endsWith('/')).map((entry) => entry.slice('package/'.length)));
  const required = [
    'package.json', 'README.md', 'LICENSE', 'cordis.patch.yml',
    'src/index.js', 'src/plugin.js', 'src/client.js', 'src/settings.js',
    'src/diagnostics.js', 'src/request-limits.js', 'src/filters.js', 'src/errors.js', 'src/notices.js', 'src/providers/searxng.js', 'docs/searxng.md',
    'assets/devbits-mark.svg', 'locale/en.json',
    'docs/settings.md', 'docs/javascript-api.md', 'docs/troubleshooting.md',
  ];
  for (const file of required) assert.ok(included.has(file), `Missing published file: ${file}`);
  const allowed = new Set([...manifest.files, 'package.json', 'README.md', 'LICENSE']);
  for (const file of included) {
    assert.ok(allowed.has(file), `Unexpected file in npm package: ${file}`);
    assert.ok(!/(^|\/)(?:node_modules|test|tests|scripts|\.git|\.github)(\/|$)|(^|\/)(?:\.env(?:\..*)?|\.npmrc|\.DS_Store)$|\.tgz$/.test(file),
      `Development or credential file must not be published: ${file}`);
  }

  // Every public export and Harness metadata asset must resolve inside the tarball.
  async function verifyTarget(target) {
    if (target === null) return;
    if (typeof target === 'object') {
      for (const value of Object.values(target)) await verifyTarget(value);
      return;
    }
    assert.equal(typeof target, 'string', 'Package targets must be strings');
    assert.ok(target.startsWith('./'), `Expected a package-relative target: ${target}`);
    const relative = path.relative(packageRoot, path.resolve(packageRoot, target));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    assert.ok((await stat(path.join(packageRoot, relative))).isFile(), `Missing target: ${target}`);
  }
  await verifyTarget(manifest.exports);
  await verifyTarget(manifest.dsh.bundle.patch);
  await verifyTarget(manifest.icon);
  const locale = JSON.parse(await readFile(path.join(packageRoot, 'locale/en.json'), 'utf8'));
  assert.equal(locale.meta.title, 'DevBits Web Search', 'The native Harness plugin title must carry the public brand');

  // Load the extracted package, reusing installed dependencies through NODE_PATH.
  // The package itself is resolved by its public name and exports from the tarball.
  execFileSync(process.execPath, ['-e', String.raw`
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const path = require('node:path');
    const vm = require('node:vm');
    const { createRequire } = require('node:module');
    const packaged = createRequire(path.join(process.argv[1], 'package.json'));
    const manifest = packaged('./package.json');
    const plugin = packaged(manifest.name);
    const Client = packaged(manifest.name + '/search-client');
    assert.equal(typeof plugin.apply, 'function');
    assert.ok(plugin.inject.includes('web'));
    assert.equal(plugin.WebSearchPlugin, Client);
    assert.equal(new Client().config.defaultEngine, 'duckduckgo');
    assert.equal(fs.realpathSync(packaged.resolve(manifest.name + '/cordis.patch.yml')),
      fs.realpathSync(path.join(process.argv[1], 'cordis.patch.yml')));
    assert.deepEqual(packaged(manifest.name + '/locale/en.json'), packaged('./locale/en.json'));
    let browserModule;
    vm.runInNewContext(fs.readFileSync(packaged.resolve(manifest.name + '/client'), 'utf8'), {
      window: { __ModuleLoader__: { load(value) { browserModule = value; } } }
    });
    assert.equal(browserModule.id, manifest.name);
    assert.equal(typeof browserModule.factory, 'function');
  `, packageRoot], {
    cwd: packageRoot,
    env: { ...process.env, NODE_PATH: path.join(projectRoot, 'node_modules') },
    stdio: 'pipe',
  });
  console.log(`PASS: ${manifest.name}@${manifest.version} tarball includes its runtime, branding and user guides; public exports load; development and credential files are excluded.`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
