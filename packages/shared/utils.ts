import { createHash } from "node:crypto";
import { basename } from "node:path";
import YAML from "yaml";
import type { AppConfig } from "./types.ts";

export function normalizeInputUrl(url: string): string {
	return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

export function normalizeUrl(url: string, config: AppConfig): string {
	const parsed = new URL(normalizeInputUrl(url));
	parsed.protocol = parsed.protocol.toLowerCase();
	parsed.hostname = parsed.hostname.toLowerCase();
	if (
		(parsed.protocol === "https:" && parsed.port === "443") ||
		(parsed.protocol === "http:" && parsed.port === "80")
	)
		parsed.port = "";
	parsed.hash = "";
	for (const param of config.removeTrackingParams)
		parsed.searchParams.delete(param);
	parsed.pathname = parsed.pathname.replace(/\/{2,}/g, "/");
	return parsed.toString();
}

export function cleanText(text: string): string {
	return decodeEntities(text)
		.replace(/[\u200B-\u200D\uFEFF]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

export function decodeEntities(text: string): string {
	return text
		.replace(/&nbsp;|&#160;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'");
}

export function countWords(text: string): number {
	return (cleanText(text).match(/\b[\p{L}\p{N}'-]+\b/gu) ?? []).length;
}

export function dedupeBlocks(text: string): string {
	const seen = new Set<string>();
	return text
		.split(/\n{2,}/)
		.filter((block) => {
			const normalized = cleanText(block).toLowerCase();
			if (normalized.length < 40) return true;
			if (seen.has(normalized)) return false;
			seen.add(normalized);
			return true;
		})
		.join("\n\n");
}

export function humanDelay(config: AppConfig["delay"]): number {
	const random = Math.random() ** config.curve;
	return Math.round(config.minMs + (config.maxMs - config.minMs) * random);
}

export function pick<T>(values: T[]): T {
	if (values.length === 0) throw new Error("Cannot pick from an empty array");
	return values[Math.floor(Math.random() * values.length)] as T;
}

export function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function slugForUrl(url: string): string {
	const parsed = new URL(url);
	const source = `${parsed.hostname}${parsed.pathname}${parsed.search}`;
	const hash = createHash("sha256").update(url).digest("hex").slice(0, 10);
	const slug = source
		.replace(/^www\./, "")
		.replace(/[^a-z0-9]+/gi, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 110);
	return `${slug || "index"}-${hash}`;
}

export function sanitizeFilePart(value: string): string {
	return (
		basename(value)
			.split("")
			.map((char) =>
				/[<>:"/\\|?*]/.test(char) || char.charCodeAt(0) < 32 ? "_" : char,
			)
			.join("")
			.replace(/\s+/g, "-")
			.slice(0, 90) || "index"
	).toLowerCase();
}

export function redactProxy(proxy: string): string {
	try {
		const parsed = new URL(proxy);
		if (parsed.username || parsed.password) {
			parsed.username = "***";
			parsed.password = "***";
		}
		return parsed.toString();
	} catch {
		return proxy.replace(/\/\/[^@]+@/, "//***:***@");
	}
}

export function luhnMaybe(value: string): boolean {
	const digits = value.replace(/\D/g, "");
	if (digits.length < 13 || digits.length > 19) return false;
	let sum = 0;
	let double = false;
	for (let i = digits.length - 1; i >= 0; i -= 1) {
		let digit = Number(digits[i]);
		if (double) {
			digit *= 2;
			if (digit > 9) digit -= 9;
		}
		sum += digit;
		double = !double;
	}
	return sum % 10 === 0;
}

export function toYaml(value: Record<string, unknown>): string {
	return YAML.stringify(value, { lineWidth: 0 });
}

export function requireValue(flag: string, value: string | undefined): string {
	if (!value) throw new Error(`${flag} requires a value`);
	return value;
}
