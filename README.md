# traverse

`traverse` is a Bun/TypeScript web scraper that can run as either a CLI or an HTTP service. It extracts readable page content as Markdown and returns useful metadata such as title, final URL, links, images, tables, Open Graph tags, quality score, word count, and fetch source.

The CLI is intended for local scraping and crawl jobs that should write files to disk. The HTTP service is intended for use from other projects and returns JSON responses without writing Markdown output artifacts.

## Requirements

- Bun
- Node-compatible shell environment
- Playwright browser binaries if using browser-backed scraping

Install dependencies:

```bash
bun install
```

Install Playwright browsers only if you use `playwright`/browser mode:

```bash
bunx playwright install chromium
```

## Configuration

The app loads `traverse.config.json` automatically from the current working directory.

Common config fields:

```json
{
  "maxPages": 10,
  "maxDepth": 2,
  "concurrency": 2,
  "renderMode": "fetch",
  "respectRobotsTxt": true
}
```

CLI flags and HTTP request `config` values override the file config for that run.

## CLI Usage

Run a single-page scrape:

```bash
bun run scrape https://example.com
```

Run a crawl:

```bash
bun run crawl https://example.com --max-pages 25 --depth 2
```

Validate config:

```bash
bun run validate
```

Resume a saved crawl:

```bash
bun run apps/cli/index.ts resume
```

Useful flags:

```bash
--config traverse.config.json
--output-dir output
--max-pages 10
--depth 2
--concurrency 4
--headless
--headed
--no-js
--dry-run
--verbose
--quiet
--clean-start
```

CLI runs write to:

```text
output/<site>/<timestamp>/
```

That folder can include Markdown pages, JSON sidecars, raw HTML, `requests.csv`, crawl state, and `report.md`, depending on config.

## HTTP Service

Start the server:

```bash
bun run server
```

By default it listens on port `8080`. In hosted environments, the app uses `process.env.PORT` when provided.

Health check:

```bash
curl http://localhost:8080/health
```

Scrape one URL:

```bash
curl -X POST http://localhost:8080/scrape \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com",
    "config": {
      "fetch_source": "fetch"
    }
  }'
```

Crawl a site:

```bash
curl -X POST http://localhost:8080/crawl \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com",
    "config": {
      "fetch_source": "fetch",
      "maxPages": 10,
      "maxDepth": 2,
      "concurrency": 2
    }
  }'
```

HTTP `config.fetch_source` accepts:

```text
fetch       fast HTTP fetch mode, default for HTTP requests
playwright  browser-backed fetch mode for JavaScript-heavy pages
```

The response is JSON:

```json
{
  "ok": true,
  "mode": "scrape",
  "url": "https://example.com",
  "finalUrl": "https://example.com/",
  "stats": {
    "scraped": 1,
    "failed": 0,
    "skipped": 0,
    "queued": 0
  },
  "issues": [],
  "pages": [
    {
      "url": "https://example.com",
      "finalUrl": "https://example.com/",
      "title": "Example Domain",
      "description": "Example Domain",
      "markdown": "...",
      "depth": 0,
      "fetch_mode": "fetch",
      "scrapedAt": "2026-06-26T00:00:00.000Z"
    }
  ]
}
```

For `/crawl`, the response has the same shape and includes multiple `pages`.
Discovered URLs that were not scraped before limits were reached are counted in
`stats.queued`:

```json
{
  "stats": {
    "scraped": 10,
    "failed": 0,
    "skipped": 0,
    "queued": 4
  }
}
```

Increase `maxPages` or `maxDepth` if you want queued URLs to be scraped in the same request.

## HTTP Persistence

HTTP runs do not write Markdown, JSON sidecars, reports, or `output/<site>/<timestamp>/` artifacts. They return content in the JSON response.

The server appends successful page names and URLs to `http.requests.csv`:

```csv
name,website
"Example Domain","https://example.com/"
```

Use `HTTP_REQUEST_LOG` to change the path:

```bash
HTTP_REQUEST_LOG=/var/log/traverse/http.requests.csv bun run server
```

Relative paths are resolved from the directory where the server process is started.

## Build Standalone Binaries

Build the CLI:

```bash
bun run build:cli
```

Build the HTTP server:

```bash
bun run build:server
```

Run the compiled server:

```bash
PORT=8080 HTTP_REQUEST_LOG=/var/log/traverse/http.requests.csv ./traverse-server
```

For compiled binaries, relative paths such as `output` or `http.requests.csv` are resolved from the current working directory where the binary is executed, not from the binary file location.

## Deployment

For the HTTP service, use a long-running web service platform such as Railway or Render.

Railway:

```text
Start command: bun run server
```

The server reads Railway's injected `PORT` automatically.

Render or Docker:

```dockerfile
FROM oven/bun:1

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

EXPOSE 8080

CMD ["bun", "run", "server"]
```

Deploy behind a reverse proxy or platform-provided domain, then call:

```bash
curl https://your-service.example.com/health
```

Before exposing the service publicly, add authentication or network restrictions. The API can fetch arbitrary URLs.

## Project Structure

```text
apps/cli            CLI entrypoint
apps/server         HTTP API entrypoint
packages/core       scrape/crawl orchestration
packages/shared     config, types, logger, utilities
packages/scraper    HTTP fetch, Playwright fetch, proxies, rate limits
packages/crawler    queue, depth, scope, robots.txt, sitemap, resume state
packages/extractor  content extraction and Markdown conversion
```

## Verification

```bash
bun run typecheck
bun run lint
bun run validate
curl http://localhost:8080/health
```
