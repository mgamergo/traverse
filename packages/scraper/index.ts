import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as cheerio from "cheerio";
import { browserProfiles } from "../shared/browser-profiles.ts";
import type { Logger } from "../shared/logger.ts";
import type {
	AppConfig,
	BrowserProfile,
	FetchResult,
	RunStats,
} from "../shared/types.ts";
import { humanDelay, pick, redactProxy, sleep } from "../shared/utils.ts";
import {
	applyWait,
	autoScroll,
	BrowserPool,
	captureDebugAssets,
	dismissOverlays,
	mapWaitUntil,
	runForms,
} from "./browser.ts";

export class ProxyManager {
	private index = 0;
	private readonly health = new Map<
		string,
		{ ok: number; fail: number; latencyMs: number; retired: boolean }
	>();
	private readonly sticky = new Map<string, string>();

	constructor(
		private proxies: string[],
		private rotation: AppConfig["proxyRotation"],
	) {
		for (const proxy of proxies)
			this.health.set(proxy, { ok: 0, fail: 0, latencyMs: 0, retired: false });
	}

	get count() {
		return this.proxies.filter((proxy) => !this.health.get(proxy)?.retired)
			.length;
	}

	async testAll(endpoint: string, logger: Logger): Promise<void> {
		for (const proxy of this.proxies) {
			const started = Date.now();
			try {
				const controller = new AbortController();
				const timeout = setTimeout(() => controller.abort(), 10_000);
				const response = await fetch(endpoint, { signal: controller.signal });
				clearTimeout(timeout);
				this.mark(proxy, response.ok, Date.now() - started);
				logger.info("proxy_test", {
					proxy: redactProxy(proxy),
					ok: response.ok,
					status: response.status,
					note: "Bun fetch does not route through arbitrary proxies without a dispatcher; Playwright browser mode uses configured proxies.",
				});
			} catch (error) {
				this.mark(proxy, false, Date.now() - started);
				logger.warn("proxy_test_failed", {
					proxy: redactProxy(proxy),
					error: String(error),
				});
			}
		}
	}

	choose(domain: string, sessionId: string): string | undefined {
		const active = this.proxies.filter(
			(proxy) => !this.health.get(proxy)?.retired,
		);
		if (active.length === 0) return undefined;
		if (this.rotation === "sticky-session")
			return this.memo(`session:${sessionId}`, active);
		if (this.rotation === "per-domain")
			return this.memo(`domain:${domain}`, active);
		if (this.rotation === "random")
			return active[Math.floor(Math.random() * active.length)];
		const proxy = active[this.index % active.length];
		this.index += 1;
		return proxy;
	}

	mark(proxy: string | undefined, ok: boolean, latencyMs = 0) {
		if (!proxy) return;
		const record = this.health.get(proxy) ?? {
			ok: 0,
			fail: 0,
			latencyMs: 0,
			retired: false,
		};
		if (ok) record.ok += 1;
		else record.fail += 1;
		record.latencyMs =
			record.latencyMs === 0
				? latencyMs
				: Math.round((record.latencyMs + latencyMs) / 2);
		const total = record.ok + record.fail;
		if (total >= 5 && record.fail / total > 0.6) record.retired = true;
		this.health.set(proxy, record);
	}

	stats() {
		return Object.fromEntries(
			[...this.health.entries()].map(([proxy, health]) => [
				redactProxy(proxy),
				health,
			]),
		);
	}

	private memo(key: string, active: string[]): string {
		const existing = this.sticky.get(key);
		if (existing && active.includes(existing)) return existing;
		const proxy = active[this.index % active.length];
		if (!proxy) throw new Error("No active proxy available");
		this.index += 1;
		this.sticky.set(key, proxy);
		return proxy;
	}
}

export class RateLimiter {
	private globalNext = 0;
	private readonly domainNext = new Map<string, number>();
	private readonly pausedUntil = new Map<string, number>();
	private readonly adaptive = new Map<string, number>();

	constructor(private config: AppConfig) {}

	async wait(url: string) {
		const domain = new URL(url).hostname;
		const now = Date.now();
		const baseInterval =
			this.config.globalRateLimitRps > 0
				? 1000 / this.config.globalRateLimitRps
				: 0;
		const domainInterval = Math.max(
			this.config.perDomainMinDelayMs,
			this.adaptive.get(domain) ?? 0,
		);
		const target = Math.max(
			this.globalNext,
			this.domainNext.get(domain) ?? 0,
			this.pausedUntil.get(domain) ?? 0,
			now,
		);
		if (target > now) await sleep(target - now);
		const jitter = humanDelay(this.config.delay);
		const next = Date.now() + jitter;
		this.globalNext = Math.max(next, Date.now() + baseInterval);
		this.domainNext.set(domain, Date.now() + domainInterval + jitter);
	}

	pause(url: string, milliseconds: number) {
		this.pausedUntil.set(new URL(url).hostname, Date.now() + milliseconds);
	}

	punish(url: string) {
		const domain = new URL(url).hostname;
		const current =
			this.adaptive.get(domain) ?? this.config.perDomainMinDelayMs;
		this.adaptive.set(domain, Math.min(120_000, Math.max(1_000, current * 2)));
	}

	reward(url: string) {
		const domain = new URL(url).hostname;
		const current = this.adaptive.get(domain);
		if (!current) return;
		this.adaptive.set(
			domain,
			Math.max(this.config.perDomainMinDelayMs, Math.round(current * 0.9)),
		);
	}
}

export class RequestEngine {
	private readonly sessionId = crypto.randomUUID().slice(0, 12);
	private readonly sessionProfile = pick(browserProfiles);
	private readonly browserPool: BrowserPool;

	constructor(
		private config: AppConfig,
		private logger: Logger,
		private proxyManager: ProxyManager,
		private rateLimiter: RateLimiter,
		private stats: RunStats,
	) {
		this.browserPool = new BrowserPool(config);
	}

	async fetch(url: string, referrer?: string): Promise<FetchResult> {
		const profile =
			this.config.userAgentRotation === "per-session"
				? this.sessionProfile
				: pick(browserProfiles);
		const domain = new URL(url).hostname;
		let lastError: unknown;
		for (
			let attempt = 0;
			attempt <= this.config.proxyFailoverRetries;
			attempt += 1
		) {
			const proxy = this.proxyManager.choose(domain, this.sessionId);
			try {
				await this.rateLimiter.wait(url);
				this.logger.info("request_start", {
					url,
					attempt,
					proxy: proxy ? redactProxy(proxy) : undefined,
				});
				const result = await this.fetchOnce(url, profile, referrer, proxy);
				this.proxyManager.mark(proxy, true, result.durationMs);
				this.stats.bytes += result.bytes;
				if (proxy)
					this.stats.proxyUses[redactProxy(proxy)] =
						(this.stats.proxyUses[redactProxy(proxy)] ?? 0) + 1;
				if (result.status === 429 || result.status === 503) {
					this.rateLimiter.punish(result.finalUrl);
					const retryAfter = parseRetryAfter(result.headers["retry-after"]);
					if (retryAfter) this.rateLimiter.pause(result.finalUrl, retryAfter);
				} else {
					this.rateLimiter.reward(result.finalUrl);
				}
				this.logger.info("request_success", {
					url,
					finalUrl: result.finalUrl,
					status: result.status,
					durationMs: result.durationMs,
					browser: result.usedBrowser,
				});
				return result;
			} catch (error) {
				lastError = error;
				this.proxyManager.mark(proxy, false);
				this.logger.warn("request_fail", {
					url,
					attempt,
					error: String(error),
					proxy: proxy ? redactProxy(proxy) : undefined,
				});
			}
		}
		throw lastError;
	}

	async close() {
		await this.browserPool.close();
	}

	private async fetchOnce(
		url: string,
		profile: BrowserProfile,
		referrer: string | undefined,
		proxy: string | undefined,
	): Promise<FetchResult> {
		if (this.config.renderMode === "browser")
			return await this.fetchWithBrowser(url, profile, referrer, proxy);
		const raw = await this.fetchRaw(url, profile, referrer);
		if (this.config.renderMode === "fetch" || !needsBrowser(raw.body))
			return raw;
		return await this.fetchWithBrowser(raw.finalUrl, profile, referrer, proxy);
	}

	private async fetchRaw(
		url: string,
		profile: BrowserProfile,
		referrer: string | undefined,
	): Promise<FetchResult> {
		const redirectChain: string[] = [];
		let current = url;
		const started = Date.now();
		for (
			let redirects = 0;
			redirects <= this.config.maxRedirects;
			redirects += 1
		) {
			const controller = new AbortController();
			const timeout = setTimeout(
				() => controller.abort(),
				this.config.requestTimeoutMs,
			);
			const response = await fetch(current, {
				redirect: "manual",
				signal: controller.signal,
				headers: buildHeaders(profile, resolveReferrer(this.config, referrer)),
			});
			clearTimeout(timeout);
			const location = response.headers.get("location");
			if (location && response.status >= 300 && response.status < 400) {
				const next = new URL(location, current).toString();
				redirectChain.push(next);
				if (
					this.config.stopRedirectPatterns.some((pattern) =>
						new RegExp(pattern).test(next),
					)
				)
					break;
				current = next;
				continue;
			}
			const body = await response.text();
			return {
				url,
				finalUrl: response.url || current,
				status: response.status,
				headers: Object.fromEntries(response.headers.entries()),
				body,
				bytes: new TextEncoder().encode(body).length,
				durationMs: Date.now() - started,
				redirectChain,
				usedBrowser: false,
				profile,
			};
		}
		throw new Error(`Too many redirects for ${url}`);
	}

	private async fetchWithBrowser(
		url: string,
		profile: BrowserProfile,
		referrer: string | undefined,
		proxy: string | undefined,
	): Promise<FetchResult> {
		const started = Date.now();
		const { context } = await this.browserPool.context(profile, proxy);
		const page = await context.newPage();
		const redirectChain: string[] = [];
		page.on("response", (response) => {
			if (response.request().isNavigationRequest() && response.url() !== url)
				redirectChain.push(response.url());
		});
		await page.route("**/*", async (route) => {
			const request = route.request();
			if (this.config.blockResources.includes(request.resourceType())) {
				await route.abort();
				return;
			}
			await route.continue();
		});
		try {
			await page.goto(url, {
				waitUntil: mapWaitUntil(this.config.wait.until),
				timeout: this.config.requestTimeoutMs,
				referer: resolveReferrer(this.config, referrer),
			});
			await dismissOverlays(page);
			await runForms(page, this.config.forms);
			await applyWait(page, this.config.wait);
			if (this.config.infiniteScroll.enabled)
				await autoScroll(page, this.config.infiniteScroll);
			const body = await page.content();
			const finalUrl = page.url();
			await captureDebugAssets(this.config, page, finalUrl);
			return {
				url,
				finalUrl,
				status: 200,
				headers: {},
				body,
				bytes: new TextEncoder().encode(body).length,
				durationMs: Date.now() - started,
				redirectChain,
				usedBrowser: true,
				profile,
				proxy,
			};
		} finally {
			await context.close();
		}
	}
}

export function buildHeaders(
	profile: BrowserProfile,
	referrer?: string,
): Record<string, string> {
	const headers: Record<string, string> = {
		"User-Agent": profile.userAgent,
		Accept:
			"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
		"Accept-Language": `${profile.languages.join(",")};q=0.9`,
		"Accept-Encoding": "gzip, deflate, br",
		"Sec-Fetch-Dest": "document",
		"Sec-Fetch-Mode": "navigate",
		"Sec-Fetch-Site": referrer ? "same-origin" : "none",
		"Sec-Fetch-User": "?1",
		DNT: "1",
		Connection: "keep-alive",
		"Upgrade-Insecure-Requests": "1",
		"sec-ch-ua": profile.secChUa,
		"sec-ch-ua-mobile": profile.secChUaMobile,
		"sec-ch-ua-platform": profile.secChUaPlatform,
	};
	if (referrer) headers.Referer = referrer;
	return headers;
}

export function detectCaptcha(html: string): {
	detected: boolean;
	type?: string;
	siteKey?: string;
} {
	const lower = html.toLowerCase();
	if (lower.includes("g-recaptcha") || lower.includes("recaptcha"))
		return {
			detected: true,
			type: "recaptcha",
			siteKey: html.match(/data-sitekey=["']([^"']+)/)?.[1],
		};
	if (lower.includes("hcaptcha"))
		return {
			detected: true,
			type: "hcaptcha",
			siteKey: html.match(/data-sitekey=["']([^"']+)/)?.[1],
		};
	if (lower.includes("cf-turnstile"))
		return {
			detected: true,
			type: "turnstile",
			siteKey: html.match(/data-sitekey=["']([^"']+)/)?.[1],
		};
	return { detected: false };
}

export async function maybeSolveCaptcha(
	config: AppConfig,
	captcha: { detected: boolean; type?: string; siteKey?: string },
	url: string,
	logger: Logger,
) {
	if (!captcha.detected || !config.captcha.enabled) return;
	if (!config.captcha.apiKey || !config.captcha.provider) {
		logger.warn("captcha_detected_no_solver", { url, type: captcha.type });
		return;
	}
	logger.warn("captcha_solver_required", {
		url,
		type: captcha.type,
		provider: config.captcha.provider,
		siteKey: captcha.siteKey,
		note: "Solver API integration point reached; token injection requires target-specific form continuation.",
	});
}

export function detectCloudflare(html: string): boolean {
	const lower = html.toLowerCase();
	return (
		lower.includes("just a moment") ||
		lower.includes("cf-chl") ||
		(lower.includes("cloudflare") && lower.includes("challenge"))
	);
}

export async function appendRequestCsv(
	config: AppConfig,
	result: FetchResult,
	retryCount: number,
) {
	if (!config.requestCsv) return;
	const file = join(config.outputDir, "requests.csv");
	await mkdir(config.outputDir, { recursive: true });
	const header = existsSync(file)
		? ""
		: "url,timestamp,status_code,response_time_ms,bytes_received,proxy,retry_count\n";
	const line = [
		result.finalUrl,
		new Date().toISOString(),
		result.status,
		result.durationMs,
		result.bytes,
		result.proxy ? redactProxy(result.proxy) : "",
		retryCount,
	]
		.map((value) => `"${String(value).replace(/"/g, '""')}"`)
		.join(",");
	await writeFile(file, `${header}${line}\n`, { flag: "a" });
}

function resolveReferrer(
	config: AppConfig,
	previous?: string,
): string | undefined {
	if (config.referrer === "none" || config.referrer === "direct")
		return undefined;
	if (config.referrer === "google") return "https://www.google.com/";
	return previous;
}

function needsBrowser(html: string): boolean {
	const $ = cheerio.load(html);
	const lower = html.toLowerCase();

	const bodyText = $("body").text().replace(/\s+/g, " ").trim();
	const textLength = bodyText.length;

	const scriptCount = $("script").length;
	const linkCount = $("a").length;

	const hasSpaRoot =
		$("#root").length > 0 ||
		$("#app").length > 0 ||
		$("#__next").length > 0 ||
		$("#__nuxt").length > 0 ||
		$("app-root").length > 0;

	const hasJsWarning =
		lower.includes("please enable javascript") ||
		lower.includes("enable javascript") ||
		lower.includes("requires javascript");

	const hasFrameworkHints =
		lower.includes("__next_data__") ||
		lower.includes("data-reactroot") ||
		lower.includes("vite") ||
		lower.includes("webpack") ||
		lower.includes("chunk.js");

	return (
		hasJsWarning ||
		(hasSpaRoot && textLength < 800) ||
		(textLength < 400 && scriptCount > 5 && linkCount < 10 && hasFrameworkHints)
	);
}

function parseRetryAfter(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds)) return seconds * 1000;
	const date = Date.parse(value);
	return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}
