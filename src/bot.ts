import { Bot, InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import { countryFlagFromSlug } from "./country-flag.ts";
import { assertCountrySlug, CountryService } from "./country-service.ts";
import type { NordVpnCityOption } from "./country-service.ts";
import { safeMessage } from "./sanitize.ts";
import { Store } from "./store.ts";
import type { JsonObject, NordVpnSource, VpnExit } from "./types.ts";

interface BotConfig {
  token: string;
  ownerId: number;
}

const PAGE_SIZE = 8;
const WIZARD_TTL_MS = 15 * 60 * 1000;

export function createBot(config: BotConfig, store: Store, service: CountryService): Bot {
  const bot = new Bot(config.token);
  const auth = (handler: (ctx: Context) => Promise<void>) => authorized(config, store, handler);
  const owner = (handler: (ctx: Context) => Promise<void>) => ownerOnly(config, handler);

  bot.use(async (ctx, next) => {
    const type = ctx.message ? "message" : ctx.callbackQuery ? "callback_query" : "other";
    console.log(`[telegram] received update ${ctx.update.update_id} (${type})`);
    await next();
  });

  bot.command("start", auth((ctx) => showMain(ctx, config)));
  bot.command("help", auth(async (ctx) => {
    await ctx.reply(helpText());
  }));
  bot.command("countries", auth((ctx) => showExits(ctx, service)));
  bot.command("nord", auth((ctx) => showNordCountries(ctx, service)));

  bot.command("set", auth(async (ctx) => {
    const [slug, ...uriParts] = commandText(ctx).split(/\s+/);
    const uri = uriParts.join("");
    if (!slug || !uri) {
      await ctx.reply("Использование: /set usa <vless://...>");
      return;
    }
    await applyManualExit(ctx, service, slug, uri);
  }));

  bot.command("sync", auth(async (ctx) => {
    await ctx.reply("Синхронизирую профили подписок...");
    const result = await service.sync(ctx.from!.id);
    await ctx.reply(`Готово. Новых профилей: ${result.created.length}. Переименовано: ${result.renamed.length}.`);
  }));

  bot.command("remove", auth(async (ctx) => {
    const slug = commandText(ctx);
    if (!slug) {
      await ctx.reply("Использование: /remove usa");
      return;
    }
    const vpnExit = service.getExit(slug);
    if (!vpnExit) {
      throw new Error(`Exit does not exist: ${slug}`);
    }
    await confirmRemove(ctx, vpnExit);
  }));

  bot.command("allow", owner(async (ctx) => {
    const telegramId = parseTelegramId(commandText(ctx));
    store.addTrustedUser(telegramId);
    await ctx.reply(`Пользователь ${telegramId} добавлен.`);
  }));

  bot.command("deny", owner(async (ctx) => {
    const telegramId = parseTelegramId(commandText(ctx));
    store.deleteTrustedUser(telegramId);
    await ctx.reply(`Пользователь ${telegramId} удалён.`);
  }));

  bot.command("trusted", owner((ctx) => showTrusted(ctx, store)));

  bot.callbackQuery("m:home", auth(async (ctx) => {
    await answer(ctx);
    await clearWizard(ctx, store);
    await showMain(ctx, config);
  }));
  bot.callbackQuery(/^m:exits:(\d+)$/, auth(async (ctx) => {
    await answer(ctx);
    await showExits(ctx, service, callbackNumber(ctx, 1));
  }));
  bot.callbackQuery("m:manual", auth(async (ctx) => {
    await answer(ctx);
    saveWizard(ctx, store, "manual-add", "slug", {});
    await render(ctx, "Введите slug ручного выхода, например `usa` или `nl-free`.", cancelKeyboard());
  }));
  bot.callbackQuery("m:nord", auth(async (ctx) => {
    await answer(ctx);
    await showNordCountries(ctx, service);
  }));
  bot.callbackQuery("m:sync", auth(async (ctx) => {
    await answer(ctx);
    await render(ctx, "Синхронизирую профили подписок...");
    const result = await service.sync(ctx.from!.id);
    await ctx.reply(`Готово. Новых профилей: ${result.created.length}. Переименовано: ${result.renamed.length}.`);
    await showMain(ctx, config);
  }));
  bot.callbackQuery("m:help", auth(async (ctx) => {
    await answer(ctx);
    await render(ctx, helpText(), backHomeKeyboard());
  }));
  bot.callbackQuery("m:trusted", owner(async (ctx) => {
    await answer(ctx);
    await showTrusted(ctx, store);
  }));

  bot.callbackQuery(/^x:v:(\d+)$/, auth(async (ctx) => {
    await answer(ctx);
    await showExitCard(ctx, requireExit(service, callbackNumber(ctx, 1)));
  }));
  bot.callbackQuery(/^x:replace:(\d+)$/, auth(async (ctx) => {
    await answer(ctx);
    const vpnExit = requireExit(service, callbackNumber(ctx, 1));
    if (vpnExit.provider !== "manual-vless") {
      throw new Error("Only manual VLESS exits can be replaced with a URI");
    }
    saveWizard(ctx, store, "manual-replace", "uri", { slug: vpnExit.slug });
    await render(ctx, `Отправьте новый VLESS URI для ${vpnExit.slug}.`, cancelKeyboard());
  }));
  bot.callbackQuery(/^x:rm:(\d+)$/, auth(async (ctx) => {
    await answer(ctx);
    await confirmRemove(ctx, requireExit(service, callbackNumber(ctx, 1)));
  }));
  bot.callbackQuery(/^x:rmc:(\d+)$/, auth(async (ctx) => {
    await answer(ctx);
    const vpnExit = requireExit(service, callbackNumber(ctx, 1));
    const deleted = await service.removeCountry(ctx.from!.id, vpnExit.slug);
    await render(ctx, `Exit ${vpnExit.slug} удалён. Удалено профилей: ${deleted}.`, backHomeKeyboard());
  }));

  bot.callbackQuery(/^n:c:(\d+)$/, auth(async (ctx) => {
    await answer(ctx);
    await showNordCountries(ctx, service, callbackNumber(ctx, 1));
  }));
  bot.callbackQuery(/^n:ct:(\d+):(\d+)$/, auth(async (ctx) => {
    await answer(ctx);
    await showNordCities(ctx, service, callbackNumber(ctx, 1), callbackNumber(ctx, 2));
  }));
  bot.callbackQuery(/^n:city:(\d+):(\d+)$/, auth(async (ctx) => {
    await answer(ctx);
    const countryId = callbackNumber(ctx, 1);
    const cityId = callbackNumber(ctx, 2);
    const existing = service.findNordVpnExit(countryId, cityId);
    if (existing) {
      await showExitCard(ctx, existing);
      return;
    }
    const options = await service.listNordVpnCityOptions(countryId);
    const option = requireCityOption(options, cityId);
    if (option.existing) {
      await showExitCard(ctx, option.existing);
      return;
    }
    await render(
      ctx,
      `Добавить NordVPN-регион ${option.slug}? Выберите способ подбора сервера.`,
      new InlineKeyboard()
        .text("Автоподбор", `n:auto:${countryId}:${cityId}`)
        .text("Выбрать hostname", `n:s:${countryId}:${cityId}:0`)
        .row()
        .text("Назад", `n:ct:${countryId}:0`),
    );
  }));
  bot.callbackQuery(/^n:auto:(\d+):(\d+)$/, auth(async (ctx) => {
    await answer(ctx);
    const countryId = callbackNumber(ctx, 1);
    const cityId = callbackNumber(ctx, 2);
    await render(ctx, "Тестирую до пяти наименее загруженных NordVPN-серверов...");
    try {
      const result = await service.addNordVpnRegion(ctx.from!.id, countryId, cityId);
      await ctx.reply(`Добавлен ${result.slug}: ${result.source.hostname}. Новых профилей: ${result.created.length}.`);
      await showExitCard(ctx, requireExitBySlug(service, result.slug));
    } catch (error) {
      await ctx.reply(`Автоподбор не применил конфиг: ${safeMessage(error)}`);
      await showNordServers(ctx, service, countryId, cityId);
    }
  }));
  bot.callbackQuery(/^n:s:(\d+):(\d+):(\d+)$/, auth(async (ctx) => {
    await answer(ctx);
    await showNordServers(
      ctx,
      service,
      callbackNumber(ctx, 1),
      callbackNumber(ctx, 2),
      callbackNumber(ctx, 3),
    );
  }));
  bot.callbackQuery(/^n:pick:(\d+):(\d+):(\d+)$/, auth(async (ctx) => {
    await answer(ctx);
    const countryId = callbackNumber(ctx, 1);
    const cityId = callbackNumber(ctx, 2);
    const serverId = callbackNumber(ctx, 3);
    await render(ctx, "Тестирую выбранный NordVPN-сервер...");
    try {
      const result = await service.addNordVpnRegion(ctx.from!.id, countryId, cityId, serverId);
      await ctx.reply(`Добавлен ${result.slug}: ${result.source.hostname}. Новых профилей: ${result.created.length}.`);
      await showExitCard(ctx, requireExitBySlug(service, result.slug));
    } catch (error) {
      await ctx.reply(`Сервер не применён: ${safeMessage(error)}`);
      await showNordServers(ctx, service, countryId, cityId);
    }
  }));
  bot.callbackQuery(/^n:repair:(\d+)$/, auth(async (ctx) => {
    await answer(ctx);
    const vpnExit = requireExit(service, callbackNumber(ctx, 1));
    await render(ctx, `Ищу замену для ${vpnExit.slug}...`);
    try {
      const result = await service.repairNordVpnRegion(ctx.from!.id, vpnExit.slug);
      await ctx.reply(`Регион ${result.slug} обновлён: ${result.source.hostname}.`);
      await showExitCard(ctx, requireExitBySlug(service, result.slug));
    } catch (error) {
      await ctx.reply(`Repair не применил конфиг: ${safeMessage(error)}`);
      await showRepairServers(ctx, service, vpnExit);
    }
  }));
  bot.callbackQuery(/^n:rs:(\d+):(\d+)$/, auth(async (ctx) => {
    await answer(ctx);
    await showRepairServers(ctx, service, requireExit(service, callbackNumber(ctx, 1)), callbackNumber(ctx, 2));
  }));
  bot.callbackQuery(/^n:rp:(\d+):(\d+)$/, auth(async (ctx) => {
    await answer(ctx);
    const vpnExit = requireExit(service, callbackNumber(ctx, 1));
    await render(ctx, `Тестирую новый сервер для ${vpnExit.slug}...`);
    try {
      const result = await service.repairNordVpnRegion(ctx.from!.id, vpnExit.slug, callbackNumber(ctx, 2));
      await ctx.reply(`Регион ${result.slug} обновлён: ${result.source.hostname}.`);
      await showExitCard(ctx, requireExitBySlug(service, result.slug));
    } catch (error) {
      await ctx.reply(`Сервер не применён: ${safeMessage(error)}`);
      await showRepairServers(ctx, service, vpnExit);
    }
  }));

  bot.callbackQuery("q:exits", auth(async (ctx) => {
    await answer(ctx);
    saveWizard(ctx, store, "search", "exits", {});
    await render(ctx, "Введите slug, страну, город или hostname для поиска exits.", cancelKeyboard());
  }));
  bot.callbackQuery("q:countries", auth(async (ctx) => {
    await answer(ctx);
    saveWizard(ctx, store, "search", "countries", {});
    await render(ctx, "Введите название или ISO-код страны.", cancelKeyboard());
  }));
  bot.callbackQuery(/^q:cities:(\d+)$/, auth(async (ctx) => {
    await answer(ctx);
    saveWizard(ctx, store, "search", "cities", { countryId: callbackNumber(ctx, 1) });
    await render(ctx, "Введите название города.", cancelKeyboard());
  }));
  bot.callbackQuery("q:cancel", auth(async (ctx) => {
    await answer(ctx);
    await clearWizard(ctx, store);
    await showMain(ctx, config);
  }));

  bot.callbackQuery("t:list", owner(async (ctx) => {
    await answer(ctx);
    await showTrusted(ctx, store);
  }));
  bot.callbackQuery("t:add", owner(async (ctx) => {
    await answer(ctx);
    saveWizard(ctx, store, "trusted-add", "telegram-id", {});
    await render(ctx, "Отправьте Telegram ID пользователя.", cancelKeyboard());
  }));
  bot.callbackQuery(/^t:del:(\d+)$/, owner(async (ctx) => {
    await answer(ctx);
    const id = callbackNumber(ctx, 1);
    await render(
      ctx,
      `Удалить trusted-пользователя ${id}?`,
      new InlineKeyboard().text("Удалить", `t:dc:${id}`).text("Отмена", "t:list"),
    );
  }));
  bot.callbackQuery(/^t:dc:(\d+)$/, owner(async (ctx) => {
    await answer(ctx);
    store.deleteTrustedUser(callbackNumber(ctx, 1));
    await showTrusted(ctx, store);
  }));

  bot.on("message:text", auth(async (ctx) => {
    const session = store.getWizardSession(ctx.chat!.id, ctx.from!.id);
    if (!session) {
      return;
    }
    const text = ctx.message?.text?.trim();
    if (!text) {
      return;
    }
    if (session.flow === "manual-add" && session.step === "slug") {
      assertCountrySlug(text);
      countryFlagFromSlug(text);
      saveWizard(ctx, store, "manual-add", "uri", { slug: text });
      await ctx.reply(`Теперь отправьте VLESS URI для ${text}.`, { reply_markup: cancelKeyboard() });
      return;
    }
    if (session.flow === "manual-add" && session.step === "uri") {
      await clearWizard(ctx, store);
      await applyManualExit(ctx, service, String(session.payload.slug), text);
      return;
    }
    if (session.flow === "manual-replace" && session.step === "uri") {
      await clearWizard(ctx, store);
      await applyManualExit(ctx, service, String(session.payload.slug), text);
      return;
    }
    if (session.flow === "trusted-add" && session.step === "telegram-id") {
      const id = parseTelegramId(text);
      store.addTrustedUser(id);
      await clearWizard(ctx, store);
      await ctx.reply(`Пользователь ${id} добавлен.`);
      await showTrusted(ctx, store);
      return;
    }
    if (session.flow === "search" && session.step === "exits") {
      await clearWizard(ctx, store);
      await showExits(ctx, service, 0, text);
      return;
    }
    if (session.flow === "search" && session.step === "countries") {
      await clearWizard(ctx, store);
      await showNordCountries(ctx, service, 0, text);
      return;
    }
    if (session.flow === "search" && session.step === "cities") {
      await clearWizard(ctx, store);
      await showNordCities(ctx, service, Number(session.payload.countryId), 0, text);
    }
  }));

  bot.catch(({ error, ctx }) => {
    const text = safeMessage(error);
    console.error(`[telegram] update ${ctx.update.update_id} failed: ${text}`);
    void ctx.reply(`Ошибка: ${text}`).catch(() => {});
  });

  return bot;
}

async function showMain(ctx: Context, config: BotConfig): Promise<void> {
  const keyboard = new InlineKeyboard()
    .text("Exits", "m:exits:0")
    .text("Add manual VLESS", "m:manual")
    .row()
    .text("Add NordVPN region", "m:nord")
    .text("Sync", "m:sync")
    .row()
    .text("Help", "m:help");
  if (ctx.from?.id === config.ownerId) {
    keyboard.text("Trusted users", "m:trusted");
  }
  await render(ctx, "VPN exits: выберите действие.", keyboard);
}

async function showExits(ctx: Context, service: CountryService, page = 0, query = ""): Promise<void> {
  const normalized = query.trim().toLowerCase();
  const exits = service.listExits().filter((vpnExit) => !normalized || exitSearchText(vpnExit).includes(normalized));
  const { items, currentPage, pages } = paginate(exits, page);
  const manual = items.filter((vpnExit) => vpnExit.provider === "manual-vless");
  const nord = items.filter((vpnExit) => vpnExit.provider === "nordvpn");
  const lines = [
    "Настроенные exits:",
    "",
    "Manual VLESS:",
    ...(manual.length ? manual.map((vpnExit) => `- ${flag(vpnExit.slug)} ${vpnExit.slug}`) : ["- нет"]),
    "",
    "NordVPN regions:",
    ...(nord.length ? nord.map((vpnExit) => {
      const source = vpnExit.source as NordVpnSource;
      return `- ${flag(vpnExit.slug)} ${vpnExit.slug}: ${source.cityName}, ${source.hostname}`;
    }) : ["- нет"]),
  ];
  const keyboard = new InlineKeyboard();
  for (const vpnExit of items) {
    keyboard.text(`${flag(vpnExit.slug)} ${vpnExit.slug}`, `x:v:${vpnExit.id}`).row();
  }
  addPager(keyboard, "m:exits", currentPage, pages);
  keyboard.text("Поиск", "q:exits").text("Главное меню", "m:home");
  await render(ctx, lines.join("\n"), keyboard);
}

async function showExitCard(ctx: Context, vpnExit: VpnExit): Promise<void> {
  const keyboard = new InlineKeyboard();
  let text = `${flag(vpnExit.slug)} ${vpnExit.slug}\nProvider: ${vpnExit.provider}`;
  if (vpnExit.provider === "manual-vless") {
    keyboard.text("Replace URI", `x:replace:${vpnExit.id}`).text("Remove", `x:rm:${vpnExit.id}`);
  } else {
    const source = vpnExit.source as NordVpnSource;
    text += `\nCountry: ${source.countryName}\nCity: ${source.cityName}\nServer: ${source.hostname}\nLoad: ${source.load}%`;
    keyboard
      .text("Repair automatically", `n:repair:${vpnExit.id}`)
      .row()
      .text("Choose server", `n:rs:${vpnExit.id}:0`)
      .text("Remove", `x:rm:${vpnExit.id}`);
  }
  keyboard.row().text("Назад к exits", "m:exits:0").text("Главное меню", "m:home");
  await render(ctx, text, keyboard);
}

async function showNordCountries(ctx: Context, service: CountryService, page = 0, query = ""): Promise<void> {
  const error = service.nordVpnAvailabilityError();
  if (error) {
    await render(ctx, `NordVPN недоступен: ${error}`, backHomeKeyboard());
    return;
  }
  const normalized = query.trim().toLowerCase();
  const countries = (await service.listNordVpnCountries())
    .filter((country) => !normalized || `${country.name} ${country.code}`.toLowerCase().includes(normalized));
  const { items, currentPage, pages } = paginate(countries, page);
  const keyboard = new InlineKeyboard();
  for (const country of items) {
    keyboard.text(`${flag(country.code.toLowerCase())} ${country.name}`, `n:ct:${country.id}:0`).row();
  }
  addPager(keyboard, "n:c", currentPage, pages);
  keyboard.text("Поиск", "q:countries").text("Главное меню", "m:home");
  await render(ctx, "Добавление NordVPN-региона: выберите страну.", keyboard);
}

async function showNordCities(
  ctx: Context,
  service: CountryService,
  countryId: number,
  page = 0,
  query = "",
): Promise<void> {
  const normalized = query.trim().toLowerCase();
  const options = (await service.listNordVpnCityOptions(countryId))
    .filter((option) => !normalized || option.city.name.toLowerCase().includes(normalized));
  const { items, currentPage, pages } = paginate(options, page);
  const keyboard = new InlineKeyboard();
  for (const option of items) {
    const marker = option.existing?.provider === "nordvpn" ? "✅ " : option.existing ? "⚠ " : "";
    keyboard.text(`${marker}${option.city.name}`, `n:city:${countryId}:${option.city.id}`).row();
  }
  addPager(keyboard, `n:ct:${countryId}`, currentPage, pages);
  keyboard.text("Поиск города", `q:cities:${countryId}`).text("Назад", "n:c:0");
  await render(ctx, "Выберите город. ✅ уже добавлен, ⚠ slug занят ручным VLESS.", keyboard);
}

async function showNordServers(
  ctx: Context,
  service: CountryService,
  countryId: number,
  cityId: number,
  page = 0,
): Promise<void> {
  const servers = await service.listNordVpnServers(countryId, cityId);
  const { items, currentPage, pages } = paginate(servers, page);
  const keyboard = new InlineKeyboard();
  for (const server of items) {
    keyboard.text(`${server.hostname} · ${server.load}%`, `n:pick:${countryId}:${cityId}:${server.id}`).row();
  }
  addPager(keyboard, `n:s:${countryId}:${cityId}`, currentPage, pages);
  keyboard.text("Назад", `n:city:${countryId}:${cityId}`).text("Главное меню", "m:home");
  await render(ctx, "Выберите NordVPN hostname. Перед добавлением он будет протестирован.", keyboard);
}

async function showRepairServers(
  ctx: Context,
  service: CountryService,
  vpnExit: VpnExit,
  page = 0,
): Promise<void> {
  if (vpnExit.provider !== "nordvpn") {
    throw new Error("Repair is available only for NordVPN regions");
  }
  const source = vpnExit.source as NordVpnSource;
  const servers = await service.listNordVpnServers(source.countryId, source.cityId, true);
  const { items, currentPage, pages } = paginate(servers, page);
  const keyboard = new InlineKeyboard();
  for (const server of items) {
    const marker = server.hostname === source.hostname ? "✅ " : "";
    keyboard.text(`${marker}${server.hostname} · ${server.load}%`, `n:rp:${vpnExit.id}:${server.id}`).row();
  }
  addPager(keyboard, `n:rs:${vpnExit.id}`, currentPage, pages);
  keyboard.text("Назад", `x:v:${vpnExit.id}`).text("Главное меню", "m:home");
  await render(ctx, `Выберите новый hostname для ${vpnExit.slug}. ✅ текущий сервер.`, keyboard);
}

async function showTrusted(ctx: Context, store: Store): Promise<void> {
  const ids = store.listTrustedUsers();
  const keyboard = new InlineKeyboard().text("Add", "t:add").row();
  for (const id of ids) {
    keyboard.text(`Remove ${id}`, `t:del:${id}`).row();
  }
  keyboard.text("Главное меню", "m:home");
  await render(ctx, ids.length ? `Trusted users:\n${ids.join("\n")}` : "Trusted users: список пуст.", keyboard);
}

async function applyManualExit(ctx: Context, service: CountryService, slug: string, uri: string): Promise<void> {
  await ctx.reply(`Проверяю и применяю ${slug}...`);
  const result = await service.setCountry(ctx.from!.id, slug, uri);
  const action = result.createdCountry ? "добавлен" : "обновлён";
  await ctx.reply(`Exit ${slug} ${action}. Новых профилей: ${result.created.length}.`);
}

async function confirmRemove(ctx: Context, vpnExit: VpnExit): Promise<void> {
  await render(
    ctx,
    `Удалить ${vpnExit.slug}?\nProvider: ${vpnExit.provider}\nБудут удалены только управляемые ботом профили этого exit.`,
    new InlineKeyboard().text("Удалить", `x:rmc:${vpnExit.id}`).text("Отмена", `x:v:${vpnExit.id}`),
  );
}

function authorized(
  config: BotConfig,
  store: Store,
  handler: (ctx: Context) => Promise<void>,
): (ctx: Context) => Promise<void> {
  return async (ctx) => {
    if (ctx.chat?.type !== "private") {
      await ctx.reply("Управление VPN доступно только в личном чате с ботом.");
      return;
    }
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
    if (ctx.chat?.type !== "private") {
      await ctx.reply("Управление VPN доступно только в личном чате с ботом.");
      return;
    }
    if (ctx.from?.id !== config.ownerId) {
      await ctx.reply("Команда доступна только владельцу.");
      return;
    }
    await handler(ctx);
  };
}

function saveWizard(ctx: Context, store: Store, flow: string, step: string, payload: JsonObject): void {
  store.upsertWizardSession({
    chatId: ctx.chat!.id,
    userId: ctx.from!.id,
    flow,
    step,
    payload,
    expiresAt: new Date(Date.now() + WIZARD_TTL_MS).toISOString(),
  });
}

async function clearWizard(ctx: Context, store: Store): Promise<void> {
  if (ctx.chat && ctx.from) {
    store.deleteWizardSession(ctx.chat.id, ctx.from.id);
  }
}

async function render(ctx: Context, text: string, keyboard?: InlineKeyboard): Promise<void> {
  const options = keyboard ? { reply_markup: keyboard } : {};
  if (ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(text, options);
      return;
    } catch {
      // The callback can originate from a stale or identical message. Reply instead.
    }
  }
  await ctx.reply(text, options);
}

async function answer(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => {});
}

function addPager(keyboard: InlineKeyboard, prefix: string, page: number, pages: number): void {
  if (pages <= 1) {
    return;
  }
  if (page > 0) {
    keyboard.text("⏮", `${prefix}:0`).text("◀", `${prefix}:${page - 1}`);
  }
  keyboard.text(`${page + 1}/${pages}`, `${prefix}:${page}`);
  if (page + 1 < pages) {
    keyboard.text("▶", `${prefix}:${page + 1}`).text("⏭", `${prefix}:${pages - 1}`);
  }
  keyboard.row();
}

function paginate<T>(items: T[], requestedPage: number): { items: T[]; currentPage: number; pages: number } {
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const currentPage = Math.min(Math.max(0, requestedPage), pages - 1);
  return {
    items: items.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE),
    currentPage,
    pages,
  };
}

function callbackNumber(ctx: Context, index: number): number {
  const value = Number(ctx.match?.[index]);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Telegram callback contains an invalid numeric ID");
  }
  return value;
}

function requireExit(service: CountryService, id: number): VpnExit {
  const vpnExit = service.getExitById(id);
  if (!vpnExit) {
    throw new Error(`Exit does not exist: ${id}`);
  }
  return vpnExit;
}

function requireExitBySlug(service: CountryService, slug: string): VpnExit {
  const vpnExit = service.getExit(slug);
  if (!vpnExit) {
    throw new Error(`Exit does not exist: ${slug}`);
  }
  return vpnExit;
}

function requireCityOption(options: NordVpnCityOption[], cityId: number): NordVpnCityOption {
  const option = options.find((item) => item.city.id === cityId);
  if (!option) {
    throw new Error(`NordVPN city does not exist: ${cityId}`);
  }
  return option;
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

function exitSearchText(vpnExit: VpnExit): string {
  if (vpnExit.provider === "manual-vless") {
    return `${vpnExit.slug} manual vless`;
  }
  const source = vpnExit.source as NordVpnSource;
  return `${vpnExit.slug} nordvpn ${source.countryCode} ${source.countryName} ${source.cityName} ${source.hostname}`.toLowerCase();
}

function flag(slug: string): string {
  return countryFlagFromSlug(slug);
}

function cancelKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("Отмена", "q:cancel");
}

function backHomeKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("Главное меню", "m:home");
}

function helpText(): string {
  return [
    "/countries - список exits",
    "/nord - добавить NordVPN-регион",
    "/set usa <vless://...> - добавить или заменить ручной VLESS exit",
    "/remove usa - удалить exit после подтверждения",
    "/sync - добавить недостающие профили подписок",
    "/allow <telegram-id>, /deny <telegram-id>, /trusted - управление доступом владельцем",
  ].join("\n");
}
