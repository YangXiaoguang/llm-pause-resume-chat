import { NextResponse } from "next/server";

import { getChatService } from "@/src/chat/service";
import { logger } from "@/src/observability/logger";
import { withActiveSpan } from "@/src/observability/tracing";
import { CHAT_SPAN_NAMES } from "@/src/chat/telemetry";

export const runtime = "nodejs";

export async function GET(_: Request, context: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await context.params;

  return withActiveSpan(CHAT_SPAN_NAMES.getSession, {
    attributes: {
      "chat.session.id": sessionId,
    },
  }, async () => {
    try {
      const session = await getChatService().getSession(sessionId);
      return NextResponse.json({ session });
    } catch (error) {
      logger.error("chat.http.get_session.failed", {
        component: "route",
        route: "/api/chat/sessions/[sessionId]",
        sessionId,
      }, error);
      const message = error instanceof Error ? error.message : "Session lookup failed";
      return NextResponse.json({ error: message }, { status: 404 });
    }
  });
}
