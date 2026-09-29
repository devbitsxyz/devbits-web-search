# JavaScript API

For use outside Harness:

```sh
npm install devbits-web-search
```

```js
const { create } = require('devbits-web-search');

async function main() {
  const client = await create();
  const result = await client.search('Ada Lovelace', { num: 5 });
  console.log(result.results);
}

main().catch(error => console.error(error.message));
```

`WebSearchPlugin` is exported at the package root and as `devbits-web-search/search-client`. `create(config)` accepts `defaultEngine`, `timeoutMs`, `filters`, and provider settings in `engines.<provider>`. Pass keys explicitly as `apiKey`; Google also needs `searchEngineId`. Keenable (`keenable`) works without a key, and `engines.keenable.apiKey` is optional. `filters` accepts `allowedDomains` and `blockedDomains` as hostname arrays or comma/newline-separated strings, plus `dateRange` (`any`, `day`, `week`, `month`, `year`). Unsupported provider/date combinations fail before a request. For SearXNG, set `engines.searxng.instanceUrl`, `auth` (`none`, `bearer`, `basic`), and the applicable `token` or `username`/`password`. Library configuration is independent of the Harness UI. The Harness request queue and rolling request budget belong to the plugin integration; standalone clients do not share them.

`search(query, options)` and its alias `query(query, options)` accept `engine`, `num`, `timeoutMs`, and an abort `signal`. The default result count is 8; `num` must be an integer from 1 to 20. Google requests are capped at 10 and report truncation when a larger count is requested.

Results have this shape:

```js
{
  query,
  engine,
  count,
  results: [{ title, url, snippet, engine }],
  truncated
}
```

When applicable, results also contain `filteredCount`, `partialFailureCount`, or `limitedDateFilter`. Counts describe returned candidates and reported upstream failures, not the size of a search index.

Requests have a 15-second default timeout, configurable from 1 to 120000 milliseconds, and a 2 MiB response limit. Redirects are rejected. Result URLs are restricted to HTTP(S) and deduplicated. Titles and snippets are limited to 300 and 2000 characters. `truncated` is true when a request or returned content is shortened. Errors preserve a status and code when available, with credentials removed from messages and diagnostic causes.

[Back to README](../README.md)
