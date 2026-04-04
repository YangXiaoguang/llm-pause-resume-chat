import { NextResponse } from "next/server";

import { getChatService } from "@/src/chat/service";

export const runtime = "nodejs";

export async function GET() {
  const chatService = getChatService();
  return NextResponse.json({
    providers: chatService.listProviders(),
  });
}
