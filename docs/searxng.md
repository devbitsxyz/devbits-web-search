# Connect SearXNG

SearXNG is an optional, separately operated search server. DuckDuckGo Instant Answers remains the default and needs no setup. Installing DevBits Web Search does not install SearXNG or select a public instance for you.

## Instance setup

Follow the [official installation guide](https://docs.searxng.org/admin/installation.html) for a server you manage. Enable JSON in that instance's `settings.yml`, preserving its other settings:

```yaml
search:
  formats:
    - html
    - json
```

Restart the instance as required by your deployment. Keep access controls appropriate to its network exposure; do not disable TLS verification or remove protections from a public server to fix an integration problem.

## Harness settings

1. Open **Plugins → DevBits Web Search** and choose **SearXNG — your own instance**.
2. Enter an **Instance URL**, such as `http://localhost:8080` or `https://search.example.com/searxng`. A base path or a URL ending in `/search` is accepted. The plugin builds the query parameters; do not paste a query template, token, or browser URL with parameters.
3. Select **None**, **Bearer token**, or **Username and password** to match your instance or reverse proxy. SearXNG does not issue a universal search API key. Its server `secret_key` is a cryptographic setting, not a credential for this form.
4. Set any source filters, save, and select **Test search**. The test sends the entered query through the same limits as model searches.

All plugin settings and credentials are saved through the Harness UI. No search configuration needs environment variables. Blank credential fields preserve saved values; explicit removal takes effect on save. Instance usernames are also hidden after saving.

## Choose the reachable address

The request originates from the machine or container running Harness, not the browser.

| Deployment | Address to use |
| --- | --- |
| Both programs on the same host | The instance's loopback address and published port. |
| Both containers on the same Docker network | The SearXNG service name and its internal port, such as `http://searxng:8080`. |
| Harness in Docker, SearXNG on the host | A configured host gateway, such as `http://host.docker.internal:8080`. Availability depends on the Docker platform and network setup. |
| Remote server | The HTTPS address of your deployment. |

HTTP is accepted only for loopback, RFC 1918 IPv4, unique-local IPv6, single-label local names, `.local`/`.localhost` names, and Docker's host/gateway names. Remote instances require HTTPS. Local names are trusted configuration supplied by the profile owner, not a DNS isolation guarantee. Redirects are not followed, so credentials cannot be forwarded to a different redirect destination.

## Understand test results

- **Could not reach the instance:** check connectivity from Harness and confirm the address and port.
- **HTTP 401 or 403:** check authentication, access rules, and JSON output. A 403 does not necessarily mean the password is wrong.
- **Web page or unreadable response:** check the deployment path, JSON settings, and whether a proxy returned a sign-in page.
- **Limited coverage:** useful results arrived, but SearXNG reported failed upstream engines. Check the instance's engine status. The plugin preserves the useful results.
- **No results with upstream failures:** no results arrived and the instance reported failed engines. This does not prove that every configured engine failed.
- **No results matched source filters:** returned candidate URLs were removed by your saved domain rules.
- **Rate limited or timed out:** review the plugin's request limits and the instance/upstream limits. There are no automatic retries or fallback instances.

SearXNG date filters depend on its configured engines. Day, month, and year are supported request values; some engines may ignore them. Domain rules are always applied locally to returned URLs. Search results and excerpts remain untrusted external content.

Your instance and its configured upstream engines receive search queries. Self-hosting gives you control over the intermediary; it does not make internet searches local or unlimited. Optional instance authentication does not sign you into source websites.
