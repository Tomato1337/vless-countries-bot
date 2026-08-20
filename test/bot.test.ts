import { describe, expect, test } from "bun:test";
import { createBot } from "../src/bot.ts";
import { CountryService } from "../src/country-service.ts";
import { Store } from "../src/store.ts";
import type { NordVpnSource } from "../src/types.ts";
import { MockXui } from "./helpers.ts";

describe("Telegram bot UI", () => {
  test("shows the button-driven main menu to the owner", async () => {
    const { bot, calls } = setupBot();

    await bot.handleUpdate(messageUpdate("/start"));

    expect(buttonTexts(calls.at(-1)?.payload)).toEqual([
      "Exits",
      "Add manual VLESS",
      "Add NordVPN region",
      "Sync",
      "Help",
      "Trusted users",
    ]);
  });

  test("shows Repair only for NordVPN exit cards", async () => {
    const { bot, calls, store } = setupBot();
    store.upsertManualExit("usa", "vless://secret", { tag: "countries-exit-usa", protocol: "vless" });
    store.upsertNordVpnExit(
      "us-chicago",
      nordSource(),
      { tag: "countries-nord-exit-us-chicago", protocol: "wireguard", settings: { secretKey: "secret" } },
    );

    await bot.handleUpdate(callbackUpdate(`x:v:${store.getExit("usa")!.id}`));
    expect(buttonTexts(calls.at(-1)?.payload)).toContain("Replace URI");
    expect(buttonTexts(calls.at(-1)?.payload)).not.toContain("Repair automatically");

    await bot.handleUpdate(callbackUpdate(`x:v:${store.getExit("us-chicago")!.id}`, 2));
    expect(buttonTexts(calls.at(-1)?.payload)).toContain("Repair automatically");
    expect(buttonTexts(calls.at(-1)?.payload)).toContain("Choose server");
  });

  test("rejects management commands outside a private chat", async () => {
    const { bot, calls } = setupBot();

    await bot.handleUpdate(messageUpdate("/start", "group"));

    expect((calls.at(-1)?.payload as { text?: string }).text).toBe(
      "Управление VPN доступно только в личном чате с ботом.",
    );
    expect(buttonTexts(calls.at(-1)?.payload)).toEqual([]);
  });

  test("shows first and last page navigation for long exit lists", async () => {
    const { bot, calls, store } = setupBot();
    for (let index = 0; index < 17; index += 1) {
      store.upsertManualExit(`us-${index}`, "vless://secret", {
        tag: `countries-exit-us-${index}`,
        protocol: "vless",
      });
    }

    await bot.handleUpdate(messageUpdate("/countries"));
    expect(buttonTexts(calls.at(-1)?.payload)).toContain("⏭");
    expect(buttonTexts(calls.at(-1)?.payload)).not.toContain("⏮");

    await bot.handleUpdate(callbackUpdate("m:exits:2", 2));
    expect(buttonTexts(calls.at(-1)?.payload)).toContain("⏮");
    expect(buttonTexts(calls.at(-1)?.payload)).not.toContain("⏭");
  });
});

function setupBot() {
  const store = new Store();
  const service = new CountryService(store, new MockXui(), { geOutboundTag: "germany", inboundId: 1 });
  const bot = createBot({ token: "123:secret", ownerId: 1 }, store, service);
  const calls: Array<{ method: string; payload: unknown }> = [];
  bot.botInfo = {
    id: 999,
    is_bot: true,
    first_name: "Test",
    username: "test_bot",
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_manage_bots: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
  };
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload });
    return { ok: true, result: apiResult(method, payload) } as never;
  });
  return { bot, calls, store };
}

function apiResult(method: string, payload: unknown): unknown {
  if (method === "sendMessage" || method === "editMessageText") {
    return {
      message_id: 100,
      date: 0,
      chat: { id: 1, type: "private" },
      text: String((payload as { text?: string }).text ?? ""),
    };
  }
  return true;
}

function messageUpdate(text: string, chatType: "private" | "group" = "private") {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: 0,
      chat: chatType === "private"
        ? { id: 1, type: "private" as const, first_name: "Owner" }
        : { id: -1, type: "group" as const, title: "Test" },
      from: { id: 1, is_bot: false, first_name: "Owner" },
      text,
      entities: [{ type: "bot_command" as const, offset: 0, length: text.length }],
    },
  };
}

function callbackUpdate(data: string, updateId = 1) {
  return {
    update_id: updateId,
    callback_query: {
      id: `callback-${updateId}`,
      chat_instance: "chat",
      from: { id: 1, is_bot: false, first_name: "Owner" },
      data,
      message: {
        message_id: 10,
        date: 0,
        chat: { id: 1, type: "private" as const, first_name: "Owner" },
        text: "menu",
      },
    },
  };
}

function buttonTexts(payload: unknown): string[] {
  const keyboard = (payload as {
    reply_markup?: { inline_keyboard?: Array<Array<{ text: string }>> };
  })?.reply_markup?.inline_keyboard ?? [];
  return keyboard.flat().map((button) => button.text);
}

function nordSource(): NordVpnSource {
  return {
    countryId: 1,
    countryCode: "US",
    countryName: "United States",
    cityId: 100,
    cityName: "Chicago",
    serverId: 1,
    serverName: "US one",
    hostname: "us-one.nordvpn.com",
    station: "198.51.100.1",
    load: 10,
    publicKey: "public-key",
  };
}
