import { createHash } from "node:crypto";

import { getObservabilityConfig } from "./config";

export function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function summarizeText(value: string, maxLength = 120): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}...`;
}

export function captureText(value: string): string | { hash: string; length: number; summary?: string } {
  const config = getObservabilityConfig();

  if (!value) {
    return "";
  }

  if (config.captureContentMode === "full") {
    return value;
  }

  const base = {
    hash: hashText(value),
    length: value.length,
  };

  if (config.captureContentMode === "summary") {
    return {
      ...base,
      summary: summarizeText(value),
    };
  }

  return base;
}

export function sanitizeErrorMessage(message: string): string {
  return summarizeText(message, 200);
}
