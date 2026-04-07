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

export type ChatTurnOutcome =
  | "in_progress"
  | "completed"
  | "paused_by_user"
  | "client_disconnected"
  | "provider_error"
  | "validation_error";

export type ChatUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
  providerRequestId: string | null;
};

export type ChatTiming = {
  startedAt: string;
  firstTokenAt: string | null;
  pauseRequestedAt: string | null;
  pauseObservedAt: string | null;
  completedAt: string | null;
};

export type ChatPromptReference = {
  key: string;
  name: string;
  version: number;
  label: string | null;
  source: "langfuse" | "local" | "session";
  isFallback: boolean;
  templateHash: string;
  templateLength: number;
  compiledHash: string;
  compiledLength: number;
  commitMessage: string | null;
};

export type ChatTurnRunSummary = {
  id: string;
  sequence: number;
  parentTurnId: string | null;
  rootTurnId: string;
  assistantMessageId: string;
  userMessageId: string | null;
  mode: "reply" | "resume";
  providerId: string;
  model: string;
  outcome: ChatTurnOutcome;
  timing: ChatTiming;
  promptRefs: ChatPromptReference[];
  usage: ChatUsage;
  chunkCount: number;
  inputChars: number;
  outputChars: number;
  stopReason: string | null;
  errorMessage: string | null;
  traceId: string | null;
  providerObservationId: string | null;
};

export type ChatGeneration = {
  assistantMessageId: string;
  turnId: string;
  mode: "reply" | "resume";
  pauseRequested: boolean;
  pauseRequestedAt: string | null;
  startedAt: string;
  traceId: string | null;
};

export type ChatSession = {
  id: string;
  title: string;
  settings: ChatSettings;
  status: ChatSessionStatus;
  messages: ChatMessage[];
  turns: ChatTurnRunSummary[];
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
  sessionId: string;
  turnId: string;
  rootTurnId: string;
  mode: "reply" | "resume";
  model: string;
  systemPrompt: string;
  messages: PromptMessage[];
  promptRefs: ChatPromptReference[];
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
      providerRequestId?: string | undefined;
      observationId?: string | undefined;
      responseStatus?: number | undefined;
      headersLatencyMs?: number | undefined;
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
