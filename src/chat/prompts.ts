import type { ChatPromptReference } from "./domain";
import { DEFAULT_SYSTEM_PROMPT } from "./domain";
import { getObservabilityConfig } from "@/src/observability/config";
import { getLangfuseClient } from "@/src/observability/langfuse";
import { hashText } from "@/src/observability/redaction";
import { logger } from "@/src/observability/logger";

export const DEFAULT_RESUME_PROMPT =
  "请从你上一条回复结束的位置继续，不要重复已经输出的内容。如果上一句没有说完，请自然接着写完。";

type PromptDefinition = {
  key: "system" | "resume_continue";
  name: string;
  version: number;
  fallback: string;
};

export type ResolvedPrompt = {
  content: string;
  reference: ChatPromptReference;
};

const PROMPT_DEFINITIONS: Record<PromptDefinition["key"], PromptDefinition> = {
  system: {
    key: "system",
    name: "chat-system",
    version: 1,
    fallback: DEFAULT_SYSTEM_PROMPT,
  },
  resume_continue: {
    key: "resume_continue",
    name: "chat-resume-continue",
    version: 1,
    fallback: DEFAULT_RESUME_PROMPT,
  },
};

function buildPromptReference(
  definition: PromptDefinition,
  content: string,
  source: ChatPromptReference["source"],
  overrides?: {
    version?: number;
    label?: string | null;
    isFallback?: boolean;
    commitMessage?: string | null;
  },
): ChatPromptReference {
  return {
    key: definition.key,
    name: definition.name,
    version: overrides?.version ?? definition.version,
    label: overrides?.label ?? null,
    source,
    isFallback: overrides?.isFallback ?? source !== "langfuse",
    templateHash: hashText(definition.fallback),
    templateLength: definition.fallback.length,
    compiledHash: hashText(content),
    compiledLength: content.length,
    commitMessage: overrides?.commitMessage ?? null,
  };
}

async function resolveManagedTextPrompt(
  definition: PromptDefinition,
  variables?: Record<string, string>,
): Promise<ResolvedPrompt> {
  const config = getObservabilityConfig();
  const langfuse = getLangfuseClient();

  if (!langfuse) {
    return {
      content: definition.fallback,
      reference: buildPromptReference(definition, definition.fallback, "local"),
    };
  }

  try {
    const prompt = await langfuse.prompt.get(definition.name, {
      type: "text",
      label: config.langfusePromptLabel,
      cacheTtlSeconds: config.langfusePromptCacheTtlSeconds,
      fallback: definition.fallback,
      fetchTimeoutMs: 1500,
    });

    const compiled = prompt.compile(variables);
    return {
      content: compiled,
      reference: buildPromptReference(definition, compiled, "langfuse", {
        version: prompt.version,
        label: config.langfusePromptLabel,
        isFallback: prompt.isFallback,
        commitMessage: prompt.commitMessage ?? null,
      }),
    };
  } catch (error) {
    logger.warn("chat.prompt.resolve_failed", {
      component: "prompt",
      outcome: "fallback",
    }, error);
    return {
      content: definition.fallback,
      reference: buildPromptReference(definition, definition.fallback, "local", {
        label: config.langfusePromptLabel,
      }),
    };
  }
}

export async function resolveSystemPrompt(sessionSystemPrompt: string): Promise<ResolvedPrompt> {
  const normalized = sessionSystemPrompt.trim();
  if (normalized && normalized !== DEFAULT_SYSTEM_PROMPT) {
    return {
      content: normalized,
      reference: buildPromptReference(
        {
          key: "system",
          name: "chat-system-custom",
          version: 1,
          fallback: normalized,
        },
        normalized,
        "session",
      ),
    };
  }

  return resolveManagedTextPrompt(PROMPT_DEFINITIONS.system);
}

export async function resolveResumePrompt(): Promise<ResolvedPrompt> {
  return resolveManagedTextPrompt(PROMPT_DEFINITIONS.resume_continue);
}
