# Changelog

## 0.1.0 — 2026-09-29

Initial public release of DevBits Web Search.

- Adds an installable DeepSeek Harness bundle using the native `web_search` provider contract.
- Supports DuckDuckGo Instant Answers, optional SearXNG, Brave, Tavily, Exa, and eligible Google Custom Search accounts.
- Provides a Harness settings page for choosing a provider, storing API keys, adjusting request limits, and saving or discarding edits.
- Adds authenticated Test search diagnostics using saved settings, with result links and actionable provider errors.
- Shares a rolling request budget, request pacing, result cap, and bounded queue between model searches and diagnostics.
- Adds persistent allowed/blocked domains and provider-aware date filters, with explanations for filtered empty results.
- Supports SearXNG instance URLs, optional bearer or Basic authentication, and partial upstream failure diagnostics.
- Reads saved settings on each request without requiring a restart.
- Adds request validation, cancellation, timeouts, response limits, URL filtering, deduplication, and credential-safe errors.
- Includes offline provider, UI, packaging, and native Harness integration tests.
- Includes illustrated installation instructions, provider setup, and troubleshooting guides.

Requires Node.js 22.12 or later. Integration tested with DeepSeek Harness 0.1.7-rc.2. DuckDuckGo provides topic summaries and related links rather than full web search. Other providers may require paid API access.
