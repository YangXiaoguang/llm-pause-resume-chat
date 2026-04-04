import { NextRequest, NextResponse } from "next/server";

import { getChatService } from "@/src/chat/service";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
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
    const message = error instanceof Error ? error.message : "Failed to create session";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
