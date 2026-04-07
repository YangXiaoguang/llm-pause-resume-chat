import type { Attributes } from "@opentelemetry/api";

import type { ChatSession, ChatTurnRunSummary } from "./domain";

export const CHAT_SPAN_NAMES = {
  createSession: "chat.session.create",
  getSession: "chat.session.get",
  requestPause: "chat.turn.pause_request",
  startTurn: "chat.turn.start",
  streamTurn: "chat.turn.stream",
  finalizeTurn: "chat.turn.finalize",
  markPaused: "chat.turn.mark_paused",
  markErrored: "chat.turn.mark_errored",
  buildPrompt: "chat.prompt.build",
  turnRequest: "chat.http.turn_request",
  sseStream: "chat.http.sse_stream",
  providerStream: "chat.provider.stream",
} as const;

export const CHAT_SPAN_EVENTS = {
  turnStarted: "turn_started",
  firstToken: "first_token",
  usageReceived: "usage_received",
  pauseRequested: "pause_requested",
  pauseObserved: "pause_observed",
  upstreamAbort: "upstream_abort_sent",
  clientDisconnected: "client_disconnected",
  turnCompleted: "turn_completed",
  turnFailed: "turn_failed",
  sseOpened: "sse_opened",
  sseClosed: "sse_closed",
  sseChunkSent: "sse_chunk_sent",
} as const;

export function buildTurnTraceAttributes(session: ChatSession, turn: ChatTurnRunSummary): Attributes {
  return {
    "chat.session.id": session.id,
    "chat.turn.id": turn.id,
    "chat.turn.sequence": turn.sequence,
    "chat.parent_turn.id": turn.parentTurnId ?? "",
    "chat.root_turn.id": turn.rootTurnId,
    "chat.assistant_message.id": turn.assistantMessageId,
    "chat.user_message.id": turn.userMessageId ?? "",
    "chat.mode": turn.mode,
    "chat.outcome": turn.outcome,
    "gen_ai.provider.name": turn.providerId,
    "gen_ai.request.model": turn.model,
  };
}

export function buildTurnMetricAttributes(session: ChatSession, turn: ChatTurnRunSummary): Attributes {
  return {
    provider: turn.providerId,
    model: turn.model,
    mode: turn.mode,
    outcome: turn.outcome,
    sequence_bucket: turn.sequence <= 3 ? String(turn.sequence) : "4_plus",
    session_status: session.status,
  };
}

export function buildRouteAttributes(route: string, requestId: string, sessionId?: string): Attributes {
  return {
    "http.route": route,
    "chat.request.id": requestId,
    "chat.session.id": sessionId ?? "",
  };
}

export function buildLogContext(session: ChatSession, turn?: ChatTurnRunSummary) {
  return {
    component: "chat",
    sessionId: session.id,
    turnId: turn?.id,
    providerId: turn?.providerId ?? session.settings.providerId,
    model: turn?.model ?? session.settings.model,
    outcome: turn?.outcome,
  };
}
