import { getChatService } from "@/src/chat/service";
import { CHAT_SPAN_EVENTS, CHAT_SPAN_NAMES, buildRouteAttributes } from "@/src/chat/telemetry";
import type { StreamEnvelope } from "@/src/chat/domain";
import { updateActiveLangfuseSpan, withLangfuseTraceAttributes } from "@/src/observability/langfuse";
import { logger } from "@/src/observability/logger";
import { chatMetrics } from "@/src/observability/metrics";
import { recordException, setSpanOk, startSpan, withActiveSpan } from "@/src/observability/tracing";

export const runtime = "nodejs";

function toSseChunk(envelope: StreamEnvelope): string {
  return `event: ${envelope.event}\ndata: ${JSON.stringify(envelope.data)}\n\n`;
}

function getRequestId(request: Request): string {
  return request.headers.get("x-request-id") ?? request.headers.get("x-vercel-id") ?? crypto.randomUUID();
}

export async function POST(request: Request, context: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await context.params;
  const requestId = getRequestId(request);
  const route = "/api/chat/sessions/[sessionId]/turn";

  return withActiveSpan(CHAT_SPAN_NAMES.turnRequest, {
    attributes: buildRouteAttributes(route, requestId, sessionId),
  }, async () => {
    try {
      const body = (await request.json()) as
        | {
            mode: "reply";
            content: string;
          }
        | {
            mode: "resume";
          };

      logger.info("chat.http.turn_request.started", {
        component: "route",
        requestId,
        route,
        sessionId,
      });
      updateActiveLangfuseSpan({
        input: body,
        metadata: {
          requestId,
          route,
        },
        version: "chat-http-turn-v2",
      });

      const chatService = getChatService();
      const { startedSession, stream } = await withLangfuseTraceAttributes(
        {
          sessionId,
          version: "chat-session-v2",
          tags: ["chat", "pause-resume", body.mode],
          metadata: {
            requestId,
            route,
          },
        },
        async () => {
          const session = await chatService.startTurn(sessionId, body);
          const streamResult = await chatService.streamTurn(sessionId, request.signal);
          return {
            startedSession: session,
            stream: streamResult.stream,
          };
        },
      );

      request.signal.addEventListener(
        "abort",
        () => {
          chatMetrics.recordSseDisconnect({
            route,
          });
          logger.warn("chat.http.turn_request.aborted", {
            component: "route",
            requestId,
            route,
            sessionId,
          });
        },
        { once: true },
      );

      const responseStream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const { span: sseSpan } = startSpan(CHAT_SPAN_NAMES.sseStream, {
            attributes: buildRouteAttributes(route, requestId, sessionId),
          });
          let chunkCount = 0;

          try {
            controller.enqueue(
              new TextEncoder().encode(
                toSseChunk({
                  event: "session",
                  data: startedSession,
                }),
              ),
            );
            sseSpan.addEvent(CHAT_SPAN_EVENTS.sseOpened);

            while (true) {
              const next = await stream.next();
              if (next.done) {
                controller.enqueue(
                  new TextEncoder().encode(
                    toSseChunk({
                      event: "done",
                      data: next.value,
                    }),
                  ),
                );
                sseSpan.addEvent(CHAT_SPAN_EVENTS.sseClosed, {
                  "chat.sse.chunk_count": chunkCount,
                });
                setSpanOk(sseSpan);
                controller.close();
                return;
              }

              chunkCount += 1;
              controller.enqueue(
                new TextEncoder().encode(
                  toSseChunk({
                    event: "text-delta",
                    data: {
                      sessionId,
                      messageId: next.value.messageId,
                      text: next.value.text,
                    },
                  }),
                ),
              );
            }
          } catch (error) {
            recordException(sseSpan, error);
            controller.enqueue(
              new TextEncoder().encode(
                toSseChunk({
                  event: "error",
                  data: {
                    message: error instanceof Error ? error.message : "Generation failed",
                  },
                }),
              ),
            );
            controller.close();
          } finally {
            sseSpan.end();
          }
        },
      });

      return new Response(responseStream, {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-request-id": requestId,
        },
      });
    } catch (error) {
      logger.error("chat.http.turn_request.failed", {
        component: "route",
        requestId,
        route,
        sessionId,
      }, error);

      const payload = {
        message: error instanceof Error ? error.message : "Invalid request",
      };

      return new Response(toSseChunk({ event: "error", data: payload }), {
        status: 400,
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          "x-request-id": requestId,
        },
      });
    }
  });
}
