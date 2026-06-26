import type { LogLevel } from "./types.ts";

export class Logger {
	private readonly levels: Record<LogLevel, number> = {
		debug: 10,
		info: 20,
		warn: 30,
		error: 40,
	};

	constructor(
		private level: LogLevel,
		private quiet: boolean,
	) {}

	debug(event: string, data: Record<string, unknown> = {}) {
		this.write("debug", event, data);
	}

	info(event: string, data: Record<string, unknown> = {}) {
		this.write("info", event, data);
	}

	warn(event: string, data: Record<string, unknown> = {}) {
		this.write("warn", event, data);
	}

	error(event: string, data: Record<string, unknown> = {}) {
		this.write("error", event, data);
	}

	private write(level: LogLevel, event: string, data: Record<string, unknown>) {
		if (this.quiet && level !== "error") return;
		if (this.levels[level] < this.levels[this.level]) return;
		console.error(
			JSON.stringify({ ts: new Date().toISOString(), level, event, ...data }),
		);
	}
}
