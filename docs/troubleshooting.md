# Troubleshooting

Start with **Plugins → DevBits Web Search → Test search**. Save any pending changes first. The test separates provider access problems from whether your model chooses to search.

## The plugin does not appear

Install into the profile you actually run, then restart Harness:

```sh
npx @deepseek-ai/dsh plugin --profile web add devbits-web-search
npx @deepseek-ai/dsh web
```

Before npm publication, use `github:devbitsxyz/devbits-web-search` instead of the package name. For a local checkout, use its absolute directory path. Adding an npm dependency or copying files into a plugins directory alone does not activate a Harness bundle. See [installation instructions](../README.md#install).

## The package name appears twice

Harness 0.1.7-rc.2 can display the component ID and module name even when both are `devbits-web-search`. If Components says **1 total · 1 running**, this is a duplicate label, not a second installation. It is controlled by Harness's plugin manager.

If two components actually load, check for an old `dsh-plugin-web-search` installation or a manual configuration insert. Back up the profile before removing an old entry, especially if it contains saved credentials.

## Search asks for DeepSeek credentials

The model provider and search provider are separate. This plugin uses `local-web-search`. A later profile, home, or command-line patch can override that selection. When correcting the native web configuration, preserve `fetchProvider: http`.

## A provider fails

| Message | What to check |
| --- | --- |
| Missing or rejected credentials | Save the selected provider's key. Google also needs a valid search engine ID. Check account permissions. |
| Quota or credits exhausted | Review usage and billing in the provider's dashboard. |
| Rate limited or queue full | Wait for current work or the rolling request budget to recover. Raising the plugin limit does not raise the provider's quota. |
| Timeout or connection failure | Check connectivity from the machine running Harness, then review the timeout and request traffic. |
| SearXNG returns HTML or denies access | Check the instance address, JSON output, and authentication. See [SearXNG setup](searxng.md). |
| Settings changed | Reload settings and test again. Results from an earlier configuration are discarded. |
| Test endpoint unavailable | Restart Harness after updating the plugin, then reload the browser. |

Google Custom Search JSON API is closed to new customers; existing users must migrate by January 1, 2027. See [Google's availability notice](https://developers.google.com/custom-search/v1/overview). Bing Search APIs retired on August 11, 2025; this plugin does not call them. See [Microsoft's retirement notice](https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement).

## Search returns no sources

DuckDuckGo Instant Answers returns topic summaries and related links, not a full search-results page. Try a known topic such as `Ada Lovelace`, or configure another provider for broader coverage. An empty result does not mean no relevant pages exist.

Review saved source filters. Allowed domains restrict results; blocked domains always win. A date range can further reduce coverage. SearXNG may return useful results while reporting failures from some upstream engines.

## The test works but the model never searches

Use a model that supports tool calls, and check that its preset exposes `web_search`. Standard and Code presets include the native web tools; a custom preset may need them enabled. Ask explicitly for a web search. Installing a provider cannot make a model call a tool it does not support.

## Report a problem

[Open an issue](https://github.com/devbitsxyz/devbits-web-search/issues) with your Node and Harness versions, selected provider, reproduction steps, and the error code or copied diagnostics. Remove API keys, launch tokens, private queries, and profile contents before sharing logs or screenshots.

[Back to README](../README.md)
