import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import * as cheerio from "cheerio";
import type { Logger } from "../shared/logger.ts";
import type {
	AppConfig,
	CrawlItem,
	ExtractedPage,
	PersistedState,
} from "../shared/types.ts";
import { normalizeInputUrl, normalizeUrl, sleep } from "../shared/utils.ts";

export class DomainConcurrencyLimiter {
	private readonly active = new Map<string, number>();

	constructor(private perDomainLimit: number) {}

	async acquire(url: string) {
		const domain = new URL(url).hostname;
		while ((this.active.get(domain) ?? 0) >= this.perDomainLimit)
			await sleep(50);
		this.active.set(domain, (this.active.get(domain) ?? 0) + 1);
	}

	release(url: string) {
		const domain = new URL(url).hostname;
		const next = Math.max(0, (this.active.get(domain) ?? 1) - 1);
		if (next === 0) this.active.delete(domain);
		else this.active.set(domain, next);
	}
}

export class CrawlState {
	queue: CrawlItem[] = [];
	visited = new Set<string>();
	scraped = 0;
	order = 0;
	private stateFile: string;
	private lastFlush = 0;

	constructor(private config: AppConfig) {
		this.stateFile = join(config.stateDir, "crawl-state.json");
	}

	async load() {
		if (!existsSync(this.stateFile)) return false;
		const parsed = JSON.parse(
			await readFile(this.stateFile, "utf8"),
		) as PersistedState;
		this.queue = parsed.queue;
		this.visited = new Set(parsed.visited);
		this.scraped = parsed.scraped;
		this.order = parsed.order;
		return true;
	}

	async reset() {
		await rm(this.config.stateDir, { recursive: true, force: true });
	}

	async flush(force = false) {
		if (
			!force &&
			Date.now() - this.lastFlush < this.config.checkpointIntervalMs
		)
			return;
		await mkdir(this.config.stateDir, { recursive: true });
		const state: PersistedState = {
			queue: this.queue,
			visited: [...this.visited],
			scraped: this.scraped,
			order: this.order,
		};
		await writeFile(this.stateFile, JSON.stringify(state, null, 2), "utf8");
		this.lastFlush = Date.now();
	}

	next(strategy: AppConfig["strategy"]): CrawlItem | undefined {
		if (strategy === "dfs") return this.queue.pop();
		return this.queue.shift();
	}

	push(item: CrawlItem) {
		this.queue.push(item);
		this.queue.sort((a, b) => b.score - a.score || a.order - b.order);
	}
}

export class RobotsCache {
	private readonly cache = new Map<string, RobotsRules>();

	constructor(
		private config: AppConfig,
		private logger: Logger,
	) {}

	async allowed(
		url: string,
		userAgent: string,
	): Promise<{ allowed: boolean; crawlDelayMs?: number }> {
		if (!this.config.respectRobotsTxt) return { allowed: true };
		const parsed = new URL(url);
		let rules = this.cache.get(parsed.origin);
		if (!rules) {
			rules = await this.fetchRules(parsed.origin);
			this.cache.set(parsed.origin, rules);
		}
		const path = `${parsed.pathname}${parsed.search}`;
		const matching = [
			...(rules.groups.get("*") ?? []),
			...(rules.groups.get(userAgent.toLowerCase()) ?? []),
		];
		let allowed = true;
		let longest = -1;
		for (const rule of matching) {
			if (path.startsWith(rule.path) && rule.path.length > longest) {
				longest = rule.path.length;
				allowed = rule.allow;
			}
		}
		return { allowed, crawlDelayMs: rules.crawlDelayMs };
	}

	private async fetchRules(origin: string): Promise<RobotsRules> {
		try {
			const response = await fetch(`${origin}/robots.txt`);
			if (!response.ok) return { groups: new Map(), crawlDelayMs: undefined };
			return parseRobotsTxt(await response.text());
		} catch (error) {
			this.logger.debug("robots_fetch_failed", {
				origin,
				error: String(error),
			});
			return { groups: new Map(), crawlDelayMs: undefined };
		}
	}
}

interface RobotsRules {
	groups: Map<string, { allow: boolean; path: string }[]>;
	crawlDelayMs?: number;
}

export function seedState(state: CrawlState, config: AppConfig) {
	let order = 0;
	for (const url of config.startUrls) {
		state.push({ url: normalizeInputUrl(url), depth: 0, score: 100, order });
		order += 1;
	}
}

export async function seedSitemaps(
	state: CrawlState,
	config: AppConfig,
	logger: Logger,
) {
	const seedUrl = config.startUrls[0];
	if (!seedUrl) return;
	for (const url of config.startUrls) {
		const origin = new URL(normalizeInputUrl(url)).origin;
		for (const path of ["/sitemap.xml", "/sitemap_index.xml"]) {
			try {
				const urls = await fetchSitemap(`${origin}${path}`, logger);
				for (const sitemapUrl of urls) {
					if (passesScope(sitemapUrl, seedUrl, config))
						state.push({
							url: normalizeUrl(sitemapUrl, config),
							depth: 0,
							score: 80,
							order: state.order++,
						});
				}
			} catch (error) {
				logger.debug("sitemap_fetch_failed", {
					url: `${origin}${path}`,
					error: String(error),
				});
			}
		}
	}
}

export function enqueueLinks(
	state: CrawlState,
	page: ExtractedPage,
	source: CrawlItem,
	config: AppConfig,
) {
	const seedUrl = config.startUrls[0];
	if (!seedUrl) return;
	for (const link of [...page.links, ...page.canonicalLinks]) {
		const normalized = normalizeUrl(link, config);
		if (state.visited.has(normalized)) continue;
		if (!passesScope(normalized, seedUrl, config)) continue;
		if (!passesUrlFilters(normalized, config)) continue;
		state.push({
			url: normalized,
			depth: source.depth + 1,
			referrer: page.finalUrl,
			score: scoreUrl(normalized, source.url, config),
			order: state.order++,
		});
	}
}

export function passesScope(
	candidate: string,
	seed: string,
	config: AppConfig,
): boolean {
	if (config.scope === "unrestricted") return true;
	const target = new URL(candidate);
	const root = new URL(normalizeInputUrl(seed));
	if (config.scope === "same-origin") return target.origin === root.origin;
	if (config.scope === "same-domain") return target.hostname === root.hostname;
	if (config.scope === "include-subdomains")
		return (
			target.hostname === root.hostname ||
			target.hostname.endsWith(`.${root.hostname}`)
		);
	return config.allowedDomains.includes(target.hostname);
}

export function passesUrlFilters(url: string, config: AppConfig): boolean {
	if (
		config.includePatterns.length > 0 &&
		!config.includePatterns.some((pattern) => new RegExp(pattern).test(url))
	)
		return false;
	return !config.excludePatterns.some((pattern) =>
		new RegExp(pattern).test(url),
	);
}

export function categorizeError(error: unknown): string {
	const text = String(error).toLowerCase();
	if (text.includes("timeout")) return "navigation_timeout";
	if (text.includes("captcha")) return "captcha_block";
	if (text.includes("proxy")) return "proxy_failure";
	if (text.includes("parse")) return "parse_error";
	if (text.includes("http")) return "http_error";
	return "unknown";
}

async function fetchSitemap(
	url: string,
	logger: Logger,
	seen = new Set<string>(),
): Promise<string[]> {
	if (seen.has(url) || seen.size > 20) return [];
	seen.add(url);
	const response = await fetch(url);
	if (!response.ok) return [];
	const buffer = Buffer.from(await response.arrayBuffer());
	const text = url.endsWith(".gz")
		? gunzipSync(buffer).toString("utf8")
		: buffer.toString("utf8");
	const $ = cheerio.load(text, { xmlMode: true });
	const urls: string[] = [];
	$("url > loc").each((_, loc) => {
		urls.push($(loc).text().trim());
	});
	const nested: string[] = [];
	$("sitemap > loc").each((_, loc) => {
		nested.push($(loc).text().trim());
	});
	for (const sitemap of nested)
		urls.push(...(await fetchSitemap(sitemap, logger, seen)));
	logger.info("sitemap_loaded", { url, count: urls.length });
	return urls;
}

function scoreUrl(
	candidate: string,
	source: string,
	config: AppConfig,
): number {
	const candidateUrl = new URL(candidate);
	const sourceUrl = new URL(source);
	let score = candidateUrl.hostname === sourceUrl.hostname ? 100 : 20;
	if (
		config.includePatterns.some((pattern) =>
			new RegExp(pattern).test(candidate),
		)
	)
		score += 50;
	score -= candidateUrl.pathname.split("/").filter(Boolean).length * 2;
	return score;
}

function parseRobotsTxt(text: string): RobotsRules {
	const groups = new Map<string, { allow: boolean; path: string }[]>();
	let currentAgents: string[] = [];
	let crawlDelayMs: number | undefined;
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.replace(/#.*/, "").trim();
		if (!line.includes(":")) continue;
		const [rawKey, ...rest] = line.split(":");
		const key = rawKey?.trim().toLowerCase();
		if (!key) continue;
		const value = rest.join(":").trim();
		if (key === "user-agent") {
			currentAgents = [value.toLowerCase()];
			for (const agent of currentAgents)
				if (!groups.has(agent)) groups.set(agent, []);
		} else if (
			(key === "allow" || key === "disallow") &&
			currentAgents.length > 0
		) {
			for (const agent of currentAgents)
				groups.get(agent)?.push({ allow: key === "allow", path: value || "/" });
		} else if (key === "crawl-delay") {
			const seconds = Number(value);
			if (Number.isFinite(seconds)) crawlDelayMs = seconds * 1000;
		}
	}
	return { groups, crawlDelayMs };
}
