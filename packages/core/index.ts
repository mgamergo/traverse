import {
	CrawlState,
	categorizeError,
	DomainConcurrencyLimiter,
	enqueueLinks,
	passesUrlFilters,
	RobotsCache,
	seedSitemaps,
	seedState,
} from "../crawler/index.ts";
import { Extractor } from "../extractor/index.ts";
import {
	appendRequestCsv,
	detectCaptcha,
	detectCloudflare,
	maybeSolveCaptcha,
	ProxyManager,
	RateLimiter,
	RequestEngine,
} from "../scraper/index.ts";
import { browserProfiles } from "../shared/browser-profiles.ts";
import { Logger } from "../shared/logger.ts";
import type {
	AppConfig,
	CrawlItem,
	ExtractedPage,
	RunStats,
} from "../shared/types.ts";
import {
	normalizeInputUrl,
	normalizeUrl,
	pick,
	sanitizeFilePart,
} from "../shared/utils.ts";
import { OutputWriter, writeReport } from "./output.ts";

export type CoreRunMode = "scrape" | "crawl";

export interface CorePageResult {
	url: string;
	finalUrl: string;
	title: string;
	description?: string;
	author?: string;
	datePublished?: string;
	language?: string;
	tags: string[];
	wordCount: number;
	links: string[];
	canonicalLinks: string[];
	documentLinks: string[];
	images: ExtractedPage["images"];
	tables: ExtractedPage["tables"];
	structuredData: unknown[];
	openGraph: Record<string, string>;
	twitter: Record<string, string>;
	meta: Record<string, string>;
	custom: Record<string, unknown>;
	pii: ExtractedPage["pii"];
	quality: ExtractedPage["quality"];
	depth: number;
	scrapedAt: string;
	markdown: string;
	output?: string;
	fetch_source: "fetch" | "playwright";
}

export type CoreRunEvent =
	| { type: "start"; mode: CoreRunMode; outputDir: string; url?: string }
	| { type: "progress"; stats: RunStats; queued: number; outputDir: string }
	| {
			type: "page";
			url: string;
			output?: string;
			wordCount: number;
			quality: number;
			page: CorePageResult;
	  }
	| { type: "skip"; url: string; reason: "robots" | "filter" | "quality" }
	| { type: "error"; url: string; category: string; error: string }
	| { type: "done"; stats: RunStats; outputDir: string };

export interface CoreRunInput {
	url?: string;
	mode: CoreRunMode;
	config: AppConfig;
	resume?: boolean;
	logger?: Logger;
	proxyManager?: ProxyManager;
	persistOutput?: boolean;
	onEvent?: (event: CoreRunEvent) => void;
}

export interface CoreRunResult {
	outputDir: string;
	stats: RunStats;
	pages: CorePageResult[];
	queued: CrawlItem[];
}

export async function runCore(input: CoreRunInput): Promise<CoreRunResult> {
	const config = prepareCoreConfig(
		input.config,
		input.mode,
		input.url,
		Boolean(input.resume),
	);
	const logger =
		input.logger ?? new Logger(config.logLevel, config.logLevel === "error");
	const proxyManager =
		input.proxyManager ??
		new ProxyManager(config.proxies, config.proxyRotation);

	if (config.cleanStart) await new CrawlState(config).reset();

	input.onEvent?.({
		type: "start",
		mode: input.mode,
		outputDir: config.outputDir,
		url: input.url,
	});

	const result = await run(
		config,
		logger,
		proxyManager,
		Boolean(input.resume),
		input.persistOutput ?? true,
		input.onEvent,
	);
	input.onEvent?.({
		type: "done",
		stats: result.stats,
		outputDir: result.outputDir,
	});
	return result;
}

export function prepareCoreConfig(
	config: AppConfig,
	mode: CoreRunMode,
	url: string | undefined,
	resume: boolean,
): AppConfig {
	const next = { ...config };
	if (url) next.startUrls = [normalizeInputUrl(url)];
	next.crawler = mode === "crawl";
	if (mode === "scrape") next.maxPages = 1;
	return resolveRunOutputDir(next, resume);
}

async function run(
	config: AppConfig,
	logger: Logger,
	proxyManager: ProxyManager,
	resume: boolean,
	persistOutput: boolean,
	onEvent?: (event: CoreRunEvent) => void,
): Promise<CoreRunResult> {
	const stats: RunStats = {
		startedAt: Date.now(),
		scraped: 0,
		failed: 0,
		skipped: 0,
		queued: 0,
		captcha: 0,
		bytes: 0,
		errors: {},
		outputs: [],
		proxyUses: {},
	};
	const pages: CorePageResult[] = [];
	const state = new CrawlState(config);
	if (resume) {
		const loaded = await state.load();
		if (!loaded) throw new Error("No saved crawl state found");
	} else {
		seedState(state, config);
		if (config.crawler && config.useSitemap)
			await seedSitemaps(state, config, logger);
	}

	const rateLimiter = new RateLimiter(config);
	const engine = new RequestEngine(
		config,
		logger,
		proxyManager,
		rateLimiter,
		stats,
	);
	const robots = new RobotsCache(config, logger);
	const extractor = new Extractor(config);
	const writer = persistOutput ? new OutputWriter(config) : undefined;
	const domainLimiter = new DomainConcurrencyLimiter(
		config.perDomainConcurrency,
	);
	let reserved = 0;

	try {
		const emitProgress = () =>
			onEvent?.({
				type: "progress",
				stats: {
					...stats,
					errors: { ...stats.errors },
					outputs: [...stats.outputs],
				},
				queued: state.queue.length,
				outputDir: config.outputDir,
			});

		const processItem = async (item: CrawlItem) => {
			let url = normalizeUrl(item.url, config);
			reserved += 1;
			try {
				if (state.visited.has(url)) return;
				state.visited.add(url);
				const domainConfig = withDomainOverrides(config, url);
				url = normalizeUrl(url, domainConfig);
				const profile = pick(browserProfiles);
				const robotsDecision = await robots.allowed(url, profile.userAgent);
				if (!robotsDecision.allowed) {
					stats.skipped += 1;
					logger.info("url_skipped_robots", { url });
					onEvent?.({ type: "skip", url, reason: "robots" });
					return;
				}
				if (robotsDecision.crawlDelayMs)
					rateLimiter.pause(url, robotsDecision.crawlDelayMs);
				if (!passesUrlFilters(url, domainConfig)) {
					stats.skipped += 1;
					logger.info("url_skipped_filter", { url });
					onEvent?.({ type: "skip", url, reason: "filter" });
					return;
				}
				if (domainConfig.dryRun) {
					stats.scraped += 1;
					state.scraped += 1;
					return;
				}
				await domainLimiter.acquire(url);
				try {
					const result = await engine.fetch(url, item.referrer);
					if (persistOutput) await appendRequestCsv(config, result, 0);
					const captcha = detectCaptcha(result.body);
					if (captcha.detected) {
						stats.captcha += 1;
						await maybeSolveCaptcha(
							domainConfig,
							captcha,
							result.finalUrl,
							logger,
						);
					}
					if (detectCloudflare(result.body))
						logger.warn("cloudflare_challenge_detected", {
							url: result.finalUrl,
						});
					const page = extractor.extract(result, item.depth);
					if (
						page.quality.score < domainConfig.minQualityScore ||
						(domainConfig.filterLanguages.length > 0 &&
							page.language &&
							!domainConfig.filterLanguages.includes(page.language))
					) {
						stats.skipped += 1;
						onEvent?.({ type: "skip", url: page.finalUrl, reason: "quality" });
						return;
					}
					const markdown = extractor.withFrontMatter(page);
					const output = persistOutput
						? await writer?.writePage(page, markdown, state.order)
						: undefined;
					const pageResult = toCorePageResult(
						page,
						page.markdown,
						output,
						result.usedBrowser ? "playwright" : "fetch",
					);
					pages.push(pageResult);
					if (output) stats.outputs.push(output);
					stats.scraped += 1;
					state.scraped += 1;
					logger.info("page_extracted", {
						url: page.finalUrl,
						output,
						wordCount: page.wordCount,
						quality: page.quality.score,
					});
					onEvent?.({
						type: "page",
						url: page.finalUrl,
						output,
						wordCount: page.wordCount,
						quality: page.quality.score,
						page: pageResult,
					});
					if (
						domainConfig.crawler &&
						item.depth < domainConfig.maxDepth &&
						!domainConfig.sitemapOnly
					) {
						enqueueLinks(state, page, item, domainConfig);
					}
				} finally {
					domainLimiter.release(url);
				}
			} catch (error) {
				stats.failed += 1;
				const category = categorizeError(error);
				stats.errors[category] = (stats.errors[category] ?? 0) + 1;
				logger.error("page_failed", { url, category, error: String(error) });
				onEvent?.({ type: "error", url, category, error: String(error) });
			} finally {
				state.order += 1;
				reserved -= 1;
				stats.queued = state.queue.length;
				await state.flush();
				emitProgress();
			}
		};

		const worker = async () => {
			while (state.scraped + reserved < config.maxPages) {
				const item = state.next(config.strategy);
				if (!item) break;
				await processItem(item);
			}
		};

		emitProgress();
		await Promise.all(
			Array.from({ length: config.concurrency }, () => worker()),
		);
	} finally {
		await state.flush(true);
		await writer?.finish();
		if (persistOutput) await writeReport(config, stats, proxyManager);
		await engine.close();
	}

	return {
		outputDir: config.outputDir,
		stats,
		pages,
		queued: [...state.queue],
	};
}

function toCorePageResult(
	page: ExtractedPage,
	markdown: string,
	output: string | undefined,
	fetchSource: CorePageResult["fetch_source"],
): CorePageResult {
	return {
		url: page.url,
		finalUrl: page.finalUrl,
		title: page.title,
		description: page.description,
		author: page.author,
		datePublished: page.datePublished,
		language: page.language,
		tags: page.tags,
		wordCount: page.wordCount,
		links: page.links,
		canonicalLinks: page.canonicalLinks,
		documentLinks: page.documentLinks,
		images: page.images,
		tables: page.tables,
		structuredData: page.structuredData,
		openGraph: page.openGraph,
		twitter: page.twitter,
		meta: page.meta,
		custom: page.custom,
		pii: page.pii,
		quality: page.quality,
		depth: page.depth,
		scrapedAt: page.scrapedAt,
		markdown,
		output,
		fetch_source: fetchSource,
	};
}

function withDomainOverrides(config: AppConfig, url: string): AppConfig {
	const override = config.domains[new URL(url).hostname];
	if (!override) return config;
	return {
		...config,
		...override,
		delay: { ...config.delay, ...override.delay },
		wait: { ...config.wait, ...override.wait },
		infiniteScroll: { ...config.infiniteScroll, ...override.infiniteScroll },
		pagination: { ...config.pagination, ...override.pagination },
		captcha: { ...config.captcha, ...override.captcha },
		domains: { ...config.domains, ...override.domains },
	};
}

function resolveRunOutputDir(config: AppConfig, resume: boolean): AppConfig {
	const baseOutputDir = config.baseOutputDir || config.outputDir;
	if (resume) return { ...config, baseOutputDir };
	const seedUrl = config.startUrls[0];
	const siteName = seedUrl
		? sanitizeFilePart(new URL(normalizeInputUrl(seedUrl)).hostname)
		: "run";
	const timestamp = new Date()
		.toISOString()
		.replace(/\.\d{3}Z$/, "Z")
		.replace(/[:.]/g, "-");
	return {
		...config,
		baseOutputDir,
		outputDir: `${baseOutputDir}/${siteName}/${timestamp}`,
		stateDir: `${config.stateDir}/${siteName}`,
	};
}
