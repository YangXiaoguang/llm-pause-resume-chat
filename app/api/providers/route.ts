import { NextResponse } from "next/server";

import { getChatService } from "@/src/chat/service";
import { logger } from "@/src/observability/logger";
import { withActiveSpan } from "@/src/observability/tracing";

export const runtime = "nodejs";

export async function GET() {
  return withActiveSpan("chat.providers.list", {}, async () => {
    try {
      const chatService = getChatService();
      return NextResponse.json({
        providers: chatService.listProviders(),
      });
    } catch (error) {
      logger.error("chat.http.providers.failed", {
        component: "route",
        route: "/api/providers",
      }, error);
      return NextResponse.json({
        error: error instanceof Error ? error.message : "Failed to list providers",
      }, { status: 500 });
    }
  });
}
