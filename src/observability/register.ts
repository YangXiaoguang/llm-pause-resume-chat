import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  SEMRESATTRS_DEPLOYMENT_ENVIRONMENT,
  SEMRESATTRS_SERVICE_NAME,
} from "@opentelemetry/semantic-conventions";

import { getObservabilityConfig } from "./config";
import { createLangfuseSpanProcessor } from "./langfuse";

declare global {
  var __observabilitySdkStarted: boolean | undefined;
}

export async function registerObservability(): Promise<void> {
  const config = getObservabilityConfig();
  if (!config.enabled || globalThis.__observabilitySdkStarted) {
    return;
  }

  if (config.logLevel === "debug") {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
  }

  const resource = resourceFromAttributes({
    [SEMRESATTRS_SERVICE_NAME]: config.serviceName,
    [SEMRESATTRS_DEPLOYMENT_ENVIRONMENT]: process.env.NODE_ENV ?? "development",
  });

  const metricReader = new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({
      url: config.metricsEndpoint,
    }),
    exportIntervalMillis: config.metricExportIntervalMs,
  });
  const langfuseSpanProcessor = createLangfuseSpanProcessor();

  // We keep the automatic layer intentionally narrow: HTTP/Undici spans are
  // useful for provider requests, while broad auto-instrumentation creates a
  // lot of noise for this repository's token-by-token file persistence flow.
  const sdk = new NodeSDK({
    resource,
    traceExporter: new OTLPTraceExporter({
      url: config.tracesEndpoint,
    }),
    spanProcessors: langfuseSpanProcessor ? [langfuseSpanProcessor] : [],
    metricReader,
    instrumentations: [
      new HttpInstrumentation(),
      new UndiciInstrumentation(),
    ],
  });

  await Promise.resolve(sdk.start());
  globalThis.__observabilitySdkStarted = true;
}
