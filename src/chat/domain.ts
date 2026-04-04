export type ChatRole = "user" | "assistant";

export type ChatMessageState = "complete" | "streaming" | "paused" | "error";

export type ChatSessionStatus = "idle" | "generating" | "paused" | "error";

export type ProviderKind = "anthropic" | "openai-compatible" | "mock";

export type ProviderDescriptor = {
  id: string;
  kind: ProviderKind;
  label: string;
  description: string;
  defaultModel: string;
  supportsPromptCaching: boolean;
};

export type ChatSettings = {
  providerId: string;
  model: string;
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
  enablePromptCaching: boolean;
};

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  state: ChatMessageState;
  createdAt: string;
  updatedAt: string;
};

export type ChatGeneration = {
  assistantMessageId: string;
  mode: "reply" | "resume";
  pauseRequested: boolean;
  startedAt: string;
};

export type ChatSession = {
  id: string;
  title: string;
  settings: ChatSettings;
  status: ChatSessionStatus;
  messages: ChatMessage[];
  generation: ChatGeneration | null;
  createdAt: string;
  updatedAt: string;
  lastError: string | null;
};

export type CreateSessionInput = {
  providerId: string;
  model?: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  enablePromptCaching?: boolean;
  title?: string;
};

export type StartTurnInput =
  | {
      mode: "reply";
      content: string;
    }
  | {
      mode: "resume";
    };

export type PromptMessage = {
  role: "user" | "assistant";
  content: string;
};

export type ProviderStreamRequest = {
  model: string;
  systemPrompt: string;
  messages: PromptMessage[];
  temperature: number;
  maxTokens: number;
  enablePromptCaching: boolean;
  signal: AbortSignal;
};

export type StreamChunk =
  | {
      type: "text-delta";
      text: string;
    }
  | {
      type: "metadata";
      usage?: Record<string, number> | undefined;
      stopReason?: string | undefined;
    };

export type StreamEnvelope =
  | {
      event: "session";
      data: ChatSession;
    }
  | {
      event: "text-delta";
      data: {
        sessionId: string;
        messageId: string;
        text: string;
      };
    }
  | {
      event: "done";
      data: ChatSession;
    }
  | {
      event: "error";
      data: {
        message: string;
      };
    };

export const DEFAULT_SYSTEM_PROMPT =
  "你是一个严谨的中文助手。回答要准确、结构清晰。如果用户要求继续上一条未完成回复，请直接续写，不要重复已输出内容。";
