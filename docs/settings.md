# Settings

Open **Plugins → DevBits Web Search**. Choose a provider, enter its required fields, and click **Save changes**. **Discard changes** restores the last loaded settings. Changes take effect on the next search.

## Credentials

Only the selected provider's controls are shown. Switching providers preserves other providers' keys and pending edits. A blank credential field keeps its saved value; use **Remove saved key** or the corresponding credential removal button to delete it on save. A saved-key indicator confirms storage, not whether the credential works or has available quota.

Brave, Tavily, and Exa need their own API keys. Google also needs a search engine ID (`cx`). SearXNG needs an instance address and, if your deployment requires it, a bearer token or username and password. See [SearXNG setup](searxng.md).

Credentials are saved in the active Harness profile and omitted from remote settings responses. The plugin does not read credentials or provider selection from environment variables. It does not encrypt profile storage.

## Source filters

**Only these domains** limits returned links to the listed hostnames and their subdomains. Leave it empty to allow any domain. **Blocked domains** takes precedence, including for subdomains.

Enter hostnames separated by commas or new lines, without URL schemes, paths, ports, or wildcards. For example:

```text
wikipedia.org
developer.mozilla.org
```

Each list accepts up to 100 entries. Internationalized names are normalized when saved. Checks apply to every provider's returned URLs before the result cap. Providers with supported domain parameters also receive those restrictions to improve candidate selection.

Filtering can return fewer results or none. The plugin explains when it removes candidates; it never relaxes restrictions or sends extra requests to fill the count. Rules apply to both model searches and tests. They do not restrict separate `web_fetch` requests or the destinations of redirects on external sites. Per-query filter overrides are not exposed by the native Harness tool.

## Date range

| Provider | Available ranges |
| --- | --- |
| DuckDuckGo | Any time |
| SearXNG | Any time, past day, month, or year; support depends on upstream engines |
| Brave, Tavily, Exa, Google | Any time, past day, week, month, or year |

An unsupported selection is kept when switching providers and must be corrected before saving. Dates come from providers and may be estimated or reflect page updates. Tavily excludes undated results when a date range is selected. Exa sends publication-date bounds ending at the current time, with rolling 30-day months and 365-day years. Retrieval time is not publication time.

## Test search

Save your settings, then select **Test search**. It sends one query using the same provider, credentials, and request limits as model searches and returns up to three source links. It may consume provider credits. An empty result can be valid, especially with DuckDuckGo Instant Answers.

The result shows elapsed time, source count, and any coverage or filter notices. **Cancel test** stops a pending test. **Copy diagnostics**, when clipboard access is available, copies status metadata without queries, results, provider messages, or keys. A successful test checks provider access, not whether a model chooses to call the search tool.

## Advanced settings

| Setting | Default | Allowed range |
| --- | --- | --- |
| Search timeout | 15 seconds | 0.001–120 seconds |
| Requests per minute | 20 | 1–600 |
| Time between requests | 1 second | 0–60 seconds |
| Results per search | 8 | 1–20; Google supports at most 10 |

One request runs at a time, with room for ten waiting requests. The timeout includes waiting, pacing, and the provider response. Each query in a multi-query tool call counts separately. Requests count when they start, including ones that later fail; missing credentials are rejected first. Tests return at most three results.

Settings changes preserve recent request history. Restarting Harness or remounting the plugin resets it. If a provider sends a `Retry-After` delay, new requests pause for that period. Failed requests are not automatically repeated, and another provider is never selected automatically.

Tavily uses basic search with automatic parameter upgrades disabled. Exa uses auto search with highlights. Neither requests generated answers or full page text. Provider quotas and fees still apply, and these local limits do not cap account spending.

Provider API references: [Brave](https://api-dashboard.search.brave.com/api-reference/web/search/get), [Tavily](https://docs.tavily.com/documentation/api-reference/endpoint/search), [Exa](https://exa.ai/docs/reference/search).

[Back to README](../README.md)
