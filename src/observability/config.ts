export type ObservabilityLogLevel = "debug" | "info" | "warn" | "error";

export type CaptureContentMode = "off" | "summary" | "full";

export type ObservabilityConfig = {
  enabled: boolean;
  serviceName: string;
  otlpBaseEndpoint: string;
  tracesEndpoint: string;
  metricsEndpoint: string;
  captureContentMode: CaptureContentMode;
  logLevel: ObservabilityLogLevel;
  metricExportIntervalMs: number;
  langfuseEnabled: boolean;
  langfusePublicKey: string | null;
  langfuseSecretKey: string | null;
  langfuseBaseUrl: string;
  langfuseTracingEnvironment: string;
  langfuseRelease: string | null;
  langfusePromptLabel: string;
  langfusePromptCacheTtlSeconds: number;
  langfuseExportMode: "immediate" | "batched";
  langfuseScoreEnabled: boolean;
};

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseLogLevel(value: string | undefined): ObservabilityLogLevel {
  if (value === "debug" || value === "info" || value === "warn" || value === "error") {
    return value;
  }
  return "info";
}

function parseCaptureContentMode(value: string | undefined): CaptureContentMode {
  if (value === "summary" || value === "full") {
    return value;
  }
  return "off";
}

function normalizeBaseEndpoint(endpoint: string): string {
  return endpoint.replace(/\/+$/, "");
}

function buildSignalEndpoint(baseEndpoint: string, signal: "traces" | "metrics"): string {
  return `${normalizeBaseEndpoint(baseEndpoint)}/v1/${signal}`;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

declare global {
  var __observabilityConfig: ObservabilityConfig | undefined;
}

export function getObservabilityConfig(): ObservabilityConfig {
  if (globalThis.__observabilityConfig) {
    return globalThis.__observabilityConfig;
  }

  const otlpBaseEndpoint = normalizeBaseEndpoint(
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://127.0.0.1:4318",
  );
  const langfusePublicKey = process.env.LANGFUSE_PUBLIC_KEY?.trim() || null;
  const langfuseSecretKey = process.env.LANGFUSE_SECRET_KEY?.trim() || null;
  const langfuseBaseUrl = normalizeBaseEndpoint(
    process.env.LANGFUSE_BASE_URL ?? process.env.LANGFUSE_BASEURL ?? "https://cloud.langfuse.com",
  );

  globalThis.__observabilityConfig = {
    enabled: parseBoolean(process.env.OBS_ENABLED, true),
    serviceName: process.env.OTEL_SERVICE_NAME ?? "llm-pause-resume-chat",
    otlpBaseEndpoint,
    tracesEndpoint: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? buildSignalEndpoint(otlpBaseEndpoint, "traces"),
    metricsEndpoint:
      process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ?? buildSignalEndpoint(otlpBaseEndpoint, "metrics"),
    captureContentMode: parseCaptureContentMode(process.env.OBS_CAPTURE_CONTENT_MODE),
    logLevel: parseLogLevel(process.env.OBS_LOG_LEVEL),
    metricExportIntervalMs: Number.parseInt(process.env.OTEL_METRIC_EXPORT_INTERVAL ?? "10000", 10),
    langfuseEnabled: Boolean(langfusePublicKey && langfuseSecretKey),
    langfusePublicKey,
    langfuseSecretKey,
    langfuseBaseUrl,
    langfuseTracingEnvironment: process.env.LANGFUSE_TRACING_ENVIRONMENT ?? process.env.NODE_ENV ?? "development",
    langfuseRelease: process.env.LANGFUSE_RELEASE?.trim() || null,
    langfusePromptLabel: process.env.LANGFUSE_PROMPT_LABEL?.trim() || "production",
    langfusePromptCacheTtlSeconds: parsePositiveInteger(process.env.LANGFUSE_PROMPT_CACHE_TTL_SECONDS, 300),
    langfuseExportMode: process.env.LANGFUSE_EXPORT_MODE === "batched" ? "batched" : "immediate",
    langfuseScoreEnabled: parseBoolean(process.env.LANGFUSE_SCORE_ENABLED, true),
  };

  return globalThis.__observabilityConfig;
}
