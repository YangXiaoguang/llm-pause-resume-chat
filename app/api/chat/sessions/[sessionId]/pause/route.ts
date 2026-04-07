import { NextResponse } from "next/server";

import { getChatService } from "@/src/chat/service";
import { logger } from "@/src/observability/logger";
import { withActiveSpan } from "@/src/observability/tracing";
import { CHAT_SPAN_NAMES } from "@/src/chat/telemetry";

export const runtime = "nodejs";

export async function POST(_: Request, context: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await context.params;

  return withActiveSpan(CHAT_SPAN_NAMES.requestPause, {
    attributes: {
      "chat.session.id": sessionId,
    },
  }, async () => {
    try {
      const session = await getChatService().requestPause(sessionId);
      return NextResponse.json({ session });
    } catch (error) {
      logger.error("chat.http.pause.failed", {
        component: "route",
        route: "/api/chat/sessions/[sessionId]/pause",
        sessionId,
      }, error);
      const message = error instanceof Error ? error.message : "Failed to request pause";
      return NextResponse.json({ error: message }, { status: 400 });
    }
  });
}
