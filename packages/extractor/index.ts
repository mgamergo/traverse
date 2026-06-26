import { Readability } from "@mozilla/readability";
import * as cheerio from "cheerio";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import type {
	AppConfig,
	ExtractedPage,
	FetchResult,
	QualityScore,
	SelectorRule,
	XPathRule,
} from "../shared/types.ts";
import {
	cleanText,
	countWords,
	decodeEntities,
	dedupeBlocks,
	luhnMaybe,
	toYaml,
} from "../shared/utils.ts";

export class Extractor {
	private readonly turndown = new TurndownService({
		headingStyle: "atx",
		bulletListMarker: "-",
		codeBlockStyle: "fenced",
		emDelimiter: "_",
		strongDelimiter: "**",
		linkStyle: "inlined",
	});

	constructor(private config: AppConfig) {
		this.installTurndownRules();
	}

	extract(fetchResult: FetchResult, depth: number): ExtractedPage {
		const html = absolutizeHtml(fetchResult.body, fetchResult.finalUrl);
		const $ = cheerio.load(html);
		const title = cleanText(
			$("title").first().text() ||
				$("h1").first().text() ||
				fetchResult.finalUrl,
		);
		const meta = extractMeta($);
		const openGraph = extractPrefixedMeta($, "og:");
		const twitter = extractPrefixedMeta($, "twitter:");
		const structuredData = extractJsonLd($);
		const readabilityHtml = runReadability(html, fetchResult.finalUrl);
		const mainHtml = cleanBoilerplate(
			readabilityHtml || selectMainHtml($),
			fetchResult.finalUrl,
		);
		const content = cheerio.load(mainHtml);
		const tables = extractTables(content);
		const images = extractImages($, fetchResult.finalUrl);
		const links = extractLinks($, fetchResult.finalUrl);
		const canonicalLinks = extractSemanticLinks($, fetchResult.finalUrl);
		const documentLinks = links.filter(isDocumentUrl);
		const custom = {
			...extractSelectors($, this.config.selectors),
			...extractXpaths(html, this.config.xpaths),
		};
		let markdown = this.toMarkdown(mainHtml);
		const faqMarkdown = faqPageToMarkdown(structuredData);
		if (faqMarkdown && !markdown.includes(faqMarkdown.questions[0] ?? "")) {
			markdown = `${markdown.trim()}\n\n${faqMarkdown.markdown}`;
		}
		markdown = normalizeMarkdown(markdown, this.config);
		let text = dedupeBlocks(cleanText(content.text()));
		if (faqMarkdown) text = dedupeBlocks(`${text}\n\n${faqMarkdown.text}`);
		const pii = detectPii(text);
		if (this.config.redactPii) {
			text = redactPii(text);
			markdown = redactPii(markdown);
		}
		const language = detectLanguage(
			text,
			meta.language ?? $("html").attr("lang"),
		);
		const wordCount = countWords(text);
		const quality = qualityScore({
			text,
			html: fetchResult.body,
			structuredData,
			images,
			links,
		});
		return {
			url: fetchResult.url,
			finalUrl: fetchResult.finalUrl,
			title,
			description:
				meta.description ?? openGraph.description ?? twitter.description,
			author: meta.author,
			datePublished: findPublishedDate(meta, structuredData),
			language,
			tags: tagsFrom(meta, structuredData),
			mainHtml,
			markdown,
			text,
			wordCount,
			links,
			canonicalLinks,
			documentLinks,
			images,
			tables,
			structuredData,
			openGraph,
			twitter,
			meta,
			custom,
			pii,
			quality,
			depth,
			scrapedAt: new Date().toISOString(),
		};
	}

	withFrontMatter(page: ExtractedPage): string {
		const frontMatter = {
			url: page.finalUrl,
			title: page.title,
			description: page.description ?? "",
			author: page.author ?? "",
			date_published: page.datePublished ?? "",
			date_scraped: page.scrapedAt,
			language: page.language ?? "",
			word_count: page.wordCount,
			scrape_depth: page.depth,
			tags: page.tags,
			...page.custom,
		};
		return `${`---\n${toYaml(frontMatter)}---\n\n${page.markdown}`.trim()}\n`;
	}

	private toMarkdown(html: string): string {
		const withoutLinks =
			this.config.linkMode === "strip" ? stripLinks(html) : html;
		const withoutImages =
			this.config.imageMode === "strip"
				? stripImages(withoutLinks)
				: withoutLinks;
		return this.turndown.turndown(withoutImages);
	}

	private installTurndownRules() {
		this.turndown.addRule("fencedCodeWithLanguage", {
			filter: (node) =>
				node.nodeName === "PRE" && node.firstChild?.nodeName === "CODE",
			replacement: (_content, node) => {
				const code = node.firstChild as HTMLElement;
				const className = code.getAttribute("class") ?? "";
				const lang =
					className.match(/language-([\w-]+)/)?.[1] ??
					className.match(/lang-([\w-]+)/)?.[1] ??
					"";
				return `\n\n\`\`\`${lang}\n${code.textContent ?? ""}\n\`\`\`\n\n`;
			},
		});
		this.turndown.addRule("tables", {
			filter: "table",
			replacement: (_content, node) =>
				tableNodeToMarkdown(node as HTMLTableElement),
		});
	}
}

function runReadability(html: string, url: string): string | undefined {
	try {
		const dom = new JSDOM(html, { url });
		const article = new Readability(dom.window.document).parse();
		return article?.content ?? undefined;
	} catch {
		return undefined;
	}
}

function selectMainHtml($: cheerio.CheerioAPI): string {
	$("script, style, noscript, iframe, svg, canvas").remove();
	$("nav, footer, header, aside, form").remove();
	$(
		".cookie, .cookies, .banner, .modal, .popup, .ad, .ads, .advertisement, .newsletter, .social-share, .comments",
	).remove();
	const candidates = [
		"main",
		"article",
		"[role='main']",
		".content",
		".post",
		".article",
		"body",
	];
	let bestHtml = $("body").html() ?? $.html();
	let bestScore = 0;
	for (const selector of candidates) {
		$(selector).each((_, element) => {
			const node = $(element);
			const score = countWords(node.text()) - node.find("a").length * 2;
			if (score > bestScore) {
				bestHtml = node.html() ?? bestHtml;
				bestScore = score;
			}
		});
	}
	return bestHtml;
}

function cleanBoilerplate(html: string, baseUrl: string): string {
	const $ = cheerio.load(html);
	$("script, style, noscript, iframe, svg, canvas").remove();
	$("button, input, select, textarea").remove();
	$(
		".cookie, .cookies, .banner, .modal, .popup, .ad, .ads, .advertisement, .newsletter, .subscribe, .share, .comments, .powered-by",
	).remove();
	$("a, img").each((_, element) => {
		const node = $(element);
		const attr = node.is("a") ? "href" : "src";
		const value = node.attr(attr);
		if (value) node.attr(attr, new URL(value, baseUrl).toString());
	});
	return $("body").html() || $.html();
}

function extractMeta($: cheerio.CheerioAPI): Record<string, string> {
	const meta: Record<string, string> = {};
	$("meta").each((_, element) => {
		const node = $(element);
		const key =
			node.attr("name") ?? node.attr("property") ?? node.attr("itemprop");
		const value = node.attr("content");
		if (key && value) meta[key.toLowerCase()] = cleanText(value);
	});
	const canonical = $("link[rel='canonical']").attr("href");
	if (canonical) meta.canonical = canonical;
	const lang = $("html").attr("lang");
	const language = lang?.split("-")[0];
	if (language) meta.language = language;
	return meta;
}

function extractPrefixedMeta(
	$: cheerio.CheerioAPI,
	prefix: string,
): Record<string, string> {
	const result: Record<string, string> = {};
	$(`meta[property^='${prefix}'], meta[name^='${prefix}']`).each(
		(_, element) => {
			const node = $(element);
			const key = (node.attr("property") ?? node.attr("name") ?? "").replace(
				prefix,
				"",
			);
			const value = node.attr("content");
			if (key && value) result[key] = cleanText(value);
		},
	);
	return result;
}

function extractJsonLd($: cheerio.CheerioAPI): unknown[] {
	const values: unknown[] = [];
	$("script[type='application/ld+json']").each((_, element) => {
		const raw = $(element).text().trim();
		if (!raw) return;
		try {
			values.push(JSON.parse(raw));
		} catch {
			const cleaned = raw.replace(/,\s*}/g, "}").replace(/,\s*]/g, "]");
			try {
				values.push(JSON.parse(cleaned));
			} catch {
				// Malformed JSON-LD stays out of structured output.
			}
		}
	});
	return values;
}

function faqPageToMarkdown(
	structuredData: unknown[],
): { markdown: string; text: string; questions: string[] } | undefined {
	const items = structuredData.flatMap(findFaqItems);
	const blocks = items
		.map((item) => {
			const question = cleanText(String(item.name ?? ""));
			const answer = answerText(item.acceptedAnswer);
			if (!question || !answer) return undefined;
			return { question, answer };
		})
		.filter((item): item is { question: string; answer: string } =>
			Boolean(item),
		);
	if (blocks.length === 0) return undefined;
	return {
		markdown: [
			"## Frequently Asked Questions",
			...blocks.flatMap(({ question, answer }) => [`### ${question}`, answer]),
		].join("\n\n"),
		text: blocks
			.flatMap(({ question, answer }) => [question, answer])
			.join("\n\n"),
		questions: blocks.map((block) => block.question),
	};
}

function findFaqItems(value: unknown): Record<string, unknown>[] {
	if (!value || typeof value !== "object") return [];
	if (Array.isArray(value)) return value.flatMap(findFaqItems);
	const record = value as Record<string, unknown>;
	const type = record["@type"];
	const types = Array.isArray(type) ? type : [type];
	if (types.includes("FAQPage")) {
		const mainEntity = record.mainEntity;
		if (Array.isArray(mainEntity))
			return mainEntity.filter(
				(item): item is Record<string, unknown> =>
					Boolean(item) && typeof item === "object" && !Array.isArray(item),
			);
		if (
			mainEntity &&
			typeof mainEntity === "object" &&
			!Array.isArray(mainEntity)
		)
			return [mainEntity as Record<string, unknown>];
	}
	return Object.values(record).flatMap(findFaqItems);
}

function answerText(value: unknown): string {
	if (!value) return "";
	if (Array.isArray(value))
		return value.map(answerText).filter(Boolean).join("\n\n");
	if (typeof value === "string") return htmlishToText(value);
	if (typeof value !== "object") return "";
	const record = value as Record<string, unknown>;
	const text = record.text ?? record.name;
	return typeof text === "string" ? htmlishToText(text) : answerText(text);
}

function htmlishToText(value: string): string {
	return cleanText(cheerio.load(`<div>${value}</div>`)("div").text() || value);
}

function extractLinks($: cheerio.CheerioAPI, baseUrl: string): string[] {
	const links = new Set<string>();
	$("a[href]").each((_, element) => {
		const href = $(element).attr("href");
		if (
			!href ||
			href.startsWith("mailto:") ||
			href.startsWith("tel:") ||
			href.startsWith("javascript:")
		)
			return;
		links.add(new URL(href, baseUrl).toString());
	});
	return [...links];
}

function extractSemanticLinks(
	$: cheerio.CheerioAPI,
	baseUrl: string,
): string[] {
	const links = new Set<string>();
	$(
		"link[rel='canonical'], link[rel='next'], link[rel='prev'], meta[property='og:url']",
	).each((_, element) => {
		const value = $(element).attr("href") ?? $(element).attr("content");
		if (value) links.add(new URL(value, baseUrl).toString());
	});
	for (const item of extractJsonLd($)) collectJsonUrls(item, links, baseUrl);
	return [...links];
}

function collectJsonUrls(value: unknown, links: Set<string>, baseUrl: string) {
	if (!value || typeof value !== "object") return;
	if (Array.isArray(value)) {
		for (const item of value) collectJsonUrls(item, links, baseUrl);
		return;
	}
	const record = value as Record<string, unknown>;
	if (typeof record.url === "string")
		links.add(new URL(record.url, baseUrl).toString());
	for (const nested of Object.values(record))
		collectJsonUrls(nested, links, baseUrl);
}

function extractImages($: cheerio.CheerioAPI, baseUrl: string) {
	const images = new Map<
		string,
		{ url: string; alt?: string; width?: number; height?: number }
	>();
	$("img[src], source[srcset], img[srcset]").each((_, element) => {
		const node = $(element);
		const raw =
			node.attr("src") ??
			node.attr("srcset")?.split(",")[0]?.trim().split(/\s+/)[0];
		if (!raw) return;
		const url = new URL(raw, baseUrl).toString();
		images.set(url, {
			url,
			alt: node.attr("alt"),
			width: numberAttr(node.attr("width")),
			height: numberAttr(node.attr("height")),
		});
	});
	$("[style*='background']").each((_, element) => {
		const style = $(element).attr("style") ?? "";
		const match = style.match(/url\(['"]?([^'")]+)['"]?\)/);
		if (match?.[1]) {
			const url = new URL(match[1], baseUrl).toString();
			images.set(url, { url });
		}
	});
	$("meta[property='og:image']").each((_, element) => {
		const value = $(element).attr("content");
		if (value) {
			const url = new URL(value, baseUrl).toString();
			images.set(url, { url });
		}
	});
	return [...images.values()];
}

function extractTables($: cheerio.CheerioAPI) {
	const tables: { headers: string[]; rows: string[][]; markdown: string }[] =
		[];
	$("table").each((_, table) => {
		const headers: string[] = [];
		$(table)
			.find("thead th, tr:first-child th")
			.each((_, th) => {
				headers.push(cleanText($(th).text()));
			});
		const rows: string[][] = [];
		$(table)
			.find("tbody tr, tr")
			.each((index, tr) => {
				if (index === 0 && headers.length > 0 && $(tr).find("th").length > 0)
					return;
				const cells: string[] = [];
				$(tr)
					.find("td, th")
					.each((_, cell) => {
						cells.push(cleanText($(cell).text()));
					});
				if (cells.length > 0) rows.push(cells);
			});
		tables.push({
			headers,
			rows,
			markdown: tableDataToMarkdown(headers, rows),
		});
	});
	return tables;
}

function extractSelectors(
	$: cheerio.CheerioAPI,
	rules: Record<string, SelectorRule>,
): Record<string, unknown> {
	const output: Record<string, unknown> = {};
	for (const [name, rule] of Object.entries(rules)) {
		const values: string[] = [];
		$(rule.selector).each((_, element) => {
			const node = $(element);
			if (rule.type === "html") values.push(node.html() ?? "");
			else if (rule.type === "attribute" && rule.attribute)
				values.push(node.attr(rule.attribute) ?? "");
			else values.push(cleanText(node.text()));
		});
		output[name] = rule.multiple ? values : (values[0] ?? "");
	}
	return output;
}

function extractXpaths(
	html: string,
	rules: Record<string, XPathRule>,
): Record<string, unknown> {
	const output: Record<string, unknown> = {};
	if (Object.keys(rules).length === 0) return output;
	const dom = new JSDOM(html);
	for (const [name, rule] of Object.entries(rules)) {
		const result = dom.window.document.evaluate(
			rule.xpath,
			dom.window.document,
			null,
			dom.window.XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
			null,
		);
		const values: string[] = [];
		for (let i = 0; i < result.snapshotLength; i += 1) {
			const node = result.snapshotItem(i);
			if (!node) continue;
			if (rule.type === "html" && "innerHTML" in node)
				values.push(String((node as HTMLElement).innerHTML));
			else if (
				rule.type === "attribute" &&
				rule.attribute &&
				"getAttribute" in node
			)
				values.push(
					String((node as HTMLElement).getAttribute(rule.attribute) ?? ""),
				);
			else values.push(cleanText(node.textContent ?? ""));
		}
		output[name] = rule.multiple ? values : (values[0] ?? "");
	}
	return output;
}

function detectPii(text: string) {
	const emails = [
		...new Set(text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []),
	];
	const phones = [
		...new Set(
			text.match(
				/(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}/g,
			) ?? [],
		),
	];
	const creditCards = [
		...new Set(text.match(/\b(?:\d[ -]*?){13,19}\b/g) ?? []),
	].filter(luhnMaybe);
	return { emails, phones, creditCards };
}

function redactPii(text: string): string {
	return text
		.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]")
		.replace(
			/(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}/g,
			"[REDACTED_PHONE]",
		)
		.replace(/\b(?:\d[ -]*?){13,19}\b/g, (match) =>
			luhnMaybe(match) ? "[REDACTED_CARD]" : match,
		);
}

function qualityScore(input: {
	text: string;
	html: string;
	structuredData: unknown[];
	images: unknown[];
	links: unknown[];
}): QualityScore {
	const wordCount = countWords(input.text);
	const textToHtmlRatio =
		input.html.length === 0 ? 0 : input.text.length / input.html.length;
	const linkDensity = wordCount === 0 ? 0 : input.links.length / wordCount;
	const score = Math.max(
		0,
		Math.min(
			100,
			Math.round(
				Math.min(40, wordCount / 20) +
					Math.min(20, textToHtmlRatio * 100) +
					Math.min(15, input.structuredData.length * 5) +
					Math.min(10, input.images.length * 1.5) +
					Math.max(0, 15 - linkDensity * 80),
			),
		),
	);
	return {
		score,
		wordCount,
		textToHtmlRatio,
		structuredDataCount: input.structuredData.length,
		imageCount: input.images.length,
		linkDensity,
	};
}

function detectLanguage(text: string, hint?: string): string | undefined {
	if (hint) return hint.toLowerCase().split("-")[0];
	const sample = text.slice(0, 5_000);
	if (/[\u0900-\u097F]/.test(sample)) return "hi";
	if (/[\u4E00-\u9FFF]/.test(sample)) return "zh";
	if (/[\u3040-\u30ff]/.test(sample)) return "ja";
	if (/\b(the|and|of|to|in|that|for|with)\b/i.test(sample)) return "en";
	return undefined;
}

function tagsFrom(
	meta: Record<string, string>,
	structuredData: unknown[],
): string[] {
	const tags = new Set<string>();
	for (const item of (meta.keywords ?? "").split(",")) {
		const value = cleanText(item);
		if (value) tags.add(value);
	}
	for (const data of structuredData) collectKeywords(data, tags);
	return [...tags];
}

function collectKeywords(value: unknown, tags: Set<string>) {
	if (!value || typeof value !== "object") return;
	if (Array.isArray(value)) {
		for (const item of value) collectKeywords(item, tags);
		return;
	}
	const record = value as Record<string, unknown>;
	const keywords = record.keywords;
	if (typeof keywords === "string")
		for (const tag of keywords.split(",")) tags.add(cleanText(tag));
	if (Array.isArray(keywords))
		for (const tag of keywords)
			if (typeof tag === "string") tags.add(cleanText(tag));
	for (const nested of Object.values(record)) collectKeywords(nested, tags);
}

function findPublishedDate(
	meta: Record<string, string>,
	structuredData: unknown[],
): string | undefined {
	const direct =
		meta["article:published_time"] ??
		meta.date ??
		meta.publishdate ??
		meta.datepublished;
	if (direct) return direct;
	for (const item of structuredData) {
		const found = findKey(item, ["datePublished", "dateCreated", "uploadDate"]);
		if (typeof found === "string") return found;
	}
	return undefined;
}

function findKey(value: unknown, keys: string[]): unknown {
	if (!value || typeof value !== "object") return undefined;
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = findKey(item, keys);
			if (found) return found;
		}
		return undefined;
	}
	const record = value as Record<string, unknown>;
	for (const key of keys) if (record[key]) return record[key];
	for (const nested of Object.values(record)) {
		const found = findKey(nested, keys);
		if (found) return found;
	}
	return undefined;
}

function normalizeMarkdown(markdown: string, config: AppConfig): string {
	let output = markdown
		.replace(/[\u200B-\u200D\uFEFF]/g, "")
		.replace(/\r\n/g, "\n")
		.replace(/[ \t]+$/gm, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	output = dedupeBlocks(output);
	if (config.linkMode === "reference")
		output = inlineLinksToReferenceLinks(output);
	return output;
}

function inlineLinksToReferenceLinks(markdown: string): string {
	const refs: string[] = [];
	let index = 1;
	const body = markdown.replace(
		/\[([^\]]+)]\(([^)]+)\)/g,
		(_match, text: string, url: string) => {
			refs.push(`[${index}]: ${url}`);
			return `[${text}][${index++}]`;
		},
	);
	return refs.length > 0 ? `${body}\n\n${refs.join("\n")}` : body;
}

function absolutizeHtml(html: string, baseUrl: string): string {
	const $ = cheerio.load(html);
	$("[href]").each((_, element) => {
		const value = $(element).attr("href");
		if (
			value &&
			!value.startsWith("#") &&
			!value.startsWith("mailto:") &&
			!value.startsWith("tel:")
		)
			$(element).attr("href", new URL(value, baseUrl).toString());
	});
	$("[src]").each((_, element) => {
		const value = $(element).attr("src");
		if (value) $(element).attr("src", new URL(value, baseUrl).toString());
	});
	return $.html();
}

function tableNodeToMarkdown(node: HTMLTableElement): string {
	const headers: string[] = [];
	const rows: string[][] = [];
	const trs = [...node.querySelectorAll("tr")];
	for (const [index, tr] of trs.entries()) {
		const cells = [...tr.querySelectorAll("th,td")].map((cell) =>
			cleanText(cell.textContent ?? ""),
		);
		if (index === 0 && tr.querySelectorAll("th").length > 0)
			headers.push(...cells);
		else if (cells.length > 0) rows.push(cells);
	}
	return `\n\n${tableDataToMarkdown(headers, rows)}\n\n`;
}

function tableDataToMarkdown(headers: string[], rows: string[][]): string {
	const width = Math.max(headers.length, ...rows.map((row) => row.length), 1);
	const normalizedHeaders =
		headers.length > 0
			? headers
			: Array.from({ length: width }, (_, index) => `Column ${index + 1}`);
	const pad = (row: string[]) =>
		Array.from({ length: width }, (_, index) =>
			escapeTableCell(row[index] ?? ""),
		);
	return [
		`| ${pad(normalizedHeaders).join(" | ")} |`,
		`| ${Array.from({ length: width }, () => "---").join(" | ")} |`,
		...rows.map((row) => `| ${pad(row).join(" | ")} |`),
	].join("\n");
}

function escapeTableCell(value: string): string {
	return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function stripLinks(html: string): string {
	const $ = cheerio.load(html);
	$("a").each((_, element) => {
		$(element).replaceWith($(element).text());
	});
	return $.html();
}

function stripImages(html: string): string {
	const $ = cheerio.load(html);
	$("img, picture, source").remove();
	return $.html();
}

function isDocumentUrl(url: string): boolean {
	return /\.(?:pdf|docx?|xlsx?|pptx?|zip|rar|7z)(?:\?|$)/i.test(url);
}

function numberAttr(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

export const extractorInternals = {
	decodeEntities,
};
