type SseEvent = {
  event: string;
  data: string;
};

export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent, void, undefined> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary === -1) {
        break;
      }

      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      let event = "message";
      const dataLines: string[] = [];

      for (const line of rawEvent.split("\n").map((entry) => entry.replace(/\r$/, ""))) {
        if (line.startsWith("event:")) {
          event = line.slice(6).trim();
          continue;
        }

        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
      }

      yield {
        event,
        data: dataLines.join("\n"),
      };
    }
  }
}
