import { dirname, join } from "node:path";

export interface AppConfig {
  telegramBotToken: string;
  telegramOwnerId: number;
  xuiBaseUrl: string;
  xuiUsername: string;
  xuiPassword: string;
  xuiInboundId: number;
  geOutboundTag: string;
  databasePath: string;
  /** JSON written by scripts/setup-ge-ipv6-slots.ts; absent file disables per-account IPv6 exits. */
  geIpv6SlotsPath: string;
  nordVpnPrivateKey?: string;
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
  const databasePath = env.DATABASE_PATH?.trim() || "./data/bot.sqlite";
  return {
    telegramBotToken: required(env, "TELEGRAM_BOT_TOKEN"),
    telegramOwnerId: positiveInteger(required(env, "TELEGRAM_OWNER_ID"), "TELEGRAM_OWNER_ID"),
    xuiBaseUrl: required(env, "XUI_BASE_URL").replace(/\/+$/, ""),
    xuiUsername: required(env, "XUI_USERNAME"),
    xuiPassword: required(env, "XUI_PASSWORD"),
    xuiInboundId: positiveInteger(required(env, "XUI_INBOUND_ID"), "XUI_INBOUND_ID"),
    geOutboundTag: outboundTag(required(env, "GE_OUTBOUND_TAG")),
    databasePath,
    geIpv6SlotsPath: env.GE_IPV6_SLOTS_PATH?.trim() || join(dirname(databasePath), "ge-ipv6-slots.json"),
    nordVpnPrivateKey: env.NORDVPN_PRIVATE_KEY?.trim() || undefined,
  };
}
