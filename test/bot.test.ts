import { describe, expect, test } from "bun:test";
import { createBot } from "../src/bot.ts";
import { CountryService } from "../src/country-service.ts";
import { Store } from "../src/store.ts";
import type { NordVpnSource } from "../src/types.ts";
import { ProxyService } from "../src/proxy-service.ts";
import { MockUrnetwork, MockXui } from "./helpers.ts";

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
      "Proxies",
      "Trusted users",
      "Profiles",
      "Add user",
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

  test("lets only the owner create users; trusted admins keep country management", async () => {
    const { bot, calls, store, xui } = setupBot();
    store.addTrustedUser(2);

    await bot.handleUpdate(messageUpdate("/start", "private", 2));
    expect(buttonTexts(calls.at(-1)?.payload)).toContain("Add NordVPN region");
    expect(buttonTexts(calls.at(-1)?.payload)).not.toContain("Add user");
    await bot.handleUpdate(messageUpdate("/adduser petya", "private", 2));
    expect((calls.at(-1)?.payload as { text?: string }).text).toBe("Команда доступна только владельцу.");
    expect(xui.created).toEqual([]);

    await bot.handleUpdate(messageUpdate("/adduser petya"));
    expect(xui.created.map((client) => client.email)).toEqual(["petya-pc", "petya-phone", "petya-russia"]);
    expect((calls.at(-1)?.payload as { text?: string }).text).toContain("Подписка: https://sub.test:2096/sub/petya");
  });

  test("lists panel users by name, @login and bound profile, and limits them to that profile", async () => {
    const { bot, calls, store } = setupBot();
    store.addTrustedUser(2);
    await bot.handleUpdate(messageUpdate("/start", "private", 2, { first_name: "Петя", last_name: "Иванов", username: "petya" }));

    await bot.handleUpdate(callbackUpdate("t:bs:2:denis", 2));
    await bot.handleUpdate(messageUpdate("/trusted"));
    const text = (calls.at(-1)?.payload as { text?: string }).text;
    expect(text).toContain("Петя Иванов (@petya) · id 2 — trusted, профиль: denis");
    expect(buttonTexts(calls.at(-1)?.payload)).toContain("👤 @petya");

    await bot.handleUpdate(callbackUpdate("pf:v:denis", 3, 2));
    expect((calls.at(-1)?.payload as { text?: string }).text).toContain("Профиль denis (subId Denis)");
    await expect(bot.handleUpdate(callbackUpdate("pf:v:ilya", 4, 2))).rejects.toThrow("Нет доступа к профилю ilya");
  });

  test("owner sets a profile key and adds a URnetwork proxy to a selected profile through buttons", async () => {
    const { bot, calls, store, xui } = setupBot();

    await bot.handleUpdate(callbackUpdate("pf:k:ilya"));
    await bot.handleUpdate(messageUpdate("urn_ilya_key"));
    expect(store.getUrnetworkKey("Ilya")).toBe("urn_ilya_key");
    expect(calls.some((call) => call.method === "deleteMessage")).toBe(true);

    await bot.handleUpdate(callbackUpdate("p:urk:de:https:0", 2));
    expect(buttonTexts(calls.at(-1)?.payload)).toContain("▫️ ilya 🔑");
    await bot.handleUpdate(callbackUpdate("p:tt:0:ilya", 3));
    expect(buttonTexts(calls.at(-1)?.payload)).toContain("✅ ilya 🔑");
    await bot.handleUpdate(callbackUpdate("p:tok", 4));

    expect(xui.created.map((client) => client.email)).toEqual(["🇩🇪-ilya-ur-de-proxy"]);
    expect((calls.at(-1)?.payload as { text?: string }).text).toContain("Добавлено профилей: 1");
  });

  test("asks a bound admin without a key to add one, then continues to the location list", async () => {
    const { bot, calls, store } = setupBot();
    store.addTrustedUser(2);
    store.setProfileBinding(2, "Denis");

    await bot.handleUpdate(callbackUpdate("p:ur:0", 1, 2));
    expect((calls.at(-1)?.payload as { text?: string }).text).toContain("🔑 Ключ URnetwork для профиля denis");

    await bot.handleUpdate(messageUpdate("auth-code-123", "private", 2));
    expect(store.getUrnetworkKey("Denis")).toBe("urn_from_auth-code-123");
    const buttons = buttonTexts(calls.at(-1)?.payload);
    expect(buttons[0]).toBe("🌐 Best available — любой провайдер");
    expect(buttons).toContain("🇩🇪 Germany · 100");

    await bot.handleUpdate(callbackUpdate("p:urc:de:0", 3, 2));
    expect(buttonTexts(calls.at(-1)?.payload)).toContain("☐ Unique exit IP (UR Pro)");
    await bot.handleUpdate(callbackUpdate("p:urc:de:1", 4, 2));
    expect(buttonTexts(calls.at(-1)?.payload)).toContain("☑ Unique exit IP (UR Pro)");
  });
});

function setupBot() {
  const store = new Store();
  const xui = new MockXui();
  const service = new CountryService(store, xui, { geOutboundTag: "germany", inboundId: 1 });
  const proxies = new ProxyService(store, xui, new MockUrnetwork(), { geOutboundTag: "germany", inboundId: 1 }, service.mutex);
  const bot = createBot({ token: "123:secret", ownerId: 1 }, store, service, proxies);
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
  return { bot, calls, store, xui };
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

function messageUpdate(
  text: string,
  chatType: "private" | "group" = "private",
  fromId = 1,
  profile: { first_name: string; last_name?: string; username?: string } = { first_name: "User" },
) {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: 0,
      chat: chatType === "private"
        ? { id: fromId, type: "private" as const, first_name: profile.first_name }
        : { id: -1, type: "group" as const, title: "Test" },
      from: { id: fromId, is_bot: false, ...profile },
      text,
      entities: [{ type: "bot_command" as const, offset: 0, length: text.split(" ", 1)[0]!.length }],
    },
  };
}

function callbackUpdate(data: string, updateId = 1, fromId = 1) {
  return {
    update_id: updateId,
    callback_query: {
      id: `callback-${updateId}`,
      chat_instance: "chat",
      from: { id: fromId, is_bot: false, first_name: "Owner" },
      data,
      message: {
        message_id: 10,
        date: 0,
        chat: { id: fromId, type: "private" as const, first_name: "Owner" },
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
