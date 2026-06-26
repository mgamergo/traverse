# Configuration

The CLI and HTTP server load `traverse.config.json` automatically. You can pass another file to the CLI with:

```bash
bun run apps/cli/index.ts crawl --config my-config.json
```

CLI flags override config values.

HTTP requests can override config values with the `config` field:

```json
{
  "url": "https://example.com",
  "config": {
    "renderMode": "fetch",
    "maxPages": 1,
    "concurrency": 1
  }
}
```

The HTTP server applies those overrides for that request only.

## Important Crawl Options

- `startUrls`: seed URLs.
- `crawler`: `true` for crawler mode, `false` for single-page scrape mode.
- `maxPages`: total page cap.
- `maxDepth`: maximum link hops from a seed URL.
- `strategy`: `bfs` for broad crawl or `dfs` for deep crawl.
- `scope`: `same-domain`, `same-origin`, `include-subdomains`, `whitelist`, or `unrestricted`.
- `allowedDomains`: required when `scope` is `whitelist`.
- `includePatterns`: regex allow-list.
- `excludePatterns`: regex block-list.
- `respectRobotsTxt`: fetch and obey robots.txt.
- `useSitemap`: seed crawl from sitemap URLs when found.
- `sitemapOnly`: crawl only sitemap URLs and do not follow page links.

## Concurrency And Rate Limits

- `concurrency`: total worker count.
- `perDomainConcurrency`: max active pages for one hostname.
- `globalRateLimitRps`: max request rate across all domains.
- `perDomainMinDelayMs`: minimum delay between requests to one domain.
- `delay.minMs`, `delay.maxMs`, `delay.curve`: randomized human-like delay distribution.

## Rendering

- `renderMode`: `fetch`, `browser`, or `auto`.
- `browserEngine`: `chromium`, `firefox`, or `webkit`.
- `headless`: run browser without a visible window.
- `blockResources`: Playwright resource types to block, such as `image`, `font`, `media`.
- `wait.until`: `domcontentloaded`, `load`, `networkidle`, `selector`, `selector-hidden`, `expression`, or `delay`.
- `infiniteScroll`: enables automatic scroll passes for lazy-loaded pages.

## Extraction

- `selectors`: custom CSS selector extraction.
- `xpaths`: custom XPath extraction.
- `linkMode`: `inline`, `reference`, or `strip`.
- `imageMode`: `keep`, `strip`, or `threshold`.
- `redactPii`: redact detected email, phone, and credit card patterns.
- `filterLanguages`: only keep detected languages listed here.
- `minQualityScore`: skip pages below this score.

## Output

- `outputDir`: base output directory from config or CLI.
- `baseOutputDir`: root folder used before the runtime site/timestamp folder is added.
- `jsonSidecar`: write full extracted data next to each Markdown file.
- `rawHtml`: save cleaned HTML next to each Markdown file.
- `consolidatedOutput`: write `combined.md`.
- `mirrorUrlStructure`: mirror URL paths in the output directory.
- `requestCsv`: write `requests.csv`.

At runtime, the CLI writes to `outputDir/site-name/timestamp/`. For example, scraping `https://example.com` writes to `output/example.com/2026-06-25T14-30-00Z/`. This keeps `report.md` and `requests.csv` from overwriting previous runs.

## Proxies And CAPTCHA

- `proxies`: static proxy list.
- `proxyFile`: file containing one proxy per line.
- `proxyEnv`: environment variable containing comma-separated proxies.
- `proxyRotation`: `round-robin`, `random`, `sticky-session`, or `per-domain`.
- `captcha.enabled`: enable CAPTCHA solver integration point.
- `captcha.provider`: `2captcha`, `capsolver`, or `anti-captcha`.
- `captcha.apiKey`: solver API key.

## Per-Domain Overrides

```json
{
  "domains": {
    "example.com": {
      "renderMode": "browser",
      "perDomainMinDelayMs": 3000,
      "maxDepth": 1
    }
  }
}
```
