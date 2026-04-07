import { metrics, type Attributes } from "@opentelemetry/api";

import { getObservabilityConfig } from "./config";

const meter = metrics.getMeter(getObservabilityConfig().serviceName);

const chatTurnTotal = meter.createCounter("chat.turn.total", {
  description: "Total number of chat turns started or finished.",
});

const chatTurnErrors = meter.createCounter("chat.turn.errors", {
  description: "Total number of chat turns that finished with an error-like outcome.",
});

const chatPauseRequests = meter.createCounter("chat.pause.requests", {
  description: "Total number of explicit pause requests received.",
});

const chatSseDisconnects = meter.createCounter("chat.sse.disconnects", {
  description: "Total number of stream disconnects observed at the HTTP boundary.",
});

const chatStreamChunks = meter.createCounter("chat.stream.chunks", {
  description: "Total number of streamed text chunks emitted to the client.",
});

const chatOutputChars = meter.createCounter("chat.stream.output_chars", {
  description: "Total number of assistant characters streamed to the client.",
});

const chatTurnDuration = meter.createHistogram("chat.turn.duration", {
  description: "Wall clock duration for a chat turn.",
  unit: "ms",
});

const chatTurnTtft = meter.createHistogram("chat.turn.ttft", {
  description: "Time to first token for a chat turn.",
  unit: "ms",
});

const chatPauseEffective = meter.createHistogram("chat.pause.effective", {
  description: "Delay between pause request and pause observation.",
  unit: "ms",
});

const chatProviderRequestDuration = meter.createHistogram("chat.provider.request", {
  description: "Duration of outbound provider requests until headers are received.",
  unit: "ms",
});

const chatRepositoryOperationDuration = meter.createHistogram("chat.repository.operation", {
  description: "Duration of repository operations.",
  unit: "ms",
});

const chatActiveGenerations = meter.createUpDownCounter("chat.active_generations", {
  description: "Number of chat generations currently in progress.",
});

const chatLangfuseScores = meter.createCounter("chat.langfuse.scores", {
  description: "Total number of Langfuse operational scores queued for export.",
});

const chatLangfuseScoreFailures = meter.createCounter("chat.langfuse.score_failures", {
  description: "Total number of Langfuse operational score writes that failed synchronously.",
});

export const chatMetrics = {
  recordTurnStarted(attributes: Attributes): void {
    chatTurnTotal.add(1, { ...attributes, phase: "started" });
    chatActiveGenerations.add(1, attributes);
  },
  recordTurnFinished(durationMs: number, attributes: Attributes): void {
    chatTurnTotal.add(1, { ...attributes, phase: "finished" });
    chatTurnDuration.record(durationMs, attributes);
    chatActiveGenerations.add(-1, attributes);
  },
  recordTurnError(attributes: Attributes): void {
    chatTurnErrors.add(1, attributes);
  },
  recordTtft(durationMs: number, attributes: Attributes): void {
    chatTurnTtft.record(durationMs, attributes);
  },
  recordPauseRequest(attributes: Attributes): void {
    chatPauseRequests.add(1, attributes);
  },
  recordPauseEffective(durationMs: number, attributes: Attributes): void {
    chatPauseEffective.record(durationMs, attributes);
  },
  recordProviderRequest(durationMs: number, attributes: Attributes): void {
    chatProviderRequestDuration.record(durationMs, attributes);
  },
  recordRepositoryOperation(durationMs: number, attributes: Attributes): void {
    chatRepositoryOperationDuration.record(durationMs, attributes);
  },
  recordStreamChunk(charCount: number, attributes: Attributes): void {
    chatStreamChunks.add(1, attributes);
    chatOutputChars.add(charCount, attributes);
  },
  recordSseDisconnect(attributes: Attributes): void {
    chatSseDisconnects.add(1, attributes);
  },
  recordLangfuseScore(attributes: Attributes): void {
    chatLangfuseScores.add(1, attributes);
  },
  recordLangfuseScoreFailure(attributes: Attributes): void {
    chatLangfuseScoreFailures.add(1, attributes);
  },
};
