export type Command =
	| "scrape"
	| "crawl"
	| "resume"
	| "validate-config"
	| "test-proxy";
export type BrowserEngine = "chromium" | "firefox" | "webkit";
export type RenderMode = "auto" | "fetch" | "browser";
export type CrawlScope =
	| "same-domain"
	| "same-origin"
	| "include-subdomains"
	| "whitelist"
	| "unrestricted";
export type CrawlStrategy = "bfs" | "dfs";
export type ProxyRotation =
	| "round-robin"
	| "random"
	| "sticky-session"
	| "per-domain";
export type LogLevel = "debug" | "info" | "warn" | "error";
export type LinkMode = "inline" | "reference" | "strip";
export type ImageMode = "keep" | "strip" | "threshold";

export interface BrowserProfile {
	name: string;
	userAgent: string;
	platform: string;
	languages: string[];
	viewport: { width: number; height: number };
	deviceMemory: number;
	hardwareConcurrency: number;
	colorDepth: number;
	timezoneId: string;
	webglVendor: string;
	webglRenderer: string;
	secChUa: string;
	secChUaMobile: string;
	secChUaPlatform: string;
}

export interface SelectorRule {
	selector: string;
	type?: "text" | "html" | "attribute";
	attribute?: string;
	multiple?: boolean;
}

export interface XPathRule {
	xpath: string;
	type?: "text" | "html" | "attribute";
	attribute?: string;
	multiple?: boolean;
}

export interface WaitConfig {
	until:
		| "domcontentloaded"
		| "load"
		| "networkidle"
		| "selector"
		| "selector-hidden"
		| "expression"
		| "delay";
	selector?: string;
	expression?: string;
	delayMs?: number;
	timeoutMs?: number;
}

export interface FormAction {
	fields?: Record<string, string>;
	submitSelector?: string;
	waitAfterSubmitMs?: number;
}

export interface CaptchaConfig {
	provider?: "2captcha" | "capsolver" | "anti-captcha";
	apiKey?: string;
	enabled: boolean;
}

export interface AppConfig {
	startUrls: string[];
	crawler: boolean;
	outputDir: string;
	baseOutputDir: string;
	stateDir: string;
	maxPages: number;
	maxDepth: number;
	strategy: CrawlStrategy;
	scope: CrawlScope;
	allowedDomains: string[];
	includePatterns: string[];
	excludePatterns: string[];
	removeTrackingParams: string[];
	concurrency: number;
	perDomainConcurrency: number;
	renderMode: RenderMode;
	browserEngine: BrowserEngine;
	headless: boolean;
	blockResources: string[];
	wait: WaitConfig;
	infiniteScroll: {
		enabled: boolean;
		stepPx: number;
		maxScrolls: number;
		waitMs: number;
	};
	pagination: {
		enabled: boolean;
		nextSelector?: string;
		maxPages: number;
		urlPattern?: string;
	};
	forms: FormAction[];
	screenshots: boolean;
	pdf: boolean;
	rawHtml: boolean;
	jsonSidecar: boolean;
	consolidatedOutput: boolean;
	mirrorUrlStructure: boolean;
	dryRun: boolean;
	respectRobotsTxt: boolean;
	useSitemap: boolean;
	sitemapOnly: boolean;
	cleanStart: boolean;
	checkpointIntervalMs: number;
	requestTimeoutMs: number;
	maxRedirects: number;
	stopRedirectPatterns: string[];
	delay: { minMs: number; maxMs: number; curve: number };
	globalRateLimitRps: number;
	perDomainMinDelayMs: number;
	userAgentRotation: "per-request" | "per-session";
	referrer: "none" | "google" | "direct" | "previous";
	proxies: string[];
	proxyFile?: string;
	proxyEnv?: string;
	proxyRotation: ProxyRotation;
	proxyHealthEndpoint: string;
	proxyGeo?: string;
	proxyFailoverRetries: number;
	captcha: CaptchaConfig;
	selectors: Record<string, SelectorRule>;
	xpaths: Record<string, XPathRule>;
	downloadImages: boolean;
	linkMode: LinkMode;
	imageMode: ImageMode;
	imageMinArea: number;
	filterLanguages: string[];
	redactPii: boolean;
	minQualityScore: number;
	logLevel: LogLevel;
	requestCsv: boolean;
	domains: Record<string, Partial<AppConfig>>;
}

export interface CliOptions {
	command: Command;
	targetUrl?: string;
	configPath?: string;
	overrides: Partial<AppConfig>;
	verbose: boolean;
	quiet: boolean;
}

export interface FetchResult {
	url: string;
	finalUrl: string;
	status: number;
	headers: Record<string, string>;
	body: string;
	bytes: number;
	durationMs: number;
	redirectChain: string[];
	usedBrowser: boolean;
	profile: BrowserProfile;
	proxy?: string;
}

export interface CrawlItem {
	url: string;
	depth: number;
	referrer?: string;
	score: number;
	order: number;
}

export interface QualityScore {
	score: number;
	wordCount: number;
	textToHtmlRatio: number;
	structuredDataCount: number;
	imageCount: number;
	linkDensity: number;
}

export interface ExtractedPage {
	url: string;
	finalUrl: string;
	title: string;
	description?: string;
	author?: string;
	datePublished?: string;
	language?: string;
	tags: string[];
	mainHtml: string;
	markdown: string;
	text: string;
	wordCount: number;
	links: string[];
	canonicalLinks: string[];
	documentLinks: string[];
	images: { url: string; alt?: string; width?: number; height?: number }[];
	tables: { headers: string[]; rows: string[][]; markdown: string }[];
	structuredData: unknown[];
	openGraph: Record<string, string>;
	twitter: Record<string, string>;
	meta: Record<string, string>;
	custom: Record<string, unknown>;
	pii: { emails: string[]; phones: string[]; creditCards: string[] };
	quality: QualityScore;
	depth: number;
	scrapedAt: string;
}

export interface RunStats {
	startedAt: number;
	scraped: number;
	failed: number;
	skipped: number;
	queued: number;
	captcha: number;
	bytes: number;
	errors: Record<string, number>;
	outputs: string[];
	proxyUses: Record<string, number>;
}

export interface PersistedState {
	queue: CrawlItem[];
	visited: string[];
	scraped: number;
	order: number;
}
