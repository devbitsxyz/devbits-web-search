#!/usr/bin/env node
/** Install the packed release into an empty directory, then exercise its exports. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const temp = await mkdtemp(path.join(tmpdir(), 'devbits-install-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const env = { ...process.env, npm_config_cache: path.join(temp, 'npm-cache') };
try {
  const [packed] = JSON.parse(execFileSync(npm, ['pack', '--json', '--pack-destination', temp], { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  await writeFile(path.join(temp, 'package.json'), JSON.stringify({ name: 'devbits-install-check', version: '1.0.0', private: true }));
  execFileSync(npm, ['install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', path.join(temp, packed.filename)], { cwd: temp, env, stdio: 'pipe' });
  const pluginRoot = path.join(temp, 'node_modules/devbits-web-search');
  const report = execFileSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const { createRequire } = require('node:module');
    const installed = createRequire(process.cwd() + '/package.json');
    const plugin = installed('devbits-web-search');
    const Client = installed('devbits-web-search/search-client');
    assert.equal(typeof plugin.apply, 'function');
    assert.equal(new Client().config.defaultEngine, 'duckduckgo');
    assert.equal(new Client().isAvailable('searxng'), false);
    assert.equal(new Client({ engines: { searxng: { instanceUrl: 'http://localhost:8080' } } }).isAvailable('searxng'), true);
    assert.throws(() => new Client({ filters: { blockedDomains: '*.example.com' } }));
    console.log(JSON.stringify({ node: process.version, entry: installed.resolve('devbits-web-search') }));
  `], { cwd: temp, env: { ...env, NODE_PATH: '' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const result = JSON.parse(report.trim());
  assert.ok((await realpath(result.entry)).startsWith(await realpath(pluginRoot) + path.sep));
  if (process.env.DSH_RUNTIME_DIR) {
    execFileSync(process.execPath, [path.join(root, 'scripts/smoke-harness.mjs')], {
      cwd: temp, env: { ...env, NODE_PATH: '', DSH_PLUGIN_DIR: pluginRoot }, stdio: 'inherit',
    });
  }
  console.log(`PASS: clean npm tarball install and public exports on ${result.node}${process.env.DSH_RUNTIME_DIR ? '; native Harness smoke used the installed package' : ''}.`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
