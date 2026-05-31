export function safeMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value
    .replace(/vless:\/\/\S+/gi, "<redacted-vless-uri>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "<redacted-uuid>");
}

