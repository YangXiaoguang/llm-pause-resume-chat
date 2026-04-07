import { getObservabilityConfig, type ObservabilityLogLevel } from "./config";
import { sanitizeErrorMessage } from "./redaction";
import { withTraceContext, type ObservabilityContext } from "./context";

const LOG_LEVEL_PRIORITY: Record<ObservabilityLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function shouldLog(level: ObservabilityLogLevel): boolean {
  const configuredLevel = getObservabilityConfig().logLevel;
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[configuredLevel];
}

function serializeError(error: unknown): Record<string, unknown> | undefined {
  if (!error) {
    return undefined;
  }

  if (error instanceof Error) {
    return {
      name: error.name,
      message: sanitizeErrorMessage(error.message),
      stack: error.stack,
    };
  }

  return {
    message: sanitizeErrorMessage(String(error)),
  };
}

function writeLog(
  level: ObservabilityLogLevel,
  message: string,
  context: ObservabilityContext = {},
  error?: unknown,
): void {
  if (!shouldLog(level)) {
    return;
  }

  // We keep logs in JSON so they are easy to ship into Loki or any other
  // backend without having to retrofit parsing rules later.
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...withTraceContext(context),
    error: serializeError(error),
  };

  const serialized = JSON.stringify(payload);
  if (level === "error") {
    console.error(serialized);
    return;
  }

  if (level === "warn") {
    console.warn(serialized);
    return;
  }

  console.log(serialized);
}

export const logger = {
  debug(message: string, context?: ObservabilityContext) {
    writeLog("debug", message, context);
  },
  info(message: string, context?: ObservabilityContext) {
    writeLog("info", message, context);
  },
  warn(message: string, context?: ObservabilityContext, error?: unknown) {
    writeLog("warn", message, context, error);
  },
  error(message: string, context?: ObservabilityContext, error?: unknown) {
    writeLog("error", message, context, error);
  },
};
