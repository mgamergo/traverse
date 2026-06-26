import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ProxyManager } from "../scraper/index.ts";
import type { AppConfig, ExtractedPage, RunStats } from "../shared/types.ts";
import { sanitizeFilePart, slugForUrl } from "../shared/utils.ts";

export class OutputWriter {
	private consolidated: {
		url: string;
		depth: number;
		order: number;
		markdown: string;
	}[] = [];

	constructor(private config: AppConfig) {}

	async writePage(
		page: ExtractedPage,
		markdown: string,
		order: number,
	): Promise<string> {
		const file = this.outputPath(page);
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, markdown, "utf8");
		if (this.config.jsonSidecar)
			await writeFile(
				file.replace(/\.md$/, ".json"),
				JSON.stringify(page, null, 2),
				"utf8",
			);
		if (this.config.rawHtml)
			await writeFile(file.replace(/\.md$/, ".html"), page.mainHtml, "utf8");
		if (this.config.consolidatedOutput)
			this.consolidated.push({
				url: page.finalUrl,
				depth: page.depth,
				order,
				markdown,
			});
		return file;
	}

	async finish() {
		if (!this.config.consolidatedOutput || this.consolidated.length === 0)
			return;
		const sorted = this.consolidated.sort((a, b) => a.order - b.order);
		const body = sorted
			.map((page) => `<!-- ${page.url} -->\n\n${page.markdown}`)
			.join("\n\n---\n\n");
		await mkdir(this.config.outputDir, { recursive: true });
		await writeFile(join(this.config.outputDir, "combined.md"), body, "utf8");
	}

	private outputPath(page: ExtractedPage): string {
		const url = new URL(page.finalUrl);
		if (this.config.mirrorUrlStructure) {
			const pathParts = url.pathname
				.split("/")
				.filter(Boolean)
				.map(sanitizeFilePart);
			const fileName =
				pathParts.length === 0
					? "index.md"
					: `${pathParts.pop() || "index"}.md`;
			return join(this.config.outputDir, url.hostname, ...pathParts, fileName);
		}
		return join(this.config.outputDir, `${slugForUrl(page.finalUrl)}.md`);
	}
}

export async function writeReport(
	config: AppConfig,
	stats: RunStats,
	proxyManager: ProxyManager,
) {
	const durationSeconds = Math.max(
		0.001,
		(Date.now() - stats.startedAt) / 1000,
	);
	const report = `# Scrape Report

- Total pages scraped: ${stats.scraped}
- Total pages failed: ${stats.failed}
- Total pages skipped: ${stats.skipped}
- Duration seconds: ${durationSeconds.toFixed(2)}
- Pages per second: ${(stats.scraped / durationSeconds).toFixed(3)}
- Bytes received: ${stats.bytes}
- CAPTCHA encounters: ${stats.captcha}

## Error Breakdown

${
	Object.entries(stats.errors)
		.map(([key, value]) => `- ${key}: ${value}`)
		.join("\n") || "- None"
}

## Proxy Usage

${
	Object.entries(stats.proxyUses)
		.map(([key, value]) => `- ${key}: ${value}`)
		.join("\n") || "- No proxies used"
}

## Proxy Health

\`\`\`json
${JSON.stringify(proxyManager.stats(), null, 2)}
\`\`\`

## Outputs

${stats.outputs.map((output) => `- ${output}`).join("\n") || "- No output files"}
`;
	await mkdir(config.outputDir, { recursive: true });
	await writeFile(join(config.outputDir, "report.md"), report, "utf8");
}
