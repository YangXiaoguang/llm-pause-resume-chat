import { LangfuseClient } from "@langfuse/client";
import { LangfuseSpanProcessor, isDefaultExportSpan } from "@langfuse/otel";
import {
  propagateAttributes,
  updateActiveObservation,
  type LangfuseGenerationAttributes,
  type LangfuseSpanAttributes,
} from "@langfuse/tracing";

import { getObservabilityConfig } from "./config";
import { captureText, summarizeText } from "./redaction";

type LangfuseTraceAttributes = {
  sessionId?: string;
  userId?: string;
  metadata?: Record<string, unknown>;
  version?: string;
  tags?: string[];
};

function toLangfuseTraceMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  if (!metadata) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [
      key,
      typeof value === "string" ? value : JSON.stringify(value),
    ]),
  );
}

function maskLangfusePayload(value: unknown, depth = 0): unknown {
  if (value == null) {
    return value;
  }

  if (typeof value === "string") {
    return captureText(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((entry) => maskLangfusePayload(entry, depth + 1));
  }

  if (typeof value === "object") {
    if (depth >= 3) {
      return summarizeText(JSON.stringify(value), 200);
    }

    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nestedValue]) => [
        key,
        maskLangfusePayload(nestedValue, depth + 1),
      ]),
    );
  }

  return String(value);
}

declare global {
  var __langfuseClient: LangfuseClient | undefined;
}

export function isLangfuseEnabled(): boolean {
  return getObservabilityConfig().langfuseEnabled;
}

export function getLangfuseClient(): LangfuseClient | null {
  const config = getObservabilityConfig();
  if (!config.langfuseEnabled) {
    return null;
  }

  if (!globalThis.__langfuseClient) {
    globalThis.__langfuseClient = new LangfuseClient({
      publicKey: config.langfusePublicKey ?? undefined,
      secretKey: config.langfuseSecretKey ?? undefined,
      baseUrl: config.langfuseBaseUrl,
    });
  }

  return globalThis.__langfuseClient;
}

export function createLangfuseSpanProcessor(): LangfuseSpanProcessor | null {
  const config = getObservabilityConfig();
  if (!config.langfuseEnabled) {
    return null;
  }

  return new LangfuseSpanProcessor({
    publicKey: config.langfusePublicKey ?? undefined,
    secretKey: config.langfuseSecretKey ?? undefined,
    baseUrl: config.langfuseBaseUrl,
    environment: config.langfuseTracingEnvironment,
    release: config.langfuseRelease ?? undefined,
    exportMode: config.langfuseExportMode,
    shouldExportSpan: ({ otelSpan }) => isDefaultExportSpan(otelSpan) || otelSpan.name.startsWith("chat."),
    mask: ({ data }) => maskLangfusePayload(data),
  });
}

export async function withLangfuseTraceAttributes<T>(
  attributes: LangfuseTraceAttributes,
  fn: () => Promise<T>,
): Promise<T> {
  if (!isLangfuseEnabled()) {
    return fn();
  }

  return propagateAttributes(
    {
      ...attributes,
      metadata: toLangfuseTraceMetadata(attributes.metadata),
    },
    fn,
  );
}

export function updateActiveLangfuseSpan(attributes: LangfuseSpanAttributes): void {
  try {
    updateActiveObservation(attributes);
  } catch {
    // Langfuse updates must never interfere with the main request path.
  }
}

export function updateActiveLangfuseGeneration(attributes: LangfuseGenerationAttributes): void {
  try {
    updateActiveObservation(attributes, { asType: "generation" });
  } catch {
    // If there is no active observation context we silently skip the update.
  }
}
