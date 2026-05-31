export interface AppConfig {
  telegramBotToken: string;
  telegramOwnerId: number;
  xuiBaseUrl: string;
  xuiUsername: string;
  xuiPassword: string;
  xuiInboundId: number;
  geOutboundTag: string;
  databasePath: string;
}

function required(env: Record<string, string | undefined>, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function positiveInteger(value: string, key: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
  return parsed;
}

function outboundTag(value: string): string {
  if (value.includes("://") || /\s/.test(value)) {
    throw new Error(
      "GE_OUTBOUND_TAG must be an existing Xray outbound tag, not a VLESS URI",
    );
  }
  return value;
}

export function loadConfig(env: Record<string, string | undefined> = Bun.env): AppConfig {
  return {
    telegramBotToken: required(env, "TELEGRAM_BOT_TOKEN"),
    telegramOwnerId: positiveInteger(required(env, "TELEGRAM_OWNER_ID"), "TELEGRAM_OWNER_ID"),
    xuiBaseUrl: required(env, "XUI_BASE_URL").replace(/\/+$/, ""),
    xuiUsername: required(env, "XUI_USERNAME"),
    xuiPassword: required(env, "XUI_PASSWORD"),
    xuiInboundId: positiveInteger(required(env, "XUI_INBOUND_ID"), "XUI_INBOUND_ID"),
    geOutboundTag: outboundTag(required(env, "GE_OUTBOUND_TAG")),
    databasePath: env.DATABASE_PATH?.trim() || "./data/bot.sqlite",
  };
}
