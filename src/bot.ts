import { Bot, InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import { CountryService } from "./country-service.ts";
import { safeMessage } from "./sanitize.ts";
import { Store } from "./store.ts";

interface BotConfig {
  token: string;
  ownerId: number;
}

export function createBot(config: BotConfig, store: Store, service: CountryService): Bot {
  const bot = new Bot(config.token);

  bot.command("start", (ctx) => ctx.reply(helpText()));
  bot.command("help", (ctx) => ctx.reply(helpText()));

  bot.command("countries", authorized(config, store, async (ctx) => {
    const countries = service.listCountries();
    await ctx.reply(countries.length ? `Страны: ${countries.join(", ")}` : "Страны пока не добавлены.");
  }));

  bot.command("set", authorized(config, store, async (ctx) => {
    const [slug, ...uriParts] = commandText(ctx).split(/\s+/);
    const uri = uriParts.join("");
    if (!slug || !uri) {
      await ctx.reply("Использование: /set usa <vless://...>");
      return;
    }
    await ctx.reply(`Проверяю и применяю ${slug}...`);
    const result = await service.setCountry(ctx.from!.id, slug, uri);
    const action = result.createdCountry ? "добавлена" : "обновлена";
    await ctx.reply(`Страна ${slug} ${action}. Новых профилей: ${result.created.length}.`);
  }));

  bot.command("sync", authorized(config, store, async (ctx) => {
    const result = await service.sync(ctx.from!.id);
    await ctx.reply(`Синхронизация завершена. Новых профилей: ${result.created.length}. Переименовано: ${result.renamed.length}.`);
  }));

  bot.command("remove", authorized(config, store, async (ctx) => {
    const slug = commandText(ctx);
    if (!slug) {
      await ctx.reply("Использование: /remove usa");
      return;
    }
    await ctx.reply(
      `Удалить страну ${slug} и её управляемые профили?`,
      { reply_markup: new InlineKeyboard().text("Удалить", `remove:${slug}`).text("Отмена", "remove:cancel") },
    );
  }));

  bot.callbackQuery(/^remove:(.+)$/, authorized(config, store, async (ctx) => {
    const slug = ctx.callbackQuery?.data?.slice("remove:".length) ?? "";
    await ctx.answerCallbackQuery();
    if (slug === "cancel") {
      await ctx.editMessageText("Удаление отменено.");
      return;
    }
    const deleted = await service.removeCountry(ctx.from!.id, slug);
    await ctx.editMessageText(`Страна ${slug} удалена. Удалено профилей: ${deleted}.`);
  }));

  bot.command("allow", ownerOnly(config, async (ctx) => {
    const telegramId = parseTelegramId(commandText(ctx));
    store.addTrustedUser(telegramId);
    await ctx.reply(`Пользователь ${telegramId} добавлен.`);
  }));

  bot.command("deny", ownerOnly(config, async (ctx) => {
    const telegramId = parseTelegramId(commandText(ctx));
    store.deleteTrustedUser(telegramId);
    await ctx.reply(`Пользователь ${telegramId} удалён.`);
  }));

  bot.command("trusted", ownerOnly(config, async (ctx) => {
    const ids = store.listTrustedUsers();
    await ctx.reply(ids.length ? `Доверенные пользователи:\n${ids.join("\n")}` : "Список доверенных пользователей пуст.");
  }));

  bot.catch(({ error, ctx }) => {
    const text = safeMessage(error);
    console.error(`[telegram] update ${ctx.update.update_id} failed: ${text}`);
    void ctx.reply(`Ошибка: ${text}`).catch(() => {});
  });

  return bot;
}

function authorized(
  config: BotConfig,
  store: Store,
  handler: (ctx: Context) => Promise<void>,
): (ctx: Context) => Promise<void> {
  return async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId || (userId !== config.ownerId && !store.isTrustedUser(userId))) {
      await ctx.reply("Недостаточно прав.");
      return;
    }
    await handler(ctx);
  };
}

function ownerOnly(
  config: BotConfig,
  handler: (ctx: Context) => Promise<void>,
): (ctx: Context) => Promise<void> {
  return async (ctx) => {
    if (ctx.from?.id !== config.ownerId) {
      await ctx.reply("Команда доступна только владельцу.");
      return;
    }
    await handler(ctx);
  };
}

function parseTelegramId(value: string): number {
  const id = Number(value.trim());
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error("Укажите корректный Telegram ID.");
  }
  return id;
}

function commandText(ctx: Context): string {
  return typeof ctx.match === "string" ? ctx.match.trim() : "";
}

function helpText(): string {
  return [
    "/countries - список стран",
    "/set usa <vless://...> - добавить или заменить страну",
    "/remove usa - удалить страну",
    "/sync - добавить недостающие профили подписок",
    "/allow <telegram-id>, /deny <telegram-id>, /trusted - управление доступом владельцем",
  ].join("\n");
}
