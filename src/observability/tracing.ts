import {
  SpanStatusCode,
  context,
  trace,
  type Attributes,
  type Context,
  type Span,
  type SpanOptions,
} from "@opentelemetry/api";

import { getObservabilityConfig } from "./config";

function getTracer() {
  return trace.getTracer(getObservabilityConfig().serviceName);
}

export async function withActiveSpan<T>(
  name: string,
  options: SpanOptions,
  fn: (span: Span) => Promise<T> | T,
  parentContext?: Context,
): Promise<T> {
  const tracer = getTracer();
  const activeContext = parentContext ?? context.active();
  const span = tracer.startSpan(name, options, activeContext);

  return await context.with(trace.setSpan(activeContext, span), async () => {
    try {
      const result = await fn(span);
      if (span.isRecording()) {
        span.setStatus({ code: SpanStatusCode.OK });
      }
      return result;
    } catch (error) {
      recordException(span, error);
      throw error;
    } finally {
      span.end();
    }
  });
}

export function startSpan(
  name: string,
  options: SpanOptions,
  parentContext?: Context,
): { span: Span; context: Context } {
  const tracer = getTracer();
  const activeContext = parentContext ?? context.active();
  const span = tracer.startSpan(name, options, activeContext);

  return {
    span,
    context: trace.setSpan(activeContext, span),
  };
}

export function setSpanAttributes(span: Span, attributes: Attributes): void {
  span.setAttributes(attributes);
}

export function addSpanEvent(name: string, attributes?: Attributes): void {
  const span = trace.getActiveSpan();
  if (span) {
    span.addEvent(name, attributes);
  }
}

export function recordException(span: Span, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  span.recordException(error instanceof Error ? error : new Error(message));
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message,
  });
}

export function setSpanOk(span: Span): void {
  span.setStatus({ code: SpanStatusCode.OK });
}

export function getTraceContext(): { traceId: string | null; spanId: string | null } {
  const activeSpan = trace.getActiveSpan();
  if (!activeSpan) {
    return {
      traceId: null,
      spanId: null,
    };
  }

  const spanContext = activeSpan.spanContext();
  return {
    traceId: spanContext.traceId,
    spanId: spanContext.spanId,
  };
}
