import { getTraceContext } from "./tracing";

export type ObservabilityContext = {
  component?: string;
  requestId?: string;
  sessionId?: string;
  turnId?: string;
  providerId?: string;
  model?: string;
  route?: string;
  outcome?: string;
  scoreName?: string;
};

export function withTraceContext(context: ObservabilityContext = {}): Record<string, unknown> {
  const traceContext = getTraceContext();

  return {
    ...context,
    traceId: traceContext.traceId,
    spanId: traceContext.spanId,
  };
}
