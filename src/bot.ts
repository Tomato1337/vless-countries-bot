import { Bot, InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import { countryFlagFromSlug } from "./country-flag.ts";
import { assertCountrySlug, CountryService, isProtectedExit, normalizeSubscriptionSlug } from "./country-service.ts";
import type { NordVpnCityOption, SyncResult } from "./country-service.ts";
import { assertProxyName, buildCustomProxyOutbound, proxyFlag } from "./proxy.ts";
import { proxyDescription, ProxyService, URNETWORK_BEST_AVAILABLE_NAME } from "./proxy-service.ts";
import type { ProxyApplyResult, ProxyRemoveResult, ProxyRotateResult, Subscription } from "./proxy-service.ts";
import { safeMessage } from "./sanitize.ts";
import { Store } from "./store.ts";
import type { NordVpnServer } from "./nordvpn.ts";
import type {
  JsonObject,
  NordVpnSource,
  ProxyRecord,
  TelegramUserInfo,
  UrnetworkProxyKind,
  UrnetworkProxySource,
  VpnExit,
} from "./types.ts";
import { URNETWORK_BEST_AVAILABLE } from "./types.ts";

interface BotConfig {
  token: string;
  ownerId: number;
}

const PAGE_SIZE = 8;
const WIZARD_TTL_MS = 15 * 60 * 1000;
const SELECTED_AT_FORMAT = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Europe/Moscow",
  day: "2-digit",
  month: "2-digit",
  year: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

export function createBot(config: BotConfig, store: Store, service: CountryService, proxies: ProxyService): Bot {
  const bot = new Bot(config.token);
  const auth = (handler: (ctx: Context) => Promise<void>) => authorized(config, store, handler);
  const owner = (handler: (ctx: Context) => Promise<void>) => ownerOnly(config, store, handler);

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
  bot.command("proxies", auth((ctx) => showProxies(ctx, config, store, proxies)));

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
    await ctx.reply(syncSummary(result, await proxies.syncIpv6Slots(ctx.from!.id)));
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

  bot.command("trusted", owner((ctx) => showTrusted(ctx, config, store)));

  bot.command("adduser", owner(async (ctx) => {
    const name = commandText(ctx);
    if (!name) {
      await ctx.reply("Использование: /adduser petya");
      return;
    }
    await createUser(ctx, service, name);
  }));

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
    await ctx.reply(syncSummary(result, await proxies.syncIpv6Slots(ctx.from!.id)));
    await showMain(ctx, config);
  }));
  bot.callbackQuery("m:help", auth(async (ctx) => {
    await answer(ctx);
    await render(ctx, helpText(), backHomeKeyboard());
  }));
  bot.callbackQuery("m:trusted", owner(async (ctx) => {
    await answer(ctx);
    await showTrusted(ctx, config, store);
  }));
  bot.callbackQuery("m:user", owner(async (ctx) => {
    await answer(ctx);
    saveWizard(ctx, store, "user-add", "name", {});
    await render(
      ctx,
      "Введите имя нового пользователя (латиница, цифры, дефисы), например petya. "
        + "Будут созданы petya-pc, petya-phone, petya-russia и профили всех стран.",
      cancelKeyboard(),
    );
  }));

  bot.callbackQuery(/^x:v:(\d+)$/, auth(async (ctx) => {
    await answer(ctx);
    await showExitCard(ctx, service, requireExit(service, callbackNumber(ctx, 1)));
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
      await showExitCard(ctx, service, existing);
      return;
    }
    const options = await service.listNordVpnCityOptions(countryId);
    const option = requireCityOption(options, cityId);
    if (option.existing) {
      await showExitCard(ctx, service, option.existing);
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
    await render(ctx, "Тестирую до пяти наиболее загруженных NordVPN-серверов...");
    try {
      const result = await service.addNordVpnRegion(ctx.from!.id, countryId, cityId);
      await ctx.reply(`Добавлен ${result.slug}: ${result.source.hostname}. Новых профилей: ${result.created.length}.`);
      await showExitCard(ctx, service, requireExitBySlug(service, result.slug));
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
      await showExitCard(ctx, service, requireExitBySlug(service, result.slug));
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
      await showExitCard(ctx, service, requireExitBySlug(service, result.slug));
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
      await showExitCard(ctx, service, requireExitBySlug(service, result.slug));
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
    await showTrusted(ctx, config, store);
  }));
  bot.callbackQuery("t:add", owner(async (ctx) => {
    await answer(ctx);
    saveWizard(ctx, store, "trusted-add", "telegram-id", {});
    await render(ctx, "Отправьте Telegram ID пользователя.", cancelKeyboard());
  }));
  bot.callbackQuery(/^t:u:(\d+)$/, owner(async (ctx) => {
    await answer(ctx);
    await showPanelUser(ctx, config, store, callbackNumber(ctx, 1));
  }));
  bot.callbackQuery(/^t:b:(\d+):(\d+)$/, owner(async (ctx) => {
    await answer(ctx);
    await showBindProfile(ctx, proxies, callbackNumber(ctx, 1), callbackNumber(ctx, 2));
  }));
  bot.callbackQuery(/^t:bs:(\d+):([a-z0-9-]+)$/, owner(async (ctx) => {
    await answer(ctx);
    const id = callbackNumber(ctx, 1);
    const subscription = await proxies.requireSubscription(callbackText(ctx, 2));
    store.setProfileBinding(id, subscription.subId);
    await showPanelUser(ctx, config, store, id);
  }));
  bot.callbackQuery(/^t:bn:(\d+)$/, owner(async (ctx) => {
    await answer(ctx);
    const id = callbackNumber(ctx, 1);
    store.setProfileBinding(id, undefined);
    await showPanelUser(ctx, config, store, id);
  }));
  bot.callbackQuery(/^t:del:(\d+)$/, owner(async (ctx) => {
    await answer(ctx);
    const id = callbackNumber(ctx, 1);
    await render(
      ctx,
      `Удалить trusted-пользователя ${userLabel(store.getTelegramUser(id) ?? { telegramId: id })}?`,
      new InlineKeyboard().text("Удалить", `t:dc:${id}`).text("Отмена", `t:u:${id}`),
    );
  }));
  bot.callbackQuery(/^t:dc:(\d+)$/, owner(async (ctx) => {
    await answer(ctx);
    store.deleteTrustedUser(callbackNumber(ctx, 1));
    await showTrusted(ctx, config, store);
  }));

  bot.callbackQuery(/^pf:l:(\d+)$/, owner(async (ctx) => {
    await answer(ctx);
    await showProfiles(ctx, store, proxies, callbackNumber(ctx, 1));
  }));
  bot.callbackQuery(/^pf:v:([a-z0-9-]+)$/, auth(async (ctx) => {
    await answer(ctx);
    const subscription = await requireEditableSubscription(ctx, config, store, proxies, callbackText(ctx, 1));
    await showProfileCard(ctx, config, store, proxies, subscription);
  }));
  bot.callbackQuery(/^pf:k:([a-z0-9-]+)(:ur)?$/, auth(async (ctx) => {
    await answer(ctx);
    const subscription = await requireEditableSubscription(ctx, config, store, proxies, callbackText(ctx, 1));
    await promptUrnetworkKey(ctx, store, subscription, callbackText(ctx, 2) === ":ur");
  }));
  bot.callbackQuery(/^pf:kd:([a-z0-9-]+)$/, auth(async (ctx) => {
    await answer(ctx);
    const subscription = await requireEditableSubscription(ctx, config, store, proxies, callbackText(ctx, 1));
    proxies.clearUrnetworkKey(ctx.from!.id, subscription);
    await showProfileCard(ctx, config, store, proxies, subscription);
  }));

  bot.callbackQuery("p:home", auth(async (ctx) => {
    await answer(ctx);
    await clearWizard(ctx, store);
    await showProxies(ctx, config, store, proxies);
  }));
  bot.callbackQuery(/^p:g:([a-z0-9-]+)$/, owner(async (ctx) => {
    await answer(ctx);
    await showProxyGroup(ctx, proxies, callbackText(ctx, 1));
  }));
  bot.callbackQuery(/^p:v:(\d+)$/, auth(async (ctx) => {
    await answer(ctx);
    await showProxyCard(ctx, await requireEditableProxy(ctx, config, store, proxies, callbackNumber(ctx, 1)));
  }));
  bot.callbackQuery(/^p:ip:(\d+)$/, auth(async (ctx) => {
    await answer(ctx);
    const proxy = await requireEditableProxy(ctx, config, store, proxies, callbackNumber(ctx, 1));
    await render(ctx, `Меняю IP выхода ${proxy.email}...`);
    const result = await proxies.rotateUniqueExit(ctx.from!.id, proxy.id);
    await ctx.reply(rotateSummary(result));
    await showProxyCard(ctx, result.proxy);
  }));
  bot.callbackQuery(/^p:rm:(\d+)$/, auth(async (ctx) => {
    await answer(ctx);
    const proxy = await requireEditableProxy(ctx, config, store, proxies, callbackNumber(ctx, 1));
    await render(
      ctx,
      `Удалить прокси-профиль ${proxy.email}?`,
      new InlineKeyboard().text("Удалить", `p:rmc:${proxy.id}`).text("Отмена", `p:v:${proxy.id}`),
    );
  }));
  bot.callbackQuery(/^p:rmc:(\d+)$/, auth(async (ctx) => {
    await answer(ctx);
    const proxy = await requireEditableProxy(ctx, config, store, proxies, callbackNumber(ctx, 1));
    await render(ctx, `Удаляю ${proxy.email}...`);
    await ctx.reply(removeSummary(await proxies.removeProxies(ctx.from!.id, [proxy.id])), { reply_markup: proxiesKeyboard() });
  }));
  bot.callbackQuery(/^p:rmg:([a-z0-9-]+)$/, owner(async (ctx) => {
    await answer(ctx);
    const name = callbackText(ctx, 1);
    await render(
      ctx,
      `Удалить прокси ${name} у всех профилей?`,
      new InlineKeyboard().text("Удалить у всех", `p:rmgc:${name}`).text("Отмена", `p:g:${name}`),
    );
  }));
  bot.callbackQuery(/^p:rmgc:([a-z0-9-]+)$/, owner(async (ctx) => {
    await answer(ctx);
    const name = callbackText(ctx, 1);
    const ids = proxies.listProxies().filter((proxy) => proxy.name === name).map((proxy) => proxy.id);
    await render(ctx, `Удаляю ${name}...`);
    await ctx.reply(removeSummary(await proxies.removeProxies(ctx.from!.id, ids)), { reply_markup: proxiesKeyboard() });
  }));
  bot.callbackQuery(/^p:ur:(\d+)$/, auth(async (ctx) => {
    await answer(ctx);
    await requireProxyEditor(ctx, config, store, proxies);
    // Offer to add the actor's own URnetwork key before the location list when it is missing.
    const own = await boundSubscriptionOrUndefined(ctx, store, proxies);
    if (own && !proxies.getUrnetworkKey(own.subId)) {
      if (ctx.from?.id !== config.ownerId) {
        await promptUrnetworkKey(ctx, store, own, true);
        return;
      }
      await render(
        ctx,
        `У вашего профиля ${own.slug} нет ключа URnetwork. Добавить сейчас?\n`
          + "Без ключа прокси можно добавить только профилям, у которых ключ уже есть.",
        new InlineKeyboard()
          .text("🔑 Добавить ключ", `pf:k:${own.slug}:ur`)
          .text("Продолжить без ключа", "p:urs:0")
          .row()
          .text("Назад", "p:home"),
      );
      return;
    }
    await showUrnetworkCountries(ctx, proxies, callbackNumber(ctx, 1));
  }));
  bot.callbackQuery(/^p:urs:(\d+)$/, auth(async (ctx) => {
    await answer(ctx);
    await requireProxyEditor(ctx, config, store, proxies);
    await showUrnetworkCountries(ctx, proxies, callbackNumber(ctx, 1));
  }));
  bot.callbackQuery("q:ur", auth(async (ctx) => {
    await answer(ctx);
    saveWizard(ctx, store, "search", "urnetwork-countries", {});
    await render(ctx, "Введите название или ISO-код страны.", cancelKeyboard());
  }));
  bot.callbackQuery(/^p:urc:([a-z]{2}|best):([01])$/, auth(async (ctx) => {
    await answer(ctx);
    const location = callbackText(ctx, 1);
    const unique = callbackText(ctx, 2);
    await render(
      ctx,
      [
        `${await urnetworkLocationLabel(proxies, location)}: выберите тип прокси URnetwork.`,
        "HTTPS работает на любом тарифе, но только для TCP. SOCKS5 передаёт и UDP, но требует UR Pro.",
        "Unique exit IP (UR Pro): у каждого прокси свой выходной IP, который не используют другие ваши прокси.",
      ].join("\n"),
      new InlineKeyboard()
        .text("HTTPS", `p:urk:${location}:https:${unique}`)
        .text("SOCKS5 (UR Pro)", `p:urk:${location}:socks:${unique}`)
        .row()
        .text(`${unique === "1" ? "☑" : "☐"} Unique exit IP (UR Pro)`, `p:urc:${location}:${unique === "1" ? 0 : 1}`)
        .row()
        .text("Назад", "p:urs:0"),
    );
  }));
  bot.callbackQuery(/^p:urk:([a-z]{2}|best):(https|socks):([01])$/, auth(async (ctx) => {
    await answer(ctx);
    const target: ProxyTarget = {
      provider: "urnetwork",
      location: callbackText(ctx, 1),
      kind: callbackText(ctx, 2) as UrnetworkProxyKind,
      uniqueExit: callbackText(ctx, 3) === "1",
      selected: [],
    };
    await chooseProxyTargets(ctx, config, store, proxies, target);
  }));
  bot.callbackQuery("p:cu", auth(async (ctx) => {
    await answer(ctx);
    await requireProxyEditor(ctx, config, store, proxies);
    saveWizard(ctx, store, "proxy-custom", "name", {});
    await render(
      ctx,
      "Введите имя прокси (латиница, цифры, дефисы), например de-home. Префикс-код страны даёт флаг в названии профиля.",
      cancelKeyboard(),
    );
  }));
  bot.callbackQuery(/^p:t:(\d+)$/, owner(async (ctx) => {
    await answer(ctx);
    await showProxyTargets(ctx, config, store, proxies, callbackNumber(ctx, 1));
  }));
  bot.callbackQuery(/^p:tt:(\d+):([a-z0-9-]+)$/, owner(async (ctx) => {
    await answer(ctx);
    const target = requireProxyTarget(ctx, store);
    const slug = callbackText(ctx, 2);
    target.selected = target.selected.includes(slug)
      ? target.selected.filter((item) => item !== slug)
      : [...target.selected, slug];
    saveWizard(ctx, store, "proxy-target", "select", target);
    await showProxyTargets(ctx, config, store, proxies, callbackNumber(ctx, 1));
  }));
  bot.callbackQuery(/^p:(tme|tall|tok)$/, owner(async (ctx) => {
    await answer(ctx);
    const target = requireProxyTarget(ctx, store);
    const subscriptions = await proxies.listSubscriptions();
    const mode = callbackText(ctx, 1);
    let chosen: Subscription[];
    if (mode === "tall") {
      chosen = subscriptions;
    } else if (mode === "tme") {
      chosen = [await requireBoundSubscription(ctx, store, proxies)];
    } else {
      chosen = subscriptions.filter((subscription) => target.selected.includes(subscription.slug));
    }
    await clearWizard(ctx, store);
    await applyProxyTarget(ctx, proxies, target, chosen);
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
      await showTrusted(ctx, config, store);
      return;
    }
    if (session.flow === "user-add" && session.step === "name") {
      await clearWizard(ctx, store);
      if (ctx.from?.id !== config.ownerId) {
        await ctx.reply("Команда доступна только владельцу.");
        return;
      }
      await createUser(ctx, service, text);
      return;
    }
    if (session.flow === "proxy-custom" && session.step === "name") {
      assertProxyName(text);
      if (text.startsWith("ur-")) {
        throw new Error("Имена ur-... зарезервированы для прокси URnetwork");
      }
      saveWizard(ctx, store, "proxy-custom", "url", { name: text });
      await ctx.reply(
        "Отправьте URL прокси: socks5://user:pass@host:port, http://host:port или https://user:pass@host:port. "
          + "Сообщение с URL бот удалит.",
        { reply_markup: cancelKeyboard() },
      );
      return;
    }
    if (session.flow === "proxy-custom" && session.step === "url") {
      await ctx.deleteMessage().catch(() => {});
      buildCustomProxyOutbound("validation", text, "validation");
      await chooseProxyTargets(ctx, config, store, proxies, {
        provider: "custom",
        name: String(session.payload.name),
        url: text,
        selected: [],
      });
      return;
    }
    if (session.flow === "urnetwork-key" && session.step === "key") {
      await ctx.deleteMessage().catch(() => {});
      const subscription = await requireEditableSubscription(ctx, config, store, proxies, String(session.payload.slug));
      // The wizard stays open on a rejected key so the user can simply send another one.
      const apiKey = await proxies.setUrnetworkKey(ctx.from!.id, subscription, text);
      await clearWizard(ctx, store);
      await ctx.reply(`Ключ URnetwork для ${subscription.slug} сохранён: ${maskKey(apiKey)}.`);
      if (session.payload.next === "urnetwork") {
        await showUrnetworkCountries(ctx, proxies);
      } else {
        await showProfileCard(ctx, config, store, proxies, subscription);
      }
      return;
    }
    if (session.flow === "search" && session.step === "urnetwork-countries") {
      await clearWizard(ctx, store);
      await showUrnetworkCountries(ctx, proxies, 0, text);
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
    .text("Help", "m:help")
    .text("Proxies", "p:home");
  if (ctx.from?.id === config.ownerId) {
    keyboard
      .row()
      .text("Trusted users", "m:trusted")
      .text("Profiles", "pf:l:0")
      .row()
      .text("Add user", "m:user");
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

async function showExitCard(ctx: Context, service: CountryService, vpnExit: VpnExit): Promise<void> {
  const keyboard = new InlineKeyboard();
  const removable = !isProtectedExit(vpnExit.slug);
  let text = `${flag(vpnExit.slug)} ${vpnExit.slug}\nProvider: ${vpnExit.provider}`;
  if (vpnExit.provider === "manual-vless") {
    keyboard.text("Replace URI", `x:replace:${vpnExit.id}`);
  } else {
    const source = vpnExit.source as NordVpnSource;
    const selectedAt = service.nordVpnServerSelections(source.countryId, source.cityId).get(source.hostname);
    text += `\nCountry: ${source.countryName}\nCity: ${source.cityName}\nServer: ${source.hostname}\nLoad: ${source.load}%`;
    if (selectedAt) {
      text += `\nSelected: ${SELECTED_AT_FORMAT.format(new Date(selectedAt))} МСК`;
    }
    keyboard
      .text("Repair automatically", `n:repair:${vpnExit.id}`)
      .row()
      .text("Choose server", `n:rs:${vpnExit.id}:0`);
  }
  if (removable) {
    keyboard.text("Remove", `x:rm:${vpnExit.id}`);
  } else {
    text += "\n🔒 Защищён от удаления: на этот exit перенаправляется torrent-трафик.";
  }
  keyboard.row().text("Назад к exits", "m:exits:0").text("Главное меню", "m:home");
  await render(ctx, text, keyboard);
}

function serverLabel(server: NordVpnServer, selections: Map<string, string>, marker = ""): string {
  const selectedAt = selections.get(server.hostname);
  return `${marker}${server.hostname} · ${server.load}%${selectedAt ? ` · 🕓 ${SELECTED_AT_FORMAT.format(new Date(selectedAt))}` : ""}`;
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
  const selections = service.nordVpnServerSelections(countryId, cityId);
  const { items, currentPage, pages } = paginate(servers, page);
  const keyboard = new InlineKeyboard();
  for (const server of items) {
    keyboard.text(serverLabel(server, selections), `n:pick:${countryId}:${cityId}:${server.id}`).row();
  }
  addPager(keyboard, `n:s:${countryId}:${cityId}`, currentPage, pages);
  keyboard.text("Назад", `n:city:${countryId}:${cityId}`).text("Главное меню", "m:home");
  await render(
    ctx,
    "Выберите NordVPN hostname. Перед добавлением он будет протестирован. 🕓 последний выбор (МСК).",
    keyboard,
  );
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
  const selections = service.nordVpnServerSelections(source.countryId, source.cityId);
  const { items, currentPage, pages } = paginate(servers, page);
  const keyboard = new InlineKeyboard();
  for (const server of items) {
    const marker = server.hostname === source.hostname ? "✅ " : "";
    keyboard.text(serverLabel(server, selections, marker), `n:rp:${vpnExit.id}:${server.id}`).row();
  }
  addPager(keyboard, `n:rs:${vpnExit.id}`, currentPage, pages);
  keyboard.text("Назад", `x:v:${vpnExit.id}`).text("Главное меню", "m:home");
  await render(
    ctx,
    `Выберите новый hostname для ${vpnExit.slug}. ✅ текущий сервер, 🕓 последний выбор (МСК).`,
    keyboard,
  );
}

async function showTrusted(ctx: Context, config: BotConfig, store: Store): Promise<void> {
  const ids = store.listTrustedUsers();
  const users = await Promise.all([config.ownerId, ...ids].map((id) => loadTelegramUser(ctx, store, id)));
  const lines = ["Доступ к панели:", ""];
  const keyboard = new InlineKeyboard();
  for (const user of users) {
    const role = user.telegramId === config.ownerId ? "владелец" : "trusted";
    lines.push(`• ${userLabel(user)} — ${role}, профиль: ${profileLabel(user.profileSubId)}`);
    keyboard.text(`${user.telegramId === config.ownerId ? "👑" : "👤"} ${shortUserLabel(user)}`, `t:u:${user.telegramId}`).row();
  }
  if (!ids.length) {
    lines.push("", "Trusted users: список пуст.");
  }
  keyboard.text("Add", "t:add").text("Главное меню", "m:home");
  await render(ctx, lines.join("\n"), keyboard);
}

async function showPanelUser(ctx: Context, config: BotConfig, store: Store, telegramId: number): Promise<void> {
  const isOwner = telegramId === config.ownerId;
  if (!isOwner && !store.isTrustedUser(telegramId)) {
    throw new Error(`Пользователь ${telegramId} не имеет доступа к панели`);
  }
  const user = await loadTelegramUser(ctx, store, telegramId);
  const keyboard = new InlineKeyboard().text("Привязать профиль", `t:b:${telegramId}:0`);
  if (user.profileSubId) {
    keyboard.text("Отвязать", `t:bn:${telegramId}`);
  }
  keyboard.row();
  if (!isOwner) {
    keyboard.text("Удалить доступ", `t:del:${telegramId}`).row();
  }
  keyboard.text("Назад", "t:list").text("Главное меню", "m:home");
  await render(
    ctx,
    [
      userLabel(user),
      `Роль: ${isOwner ? "владелец" : "trusted"}`,
      `Профиль: ${profileLabel(user.profileSubId)}`,
      "",
      "Привязанный профиль пользователь редактирует сам: ключ URnetwork и свои прокси.",
    ].join("\n"),
    keyboard,
  );
}

async function showBindProfile(ctx: Context, proxies: ProxyService, telegramId: number, page: number): Promise<void> {
  const { items, currentPage, pages } = paginate(await proxies.listSubscriptions(), page);
  const keyboard = new InlineKeyboard();
  for (const subscription of items) {
    keyboard.text(subscription.slug, `t:bs:${telegramId}:${subscription.slug}`).row();
  }
  addPager(keyboard, `t:b:${telegramId}`, currentPage, pages);
  keyboard.text("Назад", `t:u:${telegramId}`);
  await render(ctx, "Выберите профиль (подписку), который пользователь сможет редактировать.", keyboard);
}

async function showProfiles(ctx: Context, store: Store, proxies: ProxyService, page: number): Promise<void> {
  const subscriptions = await proxies.listSubscriptions();
  const keys = proxies.listUrnetworkKeys();
  const { items, currentPage, pages } = paginate(subscriptions, page);
  const lines = ["Профили (подписки):", ""];
  const keyboard = new InlineKeyboard();
  for (const subscription of items) {
    const key = keys.get(subscription.subId);
    const admins = store.listTelegramUsersByProfile(subscription.subId).map(shortUserLabel);
    lines.push(
      `• ${subscription.slug} — URnetwork: ${key ? maskKey(key) : "нет ключа"}, `
        + `прокси: ${proxies.listProxies(subscription.subId).length}`
        + (admins.length ? `, редакторы: ${admins.join(", ")}` : ""),
    );
    keyboard.text(`${key ? "🔑" : "▫️"} ${subscription.slug}`, `pf:v:${subscription.slug}`).row();
  }
  addPager(keyboard, "pf:l", currentPage, pages);
  keyboard.text("Прокси", "p:home").text("Главное меню", "m:home");
  await render(ctx, lines.join("\n"), keyboard);
}

async function showProfileCard(
  ctx: Context,
  config: BotConfig,
  store: Store,
  proxies: ProxyService,
  subscription: Subscription,
): Promise<void> {
  const key = proxies.getUrnetworkKey(subscription.subId);
  const owned = proxies.listProxies(subscription.subId);
  const admins = store.listTelegramUsersByProfile(subscription.subId).map(userLabel);
  const lines = [
    `Профиль ${subscription.slug} (subId ${subscription.subId})`,
    `Ключ URnetwork: ${key ?? "не задан"}`,
    `IPv6 к ur.io: ${proxies.ipv6Address(subscription.subId) ?? "не выдан"}`,
    `Редакторы: ${admins.length ? admins.join("; ") : "нет"}`,
    "",
    "Прокси:",
    ...(owned.length ? owned.map((proxy) => `- ${proxy.email}: ${proxyDescription(proxy)}`) : ["- нет"]),
  ];
  const keyboard = new InlineKeyboard().text(key ? "Заменить ключ" : "Задать ключ URnetwork", `pf:k:${subscription.slug}`);
  if (key) {
    keyboard.text("Удалить ключ", `pf:kd:${subscription.slug}`);
  }
  keyboard.row().text("Прокси", "p:home");
  keyboard.text(ctx.from?.id === config.ownerId ? "Назад к профилям" : "Главное меню", ctx.from?.id === config.ownerId ? "pf:l:0" : "m:home");
  await render(ctx, lines.join("\n"), keyboard);
}

async function showProxies(ctx: Context, config: BotConfig, store: Store, proxies: ProxyService): Promise<void> {
  if (ctx.from?.id === config.ownerId) {
    const groups = new Map<string, ProxyRecord[]>();
    for (const proxy of proxies.listProxies()) {
      groups.set(proxy.name, [...groups.get(proxy.name) ?? [], proxy]);
    }
    const lines = ["Прокси по профилям:", ""];
    const keyboard = new InlineKeyboard();
    for (const [name, members] of groups) {
      const slugs = members.map((proxy) => normalizeSubscriptionSlug(proxy.subId));
      lines.push(`${proxyFlag(name)} ${name} — ${proxyDescription(members[0]!)}: ${slugs.join(", ")}`);
      keyboard.text(`${proxyFlag(name)} ${name} (${members.length})`, `p:g:${name}`).row();
    }
    if (!groups.size) {
      lines.push("Прокси ещё нет.");
    }
    keyboard
      .text("+ URnetwork", "p:ur:0")
      .text("+ Свой прокси", "p:cu")
      .row();
    const own = await boundSubscriptionOrUndefined(ctx, store, proxies);
    if (own) {
      keyboard.text("🔑 Мой ключ URnetwork", `pf:v:${own.slug}`);
    }
    keyboard.text("Profiles", "pf:l:0").row().text("Главное меню", "m:home");
    await render(ctx, lines.join("\n"), keyboard);
    return;
  }
  const subscription = await boundSubscriptionOrUndefined(ctx, store, proxies);
  if (!subscription) {
    await render(
      ctx,
      "К вашему аккаунту не привязан профиль. Попросите владельца привязать профиль в Trusted users.",
      backHomeKeyboard(),
    );
    return;
  }
  const owned = proxies.listProxies(subscription.subId);
  const keyboard = new InlineKeyboard();
  for (const proxy of owned) {
    keyboard.text(`${proxyFlag(proxy.name)} ${proxy.name}`, `p:v:${proxy.id}`).row();
  }
  keyboard
    .text("+ URnetwork", "p:ur:0")
    .text("+ Свой прокси", "p:cu")
    .row()
    .text("🔑 Ключ URnetwork", `pf:v:${subscription.slug}`)
    .text("Главное меню", "m:home");
  await render(
    ctx,
    [
      `Прокси профиля ${subscription.slug}:`,
      ...(owned.length ? owned.map((proxy) => `- ${proxy.email}: ${proxyDescription(proxy)}`) : ["- нет"]),
    ].join("\n"),
    keyboard,
  );
}

async function showProxyGroup(ctx: Context, proxies: ProxyService, name: string): Promise<void> {
  const members = proxies.listProxies().filter((proxy) => proxy.name === name);
  if (!members.length) {
    throw new Error(`Прокси не найден: ${name}`);
  }
  const keyboard = new InlineKeyboard();
  for (const proxy of members) {
    keyboard.text(`❌ ${normalizeSubscriptionSlug(proxy.subId)}`, `p:rm:${proxy.id}`).row();
  }
  keyboard.text("Удалить у всех", `p:rmg:${name}`).row().text("Назад", "p:home").text("Главное меню", "m:home");
  await render(
    ctx,
    [
      `${proxyFlag(name)} ${name} — ${proxyDescription(members[0]!)}`,
      "",
      ...members.map((proxy) => `- ${proxy.email}`),
      "",
      "❌ удаляет прокси-профиль у одного пользователя.",
    ].join("\n"),
    keyboard,
  );
}

async function showProxyCard(ctx: Context, proxy: ProxyRecord): Promise<void> {
  await render(
    ctx,
    [
      `${proxyFlag(proxy.name)} ${proxy.name}`,
      `Профиль: ${normalizeSubscriptionSlug(proxy.subId)}`,
      `Клиент 3x-ui: ${proxy.email}`,
      `Источник: ${proxyDescription(proxy)}`,
      `Создан: ${SELECTED_AT_FORMAT.format(new Date(proxy.createdAt))} МСК`,
    ].join("\n"),
    proxyCardKeyboard(proxy),
  );
}

async function showUrnetworkCountries(ctx: Context, proxies: ProxyService, page = 0, query = ""): Promise<void> {
  const normalized = query.trim().toLowerCase();
  const countries = (await proxies.urnetworkCountries())
    .filter((country) => !normalized || `${country.name} ${country.code}`.toLowerCase().includes(normalized));
  const { items, currentPage, pages } = paginate(countries, page);
  const keyboard = new InlineKeyboard();
  if (currentPage === 0 && (!normalized || URNETWORK_BEST_AVAILABLE_NAME.toLowerCase().includes(normalized))) {
    keyboard.text(`🌐 ${URNETWORK_BEST_AVAILABLE_NAME} — любой провайдер`, `p:urc:${URNETWORK_BEST_AVAILABLE}:0`).row();
  }
  for (const country of items) {
    keyboard.text(`${proxyFlag(country.code)} ${country.name} · ${country.providerCount}`, `p:urc:${country.code}:0`).row();
  }
  addPager(keyboard, "p:urs", currentPage, pages);
  keyboard.text("Поиск", "q:ur").text("Назад", "p:home");
  await render(ctx, "Прокси URnetwork: выберите локацию. Число — провайдеры в стране.", keyboard);
}

async function urnetworkLocationLabel(proxies: ProxyService, location: string): Promise<string> {
  if (location === URNETWORK_BEST_AVAILABLE) {
    return `🌐 ${URNETWORK_BEST_AVAILABLE_NAME}`;
  }
  const country = (await proxies.urnetworkCountries()).find((item) => item.code === location);
  return `${proxyFlag(location)} ${country?.name ?? location.toUpperCase()}`;
}

async function promptUrnetworkKey(
  ctx: Context,
  store: Store,
  subscription: Subscription,
  continueToProxy: boolean,
): Promise<void> {
  saveWizard(ctx, store, "urnetwork-key", "key", {
    slug: subscription.slug,
    ...(continueToProxy ? { next: "urnetwork" } : {}),
  });
  await render(
    ctx,
    [
      `🔑 Ключ URnetwork для профиля ${subscription.slug}`,
      "",
      "Прокси URnetwork создаётся на вашем аккаунте ur.io, поэтому нужен ключ:",
      "1. Войдите на https://ur.io и откройте https://ur.io/app/account/settings.",
      "2. Создайте Auth code и отправьте его сюда: бот сам обменяет его на постоянный API-ключ.",
      "   Готовый API-ключ urn_... тоже подходит.",
      "",
      "Сообщение с ключом бот удалит. Заменить ключ можно позже: Proxies → 🔑 Ключ URnetwork.",
    ].join("\n"),
    cancelKeyboard(),
  );
}

interface ProxyTarget extends JsonObject {
  provider: "urnetwork" | "custom";
  /** URnetwork: ISO-2 country code or `best`. */
  location?: string;
  kind?: UrnetworkProxyKind;
  uniqueExit?: boolean;
  name?: string;
  url?: string;
  /** Subscription slugs picked by the owner. */
  selected: string[];
}

/** The owner picks target profiles; anyone else adds the proxy to their own bound profile. */
async function chooseProxyTargets(
  ctx: Context,
  config: BotConfig,
  store: Store,
  proxies: ProxyService,
  target: ProxyTarget,
): Promise<void> {
  if (ctx.from?.id === config.ownerId) {
    saveWizard(ctx, store, "proxy-target", "select", target);
    await showProxyTargets(ctx, config, store, proxies, 0);
    return;
  }
  await clearWizard(ctx, store);
  await applyProxyTarget(ctx, proxies, target, [await requireBoundSubscription(ctx, store, proxies)]);
}

async function showProxyTargets(
  ctx: Context,
  config: BotConfig,
  store: Store,
  proxies: ProxyService,
  page: number,
): Promise<void> {
  const target = requireProxyTarget(ctx, store);
  const subscriptions = await proxies.listSubscriptions();
  const keys = proxies.listUrnetworkKeys();
  const own = await boundSubscriptionOrUndefined(ctx, store, proxies);
  const { items, currentPage, pages } = paginate(subscriptions, page);
  const keyboard = new InlineKeyboard();
  if (own) {
    keyboard.text(`Мне (${own.slug})`, "p:tme");
  }
  keyboard.text(`Всем (${subscriptions.length})`, "p:tall").row();
  for (const subscription of items) {
    const mark = target.selected.includes(subscription.slug) ? "✅" : "▫️";
    const key = target.provider === "urnetwork" ? (keys.has(subscription.subId) ? " 🔑" : " — нет ключа") : "";
    keyboard.text(`${mark} ${subscription.slug}${key}`, `p:tt:${currentPage}:${subscription.slug}`).row();
  }
  addPager(keyboard, "p:t", currentPage, pages);
  keyboard.text(`Применить к выбранным (${target.selected.length})`, "p:tok").row().text("Отмена", "q:cancel");
  const what = target.provider === "urnetwork"
    ? `URnetwork ${await urnetworkLocationLabel(proxies, String(target.location))} `
      + `(${target.kind === "socks" ? "SOCKS5" : "HTTPS"}${target.uniqueExit ? ", unique exit IP" : ""}). `
      + "Прокси создаётся на аккаунте URnetwork каждого профиля; профили без ключа будут пропущены."
    : `Свой прокси ${target.name}.`;
  await render(ctx, `${what}\nКому добавить?`, keyboard);
}

async function applyProxyTarget(
  ctx: Context,
  proxies: ProxyService,
  target: ProxyTarget,
  subscriptions: Subscription[],
): Promise<void> {
  await render(ctx, "Создаю и тестирую прокси...");
  const result = target.provider === "urnetwork"
    ? await proxies.addUrnetworkProxies(
      ctx.from!.id,
      subscriptions,
      String(target.location),
      target.kind ?? "https",
      target.uniqueExit === true,
    )
    : await proxies.addCustomProxies(ctx.from!.id, subscriptions, String(target.name), String(target.url));
  await ctx.reply(applySummary(result), { reply_markup: proxiesKeyboard() });
}

function requireProxyTarget(ctx: Context, store: Store): ProxyTarget {
  const session = store.getWizardSession(ctx.chat!.id, ctx.from!.id);
  if (session?.flow !== "proxy-target") {
    throw new Error("Выбор профилей устарел. Начните добавление прокси заново.");
  }
  return session.payload as ProxyTarget;
}

async function boundSubscriptionOrUndefined(
  ctx: Context,
  store: Store,
  proxies: ProxyService,
): Promise<Subscription | undefined> {
  const subId = store.getTelegramUser(ctx.from!.id)?.profileSubId;
  if (!subId) {
    return undefined;
  }
  return (await proxies.listSubscriptions()).find((subscription) => subscription.subId === subId);
}

async function requireBoundSubscription(ctx: Context, store: Store, proxies: ProxyService): Promise<Subscription> {
  const subscription = await boundSubscriptionOrUndefined(ctx, store, proxies);
  if (!subscription) {
    throw new Error("К вашему аккаунту не привязан профиль. Попросите владельца привязать его в Trusted users.");
  }
  return subscription;
}

/** The owner edits every profile; a trusted admin edits only the profile bound to them. */
async function requireEditableSubscription(
  ctx: Context,
  config: BotConfig,
  store: Store,
  proxies: ProxyService,
  slug: string,
): Promise<Subscription> {
  const subscription = await proxies.requireSubscription(slug);
  if (ctx.from?.id !== config.ownerId && store.getTelegramUser(ctx.from!.id)?.profileSubId !== subscription.subId) {
    throw new Error(`Нет доступа к профилю ${slug}`);
  }
  return subscription;
}

async function requireEditableProxy(
  ctx: Context,
  config: BotConfig,
  store: Store,
  proxies: ProxyService,
  id: number,
): Promise<ProxyRecord> {
  const proxy = proxies.requireProxy(id);
  if (ctx.from?.id !== config.ownerId && store.getTelegramUser(ctx.from!.id)?.profileSubId !== proxy.subId) {
    throw new Error("Нет доступа к этому прокси");
  }
  return proxy;
}

async function requireProxyEditor(ctx: Context, config: BotConfig, store: Store, proxies: ProxyService): Promise<void> {
  if (ctx.from?.id !== config.ownerId) {
    await requireBoundSubscription(ctx, store, proxies);
  }
}

/** Stored name, refreshed through getChat when the user has not written to the bot since the upgrade. */
async function loadTelegramUser(ctx: Context, store: Store, telegramId: number): Promise<TelegramUserInfo> {
  const known = store.getTelegramUser(telegramId);
  if (known?.firstName || known?.username) {
    return known;
  }
  try {
    const chat = await ctx.api.getChat(telegramId);
    if (chat && typeof chat === "object" && chat.type === "private") {
      store.rememberTelegramUser({
        telegramId,
        firstName: chat.first_name,
        ...(chat.last_name ? { lastName: chat.last_name } : {}),
        ...(chat.username ? { username: chat.username } : {}),
      });
    }
  } catch {
    // The user never opened the bot: Telegram does not reveal the name, the ID stays the label.
  }
  return store.getTelegramUser(telegramId) ?? { telegramId };
}

function userLabel(user: TelegramUserInfo): string {
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ");
  return `${name || "без имени"}${user.username ? ` (@${user.username})` : ""} · id ${user.telegramId}`;
}

function shortUserLabel(user: TelegramUserInfo): string {
  return user.username ? `@${user.username}` : user.firstName ?? String(user.telegramId);
}

function profileLabel(subId: string | undefined): string {
  return subId ? normalizeSubscriptionSlug(subId) : "не привязан";
}

function maskKey(key: string): string {
  return key.length > 12 ? `${key.slice(0, 8)}…${key.slice(-4)}` : "…";
}

function applySummary(result: ProxyApplyResult): string {
  const lines = [
    result.added.length
      ? `Добавлено профилей: ${result.added.length}\n${result.added.map((proxy) => `- ${proxy.email}`).join("\n")}`
      : "Ни один прокси не добавлен.",
  ];
  if (result.failed.length) {
    lines.push(`Пропущено:\n${result.failed.map((item) => `- ${item.slug}: ${item.reason}`).join("\n")}`);
  }
  return lines.join("\n\n");
}

function removeSummary(result: ProxyRemoveResult): string {
  const leftovers = result.upstreamLeftovers.length
    ? `\nНе удалось удалить на ur.io (удалите вручную в ur.io/app/proxies): ${result.upstreamLeftovers.join(", ")}`
    : "";
  return `Удалено прокси-профилей: ${result.removed}.${leftovers}`;
}

function rotateSummary(result: ProxyRotateResult): string {
  const next = result.proxy.upstream?.exitLocation ?? "новый выход";
  const leftover = result.upstreamLeftover
    ? "\nСтарый прокси не удалился на ur.io (удалите вручную в ur.io/app/proxies)."
    : "";
  return `IP выхода сменён: ${result.previousExit ?? "старый выход"} → ${next}. Ссылка подписки не изменилась.${leftover}`;
}

function proxyCardKeyboard(proxy: ProxyRecord): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (proxy.provider === "urnetwork" && (proxy.source as UrnetworkProxySource).uniqueExit) {
    keyboard.text("🔄 Сменить IP", `p:ip:${proxy.id}`);
  }
  return keyboard.text("Удалить", `p:rm:${proxy.id}`).row().text("Назад", "p:home").text("Главное меню", "m:home");
}

function proxiesKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("Прокси", "p:home").text("Главное меню", "m:home");
}

async function createUser(ctx: Context, service: CountryService, name: string): Promise<void> {
  await ctx.reply(`Создаю пользователя ${name}...`);
  const result = await service.createUser(ctx.from!.id, name);
  const lines = [
    `Пользователь ${result.subId} создан.`,
    `Профили: ${result.profiles.join(", ")}.`,
    `Профилей стран: ${result.created.length}.`,
    result.subscriptionUrl ? `Подписка: ${result.subscriptionUrl}` : "Подписки в 3x-ui выключены — ссылки нет.",
  ];
  await ctx.reply(lines.join("\n"));
}

async function applyManualExit(ctx: Context, service: CountryService, slug: string, uri: string): Promise<void> {
  await ctx.reply(`Проверяю и применяю ${slug}...`);
  const result = await service.setCountry(ctx.from!.id, slug, uri);
  const action = result.createdCountry ? "добавлен" : "обновлён";
  await ctx.reply(`Exit ${slug} ${action}. Новых профилей: ${result.created.length}.`);
}

async function confirmRemove(ctx: Context, vpnExit: VpnExit): Promise<void> {
  if (isProtectedExit(vpnExit.slug)) {
    throw new Error(`Exit ${vpnExit.slug} is protected and cannot be removed: torrent traffic is redirected to it`);
  }
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
    rememberSender(ctx, store);
    await handler(ctx);
  };
}

function ownerOnly(
  config: BotConfig,
  store: Store,
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
    rememberSender(ctx, store);
    await handler(ctx);
  };
}

function rememberSender(ctx: Context, store: Store): void {
  const from = ctx.from!;
  store.rememberTelegramUser({
    telegramId: from.id,
    firstName: from.first_name,
    ...(from.last_name ? { lastName: from.last_name } : {}),
    ...(from.username ? { username: from.username } : {}),
  });
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

function callbackText(ctx: Context, index: number): string {
  return String(ctx.match?.[index] ?? "");
}

function syncSummary(result: SyncResult, ipv6Chained: number): string {
  const attached = result.attached.length ? ` Возвращено в inbound: ${result.attached.length}.` : "";
  const ipv6 = ipv6Chained ? ` Прокси URnetwork через свой IPv6: ${ipv6Chained}.` : "";
  return `Готово. Новых профилей: ${result.created.length}. Переименовано: ${result.renamed.length}.${attached}${ipv6}`;
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
    "/proxies - прокси URnetwork (ur.io) и свои SOCKS5/HTTP(S) прокси как отдельные профили подписки",
    "/allow <telegram-id>, /deny <telegram-id>, /trusted - доступ и привязка профилей (только владелец)",
    "/adduser <name> - новый пользователь: <name>-pc, <name>-phone, <name>-russia и профили стран (только владелец)",
  ].join("\n");
}
