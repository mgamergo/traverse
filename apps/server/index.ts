#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
	type CorePageResult,
	type CoreRunMode,
	runCore,
} from "../../packages/core/index.ts";
import {
	loadConfig,
	loadProxySources,
	mergeConfig,
	validateConfig,
} from "../../packages/shared/config.ts";
import { Logger } from "../../packages/shared/logger.ts";
import type { AppConfig } from "../../packages/shared/types.ts";
import { normalizeInputUrl } from "../../packages/shared/utils.ts";

type HttpFetchSource = "fetch" | "playwright";
type HttpRequestConfig = Partial<AppConfig> & {
	fetch_source?: HttpFetchSource;
};

interface ScrapeRequestBody {
	url?: string;
	mode?: CoreRunMode;
	config?: HttpRequestConfig;
}

interface RunIssue {
	type: "skip" | "error";
	url: string;
	reason?: string;
	category?: string;
	error?: string;
}

interface ApiRunStats {
	scraped: number;
	failed: number;
	skipped: number;
	queued: number;
}

interface MarkdownTable {
	caption?: string;
	markdown: string;
}

interface ApiScrapedPage {
	url: string;
	finalUrl: string;
	title?: string;
	description?: string;
	markdown: string;
	tables?: MarkdownTable[];
	links?: string[];
	depth?: number;
	fetch_mode: CorePageResult["fetch_source"];
	scrapedAt: string;
}

interface ApiScrapeResponse {
	ok: boolean;
	mode: CoreRunMode;
	url: string;
	finalUrl?: string;
	stats: ApiRunStats;
	issues: string[];
	pages: ApiScrapedPage[];
}

const DEFAULT_PORT = 8080;
const REQUEST_LOG_PATH = process.env.HTTP_REQUEST_LOG ?? "http.requests.csv";

const server = Bun.serve({
	hostname: "0.0.0.0",
	port: Number(process.env.PORT ?? DEFAULT_PORT),
	async fetch(request) {
		const url = new URL(request.url);

		if (request.method === "OPTIONS") return emptyResponse(204);
		if (request.method === "GET" && url.pathname === "/health") {
			return jsonResponse({ ok: true, service: "traverse" });
		}
		if (request.method === "POST" && url.pathname === "/scrape") {
			return handleRun(request, "scrape");
		}
		if (request.method === "POST" && url.pathname === "/crawl") {
			return handleRun(request, "crawl");
		}

		return jsonResponse({ ok: false, error: "Not found" }, 404);
	},
});

console.log(`Traverse HTTP server listening on http://0.0.0.0:${server.port}`);

async function handleRun(request: Request, routeMode: CoreRunMode) {
	try {
		const body = await readJsonBody(request);
		const targetUrl = requireUrl(body.url);
		const mode = body.mode ?? routeMode;
		if (mode !== routeMode) {
			return jsonResponse(
				{
					ok: false,
					error: `Use /${mode} for mode '${mode}' or omit the mode field`,
				},
				400,
			);
		}

		const runId = crypto.randomUUID();
		const loadedConfig = await loadConfig();
		const requestConfig = resolveHttpConfig(body.config);
		let config = mergeConfig(loadedConfig, requestConfig);
		config = mergeConfig(config, {
			startUrls: [targetUrl],
			baseOutputDir: config.baseOutputDir || config.outputDir || "output",
			stateDir: `${config.stateDir || ".traverse-state"}/http/${runId}`,
			logLevel: config.logLevel,
		});
		await loadProxySources(config);
		validateConfig(config, mode);

		const issues: RunIssue[] = [];
		const logger = new Logger(config.logLevel, true);
		const result = await runCore({
			url: targetUrl,
			mode,
			config,
			logger,
			persistOutput: false,
			onEvent(event) {
				if (event.type === "skip") {
					issues.push({
						type: "skip",
						url: event.url,
						reason: event.reason,
					});
				}
				if (event.type === "error") {
					issues.push({
						type: "error",
						url: event.url,
						category: event.category,
						error: event.error,
					});
				}
			},
		});
		await appendHttpRequestLog(
			result.pages.map((page) => ({
				name: page.title || new URL(page.finalUrl).hostname,
				website: page.finalUrl,
			})),
		);

		return jsonResponse({
			ok: result.stats.failed === 0,
			mode,
			url: targetUrl,
			...(result.pages[0]?.finalUrl
				? { finalUrl: result.pages[0].finalUrl }
				: {}),
			stats: {
				scraped: result.stats.scraped,
				failed: result.stats.failed,
				skipped: result.stats.skipped,
				queued: result.queued.length,
			},
			issues: issues.map(formatIssue),
			pages: result.pages.map((page) => toApiScrapedPage(page, mode)),
		} satisfies ApiScrapeResponse);
	} catch (error) {
		return jsonResponse(
			{
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			},
			400,
		);
	}
}

function toApiScrapedPage(
	page: CorePageResult,
	mode: CoreRunMode,
): ApiScrapedPage {
	const tables = page.tables
		.map((table) => ({ markdown: table.markdown }))
		.filter((table) => table.markdown.trim().length > 0);
	const missingTables = tables.filter(
		(table) => !page.markdown.includes(table.markdown),
	);
	return {
		url: page.url,
		finalUrl: page.finalUrl,
		...(page.title ? { title: page.title } : {}),
		...(page.description ? { description: page.description } : {}),
		markdown: page.markdown,
		...(missingTables.length > 0 ? { tables: missingTables } : {}),
		...(mode === "crawl" && page.links.length > 0 ? { links: page.links } : {}),
		depth: page.depth,
		fetch_mode: page.fetch_source,
		scrapedAt: page.scrapedAt,
	};
}

function formatIssue(issue: RunIssue): string {
	if (issue.type === "skip") return `Skipped ${issue.url}: ${issue.reason}`;
	return `Failed ${issue.url}: ${issue.category}: ${issue.error}`;
}

function resolveHttpConfig(
	input: HttpRequestConfig | undefined,
): Partial<AppConfig> {
	const { fetch_source: fetchSource = "fetch", ...config } = input ?? {};
	if (fetchSource !== "fetch" && fetchSource !== "playwright") {
		throw new Error("config.fetch_source must be 'fetch' or 'playwright'");
	}
	return {
		...config,
		renderMode: fetchSource === "playwright" ? "browser" : "fetch",
	};
}

async function appendHttpRequestLog(rows: { name: string; website: string }[]) {
	if (rows.length === 0) return;
	await mkdir(dirname(REQUEST_LOG_PATH), { recursive: true });
	const header = existsSync(REQUEST_LOG_PATH) ? "" : "name,website\n";
	const body = rows
		.map((row) => [row.name, row.website].map(csvCell).join(","))
		.join("\n");
	await writeFile(REQUEST_LOG_PATH, `${header}${body}\n`, { flag: "a" });
}

function csvCell(value: string) {
	return `"${value.replace(/"/g, '""')}"`;
}

async function readJsonBody(request: Request): Promise<ScrapeRequestBody> {
	const contentType = request.headers.get("content-type") ?? "";
	if (!contentType.includes("application/json")) {
		throw new Error("Content-Type must be application/json");
	}
	const body = await request.json();
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		throw new Error("Request body must be a JSON object");
	}
	return body as ScrapeRequestBody;
}

function requireUrl(value: unknown): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error("Field 'url' is required");
	}
	return normalizeInputUrl(value.trim());
}

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body, null, 2), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			...corsHeaders(),
		},
	});
}

function emptyResponse(status: number) {
	return new Response(null, {
		status,
		headers: corsHeaders(),
	});
}

function corsHeaders() {
	return {
		"access-control-allow-origin": "*",
		"access-control-allow-methods": "GET, POST, OPTIONS",
		"access-control-allow-headers": "content-type",
	};
}
