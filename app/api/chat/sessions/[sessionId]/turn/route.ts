import { getChatService } from "@/src/chat/service";
import type { StreamEnvelope } from "@/src/chat/domain";

export const runtime = "nodejs";

function toSseChunk(envelope: StreamEnvelope): string {
  return `event: ${envelope.event}\ndata: ${JSON.stringify(envelope.data)}\n\n`;
}

export async function POST(request: Request, context: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await context.params;

  try {
    const body = (await request.json()) as
      | {
          mode: "reply";
          content: string;
        }
      | {
          mode: "resume";
        };

    const chatService = getChatService();
    const startedSession = await chatService.startTurn(sessionId, body);
    const { stream } = await chatService.streamTurn(sessionId, request.signal);

    const responseStream = new ReadableStream<Uint8Array>({
      async start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              toSseChunk({
                event: "session",
                data: startedSession,
              }),
            ),
          );

        try {
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
              controller.close();
              return;
            }

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
        }
      },
    });

    return new Response(responseStream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      },
    });
  } catch (error) {
    const payload = {
      message: error instanceof Error ? error.message : "Invalid request",
    };

    return new Response(toSseChunk({ event: "error", data: payload }), {
      status: 400,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
      },
    });
  }
}
