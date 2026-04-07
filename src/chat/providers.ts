import { startObservation } from "@langfuse/tracing";

import type {
  ChatPromptReference,
  PromptMessage,
  ProviderDescriptor,
  ProviderKind,
  ProviderStreamRequest,
  StreamChunk,
} from "./domain";
import { parseSseStream } from "./sse";
import { CHAT_SPAN_NAMES } from "./telemetry";
import { logger } from "@/src/observability/logger";

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

function getLatestConversationUserText(messages: PromptMessage[], mode: "reply" | "resume"): string {
  const userMessages = messages.filter((message) => message.role === "user");
  if (mode === "resume" && userMessages.length >= 2) {
    return userMessages.at(-2)?.content ?? userMessages.at(-1)?.content ?? "你好";
  }

  return userMessages.at(-1)?.content ?? "你好";
}

function getExistingAssistantPrefix(messages: PromptMessage[]): string {
  return [...messages].reverse().find((message) => message.role === "assistant")?.content ?? "";
}

function getSharedPrefixLength(left: string, right: string): number {
  const maxLength = Math.min(left.length, right.length);
  let index = 0;

  while (index < maxLength && left[index] === right[index]) {
    index += 1;
  }

  return index;
}

function buildMockReplyOutput(request: ProviderStreamRequest): string {
  const lastUserText = getLatestConversationUserText(request.messages, request.mode);

  return [
    "这是一个用于验证暂停与继续流程的 mock 响应。",
    `当前模型配置为 ${request.model}。`,
    `最近一条用户输入摘要：${lastUserText.slice(0, 80)}。`,
    "在接入真实 provider 后，这里会替换为厂商流式输出。",
  ].join(" ");
}

function buildMockStreamOutput(request: ProviderStreamRequest): string {
  const fullOutput = buildMockReplyOutput(request);
  if (request.mode !== "resume") {
    return fullOutput;
  }

  const existingAssistantPrefix = getExistingAssistantPrefix(request.messages);
  if (!existingAssistantPrefix) {
    return fullOutput;
  }

  const sharedPrefixLength = getSharedPrefixLength(fullOutput, existingAssistantPrefix);
  const remainder = fullOutput.slice(sharedPrefixLength);

  // Resume should model "continue from where you left off" rather than restart
  // the canned response. If the previous prefix cannot be aligned cleanly we
  // fall back to the full output so the mock provider still returns something.
  return remainder.length > 0 ? remainder : " 续写部分已经完成。";
}

function getProviderRequestId(headers: Headers): string | undefined {
  return (
    headers.get("anthropic-request-id") ??
    headers.get("x-request-id") ??
    headers.get("request-id") ??
    headers.get("openai-request-id") ??
    undefined
  );
}

function buildLangfusePrompt(promptRefs: ChatPromptReference[]) {
  const prompt = promptRefs.find((entry) => entry.key === "system") ?? promptRefs[0];
  if (!prompt) {
    return undefined;
  }

  return {
    name: prompt.name,
    version: prompt.version,
    isFallback: prompt.isFallback,
  };
}

function mapUsageDetails(usage?: Record<string, number>) {
  if (!usage) {
    return undefined;
  }

  return {
    promptTokens: usage.input_tokens ?? usage.prompt_tokens,
    completionTokens: usage.output_tokens ?? usage.completion_tokens,
    totalTokens: usage.total_tokens,
    cacheCreationInputTokens: usage.cache_creation_input_tokens,
    cacheReadInputTokens: usage.cache_read_input_tokens,
  };
}

function createGenerationMetadata(definition: ProviderDefinition, request: ProviderStreamRequest) {
  return {
    providerId: definition.id,
    sessionId: request.sessionId,
    turnId: request.turnId,
    rootTurnId: request.rootTurnId,
    mode: request.mode,
    promptRefs: request.promptRefs,
    promptCaching: request.enablePromptCaching,
  };
}

function startProviderGeneration(definition: ProviderDefinition, request: ProviderStreamRequest) {
  // We create the Langfuse observation synchronously so it inherits the active
  // trace context from the HTTP request before the async generator starts.
  return startObservation(
    CHAT_SPAN_NAMES.providerStream,
    {
      input: {
        systemPrompt: request.systemPrompt,
        messages: request.messages,
      },
      metadata: createGenerationMetadata(definition, request),
      version: "chat-provider-v2",
      model: request.model,
      modelParameters: {
        temperature: request.temperature,
        maxTokens: request.maxTokens,
      },
      prompt: buildLangfusePrompt(request.promptRefs),
    },
    { asType: "generation" },
  );
}

class AnthropicProvider implements LlmProvider {
  constructor(private readonly definition: ProviderDefinition) {}

  get descriptor(): ProviderDescriptor {
    const { id, kind, label, description, defaultModel, supportsPromptCaching } = this.definition;
    return { id, kind, label, description, defaultModel, supportsPromptCaching };
  }

  stream(request: ProviderStreamRequest): AsyncGenerator<StreamChunk, void, undefined> {
    const generation = startProviderGeneration(this.definition, request);
    const definition = this.definition;

    return (async function* () {
      const requestStartedAt = performance.now();
      let providerRequestId: string | undefined;
      let latestStopReason: string | undefined;
      let completionStarted = false;

      try {
        const response = await fetch(`${definition.baseUrl}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": definition.apiKey ?? "",
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

        const headersLatencyMs = performance.now() - requestStartedAt;
        providerRequestId = getProviderRequestId(response.headers);
        generation.update({
          metadata: {
            ...createGenerationMetadata(definition, request),
            providerRequestId,
            headersLatencyMs,
            httpStatus: response.status,
          },
        });

        if (!response.ok || !response.body) {
          throw new Error(`Anthropic request failed with status ${response.status}`);
        }

        yield {
          type: "metadata",
          observationId: generation.id,
          providerRequestId,
          responseStatus: response.status,
          headersLatencyMs,
        };

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
            if (!completionStarted) {
              generation.update({
                completionStartTime: new Date(),
              });
              completionStarted = true;
            }

            yield {
              type: "text-delta",
              text: payload.delta.text,
            };
          }

          if (event.event === "message_delta" || event.event === "message_stop") {
            latestStopReason = payload.delta?.stop_reason ?? payload.stop_reason ?? latestStopReason;
            generation.update({
              usageDetails: mapUsageDetails(payload.usage),
              metadata: {
                providerRequestId,
                stopReason: latestStopReason ?? null,
              },
            });
            yield {
              type: "metadata",
              observationId: generation.id,
              usage: payload.usage,
              stopReason: latestStopReason,
              providerRequestId,
              responseStatus: response.status,
            };
          }
        }

        generation.update({
          output: {
            stopReason: latestStopReason ?? null,
            providerRequestId: providerRequestId ?? null,
          },
        });
        logger.info("chat.provider.completed", {
          component: "provider",
          providerId: definition.id,
          model: request.model,
        });
      } catch (error) {
        generation.update({
          level: "ERROR",
          statusMessage: error instanceof Error ? error.message : "Provider request failed",
          output: {
            errorMessage: error instanceof Error ? error.message : String(error),
          },
        });
        logger.error("chat.provider.failed", {
          component: "provider",
          providerId: definition.id,
          model: request.model,
        }, error);
        throw error;
      } finally {
        generation.end();
      }
    })();
  }
}

class OpenAiCompatibleProvider implements LlmProvider {
  constructor(private readonly definition: ProviderDefinition) {}

  get descriptor(): ProviderDescriptor {
    const { id, kind, label, description, defaultModel, supportsPromptCaching } = this.definition;
    return { id, kind, label, description, defaultModel, supportsPromptCaching };
  }

  stream(request: ProviderStreamRequest): AsyncGenerator<StreamChunk, void, undefined> {
    const generation = startProviderGeneration(this.definition, request);
    const definition = this.definition;

    return (async function* () {
      const requestStartedAt = performance.now();
      let providerRequestId: string | undefined;
      let latestStopReason: string | undefined;
      let completionStarted = false;

      try {
        const response = await fetch(`${definition.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${definition.apiKey ?? ""}`,
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

        const headersLatencyMs = performance.now() - requestStartedAt;
        providerRequestId = getProviderRequestId(response.headers);
        generation.update({
          metadata: {
            ...createGenerationMetadata(definition, request),
            providerRequestId,
            headersLatencyMs,
            httpStatus: response.status,
          },
        });

        if (!response.ok || !response.body) {
          throw new Error(`OpenAI-compatible request failed with status ${response.status}`);
        }

        yield {
          type: "metadata",
          observationId: generation.id,
          providerRequestId,
          responseStatus: response.status,
          headersLatencyMs,
        };

        for await (const event of parseSseStream(response.body)) {
          if (!event.data) {
            continue;
          }

          if (event.data === "[DONE]") {
            break;
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
            if (!completionStarted) {
              generation.update({
                completionStartTime: new Date(),
              });
              completionStarted = true;
            }

            yield {
              type: "text-delta",
              text,
            };
          }

          if (choice?.finish_reason || payload.usage) {
            latestStopReason = choice?.finish_reason ?? latestStopReason;
            generation.update({
              usageDetails: mapUsageDetails(payload.usage),
              metadata: {
                providerRequestId,
                stopReason: latestStopReason ?? null,
              },
            });
            yield {
              type: "metadata",
              observationId: generation.id,
              usage: payload.usage,
              stopReason: latestStopReason ?? undefined,
              providerRequestId,
              responseStatus: response.status,
            };
          }
        }

        generation.update({
          output: {
            stopReason: latestStopReason ?? null,
            providerRequestId: providerRequestId ?? null,
          },
        });
        logger.info("chat.provider.completed", {
          component: "provider",
          providerId: definition.id,
          model: request.model,
        });
      } catch (error) {
        generation.update({
          level: "ERROR",
          statusMessage: error instanceof Error ? error.message : "Provider request failed",
          output: {
            errorMessage: error instanceof Error ? error.message : String(error),
          },
        });
        logger.error("chat.provider.failed", {
          component: "provider",
          providerId: definition.id,
          model: request.model,
        }, error);
        throw error;
      } finally {
        generation.end();
      }
    })();
  }
}

class MockProvider implements LlmProvider {
  constructor(private readonly definition: ProviderDefinition) {}

  get descriptor(): ProviderDescriptor {
    const { id, kind, label, description, defaultModel, supportsPromptCaching } = this.definition;
    return { id, kind, label, description, defaultModel, supportsPromptCaching };
  }

  stream(request: ProviderStreamRequest): AsyncGenerator<StreamChunk, void, undefined> {
    const generation = startProviderGeneration(this.definition, request);

    return (async function* () {
      try {
        const output = buildMockStreamOutput(request);

        generation.update({
          metadata: {
            sessionId: request.sessionId,
            turnId: request.turnId,
            mode: request.mode,
            mock: true,
          },
        });

        yield {
          type: "metadata",
          observationId: generation.id,
          providerRequestId: "mock-request",
          responseStatus: 200,
          headersLatencyMs: 0,
        };

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

        generation.update({
          output: {
            stopReason: "end_turn",
            providerRequestId: "mock-request",
          },
        });

        yield {
          type: "metadata",
          observationId: generation.id,
          stopReason: "end_turn",
          providerRequestId: "mock-request",
          responseStatus: 200,
        };
      } finally {
        generation.end();
      }
    })();
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
      const unsupportedKind = definition.kind as never;
      throw new Error(`Unsupported provider kind: ${unsupportedKind}`);
    }
  }
}
