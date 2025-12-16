import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import {
	ATTR_SERVICE_NAME,
	ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";

// Read config directly from env to avoid circular dependencies
const otelEndpoint =
	process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318";
const serviceName = process.env.OTEL_SERVICE_NAME ?? "reactions-kalshi-bot";
const otelEnabled = process.env.OTEL_ENABLED !== "false";

const resource = new Resource({
	[ATTR_SERVICE_NAME]: serviceName,
	[ATTR_SERVICE_VERSION]: "1.0.0",
	"deployment.environment": process.env.NODE_ENV ?? "development",
});

let sdk: NodeSDK | null = null;

if (otelEnabled) {
	const traceExporter = new OTLPTraceExporter({
		url: `${otelEndpoint}/v1/traces`,
	});

	const metricExporter = new OTLPMetricExporter({
		url: `${otelEndpoint}/v1/metrics`,
	});

	const logExporter = new OTLPLogExporter({
		url: `${otelEndpoint}/v1/logs`,
	});

	sdk = new NodeSDK({
		resource,
		spanProcessor: new BatchSpanProcessor(traceExporter, {
			maxQueueSize: 2048,
			maxExportBatchSize: 512,
			scheduledDelayMillis: 5000,
			exportTimeoutMillis: 30000,
		}),
		metricReader: new PeriodicExportingMetricReader({
			exporter: metricExporter,
			exportIntervalMillis: 15000,
		}),
		logRecordProcessor: new BatchLogRecordProcessor(logExporter),
	});

	sdk.start();
	console.log(
		`OpenTelemetry SDK initialized (endpoint: ${otelEndpoint}, service: ${serviceName})`,
	);

	const shutdown = async () => {
		console.log("Shutting down OpenTelemetry SDK...");
		await sdk?.shutdown();
		process.exit(0);
	};

	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
} else {
	console.log("OpenTelemetry SDK disabled (OTEL_ENABLED=false)");
}

export { sdk };
