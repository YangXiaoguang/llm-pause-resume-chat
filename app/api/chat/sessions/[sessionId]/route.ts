import { NextResponse } from "next/server";

import { getChatService } from "@/src/chat/service";

export const runtime = "nodejs";

export async function GET(_: Request, context: { params: Promise<{ sessionId: string }> }) {
  try {
    const { sessionId } = await context.params;
    const session = await getChatService().getSession(sessionId);
    return NextResponse.json({ session });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Session lookup failed";
    return NextResponse.json({ error: message }, { status: 404 });
  }
}
