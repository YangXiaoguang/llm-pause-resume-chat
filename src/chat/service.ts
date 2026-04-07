import {
  DEFAULT_SYSTEM_PROMPT,
  type ChatMessage,
  type ChatPromptReference,
  type ChatSession,
  type ChatTurnOutcome,
  type ChatTurnRunSummary,
  type CreateSessionInput,
  type PromptMessage,
  type ProviderDescriptor,
  type StartTurnInput,
  type StreamChunk,
} from "./domain";
import { createId, nowIso } from "./ids";
import { resolveResumePrompt, resolveSystemPrompt } from "./prompts";
import { getProvider, listProviders } from "./providers";
import { getChatSessionRepository } from "./repository";
import { CHAT_SPAN_EVENTS, CHAT_SPAN_NAMES, buildLogContext, buildTurnMetricAttributes, buildTurnTraceAttributes } from "./telemetry";
import { updateActiveLangfuseSpan } from "@/src/observability/langfuse";
import { recordTurnOperationalScores } from "@/src/observability/evaluations";
import { logger } from "@/src/observability/logger";
import { chatMetrics } from "@/src/observability/metrics";
import { getTraceContext, recordException, setSpanOk, startSpan, withActiveSpan } from "@/src/observability/tracing";

function requireSession(session: ChatSession | null, sessionId: string): ChatSession {
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  return session;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function getProviderDescriptorOrThrow(providerId: string): ProviderDescriptor {
  const provider = listProviders().find((item) => item.id === providerId);
  if (!provider) {
    throw new Error(`Provider not configured: ${providerId}`);
  }
  return provider;
}

function emptyUsage() {
  return {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    providerRequestId: null,
  };
}

function calculateDurationMs(startedAt: string, completedAt: string | null): number | null {
  if (!completedAt) {
    return null;
  }

  return Math.max(0, Date.parse(completedAt) - Date.parse(startedAt));
}

function calculatePauseEffectiveMs(turn: ChatTurnRunSummary): number | null {
  if (!turn.timing.pauseRequestedAt || !turn.timing.pauseObservedAt) {
    return null;
  }

  return Math.max(0, Date.parse(turn.timing.pauseObservedAt) - Date.parse(turn.timing.pauseRequestedAt));
}

function calculatePromptChars(systemPrompt: string, messages: PromptMessage[]): number {
  return systemPrompt.length + messages.reduce((total, message) => total + message.content.length, 0);
}

function shouldCountAsError(outcome: ChatTurnOutcome): boolean {
  return outcome === "provider_error" || outcome === "validation_error";
}

class ChatTurnInterruptedError extends Error {
  constructor(
    readonly outcome: "paused_by_user" | "client_disconnected",
    message: string,
  ) {
    super(message);
    this.name = "ChatTurnInterruptedError";
  }
}

export class ChatService {
  private readonly repository = getChatSessionRepository();
  private readonly sessionMutationQueues = new Map<string, Promise<void>>();

  private async withSessionMutation<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionMutationQueues.get(sessionId) ?? Promise.resolve();
    let result: T | undefined;
    let capturedError: unknown;

    const current = previous
      .catch(() => undefined)
      .then(async () => {
        try {
          result = await operation();
        } catch (error) {
          capturedError = error;
        }
      });

    this.sessionMutationQueues.set(sessionId, current);
    await current;

    if (this.sessionMutationQueues.get(sessionId) === current) {
      this.sessionMutationQueues.delete(sessionId);
    }

    if (capturedError) {
      throw capturedError;
    }

    return result as T;
  }

  listProviders(): ProviderDescriptor[] {
    return listProviders();
  }

  async createSession(input: CreateSessionInput): Promise<ChatSession> {
    return withActiveSpan(CHAT_SPAN_NAMES.createSession, {}, async () => {
      const provider = getProviderDescriptorOrThrow(input.providerId);
      const timestamp = nowIso();

      const session: ChatSession = {
        id: createId("session"),
        title: input.title?.trim() || "未命名会话",
        settings: {
          providerId: provider.id,
          model: input.model?.trim() || provider.defaultModel,
          systemPrompt: input.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT,
          temperature: clamp(input.temperature ?? 0.2, 0, 2),
          maxTokens: Math.round(clamp(input.maxTokens ?? 1024, 128, 8192)),
          enablePromptCaching: input.enablePromptCaching ?? provider.supportsPromptCaching,
        },
        status: "idle",
        messages: [],
        turns: [],
        generation: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastError: null,
      };

      logger.info("chat.session.created", {
        component: "chat",
        sessionId: session.id,
        providerId: session.settings.providerId,
        model: session.settings.model,
      });

      return this.repository.create(session);
    });
  }

  async getSession(sessionId: string): Promise<ChatSession> {
    return withActiveSpan(CHAT_SPAN_NAMES.getSession, {
      attributes: {
        "chat.session.id": sessionId,
      },
    }, async () => requireSession(await this.repository.get(sessionId), sessionId));
  }

  async requestPause(sessionId: string): Promise<ChatSession> {
    return withActiveSpan(CHAT_SPAN_NAMES.requestPause, {
      attributes: {
        "chat.session.id": sessionId,
      },
    }, async () =>
      this.withSessionMutation(sessionId, async () => {
        const session = requireSession(await this.repository.get(sessionId), sessionId);
        if (!session.generation) {
          return session;
        }

        const requestedAt = nowIso();
        session.generation.pauseRequested = true;
        session.generation.pauseRequestedAt = requestedAt;

        const turn = this.findTurn(session, session.generation.turnId);
        if (turn) {
          turn.timing.pauseRequestedAt = requestedAt;
          chatMetrics.recordPauseRequest(buildTurnMetricAttributes(session, turn));
          logger.info("chat.turn.pause_requested", buildLogContext(session, turn));
        }

        session.updatedAt = requestedAt;
        return this.repository.save(session);
      }),
    );
  }

  async startTurn(sessionId: string, input: StartTurnInput): Promise<ChatSession> {
    return withActiveSpan(CHAT_SPAN_NAMES.startTurn, {
      attributes: {
        "chat.session.id": sessionId,
        "chat.turn.mode": input.mode,
      },
    }, async () =>
      this.withSessionMutation(sessionId, async () => {
        const session = requireSession(await this.repository.get(sessionId), sessionId);

        if (session.status === "generating") {
          throw new Error("A generation is already in progress.");
        }

        const timestamp = nowIso();
        const traceContext = getTraceContext();
        let assistantMessage: ChatMessage | undefined;
        let userMessageId: string | null = null;
        let parentTurnId: string | null = null;
        let rootTurnId: string | null = null;
        let inputChars = 0;

        if (input.mode === "reply") {
          const content = input.content.trim();
          if (!content) {
            throw new Error("Message content cannot be empty.");
          }

          const userMessage: ChatMessage = {
            id: createId("msg"),
            role: "user",
            content,
            state: "complete",
            createdAt: timestamp,
            updatedAt: timestamp,
          };

          assistantMessage = {
            id: createId("msg"),
            role: "assistant",
            content: "",
            state: "streaming",
            createdAt: timestamp,
            updatedAt: timestamp,
          };

          inputChars = content.length;
          userMessageId = userMessage.id;
          session.messages.push(userMessage, assistantMessage);
        }

        if (input.mode === "resume") {
          const resumedAssistantMessage = [...session.messages].reverse().find((message) => message.role === "assistant");
          if (!resumedAssistantMessage || resumedAssistantMessage.state !== "paused") {
            throw new Error("No paused assistant message is available to resume.");
          }

          assistantMessage = resumedAssistantMessage;
          const parentTurn = [...session.turns].reverse().find((turn) => turn.assistantMessageId === resumedAssistantMessage.id);
          parentTurnId = parentTurn?.id ?? null;
          rootTurnId = parentTurn?.rootTurnId ?? parentTurn?.id ?? null;
          userMessageId = parentTurn?.userMessageId ?? null;
          resumedAssistantMessage.state = "streaming";
          resumedAssistantMessage.updatedAt = timestamp;
        }

        if (!assistantMessage) {
          throw new Error("Assistant message could not be created.");
        }

        const turn: ChatTurnRunSummary = {
          id: createId("turn"),
          sequence: session.turns.length + 1,
          parentTurnId,
          rootTurnId: rootTurnId ?? parentTurnId ?? assistantMessage.id,
          assistantMessageId: assistantMessage.id,
          userMessageId,
          mode: input.mode,
          providerId: session.settings.providerId,
          model: session.settings.model,
          outcome: "in_progress",
          timing: {
            startedAt: timestamp,
            firstTokenAt: null,
            pauseRequestedAt: null,
            pauseObservedAt: null,
            completedAt: null,
          },
          promptRefs: [],
          usage: emptyUsage(),
          chunkCount: 0,
          inputChars,
          outputChars: assistantMessage.content.length,
          stopReason: null,
          errorMessage: null,
          traceId: traceContext.traceId,
          providerObservationId: null,
        };

        if (!turn.rootTurnId || turn.rootTurnId === assistantMessage.id) {
          turn.rootTurnId = parentTurnId ?? turn.id;
        }

        session.turns.push(turn);
        session.generation = {
          assistantMessageId: assistantMessage.id,
          turnId: turn.id,
          mode: input.mode,
          pauseRequested: false,
          pauseRequestedAt: null,
          startedAt: timestamp,
          traceId: traceContext.traceId,
        };
        session.status = "generating";
        session.lastError = null;
        session.updatedAt = timestamp;

        chatMetrics.recordTurnStarted(buildTurnMetricAttributes(session, turn));
        logger.info("chat.turn.started", buildLogContext(session, turn));

        return this.repository.save(session);
      }),
    );
  }

  async appendAssistantDelta(sessionId: string, text: string): Promise<ChatSession> {
    return this.withSessionMutation(sessionId, async () => {
      const session = requireSession(await this.repository.get(sessionId), sessionId);
      const generation = session.generation;
      if (!generation) {
        throw new Error("No active assistant message.");
      }

      const assistantMessage = session.messages.find((message) => message.id === generation.assistantMessageId);
      if (!assistantMessage) {
        throw new Error(`Assistant message not found: ${generation.assistantMessageId}`);
      }

      const turn = this.findTurn(session, generation.turnId);
      const timestamp = nowIso();

      assistantMessage.content += text;
      assistantMessage.updatedAt = timestamp;

      if (turn) {
        turn.chunkCount += 1;
        turn.outputChars += text.length;

        if (!turn.timing.firstTokenAt) {
          turn.timing.firstTokenAt = timestamp;
          const ttftMs = Math.max(0, Date.parse(timestamp) - Date.parse(turn.timing.startedAt));
          chatMetrics.recordTtft(ttftMs, buildTurnMetricAttributes(session, turn));
        }

        chatMetrics.recordStreamChunk(text.length, buildTurnMetricAttributes(session, turn));
      }

      session.updatedAt = assistantMessage.updatedAt;
      return this.repository.save(session);
    });
  }

  async finalizeTurn(sessionId: string): Promise<ChatSession> {
    return withActiveSpan(CHAT_SPAN_NAMES.finalizeTurn, {
      attributes: {
        "chat.session.id": sessionId,
      },
    }, async () =>
      this.withSessionMutation(sessionId, async () => {
        const session = requireSession(await this.repository.get(sessionId), sessionId);
        const generation = session.generation;
        if (!generation) {
          return session;
        }

        const assistantMessage = session.messages.find((message) => message.id === generation.assistantMessageId);
        const turn = this.findTurn(session, generation.turnId);
        const completedAt = nowIso();

        if (assistantMessage) {
          assistantMessage.state = "complete";
          assistantMessage.updatedAt = completedAt;
        }

        if (turn) {
          turn.outcome = "completed";
          turn.timing.completedAt = completedAt;
          updateActiveLangfuseSpan({
            output: {
              outcome: turn.outcome,
              outputChars: turn.outputChars,
              stopReason: turn.stopReason,
            },
            metadata: {
              turnId: turn.id,
              promptRefs: turn.promptRefs,
            },
            version: "chat-turn-finalize-v1",
          });
        }

        session.status = "idle";
        session.generation = null;
        session.updatedAt = completedAt;
        session.lastError = null;

        if (turn) {
          this.recordFinishedTurnMetrics(session, turn);
          // Score emission is intentionally fail-open and async-buffered inside
          // the Langfuse client so finalize latency stays bounded by repository IO.
          recordTurnOperationalScores(session, turn);
          logger.info("chat.turn.completed", buildLogContext(session, turn));
        }

        return this.repository.save(session);
      }),
    );
  }

  async markPaused(sessionId: string): Promise<ChatSession> {
    return withActiveSpan(CHAT_SPAN_NAMES.markPaused, {
      attributes: {
        "chat.session.id": sessionId,
      },
    }, async () =>
      this.withSessionMutation(sessionId, async () => {
        const session = requireSession(await this.repository.get(sessionId), sessionId);
        const generation = session.generation;
        if (!generation) {
          return session;
        }

        const assistantMessage = session.messages.find((message) => message.id === generation.assistantMessageId);
        const turn = this.findTurn(session, generation.turnId);
        const pausedAt = nowIso();

        if (assistantMessage) {
          assistantMessage.state = "paused";
          assistantMessage.updatedAt = pausedAt;
        }

        if (turn) {
          turn.outcome = "paused_by_user";
          turn.timing.pauseObservedAt = pausedAt;
          turn.timing.completedAt = pausedAt;
          updateActiveLangfuseSpan({
            output: {
              outcome: turn.outcome,
              outputChars: turn.outputChars,
            },
            metadata: {
              turnId: turn.id,
              promptRefs: turn.promptRefs,
            },
            version: "chat-turn-pause-v1",
          });
        }

        session.status = "paused";
        session.generation = null;
        session.updatedAt = pausedAt;

        if (turn) {
          this.recordFinishedTurnMetrics(session, turn);
          recordTurnOperationalScores(session, turn);
          logger.info("chat.turn.paused", buildLogContext(session, turn));
        }

        return this.repository.save(session);
      }),
    );
  }

  async markErrored(sessionId: string, message: string): Promise<ChatSession> {
    return withActiveSpan(CHAT_SPAN_NAMES.markErrored, {
      attributes: {
        "chat.session.id": sessionId,
      },
    }, async () =>
      this.withSessionMutation(sessionId, async () => {
        const session = requireSession(await this.repository.get(sessionId), sessionId);
        const generation = session.generation;
        const erroredAt = nowIso();
        const turn = generation ? this.findTurn(session, generation.turnId) : null;

        if (generation) {
          const assistantMessage = session.messages.find((entry) => entry.id === generation.assistantMessageId);
          if (assistantMessage) {
            assistantMessage.state = assistantMessage.content ? "paused" : "error";
            assistantMessage.updatedAt = erroredAt;
          }
        }

        if (turn) {
          turn.outcome = "provider_error";
          turn.errorMessage = message;
          turn.timing.completedAt = erroredAt;
          updateActiveLangfuseSpan({
            output: {
              outcome: turn.outcome,
              errorMessage: message,
            },
            metadata: {
              turnId: turn.id,
              promptRefs: turn.promptRefs,
            },
            version: "chat-turn-error-v1",
          });
        }

        session.status = session.messages.some((entry) => entry.state === "paused") ? "paused" : "error";
        session.generation = null;
        session.updatedAt = erroredAt;
        session.lastError = message;

        if (turn) {
          this.recordFinishedTurnMetrics(session, turn);
          recordTurnOperationalScores(session, turn);
          logger.error("chat.turn.failed", buildLogContext(session, turn));
        }

        return this.repository.save(session);
      }),
    );
  }

  async shouldPause(sessionId: string): Promise<boolean> {
    const session = requireSession(await this.repository.get(sessionId), sessionId);
    return Boolean(session.generation?.pauseRequested);
  }

  async streamTurn(sessionId: string, abortSignal: AbortSignal): Promise<{
    session: ChatSession;
    stream: AsyncGenerator<{ messageId: string; text: string }, ChatSession, undefined>;
  }> {
    const session = requireSession(await this.repository.get(sessionId), sessionId);
    const generation = session.generation;
    if (!generation) {
      throw new Error("No active generation found.");
    }

    const assistantMessage = session.messages.find((message) => message.id === generation.assistantMessageId);
    if (!assistantMessage) {
      throw new Error(`Assistant message not found: ${generation.assistantMessageId}`);
    }

    const turn = this.findTurn(session, generation.turnId);
    if (!turn) {
      throw new Error(`Turn not found: ${generation.turnId}`);
    }

    const systemPrompt = await resolveSystemPrompt(session.settings.systemPrompt);
    const resumePrompt = generation.mode === "resume" ? await resolveResumePrompt() : null;
    const requestMessages = await withActiveSpan(CHAT_SPAN_NAMES.buildPrompt, {
      attributes: buildTurnTraceAttributes(session, turn),
    }, async () => {
      const promptMessages = this.buildPromptMessages(
        session,
        generation.mode,
        assistantMessage.id,
        resumePrompt?.content ?? null,
      );
      const promptRefs = [systemPrompt.reference, ...(resumePrompt ? [resumePrompt.reference] : [])];
      await this.updateTurnPromptContext(
        sessionId,
        turn.id,
        promptRefs,
        calculatePromptChars(systemPrompt.content, promptMessages),
      );
      updateActiveLangfuseSpan({
        metadata: {
          promptRefs,
          mode: generation.mode,
          messageCount: promptMessages.length,
        },
        version: "chat-prompt-build-v1",
      });
      return promptMessages;
    });

    const provider = getProvider(session.settings.providerId);
    const upstreamAbort = new AbortController();
    abortSignal.addEventListener("abort", () => upstreamAbort.abort(abortSignal.reason), { once: true });

    const source = provider.stream({
      sessionId,
      turnId: turn.id,
      rootTurnId: turn.rootTurnId,
      mode: generation.mode,
      model: session.settings.model,
      systemPrompt: systemPrompt.content,
      messages: requestMessages,
      promptRefs: [systemPrompt.reference, ...(resumePrompt ? [resumePrompt.reference] : [])],
      temperature: session.settings.temperature,
      maxTokens: session.settings.maxTokens,
      enablePromptCaching: session.settings.enablePromptCaching,
      signal: upstreamAbort.signal,
    });

    const self = this;
    const { span: streamSpan } = startSpan(CHAT_SPAN_NAMES.streamTurn, {
      attributes: buildTurnTraceAttributes(session, turn),
    });

    return {
      session,
      stream: (async function* () {
        try {
          for await (const chunk of source) {
            const pauseRequested = await self.shouldPause(sessionId);
            if (pauseRequested) {
              streamSpan.addEvent(CHAT_SPAN_EVENTS.pauseRequested);
              upstreamAbort.abort("pause-requested");
              throw new ChatTurnInterruptedError("paused_by_user", "Pause requested by user");
            }

            if (abortSignal.aborted) {
              streamSpan.addEvent(CHAT_SPAN_EVENTS.clientDisconnected);
              upstreamAbort.abort(abortSignal.reason);
              throw new ChatTurnInterruptedError("client_disconnected", "Client disconnected during streaming");
            }

            if (chunk.type === "metadata") {
              await self.recordTurnMetadata(sessionId, chunk);
              streamSpan.addEvent(CHAT_SPAN_EVENTS.usageReceived, {
                "chat.provider_request.id": chunk.providerRequestId ?? "",
                "chat.stop_reason": chunk.stopReason ?? "",
              });
              continue;
            }

            if (chunk.type === "text-delta" && chunk.text) {
              const previousSession = await self.appendAssistantDelta(sessionId, chunk.text);
              const latestTurn = self.findTurn(previousSession, generation.turnId) ?? turn;
              if (latestTurn.timing.firstTokenAt && latestTurn.chunkCount === 1) {
                streamSpan.addEvent(CHAT_SPAN_EVENTS.firstToken);
              }
              yield {
                messageId: assistantMessage.id,
                text: chunk.text,
              };
            }
          }

          streamSpan.addEvent(CHAT_SPAN_EVENTS.turnCompleted);
          setSpanOk(streamSpan);
          return await self.finalizeTurn(sessionId);
        } catch (error) {
          if (error instanceof ChatTurnInterruptedError) {
            if (error.outcome === "paused_by_user") {
              streamSpan.addEvent(CHAT_SPAN_EVENTS.pauseObserved);
              setSpanOk(streamSpan);
              return await self.markPaused(sessionId);
            }

            setSpanOk(streamSpan);
            return await self.markInterrupted(sessionId, error.outcome, error.message);
          }

          streamSpan.addEvent(CHAT_SPAN_EVENTS.turnFailed, {
            "chat.error.message": error instanceof Error ? error.message : "Unknown generation error",
          });
          recordException(streamSpan, error);
          const message = error instanceof Error ? error.message : "Unknown generation error";
          await self.markErrored(sessionId, message);
          throw error;
        } finally {
          streamSpan.end();
        }
      })(),
    };
  }

  private async markInterrupted(
    sessionId: string,
    outcome: "client_disconnected",
    message: string,
  ): Promise<ChatSession> {
    return this.withSessionMutation(sessionId, async () => {
      const session = requireSession(await this.repository.get(sessionId), sessionId);
      const generation = session.generation;
      if (!generation) {
        return session;
      }

      const turn = this.findTurn(session, generation.turnId);
      const interruptedAt = nowIso();
      const assistantMessage = session.messages.find((entry) => entry.id === generation.assistantMessageId);
      const hasPartialContent = Boolean(assistantMessage?.content);

      if (assistantMessage) {
        assistantMessage.state = hasPartialContent ? "paused" : "error";
        assistantMessage.updatedAt = interruptedAt;
      }

      if (turn) {
        turn.outcome = outcome;
        turn.errorMessage = message;
        turn.timing.completedAt = interruptedAt;
        updateActiveLangfuseSpan({
          output: {
            outcome: turn.outcome,
            errorMessage: message,
          },
          metadata: {
            turnId: turn.id,
            promptRefs: turn.promptRefs,
          },
          version: "chat-turn-interrupted-v1",
        });
      }

      session.status = hasPartialContent ? "paused" : "error";
      session.generation = null;
      session.updatedAt = interruptedAt;
      session.lastError = hasPartialContent ? null : message;

      if (turn) {
        this.recordFinishedTurnMetrics(session, turn);
        recordTurnOperationalScores(session, turn);
        logger.warn("chat.turn.interrupted", buildLogContext(session, turn));
      }

      return this.repository.save(session);
    });
  }

  private async updateTurnPromptContext(
    sessionId: string,
    turnId: string,
    promptRefs: ChatPromptReference[],
    inputChars: number,
  ): Promise<void> {
    await this.withSessionMutation(sessionId, async () => {
      const session = requireSession(await this.repository.get(sessionId), sessionId);
      const turn = this.findTurn(session, turnId);
      if (!turn) {
        return;
      }

      turn.promptRefs = promptRefs;
      turn.inputChars = inputChars;
      session.updatedAt = nowIso();
      await this.repository.save(session);
    });
  }

  private async recordTurnMetadata(sessionId: string, chunk: Extract<StreamChunk, { type: "metadata" }>): Promise<void> {
    await this.withSessionMutation(sessionId, async () => {
      const session = requireSession(await this.repository.get(sessionId), sessionId);
      const generation = session.generation;
      if (!generation) {
        return;
      }

      const turn = this.findTurn(session, generation.turnId);
      if (!turn) {
        return;
      }

      const usage = chunk.usage ?? {};
      turn.usage = {
        inputTokens: usage.input_tokens ?? usage.prompt_tokens ?? turn.usage.inputTokens,
        outputTokens: usage.output_tokens ?? usage.completion_tokens ?? turn.usage.outputTokens,
        totalTokens:
          usage.total_tokens ??
          (usage.input_tokens ?? usage.prompt_tokens ?? turn.usage.inputTokens ?? 0) +
            (usage.output_tokens ?? usage.completion_tokens ?? turn.usage.outputTokens ?? 0),
        cacheCreationInputTokens:
          usage.cache_creation_input_tokens ?? turn.usage.cacheCreationInputTokens,
        cacheReadInputTokens: usage.cache_read_input_tokens ?? turn.usage.cacheReadInputTokens,
        providerRequestId: chunk.providerRequestId ?? turn.usage.providerRequestId,
      };
      turn.stopReason = chunk.stopReason ?? turn.stopReason;
      turn.providerObservationId = chunk.observationId ?? turn.providerObservationId;
      session.updatedAt = nowIso();

      if (typeof chunk.headersLatencyMs === "number") {
        chatMetrics.recordProviderRequest(chunk.headersLatencyMs, buildTurnMetricAttributes(session, turn));
      }

      await this.repository.save(session);
    });
  }

  private recordFinishedTurnMetrics(session: ChatSession, turn: ChatTurnRunSummary): void {
    const metricAttributes = buildTurnMetricAttributes(session, turn);
    const durationMs = calculateDurationMs(turn.timing.startedAt, turn.timing.completedAt);

    if (durationMs !== null) {
      chatMetrics.recordTurnFinished(durationMs, metricAttributes);
    }

    const pauseEffectiveMs = calculatePauseEffectiveMs(turn);
    if (pauseEffectiveMs !== null) {
      chatMetrics.recordPauseEffective(pauseEffectiveMs, metricAttributes);
    }

    if (shouldCountAsError(turn.outcome)) {
      chatMetrics.recordTurnError(metricAttributes);
    }
  }

  private findTurn(session: ChatSession, turnId: string): ChatTurnRunSummary | null {
    return session.turns.find((entry) => entry.id === turnId) ?? null;
  }

  private buildPromptMessages(
    session: ChatSession,
    mode: "reply" | "resume",
    activeAssistantMessageId: string,
    resumeInstruction: string | null,
  ): PromptMessage[] {
    const prompt: PromptMessage[] = [];

    for (const message of session.messages) {
      if (message.id === activeAssistantMessageId) {
        if (mode === "resume" && message.content) {
          prompt.push({
            role: "assistant",
            content: message.content,
          });
          if (resumeInstruction) {
            prompt.push({
              role: "user",
              content: resumeInstruction,
            });
          }
        }
        continue;
      }

      if (message.state === "error") {
        continue;
      }

      prompt.push({
        role: message.role,
        content: message.content,
      });
    }

    return prompt;
  }
}

declare global {
  var __chatService: ChatService | undefined;
}

export function getChatService(): ChatService {
  if (!globalThis.__chatService) {
    globalThis.__chatService = new ChatService();
  }
  return globalThis.__chatService;
}
