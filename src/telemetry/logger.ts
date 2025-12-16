import { context, trace } from "@opentelemetry/api";

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
	level: LogLevel;
	message: string;
	timestamp: string;
	traceId?: string;
	spanId?: string;
	attributes?: Record<string, unknown>;
}

function getCurrentSpanContext(): { traceId?: string; spanId?: string } {
	const span = trace.getSpan(context.active());
	if (!span) return {};

	const spanContext = span.spanContext();
	return {
		traceId: spanContext.traceId,
		spanId: spanContext.spanId,
	};
}

function formatLog(entry: LogEntry): string {
	return JSON.stringify(entry);
}

function log(
	level: LogLevel,
	message: string,
	attributes?: Record<string, unknown>,
): void {
	const spanContext = getCurrentSpanContext();

	const entry: LogEntry = {
		level,
		message,
		timestamp: new Date().toISOString(),
		...spanContext,
		...(attributes && { attributes }),
	};

	const formatted = formatLog(entry);

	switch (level) {
		case "debug":
			console.debug(formatted);
			break;
		case "info":
			console.info(formatted);
			break;
		case "warn":
			console.warn(formatted);
			break;
		case "error":
			console.error(formatted);
			break;
	}
}

export const logger = {
	debug: (message: string, attributes?: Record<string, unknown>) =>
		log("debug", message, attributes),
	info: (message: string, attributes?: Record<string, unknown>) =>
		log("info", message, attributes),
	warn: (message: string, attributes?: Record<string, unknown>) =>
		log("warn", message, attributes),
	error: (message: string, attributes?: Record<string, unknown>) =>
		log("error", message, attributes),
};
