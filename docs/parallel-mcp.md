# Parallel Search MCP

[Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp) adds web search and page excerpts to Harness without an account or API key. Anonymous search uses Fast mode. It is free for light use, with service rate limits.

This is an optional connection through Harness's built-in MCP client. It adds `mcp__parallel__web_search` and `mcp__parallel__web_fetch` alongside the native web tools. Your DevBits provider selection and saved credentials stay as configured; Parallel is not a new provider in the plugin's settings menu.

## Connect

Requires the same Node.js 22.12+ and tool-capable model as the plugin. The configuration below uses Harness 0.1.7-rc.2, the version supported by this plugin.

Save this as `parallel-search.cordis.yml` in your working directory:

```yaml
- insert:
    - id: mcp-parallel-search
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: parallel
        transport: streamable-http
        url: https://search.parallel.ai/mcp
        headers:
          User-Agent: devbits-web-search
        toolCallTimeoutMs: 60000
```

Start Harness with the extra configuration:

```sh
npx @deepseek-ai/dsh@0.1.7-rc.2 web --patch "$PWD/parallel-search.cordis.yml"
```

Use a unique `serverName` if you already have an MCP server named `parallel`; its tool names will use that name instead. To disconnect, stop Harness and start it again without this `--patch` argument. Keep any other patch arguments you normally use.

## Verify search and page fetching

Wait for MCP discovery, then use a chat preset that permits the MCP tools. Ask your model:

> Use `mcp__parallel__web_search` to find Ada Lovelace's contributions to computing. Set `objective` to that research goal and `search_queries` to `["Ada Lovelace computing contributions"]`. Include source links in your answer.

Check that the chat shows a call to the named tool and a result with source URLs and excerpts. Then ask it to call `mcp__parallel__web_fetch` with one of those URLs in the `urls` array and summarize the returned excerpts. Reuse the same `session_id` across related search and fetch calls when supplying it; the server returns one if omitted.

The plugin's **Test search** button exercises your selected native provider, so use the chat's MCP tool calls to check this connection. A model may choose another tool or answer without searching; naming the tool in the prompt helps, but inspect the actual call before treating it as verified.

## Settings, privacy, and troubleshooting

MCP requests use the configuration above, including a 60-second tool-call timeout. The plugin's domain/date filters, result cap, request queue, and request budget apply to its native provider, not these separate MCP tools. Queries and requested page URLs go to Parallel even with a local model; treat returned web content as untrusted.

If the tools are missing, check Harness's startup logs, outbound HTTPS access, and whether your preset permits MCP tools. A name collision needs a different `serverName`. If a call reports a quota or rate limit, pause before trying again and honor any retry guidance. The [Parallel setup guide](https://docs.parallel.ai/integrations/mcp/search-mcp) also explains optional authentication for higher limits; this anonymous configuration sends no authorization header.

For the underlying configuration fields and tool naming, see the [Harness MCP client reference](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md).

[Back to README](../README.md)
