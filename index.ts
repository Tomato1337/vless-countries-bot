import { createBot } from "./src/bot.ts";
import { loadConfig } from "./src/config.ts";
import { CountryService } from "./src/country-service.ts";
import { ProxyService } from "./src/proxy-service.ts";
import { safeMessage } from "./src/sanitize.ts";
import { Store } from "./src/store.ts";
import { HttpUrnetworkClient } from "./src/urnetwork.ts";
import { HttpXuiClient } from "./src/xui-client.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new Store(config.databasePath);
  const xui = new HttpXuiClient({
    baseUrl: config.xuiBaseUrl,
    username: config.xuiUsername,
    password: config.xuiPassword,
  });
  const service = new CountryService(store, xui, {
    geOutboundTag: config.geOutboundTag,
    inboundId: config.xuiInboundId,
    nordVpnPrivateKey: config.nordVpnPrivateKey,
  });

  try {
    await service.checkCompatibility();
    if (process.argv.includes("--check")) {
      console.log("Compatibility check passed.");
      return;
    }
    const nordError = service.nordVpnAvailabilityError();
    if (nordError) {
      console.log(`NordVPN module disabled: ${nordError}`);
    }
    const proxies = new ProxyService(store, xui, new HttpUrnetworkClient(), {
      geOutboundTag: config.geOutboundTag,
      inboundId: config.xuiInboundId,
    }, service.mutex);
    const bot = createBot(
      { token: config.telegramBotToken, ownerId: config.telegramOwnerId },
      store,
      service,
      proxies,
    );
    process.once("SIGINT", () => bot.stop());
    process.once("SIGTERM", () => bot.stop());
    await bot.init();
    console.log(`Compatibility check passed. Starting Telegram long polling for @${bot.botInfo.username}.`);
    await bot.start();
  } finally {
    store.close();
  }
}

main().catch((error) => {
  console.error(`Startup failed: ${safeMessage(error)}`);
  process.exitCode = 1;
});
