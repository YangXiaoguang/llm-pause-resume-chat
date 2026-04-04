import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ChatSession } from "./domain";

export interface ChatSessionRepository {
  create(session: ChatSession): Promise<ChatSession>;
  get(sessionId: string): Promise<ChatSession | null>;
  save(session: ChatSession): Promise<ChatSession>;
}

class MemoryChatSessionRepository implements ChatSessionRepository {
  private readonly sessions = new Map<string, ChatSession>();

  async create(session: ChatSession): Promise<ChatSession> {
    this.sessions.set(session.id, structuredClone(session));
    return structuredClone(session);
  }

  async get(sessionId: string): Promise<ChatSession | null> {
    const session = this.sessions.get(sessionId);
    return session ? structuredClone(session) : null;
  }

  async save(session: ChatSession): Promise<ChatSession> {
    this.sessions.set(session.id, structuredClone(session));
    return structuredClone(session);
  }
}

class FileChatSessionRepository implements ChatSessionRepository {
  constructor(private readonly rootDir: string) {}

  async create(session: ChatSession): Promise<ChatSession> {
    await this.writeSession(session);
    return structuredClone(session);
  }

  async get(sessionId: string): Promise<ChatSession | null> {
    const filePath = this.filePath(sessionId);
    try {
      const content = await readFile(filePath, "utf8");
      return JSON.parse(content) as ChatSession;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async save(session: ChatSession): Promise<ChatSession> {
    await this.writeSession(session);
    return structuredClone(session);
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
