import { NextRequest, NextResponse } from "next/server";

import { getChatService } from "@/src/chat/service";
import { logger } from "@/src/observability/logger";
import { withActiveSpan } from "@/src/observability/tracing";
import { CHAT_SPAN_NAMES } from "@/src/chat/telemetry";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  return withActiveSpan(CHAT_SPAN_NAMES.createSession, {}, async () => {
    try {
      const body = (await request.json()) as {
        providerId: string;
        model?: string;
        systemPrompt?: string;
        temperature?: number;
        maxTokens?: number;
        enablePromptCaching?: boolean;
        title?: string;
      };

      const session = await getChatService().createSession(body);
      return NextResponse.json({ session }, { status: 201 });
    } catch (error) {
      logger.error("chat.http.create_session.failed", {
        component: "route",
        route: "/api/chat/sessions",
      }, error);
      const message = error instanceof Error ? error.message : "Failed to create session";
      return NextResponse.json({ error: message }, { status: 400 });
    }
  });
}
