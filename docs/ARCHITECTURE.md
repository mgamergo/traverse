# Architecture

`traverse` ships a CLI app, an HTTP app, and a reusable scraping core. The apps are thin wrappers around the same core runner so terminal and service usage share scraping behavior, config, proxy handling, output writing, and extraction metadata.

## Package Layout

```text
index.ts                         compatibility entrypoint for the CLI app
traverse.config.json             default project config
apps/cli/
  index.ts                       terminal CLI, flags, loading/done states
apps/server/
  index.ts                       HTTP API for scrape/crawl requests
packages/core/                   reusable scrape/crawl runner
  index.ts                       URL/config runner and lifecycle events
  output.ts                      markdown/json/report writers
packages/shared/                 shared contracts and helpers
  types.ts                       all models and config types
  config.ts                      config loading, merging, validation
  logger.ts                      structured JSON logger
  browser-profiles.ts            realistic browser profile pool
  utils.ts                       URL, text, slug, timing helpers
packages/scraper/                request and rendering engine
  index.ts                       raw fetch, Playwright fetch, proxies, rate limits
  browser.ts                     browser context, stealth patches, waits, scrolls
packages/crawler/                crawl-only behavior
  index.ts                       queue, visited set, robots, sitemap, scope, filters
packages/extractor/              content pipeline
  index.ts                       Readability, selectors, JSON-LD, tables, markdown
```

## Runtime Flow

1. `apps/cli/index.ts` parses flags or `apps/server/index.ts` parses JSON requests.
2. The app loads `traverse.config.json`, applies overrides, and calls `runCore({ url, mode, config, onEvent })`.
3. Core emits lifecycle events: `start`, `progress`, `page`, `skip`, `error`, and `done`.
4. The CLI uses those events to show loading/progress/done states. The HTTP app uses them to collect skips and errors.
5. Core creates the scraper, crawler state, extractor, and output writer.
6. In `scrape` mode, one URL is queued and extracted.
7. In `crawl` mode, crawler state manages discovered URLs until `maxPages` or `maxDepth` is reached.
8. Scraper fetches each page through raw HTTP or Playwright based on `renderMode`.
9. Extractor turns HTML into structured data and Markdown.
10. CLI runs save per-page Markdown, optional JSON sidecars, request CSV, state, and report. HTTP runs keep page content in the JSON response and only append page names/URLs to `http.requests.csv`.

## Core API

```ts
import { runCore } from "./packages/core/index.ts";

const result = await runCore({
  url: "https://example.com",
  mode: "scrape",
  config,
  onEvent(event) {
    if (event.type === "done") console.log(event.outputDir);
  },
});

console.log(result.pages[0]?.markdown);
console.log(result.pages[0]?.title);
```

This is the API both app layers call. `result.pages[]` contains Markdown and structured metadata for each extracted page.

## HTTP API

`apps/server/index.ts` starts a Bun server on port `8080` by default. It exposes:

- `GET /health`: service health check.
- `POST /scrape`: single-page scrape.
- `POST /crawl`: bounded crawl.

Request body:

```json
{
  "url": "https://example.com",
  "config": {
    "fetch_source": "fetch",
    "maxPages": 1
  }
}
```

`config.fetch_source` is HTTP-only convenience input. It accepts `"fetch"` or `"playwright"` and defaults to `"fetch"`. Internally it maps to the shared core render mode.

Response body:

```json
{
  "ok": true,
  "runId": "uuid",
  "mode": "scrape",
  "url": "https://example.com/",
  "stats": {},
  "issues": [],
  "requestLog": "http.requests.csv",
  "queued": [
    {
      "url": "https://example.com/docs",
      "depth": 1,
      "referrer": "https://example.com/",
      "score": 94,
      "order": 12
    }
  ],
  "pages": [
    {
      "title": "Example Domain",
      "finalUrl": "https://example.com/",
      "fetch_source": "fetch",
      "markdown": "...",
      "wordCount": 120,
      "links": [],
      "images": [],
      "quality": {}
    }
  ]
}
```

`queued[]` contains URLs discovered by `/crawl` that were not processed before `maxPages`, `maxDepth`, filtering, or strategy limits stopped the run. The objects match the internal crawl queue item shape: URL, depth, optional referrer, score, and order.

The HTTP app does not write Markdown, JSON sidecars, reports, or `output/<site>/<timestamp>/` artifacts. It appends successful pages to `http.requests.csv` with `name,website` columns. Set `HTTP_REQUEST_LOG=logs/http.requests.csv` to choose another path.

The HTTP app isolates crawl state per request under `.traverse-state/http/<runId>/...` so concurrent requests do not reuse CLI resume state.

## Where To Learn From

- Start with `apps/cli/index.ts` to see how terminal commands call core.
- Read `apps/server/index.ts` to see how HTTP requests call core.
- Read `packages/core/index.ts` to see the reusable scrape/crawl workflow.
- Read `packages/shared/types.ts` next; those types define the whole system.
- Read `packages/scraper/index.ts` for request behavior and anti-bot integration points.
- Read `packages/crawler/index.ts` for queueing, robots.txt, sitemap, filtering, and depth.
- Read `packages/extractor/index.ts` for content extraction and Markdown conversion.

## External Service Boundaries

CAPTCHA solver APIs and commercial proxy provider APIs require paid credentials and target-specific continuation logic. The integration points are explicit in `packages/scraper/index.ts`; they log when reached and are ready for provider-specific implementations.
