import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ChatGeneration, ChatPromptReference, ChatSession, ChatTurnRunSummary } from "./domain";
import { chatMetrics } from "@/src/observability/metrics";
import { logger } from "@/src/observability/logger";

export interface ChatSessionRepository {
  readonly kind: "memory" | "file";
  create(session: ChatSession): Promise<ChatSession>;
  get(sessionId: string): Promise<ChatSession | null>;
  save(session: ChatSession): Promise<ChatSession>;
}

function normalizeGeneration(generation: ChatGeneration | null | undefined): ChatGeneration | null {
  if (!generation) {
    return null;
  }

  return {
    ...generation,
    turnId: generation.turnId ?? generation.assistantMessageId,
    pauseRequestedAt: generation.pauseRequestedAt ?? null,
    traceId: generation.traceId ?? null,
  };
}

function normalizePromptReference(reference: ChatPromptReference): ChatPromptReference {
  return {
    ...reference,
    label: reference.label ?? null,
    commitMessage: reference.commitMessage ?? null,
  };
}

function normalizeTurn(turn: ChatTurnRunSummary, sequence: number): ChatTurnRunSummary {
  return {
    ...turn,
    sequence: turn.sequence ?? sequence,
    rootTurnId: turn.rootTurnId ?? turn.parentTurnId ?? turn.id,
    userMessageId: turn.userMessageId ?? null,
    promptRefs: Array.isArray(turn.promptRefs) ? turn.promptRefs.map(normalizePromptReference) : [],
    providerObservationId: turn.providerObservationId ?? null,
  };
}

function normalizeSession(session: ChatSession): ChatSession {
  return {
    ...session,
    turns: Array.isArray(session.turns) ? session.turns.map((turn, index) => normalizeTurn(turn, index + 1)) : [],
    generation: normalizeGeneration(session.generation),
  };
}

async function measureRepositoryOperation<T>(
  repositoryKind: "memory" | "file",
  operation: "create" | "get" | "save",
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();

  try {
    const result = await fn();
    chatMetrics.recordRepositoryOperation(performance.now() - startedAt, {
      repository: repositoryKind,
      operation,
      outcome: "ok",
    });
    return result;
  } catch (error) {
    chatMetrics.recordRepositoryOperation(performance.now() - startedAt, {
      repository: repositoryKind,
      operation,
      outcome: "error",
    });
    logger.error("chat.repository.operation_failed", {
      component: "repository",
      outcome: "error",
    }, error);
    throw error;
  }
}

class MemoryChatSessionRepository implements ChatSessionRepository {
  readonly kind = "memory" as const;

  private readonly sessions = new Map<string, ChatSession>();

  async create(session: ChatSession): Promise<ChatSession> {
    return measureRepositoryOperation(this.kind, "create", async () => {
      const normalized = normalizeSession(session);
      this.sessions.set(session.id, structuredClone(normalized));
      return structuredClone(normalized);
    });
  }

  async get(sessionId: string): Promise<ChatSession | null> {
    return measureRepositoryOperation(this.kind, "get", async () => {
      const session = this.sessions.get(sessionId);
      return session ? structuredClone(normalizeSession(session)) : null;
    });
  }

  async save(session: ChatSession): Promise<ChatSession> {
    return measureRepositoryOperation(this.kind, "save", async () => {
      const normalized = normalizeSession(session);
      this.sessions.set(session.id, structuredClone(normalized));
      return structuredClone(normalized);
    });
  }
}

class FileChatSessionRepository implements ChatSessionRepository {
  readonly kind = "file" as const;

  constructor(private readonly rootDir: string) {}

  async create(session: ChatSession): Promise<ChatSession> {
    return measureRepositoryOperation(this.kind, "create", async () => {
      const normalized = normalizeSession(session);
      await this.writeSession(normalized);
      return structuredClone(normalized);
    });
  }

  async get(sessionId: string): Promise<ChatSession | null> {
    return measureRepositoryOperation(this.kind, "get", async () => {
      const filePath = this.filePath(sessionId);
      try {
        const content = await readFile(filePath, "utf8");
        return normalizeSession(JSON.parse(content) as ChatSession);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return null;
        }
        throw error;
      }
    });
  }

  async save(session: ChatSession): Promise<ChatSession> {
    return measureRepositoryOperation(this.kind, "save", async () => {
      const normalized = normalizeSession(session);
      await this.writeSession(normalized);
      return structuredClone(normalized);
    });
  }

  private async writeSession(session: ChatSession): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    await writeFile(this.filePath(session.id), JSON.stringify(session, null, 2), "utf8");
  }

  private filePath(sessionId: string): string {
    return path.join(this.rootDir, `${sessionId}.json`);
  }
}

declare global {
  var __chatSessionRepository: ChatSessionRepository | undefined;
}

export function getChatSessionRepository(): ChatSessionRepository {
  if (globalThis.__chatSessionRepository) {
    return globalThis.__chatSessionRepository;
  }

  const mode = process.env.CHAT_SESSION_REPOSITORY ?? "file";

  globalThis.__chatSessionRepository =
    mode === "memory"
      ? new MemoryChatSessionRepository()
      : new FileChatSessionRepository(path.join(process.cwd(), ".data", "chat-sessions"));

  return globalThis.__chatSessionRepository;
}
