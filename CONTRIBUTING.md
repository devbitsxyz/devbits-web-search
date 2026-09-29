# Contributing

Bug reports and pull requests are welcome at [devbitsxyz/devbits-web-search](https://github.com/devbitsxyz/devbits-web-search).

For a bug report, include the Node and Harness versions, selected provider, steps to reproduce, and the error code or status. Explain whether the failure happens during installation, saving settings, a search request, or model tool calling. Remove API keys and private query content from logs.

## Local setup

Use Node.js 22.12 or later. The integration has been tested with DeepSeek Harness 0.1.7-rc.2.

```sh
git clone https://github.com/devbitsxyz/devbits-web-search.git
cd devbits-web-search
npm ci
npm test
npm run test:package
```

To try the checkout in Harness:

```sh
npx @deepseek-ai/dsh plugin --profile web add "$PWD"
npx @deepseek-ai/dsh web
```

Restart Harness after source changes. Saved settings are read on the next request.

## Tests

`npm test` runs offline tests for provider requests and responses, errors, settings, and the browser configuration page. Provider responses are mocked; no API keys are needed.

`npm run test:package` checks the contents and metadata of the npm package. Run it when changing packaging, bundled assets, or package entry points.

`npm run test:install` installs the packed package into an empty temporary project and checks its public exports. It needs registry access to download dependencies. Set `DSH_RUNTIME_DIR` to also run the native integration test against that installed copy. The temporary project is removed when the check finishes.

The Harness integration test loads the real Cordis Loader, native `web_search` tool, settings service, browser RPC client, and authenticated Connection transport while mocking external search requests. It preserves the real WebServer service and routing, replacing only its TCP listener lifecycle. Its browser cookie exchange and RPC requests use in-memory streams and credential records, without a TCP listener or user-profile writes. This retains the service scope checks that a plain route mock would miss. Point it at an installed Harness runtime:

```sh
DSH_RUNTIME_DIR=/path/to/harness/node_modules npm run test:harness
```

`DSH_RUNTIME_DIR` only locates the test runtime. Search credentials and provider selection do not use environment variables. Run this test when changing registration, configuration, or the native provider contract.

A live DuckDuckGo example is available from the source checkout:

```sh
node example.js Ada Lovelace
```

That command sends a query to DuckDuckGo. It is separate from the offline tests.

## Changes

Keep JavaScript in the existing CommonJS style. Use English in code comments and documentation. Prefer a small change with a clear reason over a broad rewrite.

When adding or changing a provider, check its official API documentation and cover the request shape, missing credentials, empty and malformed responses, cancellation, and errors that might contain secrets. Keep optional paid modes explicit. Avoid live API calls in automated tests.

Settings changes should preserve saved keys when password fields are left blank, support explicit removal, and apply through Harness's revision checks. Test behavior that can break for users; documentation and simple copy changes do not need new tests.

Diagnostic tests must use saved configuration and the same request controls as native model searches. Cover stale settings, authentication, cancellation, empty results, provider errors, and secret redaction. Request-limit tests should use a controlled clock where practical; verify queue and pacing waits share the total timeout and that failed provider requests still count once started.

Describe the problem, resulting behavior, and relevant validation in a pull request. Update the README for user-visible changes and the changelog for a release. Do not include local profiles, credentials, or generated package archives.

For release preparation, see [Releasing](docs/releasing.md).
