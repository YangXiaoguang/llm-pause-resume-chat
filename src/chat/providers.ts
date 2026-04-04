import type {
  PromptMessage,
  ProviderDescriptor,
  ProviderKind,
  ProviderStreamRequest,
  StreamChunk,
} from "./domain";
import { parseSseStream } from "./sse";

type ProviderDefinition = ProviderDescriptor & {
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
};

interface LlmProvider {
  readonly descriptor: ProviderDescriptor;
  stream(request: ProviderStreamRequest): AsyncGenerator<StreamChunk, void, undefined>;
}

function parseProviderListFromEnv(): ProviderDefinition[] {
  const raw = process.env.LLM_PROVIDER_REGISTRY_JSON;
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as Array<{
      id: string;
      kind: ProviderKind;
      label: string;
      description?: string;
      defaultModel: string;
      supportsPromptCaching?: boolean;
      baseUrl?: string;
      apiKey?: string;
      apiKeyEnv?: string;
    }>;

    return parsed
      .map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        label: entry.label,
        description: entry.description ?? `${entry.label} adapter`,
        defaultModel: entry.defaultModel,
        supportsPromptCaching: entry.supportsPromptCaching ?? entry.kind === "anthropic",
        baseUrl: entry.baseUrl,
        apiKey: entry.apiKey ?? (entry.apiKeyEnv ? process.env[entry.apiKeyEnv] : undefined),
      }))
      .filter((entry) => entry.kind === "mock" || Boolean(entry.apiKey));
  } catch (error) {
    console.error("Failed to parse LLM_PROVIDER_REGISTRY_JSON", error);
    return [];
  }
}

function getBuiltInProviders(): ProviderDefinition[] {
  const providers: ProviderDefinition[] = [
    {
      id: "mock",
      kind: "mock",
      label: "Mock Provider",
      description: "Local deterministic provider for UI and pause/resume testing.",
      defaultModel: "mock-simulated-1",
      supportsPromptCaching: false,
    },
  ];

  if (process.env.ANTHROPIC_API_KEY) {
    providers.push({
      id: "anthropic",
      kind: "anthropic",
      label: "Anthropic Claude",
      description: "Claude Messages API with prompt-caching support.",
      defaultModel: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-20250514",
      supportsPromptCaching: true,
      baseUrl: process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com",
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
  }

  if (process.env.OPENAI_API_KEY) {
    providers.push({
      id: "openai",
      kind: "openai-compatible",
      label: "OpenAI-Compatible",
      description: "Chat Completions compatible endpoint.",
      defaultModel: process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
      supportsPromptCaching: false,
      baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  return providers;
}

function getProviderDefinitions(): ProviderDefinition[] {
  const dynamic = parseProviderListFromEnv();
  if (dynamic.length > 0) {
    return dynamic.some((provider) => provider.kind === "mock")
      ? dynamic
      : [...dynamic, ...getBuiltInProviders().filter((provider) => provider.id === "mock")];
  }
  return getBuiltInProviders();
}

function mapOpenAiMessages(systemPrompt: string, messages: PromptMessage[]) {
  return [
    { role: "system", content: systemPrompt },
    ...messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
  ];
}

class AnthropicProvider implements LlmProvider {
  constructor(private readonly definition: ProviderDefinition) {}

  get descriptor(): ProviderDescriptor {
    const { id, kind, label, description, defaultModel, supportsPromptCaching } = this.definition;
    return { id, kind, label, description, defaultModel, supportsPromptCaching };
  }

  async *stream(request: ProviderStreamRequest): AsyncGenerator<StreamChunk, void, undefined> {
    const response = await fetch(`${this.definition.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.definition.apiKey ?? "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: request.model,
        system: request.systemPrompt,
        messages: request.messages,
        max_tokens: request.maxTokens,
        temperature: request.temperature,
        stream: true,
        ...(request.enablePromptCaching
          ? {
              cache_control: {
                type: "ephemeral",
                ttl: "1h",
              },
            }
          : {}),
      }),
      signal: request.signal,
    });

    if (!response.ok || !response.body) {
      throw new Error(`Anthropic request failed with status ${response.status}`);
    }

    for await (const event of parseSseStream(response.body)) {
      if (!event.data || event.data === "[DONE]") {
        continue;
      }

      const payload = JSON.parse(event.data) as {
        type?: string;
        delta?: { type?: string; text?: string; stop_reason?: string };
        usage?: Record<string, number>;
        stop_reason?: string;
      };

      if (event.event === "content_block_delta" && payload.delta?.type === "text_delta" && payload.delta.text) {
        yield {
          type: "text-delta",
          text: payload.delta.text,
        };
      }

      if (event.event === "message_delta" || event.event === "message_stop") {
        yield {
          type: "metadata",
          usage: payload.usage,
          stopReason: payload.delta?.stop_reason ?? payload.stop_reason,
        };
      }
    }
  }
}

class OpenAiCompatibleProvider implements LlmProvider {
  constructor(private readonly definition: ProviderDefinition) {}

  get descriptor(): ProviderDescriptor {
    const { id, kind, label, description, defaultModel, supportsPromptCaching } = this.definition;
    return { id, kind, label, description, defaultModel, supportsPromptCaching };
  }

  async *stream(request: ProviderStreamRequest): AsyncGenerator<StreamChunk, void, undefined> {
    const response = await fetch(`${this.definition.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.definition.apiKey ?? ""}`,
      },
      body: JSON.stringify({
        model: request.model,
        messages: mapOpenAiMessages(request.systemPrompt, request.messages),
        temperature: request.temperature,
        max_tokens: request.maxTokens,
        stream: true,
      }),
      signal: request.signal,
    });

    if (!response.ok || !response.body) {
      throw new Error(`OpenAI-compatible request failed with status ${response.status}`);
    }

    for await (const event of parseSseStream(response.body)) {
      if (!event.data) {
        continue;
      }

      if (event.data === "[DONE]") {
        return;
      }

      const payload = JSON.parse(event.data) as {
        choices?: Array<{
          delta?: { content?: string };
          finish_reason?: string | null;
        }>;
        usage?: Record<string, number>;
      };

      const choice = payload.choices?.[0];
      const text = choice?.delta?.content;
      if (text) {
        yield {
          type: "text-delta",
          text,
        };
      }

      if (choice?.finish_reason) {
        yield {
          type: "metadata",
          usage: payload.usage,
          stopReason: choice.finish_reason,
        };
      }
    }
  }
}

class MockProvider implements LlmProvider {
  constructor(private readonly definition: ProviderDefinition) {}

  get descriptor(): ProviderDescriptor {
    const { id, kind, label, description, defaultModel, supportsPromptCaching } = this.definition;
    return { id, kind, label, description, defaultModel, supportsPromptCaching };
  }

  async *stream(request: ProviderStreamRequest): AsyncGenerator<StreamChunk, void, undefined> {
    const resumeHint = request.messages.at(-1)?.content.includes("继续") ? "已根据暂停内容继续作答。" : "";
    const lastUserText = [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "你好";

    const output = [
      resumeHint,
      "这是一个用于验证暂停与继续流程的 mock 响应。",
      `当前模型配置为 ${request.model}。`,
      `最近一条用户输入摘要：${lastUserText.slice(0, 80)}。`,
      "在接入真实 provider 后，这里会替换为厂商流式输出。",
    ]
      .filter(Boolean)
      .join(" ");

    for (const token of output.split(/(\s+)/)) {
      if (request.signal.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      if (!token) {
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
      yield {
        type: "text-delta",
        text: token,
      };
    }

    yield {
      type: "metadata",
      stopReason: "end_turn",
    };
  }
}

export function listProviders(): ProviderDescriptor[] {
  return getProviderDefinitions().map(({ id, kind, label, description, defaultModel, supportsPromptCaching }) => ({
    id,
    kind,
    label,
    description,
    defaultModel,
    supportsPromptCaching,
  }));
}

export function getProvider(providerId: string): LlmProvider {
  const definition = getProviderDefinitions().find((provider) => provider.id === providerId);
  if (!definition) {
    throw new Error(`Unknown provider: ${providerId}`);
  }

  switch (definition.kind) {
    case "anthropic":
      return new AnthropicProvider(definition);
    case "openai-compatible":
      return new OpenAiCompatibleProvider(definition);
    case "mock":
      return new MockProvider(definition);
    default: {
      const exhaustiveCheck: never = definition.kind;
      throw new Error(`Unsupported provider kind: ${exhaustiveCheck}`);
    }
  }
}
