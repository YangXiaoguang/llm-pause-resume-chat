import type { ChatSession, ChatTurnRunSummary } from "@/src/chat/domain";
import { buildTurnMetricAttributes } from "@/src/chat/telemetry";

import { getObservabilityConfig } from "./config";
import { getLangfuseClient } from "./langfuse";
import { logger } from "./logger";
import { chatMetrics } from "./metrics";

type LangfuseScoreType = "NUMERIC" | "CATEGORICAL";

type LangfuseOperationalScore = {
  name: string;
  value: number | string;
  dataType: LangfuseScoreType;
  comment?: string;
  metadata?: Record<string, unknown>;
  observationId?: string;
};

function calculateDurationMs(turn: ChatTurnRunSummary): number | null {
  if (!turn.timing.completedAt) {
    return null;
  }

  return Math.max(0, Date.parse(turn.timing.completedAt) - Date.parse(turn.timing.startedAt));
}

function calculateTtftMs(turn: ChatTurnRunSummary): number | null {
  if (!turn.timing.firstTokenAt) {
    return null;
  }

  return Math.max(0, Date.parse(turn.timing.firstTokenAt) - Date.parse(turn.timing.startedAt));
}

function calculatePauseEffectiveMs(turn: ChatTurnRunSummary): number | null {
  if (!turn.timing.pauseRequestedAt || !turn.timing.pauseObservedAt) {
    return null;
  }

  return Math.max(0, Date.parse(turn.timing.pauseObservedAt) - Date.parse(turn.timing.pauseRequestedAt));
}

function buildScoreMetadata(session: ChatSession, turn: ChatTurnRunSummary): Record<string, unknown> {
  return {
    sessionId: session.id,
    turnId: turn.id,
    rootTurnId: turn.rootTurnId,
    mode: turn.mode,
    providerId: turn.providerId,
    model: turn.model,
    outcome: turn.outcome,
    promptRefs: turn.promptRefs.map((prompt) => ({
      key: prompt.key,
      version: prompt.version,
      source: prompt.source,
      isFallback: prompt.isFallback,
    })),
  };
}

function buildOperationalScores(session: ChatSession, turn: ChatTurnRunSummary): LangfuseOperationalScore[] {
  const sharedMetadata = buildScoreMetadata(session, turn);
  const durationMs = calculateDurationMs(turn);
  const ttftMs = calculateTtftMs(turn);
  const pauseEffectiveMs = calculatePauseEffectiveMs(turn);
  const promptFallback = turn.promptRefs.some((prompt) => prompt.isFallback);
  const terminalSuccess = turn.outcome === "completed" || turn.outcome === "paused_by_user";
  const resumeSuccess = turn.mode === "resume" && turn.outcome === "completed" && turn.outputChars > 0;
  const scores: LangfuseOperationalScore[] = [
    {
      name: "chat_turn_outcome",
      value: turn.outcome,
      dataType: "CATEGORICAL",
      comment: `${turn.mode} turn finished with outcome ${turn.outcome}.`,
      metadata: sharedMetadata,
    },
    {
      name: "chat_turn_success",
      value: terminalSuccess ? 1 : 0,
      dataType: "NUMERIC",
      metadata: sharedMetadata,
    },
    {
      name: "chat_turn_prompt_fallback",
      value: promptFallback ? 1 : 0,
      dataType: "NUMERIC",
      metadata: sharedMetadata,
    },
    {
      name: "chat_turn_output_chars",
      value: turn.outputChars,
      dataType: "NUMERIC",
      metadata: sharedMetadata,
    },
  ];

  if (turn.mode === "resume") {
    scores.push({
      name: "chat_turn_resume_success",
      value: resumeSuccess ? 1 : 0,
      dataType: "NUMERIC",
      metadata: sharedMetadata,
    });
  }

  if (durationMs !== null) {
    scores.push({
      name: "chat_turn_duration_ms",
      value: durationMs,
      dataType: "NUMERIC",
      metadata: sharedMetadata,
    });
  }

  if (ttftMs !== null) {
    scores.push({
      name: "chat_turn_ttft_ms",
      value: ttftMs,
      dataType: "NUMERIC",
      metadata: sharedMetadata,
    });
  }

  if (pauseEffectiveMs !== null) {
    scores.push({
      name: "chat_turn_pause_effective_ms",
      value: pauseEffectiveMs,
      dataType: "NUMERIC",
      metadata: sharedMetadata,
    });
  }

  if (turn.stopReason) {
    scores.push({
      name: "chat_provider_stop_reason",
      value: turn.stopReason,
      dataType: "CATEGORICAL",
      metadata: sharedMetadata,
      observationId: turn.providerObservationId ?? undefined,
    });
  }

  if (turn.usage.outputTokens != null) {
    scores.push({
      name: "chat_provider_output_tokens",
      value: turn.usage.outputTokens,
      dataType: "NUMERIC",
      metadata: sharedMetadata,
      observationId: turn.providerObservationId ?? undefined,
    });
  }

  return scores;
}

export function recordTurnOperationalScores(session: ChatSession, turn: ChatTurnRunSummary): void {
  const config = getObservabilityConfig();
  if (!config.langfuseEnabled || !config.langfuseScoreEnabled || !turn.traceId) {
    return;
  }

  const client = getLangfuseClient();
  if (!client) {
    return;
  }

  const metricAttributes = buildTurnMetricAttributes(session, turn);

  // These scores are operational heuristics, not semantic quality judgments.
  // They help correlate pause/resume correctness, latency, and fallback usage
  // in Langfuse without putting the user-facing stream on the critical path.
  for (const score of buildOperationalScores(session, turn)) {
    try {
      client.score.create({
        traceId: turn.traceId,
        sessionId: session.id,
        observationId: score.observationId,
        name: score.name,
        value: score.value,
        dataType: score.dataType,
        comment: score.comment,
        metadata: score.metadata,
      });
      chatMetrics.recordLangfuseScore(metricAttributes);
    } catch (error) {
      chatMetrics.recordLangfuseScoreFailure(metricAttributes);
      logger.warn(
        "chat.langfuse.score_failed",
        {
          component: "observability",
          sessionId: session.id,
          turnId: turn.id,
          scoreName: score.name,
        },
        error,
      );
    }
  }
}
