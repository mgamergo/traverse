import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import YAML from "yaml";
import type { AppConfig, Command } from "./types.ts";

export const defaultConfig: AppConfig = {
	startUrls: [],
	crawler: false,
	outputDir: "output",
	baseOutputDir: "output",
	stateDir: ".traverse-state",
	maxPages: 1,
	maxDepth: 1,
	strategy: "bfs",
	scope: "same-domain",
	allowedDomains: [],
	includePatterns: [],
	excludePatterns: [
		"\\.(?:jpg|jpeg|png|gif|webp|svg|ico|pdf|docx?|xlsx?|pptx?|zip|rar|7z|mp4|mp3|mov|avi)(?:\\?|$)",
		"/(?:admin|login|logout|cart|checkout)(?:/|$)",
	],
	removeTrackingParams: [
		"utm_source",
		"utm_medium",
		"utm_campaign",
		"utm_term",
		"utm_content",
		"fbclid",
		"gclid",
		"mc_cid",
		"mc_eid",
	],
	concurrency: 4,
	perDomainConcurrency: 1,
	renderMode: "auto",
	browserEngine: "chromium",
	headless: true,
	blockResources: ["image", "font", "media"],
	wait: { until: "domcontentloaded", timeoutMs: 30_000 },
	infiniteScroll: { enabled: false, stepPx: 900, maxScrolls: 8, waitMs: 600 },
	pagination: { enabled: false, maxPages: 5 },
	forms: [],
	screenshots: false,
	pdf: false,
	rawHtml: false,
	jsonSidecar: true,
	consolidatedOutput: false,
	mirrorUrlStructure: false,
	dryRun: false,
	respectRobotsTxt: true,
	useSitemap: true,
	sitemapOnly: false,
	cleanStart: false,
	checkpointIntervalMs: 2_000,
	requestTimeoutMs: 30_000,
	maxRedirects: 10,
	stopRedirectPatterns: [],
	delay: { minMs: 400, maxMs: 2_500, curve: 2.4 },
	globalRateLimitRps: 2,
	perDomainMinDelayMs: 1_000,
	userAgentRotation: "per-session",
	referrer: "previous",
	proxies: [],
	proxyRotation: "round-robin",
	proxyHealthEndpoint: "https://httpbin.org/ip",
	proxyFailoverRetries: 1,
	captcha: { enabled: false },
	selectors: {},
	xpaths: {},
	downloadImages: false,
	linkMode: "inline",
	imageMode: "keep",
	imageMinArea: 10_000,
	filterLanguages: [],
	redactPii: false,
	minQualityScore: 0,
	logLevel: "info",
	requestCsv: true,
	domains: {},
};

export async function loadConfig(path?: string): Promise<AppConfig> {
	const candidates = [
		path,
		"traverse.config.json",
		"traverse.config.yaml",
		"traverse.config.yml",
	].filter(Boolean) as string[];
	for (const candidate of candidates) {
		if (!existsSync(candidate)) continue;
		const text = await readFile(candidate, "utf8");
		const parsed = candidate.endsWith(".json")
			? JSON.parse(text)
			: YAML.parse(text);
		return mergeConfig(defaultConfig, parsed as Partial<AppConfig>);
	}
	return { ...defaultConfig };
}

export function mergeConfig(
	base: AppConfig,
	overrides: Partial<AppConfig>,
): AppConfig {
	const merged = { ...base, ...overrides };
	merged.delay = { ...base.delay, ...overrides.delay };
	merged.wait = { ...base.wait, ...overrides.wait };
	merged.infiniteScroll = {
		...base.infiniteScroll,
		...overrides.infiniteScroll,
	};
	merged.pagination = { ...base.pagination, ...overrides.pagination };
	merged.captcha = { ...base.captcha, ...overrides.captcha };
	merged.domains = { ...base.domains, ...overrides.domains };
	return merged;
}

export function validateConfig(config: AppConfig, command: Command) {
	if (
		(command === "scrape" || command === "crawl") &&
		config.startUrls.length === 0
	)
		throw new Error("At least one start URL is required for scrape/crawl");
	if (config.maxPages < 1) throw new Error("maxPages must be >= 1");
	if (config.maxDepth < 0) throw new Error("maxDepth must be >= 0");
	if (config.concurrency < 1) throw new Error("concurrency must be >= 1");
	if (config.perDomainConcurrency < 1)
		throw new Error("perDomainConcurrency must be >= 1");
	for (const pattern of [
		...config.includePatterns,
		...config.excludePatterns,
		...config.stopRedirectPatterns,
	])
		new RegExp(pattern);
}

export async function loadProxySources(config: AppConfig) {
	if (config.proxyFile && existsSync(config.proxyFile)) {
		const lines = (await readFile(config.proxyFile, "utf8"))
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean);
		config.proxies.push(...lines);
	}
	if (config.proxyEnv && process.env[config.proxyEnv]) {
		const proxyEnvValue = process.env[config.proxyEnv];
		if (!proxyEnvValue) return;
		config.proxies.push(
			...proxyEnvValue
				.split(",")
				.map((line) => line.trim())
				.filter(Boolean),
		);
	}
	config.proxies = [...new Set(config.proxies)];
}
