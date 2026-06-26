#!/usr/bin/env bun
import { type CoreRunEvent, runCore } from "../../packages/core/index.ts";
import { CrawlState } from "../../packages/crawler/index.ts";
import { ProxyManager } from "../../packages/scraper/index.ts";
import {
	loadConfig,
	loadProxySources,
	mergeConfig,
	validateConfig,
} from "../../packages/shared/config.ts";
import { Logger } from "../../packages/shared/logger.ts";
import type {
	AppConfig,
	CliOptions,
	Command,
	RunStats,
} from "../../packages/shared/types.ts";
import {
	normalizeInputUrl,
	requireValue,
} from "../../packages/shared/utils.ts";

export async function runCli(argv = Bun.argv.slice(2)) {
	const cli = parseCli(argv);
	let config = await loadConfig(cli.configPath);
	config = applyCliConfig(cli, config);

	const logger = new Logger(config.logLevel, cli.quiet);
	await loadProxySources(config);
	validateConfig(config, cli.command);

	if (cli.command === "validate-config") {
		console.log("Config valid");
		return;
	}

	const proxyManager = new ProxyManager(config.proxies, config.proxyRotation);
	if (cli.command === "test-proxy") {
		await proxyManager.testAll(config.proxyHealthEndpoint, logger);
		console.log(JSON.stringify(proxyManager.stats(), null, 2));
		return;
	}

	if (config.cleanStart) await new CrawlState(config).reset();
	const mode =
		cli.command === "crawl" || cli.command === "resume" ? "crawl" : "scrape";
	const renderer = createCliRenderer(cli.quiet);
	const result = await runCore({
		url: cli.targetUrl,
		mode,
		config,
		resume: cli.command === "resume",
		logger,
		proxyManager,
		onEvent: renderer.onEvent,
	});
	renderer.done(result.outputDir, result.stats);
}

function parseCli(argv: string[]): CliOptions {
	const command = (argv[0] ?? "scrape") as Command;
	if (
		!["scrape", "crawl", "resume", "validate-config", "test-proxy"].includes(
			command,
		)
	)
		throw new Error(`Unknown command: ${command}`);
	const overrides: Partial<AppConfig> = {};
	let targetUrl: string | undefined;
	let configPath: string | undefined;
	let verbose = false;
	let quiet = false;
	for (let i = 1; i < argv.length; i += 1) {
		const arg = argv[i];
		if (!arg) continue;
		const next = argv[i + 1];
		if (!arg.startsWith("--") && !targetUrl) {
			targetUrl = arg;
			continue;
		}
		switch (arg) {
			case "--config":
				configPath = requireValue(arg, next);
				i += 1;
				break;
			case "--output-dir":
				overrides.outputDir = requireValue(arg, next);
				overrides.baseOutputDir = overrides.outputDir;
				i += 1;
				break;
			case "--max-pages":
				overrides.maxPages = Number(requireValue(arg, next));
				i += 1;
				break;
			case "--depth":
				overrides.maxDepth = Number(requireValue(arg, next));
				i += 1;
				break;
			case "--concurrency":
				overrides.concurrency = Number(requireValue(arg, next));
				i += 1;
				break;
			case "--headless":
				overrides.headless = true;
				break;
			case "--headed":
				overrides.headless = false;
				break;
			case "--no-js":
				overrides.renderMode = "fetch";
				break;
			case "--dry-run":
				overrides.dryRun = true;
				break;
			case "--verbose":
				verbose = true;
				break;
			case "--quiet":
				quiet = true;
				break;
			case "--clean-start":
				overrides.cleanStart = true;
				break;
			default:
				throw new Error(`Unknown flag: ${arg}`);
		}
	}
	return { command, targetUrl, configPath, overrides, verbose, quiet };
}

function applyCliConfig(cli: CliOptions, config: AppConfig): AppConfig {
	const next = mergeConfig(config, cli.overrides);
	if (cli.targetUrl) next.startUrls = [normalizeInputUrl(cli.targetUrl)];
	if (cli.command === "crawl") next.crawler = true;
	if (cli.command === "scrape") {
		next.crawler = false;
		next.maxPages = 1;
	}
	if (cli.verbose) next.logLevel = "debug";
	if (cli.quiet) next.logLevel = "error";
	return next;
}

function createCliRenderer(quiet: boolean) {
	const render = (stats: RunStats, queued: number) => {
		if (quiet) return;
		const elapsed = Math.max(0.001, (Date.now() - stats.startedAt) / 1000);
		const line = `scraped=${stats.scraped} failed=${stats.failed} skipped=${stats.skipped} queued=${queued} pps=${(stats.scraped / elapsed).toFixed(2)} mem=${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`;
		process.stderr.write(`\r${line.padEnd(100, " ")}`);
	};
	return {
		onEvent(event: CoreRunEvent) {
			if (event.type === "start" && !quiet) {
				console.error(`Starting ${event.mode}: ${event.url ?? "resume"}`);
				console.error(`Output: ${event.outputDir}`);
			}
			if (event.type === "progress") render(event.stats, event.queued);
			if (event.type === "page" && !quiet) {
				process.stderr.write("\n");
				console.error(`Wrote ${event.output}`);
			}
		},
		done(outputDir: string, stats: RunStats) {
			if (quiet) return;
			process.stderr.write("\n");
			console.error(
				`Done. scraped=${stats.scraped} failed=${stats.failed} skipped=${stats.skipped} output=${outputDir}`,
			);
		},
	};
}

if (import.meta.main) {
	runCli().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
