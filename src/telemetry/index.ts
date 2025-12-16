import { type Span, SpanStatusCode, trace } from "@opentelemetry/api";

export const tracer = trace.getTracer("reactions-kalshi-bot", "1.0.0");

export { SpanStatusCode };
export type { Span };

/**
 * Wraps an async function in a span with automatic error handling.
 * The span is automatically ended when the function completes or throws.
 */
export async function withSpan<T>(
	name: string,
	attributes: Record<string, string | number | boolean>,
	fn: (span: Span) => Promise<T>,
): Promise<T> {
	return tracer.startActiveSpan(name, { attributes }, async (span) => {
		try {
			const result = await fn(span);
			span.setStatus({ code: SpanStatusCode.OK });
			return result;
		} catch (error) {
			span.setStatus({
				code: SpanStatusCode.ERROR,
				message: error instanceof Error ? error.message : String(error),
			});
			span.recordException(
				error instanceof Error ? error : new Error(String(error)),
			);
			throw error;
		} finally {
			span.end();
		}
	});
}
