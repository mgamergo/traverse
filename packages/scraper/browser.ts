import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
	type Browser,
	type BrowserContext,
	chromium,
	firefox,
	type Page,
	webkit,
} from "playwright";
import type { AppConfig, BrowserProfile, WaitConfig } from "../shared/types.ts";
import { slugForUrl } from "../shared/utils.ts";

export class BrowserPool {
	private browser?: Browser;

	constructor(private config: AppConfig) {}

	async context(
		profile: BrowserProfile,
		proxy?: string,
	): Promise<{ context: BrowserContext; browser: Browser }> {
		if (!this.browser) {
			const launcher =
				this.config.browserEngine === "firefox"
					? firefox
					: this.config.browserEngine === "webkit"
						? webkit
						: chromium;
			this.browser = await launcher.launch({ headless: this.config.headless });
		}
		const viewport = jitterViewport(profile.viewport);
		const context = await this.browser.newContext({
			userAgent: profile.userAgent.replace("HeadlessChrome", "Chrome"),
			viewport,
			locale: profile.languages[0],
			timezoneId: profile.timezoneId,
			colorScheme: "light",
			javaScriptEnabled: true,
			extraHTTPHeaders: {},
			proxy: proxy ? parsePlaywrightProxy(proxy) : undefined,
		});
		await context.addInitScript(stealthScript(profile, viewport));
		return { context, browser: this.browser };
	}

	async close() {
		await this.browser?.close();
		this.browser = undefined;
	}
}

export async function captureDebugAssets(
	config: AppConfig,
	page: Page,
	url: string,
) {
	if (!config.screenshots && !config.pdf) return;
	const dir = join(config.outputDir, "captures", new URL(url).hostname);
	await mkdir(dir, { recursive: true });
	const slug = slugForUrl(url);
	if (config.screenshots)
		await page.screenshot({ path: join(dir, `${slug}.png`), fullPage: true });
	if (
		config.pdf &&
		page.context().browser()?.browserType().name() === "chromium"
	)
		await page.pdf({ path: join(dir, `${slug}.pdf`) });
}

export function mapWaitUntil(
	wait: WaitConfig["until"],
): "domcontentloaded" | "load" | "networkidle" {
	if (wait === "load") return "load";
	if (wait === "networkidle") return "networkidle";
	return "domcontentloaded";
}

export async function applyWait(page: Page, wait: WaitConfig) {
	const timeout = wait.timeoutMs ?? 30_000;
	if (wait.until === "selector" && wait.selector)
		await page.waitForSelector(wait.selector, { state: "visible", timeout });
	if (wait.until === "selector-hidden" && wait.selector)
		await page.waitForSelector(wait.selector, { state: "hidden", timeout });
	if (wait.until === "expression" && wait.expression)
		await page.waitForFunction(wait.expression, undefined, { timeout });
	if (wait.until === "delay" && wait.delayMs)
		await page.waitForTimeout(wait.delayMs);
}

export async function autoScroll(
	page: Page,
	config: AppConfig["infiniteScroll"],
) {
	let previousHeight = 0;
	for (let i = 0; i < config.maxScrolls; i += 1) {
		const height = await page.evaluate(() => document.body.scrollHeight);
		if (height === previousHeight) break;
		previousHeight = height;
		await humanMouseMove(page);
		await page.mouse.wheel(0, config.stepPx + Math.round(Math.random() * 200));
		await page.waitForTimeout(config.waitMs + Math.round(Math.random() * 250));
	}
}

export async function dismissOverlays(page: Page) {
	const selectors = [
		"button:has-text('Accept')",
		"button:has-text('I agree')",
		"button:has-text('Reject')",
		"button:has-text('Close')",
		"[aria-label='close']",
		".modal button.close",
		".newsletter button",
	];
	for (const selector of selectors) {
		try {
			const button = page.locator(selector).first();
			if (await button.isVisible({ timeout: 500 }))
				await button.click({ timeout: 1_000 });
		} catch {
			// Overlay dismissal is opportunistic.
		}
	}
}

export async function runForms(page: Page, forms: AppConfig["forms"]) {
	for (const form of forms) {
		for (const [selector, value] of Object.entries(form.fields ?? {}))
			await page.fill(selector, value);
		if (form.submitSelector) await page.click(form.submitSelector);
		if (form.waitAfterSubmitMs)
			await page.waitForTimeout(form.waitAfterSubmitMs);
	}
}

async function humanMouseMove(page: Page) {
	const start = { x: 40 + Math.random() * 100, y: 40 + Math.random() * 100 };
	const end = { x: 300 + Math.random() * 400, y: 250 + Math.random() * 300 };
	for (let i = 0; i <= 12; i += 1) {
		const t = i / 12;
		const x = start.x + (end.x - start.x) * t + Math.sin(t * Math.PI) * 30;
		const y = start.y + (end.y - start.y) * t + Math.cos(t * Math.PI) * 20;
		await page.mouse.move(x, y);
		await page.waitForTimeout(10 + Math.random() * 30);
	}
}

function stealthScript(
	profile: BrowserProfile,
	viewport: { width: number; height: number },
) {
	return `
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ${JSON.stringify(profile.languages)} });
    Object.defineProperty(navigator, 'platform', { get: () => ${JSON.stringify(profile.platform)} });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => ${profile.deviceMemory} });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => ${profile.hardwareConcurrency} });
    Object.defineProperty(screen, 'colorDepth', { get: () => ${profile.colorDepth} });
    Object.defineProperty(window, 'outerWidth', { get: () => ${viewport.width + 16} });
    Object.defineProperty(window, 'outerHeight', { get: () => ${viewport.height + 88} });
    window.chrome = window.chrome || { runtime: {} };
    const originalQuery = window.navigator.permissions && window.navigator.permissions.query;
    if (originalQuery) {
      window.navigator.permissions.query = (parameters) => (
        parameters && parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(parameters)
      );
    }
    const canvasNoise = Math.random() * 0.000001;
    const originalGetImageData = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function(...args) {
      const data = originalGetImageData.apply(this, args);
      for (let i = 0; i < data.data.length; i += 64) data.data[i] = data.data[i] + canvasNoise;
      return data;
    };
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(parameter) {
      if (parameter === 37445) return ${JSON.stringify(profile.webglVendor)};
      if (parameter === 37446) return ${JSON.stringify(profile.webglRenderer)};
      return getParameter.apply(this, arguments);
    };
    const originalGetChannelData = AudioBuffer.prototype.getChannelData;
    AudioBuffer.prototype.getChannelData = function() {
      const data = originalGetChannelData.apply(this, arguments);
      for (let i = 0; i < data.length; i += 100) data[i] = data[i] + 0.0000001;
      return data;
    };
  `;
}

function parsePlaywrightProxy(proxy: string) {
	const parsed = new URL(proxy);
	return {
		server: `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`,
		username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
		password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
	};
}

function jitterViewport(viewport: { width: number; height: number }) {
	return {
		width: viewport.width + Math.round((Math.random() - 0.5) * 24),
		height: viewport.height + Math.round((Math.random() - 0.5) * 24),
	};
}
