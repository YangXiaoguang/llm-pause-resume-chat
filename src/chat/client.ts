"use client";

import { useEffect, useMemo, useRef, useState, startTransition } from "react";

import type { ChatSession, ProviderDescriptor, StreamEnvelope } from "./domain";

type UseChatControllerResult = {
  providers: ProviderDescriptor[];
  selectedProviderId: string;
  setSelectedProviderId: (providerId: string) => void;
  session: ChatSession | null;
  input: string;
  setInput: (value: string) => void;
  isBootstrapping: boolean;
  isStreaming: boolean;
  error: string | null;
  createSession: () => Promise<void>;
  sendMessage: () => Promise<void>;
  pauseMessage: () => Promise<void>;
  resumeMessage: () => Promise<void>;
};

async function fetchJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error ?? `Request failed with status ${response.status}`);
  }

  return (await response.json()) as T;
}

async function readEventStream(
  response: Response,
  onEvent: (event: StreamEnvelope) => void,
): Promise<void> {
  if (!response.body) {
    throw new Error("Missing response body.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      return;
    }

    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary === -1) {
        break;
      }

      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      let eventName = "message";
      const dataLines: string[] = [];

      for (const line of block.split("\n").map((entry) => entry.replace(/\r$/, ""))) {
        if (line.startsWith("event:")) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
      }

      if (!dataLines.length) {
        continue;
      }

      onEvent({
        event: eventName,
        data: JSON.parse(dataLines.join("\n")) as never,
      } as StreamEnvelope);
    }
  }
}

export function useChatController(): UseChatControllerResult {
  const [providers, setProviders] = useState<ProviderDescriptor[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [session, setSession] = useState<ChatSession | null>(null);
  const [input, setInput] = useState("");
  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeAbortRef = useRef<AbortController | null>(null);

  const activeProvider = useMemo(
    () => providers.find((provider) => provider.id === selectedProviderId) ?? null,
    [providers, selectedProviderId],
  );

  const applyStreamEvent = (event: StreamEnvelope) => {
    if (event.event === "session" || event.event === "done") {
      setSession(event.data);
      if (event.event === "done") {
        setIsStreaming(false);
      }
      return;
    }

    if (event.event === "text-delta") {
      setSession((current) => {
        if (!current) {
          return current;
        }

        return {
          ...current,
          messages: current.messages.map((message) =>
            message.id === event.data.messageId
              ? {
                  ...message,
                  content: message.content + event.data.text,
                  updatedAt: new Date().toISOString(),
                }
              : message,
          ),
          updatedAt: new Date().toISOString(),
        };
      });
      return;
    }

    setError(event.data.message);
    setIsStreaming(false);
  };

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      try {
        const payload = await fetchJson<{ providers: ProviderDescriptor[] }>("/api/providers");
        if (cancelled) {
          return;
        }

        setProviders(payload.providers);
        const defaultProviderId = payload.providers[0]?.id ?? "";
        setSelectedProviderId(defaultProviderId);

        if (defaultProviderId) {
          startTransition(() => {
            void createSessionInternal(defaultProviderId);
          });
        }
      } catch (bootstrapError) {
        if (!cancelled) {
          setError(bootstrapError instanceof Error ? bootstrapError.message : "Bootstrap failed");
        }
      } finally {
        if (!cancelled) {
          setIsBootstrapping(false);
        }
      }
    }

    void bootstrap();

    return () => {
      cancelled = true;
      activeAbortRef.current?.abort();
    };
  }, []);

  async function createSessionInternal(providerId: string) {
    setError(null);
    const provider = providers.find((entry) => entry.id === providerId);
    const payload = await fetchJson<{ session: ChatSession }>("/api/chat/sessions", {
      method: "POST",
      body: JSON.stringify({
        providerId,
        model: provider?.defaultModel,
        title: `会话 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`,
        enablePromptCaching: provider?.supportsPromptCaching ?? false,
      }),
    });
    setSession(payload.session);
  }

  async function createSession() {
    if (!selectedProviderId) {
      return;
    }

    setInput("");
    await createSessionInternal(selectedProviderId);
  }

  async function beginStream(body: { mode: "reply"; content: string } | { mode: "resume" }) {
    if (!session) {
      throw new Error("Session is not ready.");
    }

    const abortController = new AbortController();
    activeAbortRef.current = abortController;
    setIsStreaming(true);
    setError(null);

    try {
      const response = await fetch(`/api/chat/sessions/${session.id}/turn`, {
        method: "POST",
        body: JSON.stringify(body),
        headers: {
          "content-type": "application/json",
        },
        signal: abortController.signal,
      });

      await readEventStream(response, applyStreamEvent);
    } catch (streamError) {
      if ((streamError as DOMException).name !== "AbortError") {
        throw streamError;
      }
    } finally {
      activeAbortRef.current = null;
      setIsStreaming(false);
    }
  }

  async function sendMessage() {
    const content = input.trim();
    if (!session || !content || isStreaming) {
      return;
    }

    setInput("");
    await beginStream({
      mode: "reply",
      content,
    });
  }

  async function pauseMessage() {
    if (!session || !isStreaming) {
      return;
    }

    await fetchJson(`/api/chat/sessions/${session.id}/pause`, {
      method: "POST",
    });
    activeAbortRef.current?.abort();
    setSession((current) =>
      current
        ? {
            ...current,
            status: "paused",
            messages: current.messages.map((message) =>
              current.generation?.assistantMessageId === message.id
                ? {
                    ...message,
                    state: "paused",
                  }
                : message,
            ),
          }
        : current,
    );

    const payload = await fetchJson<{ session: ChatSession }>(`/api/chat/sessions/${session.id}`);
    setSession(payload.session);
    setIsStreaming(false);
  }

  async function resumeMessage() {
    if (!session || isStreaming || session.status !== "paused") {
      return;
    }

    await beginStream({
      mode: "resume",
    });
  }

  return {
    providers,
    selectedProviderId,
    setSelectedProviderId,
    session,
    input,
    setInput,
    isBootstrapping,
    isStreaming,
    error,
    createSession,
    sendMessage,
    pauseMessage,
    resumeMessage,
  };
}

export function useActiveProvider(providers: ProviderDescriptor[], providerId: string) {
  return useMemo(() => providers.find((provider) => provider.id === providerId) ?? null, [providers, providerId]);
}
