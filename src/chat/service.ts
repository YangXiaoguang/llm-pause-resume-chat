import {
  DEFAULT_SYSTEM_PROMPT,
  type ChatMessage,
  type ChatSession,
  type CreateSessionInput,
  type PromptMessage,
  type ProviderDescriptor,
  type StartTurnInput,
} from "./domain";
import { createId, nowIso } from "./ids";
import { getProvider, listProviders } from "./providers";
import { getChatSessionRepository } from "./repository";

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

function continueInstruction(): string {
  return "请从你上一条回复结束的位置继续，不要重复已经输出的内容。如果上一句没有说完，请自然接着写完。";
}

export class ChatService {
  private readonly repository = getChatSessionRepository();

  listProviders(): ProviderDescriptor[] {
    return listProviders();
  }

  async createSession(input: CreateSessionInput): Promise<ChatSession> {
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
      generation: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastError: null,
    };

    return this.repository.create(session);
  }

  async getSession(sessionId: string): Promise<ChatSession> {
    return requireSession(await this.repository.get(sessionId), sessionId);
  }

  async requestPause(sessionId: string): Promise<ChatSession> {
    const session = requireSession(await this.repository.get(sessionId), sessionId);
    if (!session.generation) {
      return session;
    }

    session.generation.pauseRequested = true;
    session.updatedAt = nowIso();
    return this.repository.save(session);
  }

  async startTurn(sessionId: string, input: StartTurnInput): Promise<ChatSession> {
    const session = requireSession(await this.repository.get(sessionId), sessionId);

    if (session.status === "generating") {
      throw new Error("A generation is already in progress.");
    }

    const timestamp = nowIso();

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

      const assistantMessage: ChatMessage = {
        id: createId("msg"),
        role: "assistant",
        content: "",
        state: "streaming",
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      session.messages.push(userMessage, assistantMessage);
      session.generation = {
        assistantMessageId: assistantMessage.id,
        mode: "reply",
        pauseRequested: false,
        startedAt: timestamp,
      };
    }

    if (input.mode === "resume") {
      const assistantMessage = [...session.messages].reverse().find((message) => message.role === "assistant");
      if (!assistantMessage || assistantMessage.state !== "paused") {
        throw new Error("No paused assistant message is available to resume.");
      }

      assistantMessage.state = "streaming";
      assistantMessage.updatedAt = timestamp;
      session.generation = {
        assistantMessageId: assistantMessage.id,
        mode: "resume",
        pauseRequested: false,
        startedAt: timestamp,
      };
    }

    session.status = "generating";
    session.lastError = null;
    session.updatedAt = timestamp;
    return this.repository.save(session);
  }

  async appendAssistantDelta(sessionId: string, text: string): Promise<ChatSession> {
    const session = requireSession(await this.repository.get(sessionId), sessionId);
    const messageId = session.generation?.assistantMessageId;
    if (!messageId) {
      throw new Error("No active assistant message.");
    }

    const assistantMessage = session.messages.find((message) => message.id === messageId);
    if (!assistantMessage) {
      throw new Error(`Assistant message not found: ${messageId}`);
    }

    assistantMessage.content += text;
    assistantMessage.updatedAt = nowIso();
    session.updatedAt = assistantMessage.updatedAt;
    return this.repository.save(session);
  }

  async finalizeTurn(sessionId: string): Promise<ChatSession> {
    const session = requireSession(await this.repository.get(sessionId), sessionId);
    const messageId = session.generation?.assistantMessageId;
    if (!messageId) {
      return session;
    }

    const assistantMessage = session.messages.find((message) => message.id === messageId);
    if (assistantMessage) {
      assistantMessage.state = "complete";
      assistantMessage.updatedAt = nowIso();
    }

    session.status = "idle";
    session.generation = null;
    session.updatedAt = nowIso();
    session.lastError = null;
    return this.repository.save(session);
  }

  async markPaused(sessionId: string): Promise<ChatSession> {
    const session = requireSession(await this.repository.get(sessionId), sessionId);
    const messageId = session.generation?.assistantMessageId;
    if (!messageId) {
      return session;
    }

    const assistantMessage = session.messages.find((message) => message.id === messageId);
    if (assistantMessage) {
      assistantMessage.state = "paused";
      assistantMessage.updatedAt = nowIso();
    }

    session.status = "paused";
    session.generation = null;
    session.updatedAt = nowIso();
    return this.repository.save(session);
  }

  async markErrored(sessionId: string, message: string): Promise<ChatSession> {
    const session = requireSession(await this.repository.get(sessionId), sessionId);
    const messageId = session.generation?.assistantMessageId;
    if (messageId) {
      const assistantMessage = session.messages.find((entry) => entry.id === messageId);
      if (assistantMessage) {
        assistantMessage.state = assistantMessage.content ? "paused" : "error";
        assistantMessage.updatedAt = nowIso();
      }
    }

    session.status = session.messages.some((entry) => entry.state === "paused") ? "paused" : "error";
    session.generation = null;
    session.updatedAt = nowIso();
    session.lastError = message;
    return this.repository.save(session);
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

    const provider = getProvider(session.settings.providerId);
    const requestMessages = this.buildPromptMessages(session, generation.mode, assistantMessage.id);

    const upstreamAbort = new AbortController();
    abortSignal.addEventListener("abort", () => upstreamAbort.abort(abortSignal.reason), { once: true });

    const source = provider.stream({
      model: session.settings.model,
      systemPrompt: session.settings.systemPrompt,
      messages: requestMessages,
      temperature: session.settings.temperature,
      maxTokens: session.settings.maxTokens,
      enablePromptCaching: session.settings.enablePromptCaching,
      signal: upstreamAbort.signal,
    });

    const self = this;

    return {
      session,
      stream: (async function* () {
        try {
          for await (const chunk of source) {
            if (abortSignal.aborted || (await self.shouldPause(sessionId))) {
              upstreamAbort.abort("pause-requested");
              throw new DOMException("Paused", "AbortError");
            }

            if (chunk.type === "text-delta" && chunk.text) {
              await self.appendAssistantDelta(sessionId, chunk.text);
              yield {
                messageId: assistantMessage.id,
                text: chunk.text,
              };
            }
          }

          return await self.finalizeTurn(sessionId);
        } catch (error) {
          if (abortSignal.aborted || error instanceof DOMException) {
            return await self.markPaused(sessionId);
          }

          const message = error instanceof Error ? error.message : "Unknown generation error";
          await self.markErrored(sessionId, message);
          throw error;
        }
      })(),
    };
  }

  private buildPromptMessages(
    session: ChatSession,
    mode: "reply" | "resume",
    activeAssistantMessageId: string,
  ): PromptMessage[] {
    const prompt: PromptMessage[] = [];

    for (const message of session.messages) {
      if (message.id === activeAssistantMessageId) {
        if (mode === "resume" && message.content) {
          prompt.push({
            role: "assistant",
            content: message.content,
          });
          prompt.push({
            role: "user",
            content: continueInstruction(),
          });
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
