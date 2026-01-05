import { vi } from "vitest";

// Mock OpenTelemetry API to prevent instrumentation side effects
vi.mock("@opentelemetry/api", () => ({
	trace: {
		getTracer: () => ({
			startActiveSpan: (
				_name: string,
				_options: unknown,
				fn: (span: unknown) => unknown,
			) => {
				const mockSpan = {
					setAttributes: vi.fn(),
					setAttribute: vi.fn(),
					setStatus: vi.fn(),
					addEvent: vi.fn(),
					recordException: vi.fn(),
					end: vi.fn(),
					spanContext: () => ({ traceId: "test-trace", spanId: "test-span" }),
				};
				return fn(mockSpan);
			},
		}),
		getSpan: () => null,
	},
	context: {
		active: () => ({}),
	},
	metrics: {
		getMeter: () => ({
			createCounter: () => ({ add: vi.fn() }),
			createHistogram: () => ({ record: vi.fn() }),
			createObservableGauge: () => ({ addCallback: vi.fn() }),
		}),
	},
	SpanStatusCode: { OK: 0, ERROR: 1 },
}));

// Mock telemetry module
vi.mock("../src/telemetry/index.js", () => ({
	withSpan: async <T>(
		_name: string,
		_attrs: unknown,
		fn: (span: unknown) => Promise<T>,
	) => {
		const mockSpan = {
			setAttributes: vi.fn(),
			setAttribute: vi.fn(),
			setStatus: vi.fn(),
			addEvent: vi.fn(),
		};
		return fn(mockSpan);
	},
	tracer: {
		startActiveSpan: vi.fn(),
	},
	SpanStatusCode: { OK: 0, ERROR: 1 },
}));

// Mock logger
vi.mock("../src/telemetry/logger.js", () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

// Mock metrics
vi.mock("../src/telemetry/metrics.js", () => ({
	dbQueryCounter: { add: vi.fn() },
	dbQueryDuration: { record: vi.fn() },
	dbErrorsCounter: { add: vi.fn() },
	commandInvocationsCounter: { add: vi.fn() },
	commandErrorsCounter: { add: vi.fn() },
	commandDuration: { record: vi.fn() },
	reactionsAddedCounter: { add: vi.fn() },
	reactionsRemovedCounter: { add: vi.fn() },
	selfReactionsSkippedCounter: { add: vi.fn() },
	botReactionsSkippedCounter: { add: vi.fn() },
	reactionProcessingDuration: { record: vi.fn() },
	backfillBatchCounter: { add: vi.fn() },
	backfillBatchDuration: { record: vi.fn() },
	leaderboardPageViewsCounter: { add: vi.fn() },
	leaderboardQueryDuration: { record: vi.fn() },
	meter: {
		createCounter: () => ({ add: vi.fn() }),
		createHistogram: () => ({ record: vi.fn() }),
		createObservableGauge: () => ({ addCallback: vi.fn() }),
	},
}));
