import { collectSubscriptions } from "./country-service.ts";
import { Mutex } from "./mutex.ts";
import {
  assertProxyName,
  buildCustomProxyOutbound,
  buildUrnetworkOutbound,
  proxyClientEmail,
  proxyServerEndpoint,
  proxyOutboundTag,
  removeProxies,
  upsertProxies,
  urnetworkProxyName,
} from "./proxy.ts";
import { safeMessage } from "./sanitize.ts";
import { Store } from "./store.ts";
import { assertGeOutbound } from "./template.ts";
import type {
  CustomProxySource,
  ProxyRecord,
  UrnetworkApi,
  UrnetworkCountry,
  UrnetworkProxyKind,
  UrnetworkProxySource,
  UrnetworkUpstream,
  XrayOutbound,
  XrayTemplate,
  XuiApi,
} from "./types.ts";
import { URNETWORK_BEST_AVAILABLE } from "./types.ts";

export const URNETWORK_BEST_AVAILABLE_NAME = "Best available";

export interface ProxyServiceConfig {
  geOutboundTag: string;
  inboundId: number;
}

export interface Subscription {
  subId: string;
  slug: string;
}

export interface ProxyApplyResult {
  added: ProxyRecord[];
  failed: Array<{ slug: string; reason: string }>;
}

export interface ProxyRemoveResult {
  removed: number;
  /** URnetwork proxies the bot could not delete on the account; they keep counting toward its proxy limit. */
  upstreamLeftovers: string[];
}

interface ProxyDraft {
  subscription: Subscription;
  record: Omit<ProxyRecord, "id" | "createdAt">;
  apiKey?: string;
}

export class ProxyService {
  constructor(
    private readonly store: Store,
    private readonly xui: XuiApi,
    private readonly urnetwork: UrnetworkApi,
    private readonly config: ProxyServiceConfig,
    // Shared with CountryService: both rewrite the same Xray template and client list.
    private readonly mutex: Mutex,
  ) {}

  async listSubscriptions(): Promise<Subscription[]> {
    const subscriptions = collectSubscriptions(await this.xui.listClients(), this.config.inboundId);
    return subscriptions.sort((a, b) => a.slug.localeCompare(b.slug));
  }

  async requireSubscription(slug: string): Promise<Subscription> {
    const subscription = (await this.listSubscriptions()).find((item) => item.slug === slug);
    if (!subscription) {
      throw new Error(`Подписка не найдена: ${slug}`);
    }
    return subscription;
  }

  listProxies(subId?: string): ProxyRecord[] {
    return this.store.listProxies(subId);
  }

  requireProxy(id: number): ProxyRecord {
    const proxy = this.store.getProxy(id);
    if (!proxy) {
      throw new Error(`Прокси не найден: ${id}`);
    }
    return proxy;
  }

  urnetworkCountries(): Promise<UrnetworkCountry[]> {
    return this.urnetwork.listCountries();
  }

  getUrnetworkKey(subId: string): string | undefined {
    return this.store.getUrnetworkKey(subId);
  }

  listUrnetworkKeys(): Map<string, string> {
    return this.store.listUrnetworkKeys();
  }

  /** Accepts a `urn_` API key or a one-time auth code from ur.io/app/account/settings. */
  async setUrnetworkKey(actorId: number, subscription: Subscription, input: string): Promise<string> {
    const value = input.trim();
    if (!value || /\s/.test(value)) {
      throw new Error("Отправьте API-ключ urn_... или auth code одной строкой");
    }
    try {
      const apiKey = value.startsWith("urn_")
        ? value
        : await this.urnetwork.createApiKey(value, `vless-countries-bot ${subscription.slug}`);
      await this.urnetwork.verifyApiKey(apiKey);
      this.store.setUrnetworkKey(subscription.subId, apiKey);
      this.store.audit(actorId, "urnetwork-key-set", subscription.slug, true, value.startsWith("urn_") ? "api-key" : "auth-code");
      return apiKey;
    } catch (error) {
      this.store.audit(actorId, "urnetwork-key-set", subscription.slug, false, safeMessage(error));
      throw error;
    }
  }

  clearUrnetworkKey(actorId: number, subscription: Subscription): void {
    this.store.setUrnetworkKey(subscription.subId, undefined);
    this.store.audit(actorId, "urnetwork-key-clear", subscription.slug, true, "");
  }

  /**
   * Creates one hosted proxy per subscription, each on that subscription's own URnetwork account.
   * `location` is a country code or `best` (any provider on the network).
   */
  async addUrnetworkProxies(
    actorId: number,
    subscriptions: Subscription[],
    location: string,
    kind: UrnetworkProxyKind,
    uniqueExit = false,
  ): Promise<ProxyApplyResult> {
    const code = location.toLowerCase();
    let countryName = URNETWORK_BEST_AVAILABLE_NAME;
    if (code !== URNETWORK_BEST_AVAILABLE) {
      const country = (await this.urnetwork.listCountries()).find((item) => item.code === code);
      if (!country) {
        throw new Error(`URnetwork не предлагает страну ${code}`);
      }
      countryName = country.name;
    }
    const name = urnetworkProxyName(code, kind, uniqueExit);
    const source: UrnetworkProxySource = { countryCode: code, countryName, kind, ...(uniqueExit ? { uniqueExit } : {}) };
    return this.addProxies(actorId, `urnetwork-add:${name}`, subscriptions, name, async (subscription, base, outboundTag) => {
      const apiKey = this.store.getUrnetworkKey(subscription.subId);
      if (!apiKey) {
        throw new Error("нет ключа URnetwork");
      }
      const upstream = await this.urnetwork.createProxy(
        apiKey,
        { location: code, uniqueExit },
        `vless-countries-bot ${subscription.slug}`,
      );
      let outbound: XrayOutbound;
      try {
        outbound = buildUrnetworkOutbound(outboundTag, upstream, kind, this.config.geOutboundTag);
      } catch (error) {
        await this.removeUpstream(apiKey, upstream);
        throw error;
      }
      return { subscription, apiKey, record: { ...base, provider: "urnetwork", source, upstream, outbound } };
    });
  }

  async addCustomProxies(
    actorId: number,
    subscriptions: Subscription[],
    name: string,
    url: string,
  ): Promise<ProxyApplyResult> {
    assertProxyName(name);
    if (name.startsWith("ur-")) {
      throw new Error("Имена ur-... зарезервированы для прокси URnetwork");
    }
    // Validate the URL once before touching any subscription.
    buildCustomProxyOutbound("validation", url, this.config.geOutboundTag);
    const source: CustomProxySource = { url: url.trim() };
    return this.addProxies(actorId, `custom-add:${name}`, subscriptions, name, async (subscription, base, outboundTag) => ({
      subscription,
      record: {
        ...base,
        provider: "custom",
        source,
        outbound: buildCustomProxyOutbound(outboundTag, url, this.config.geOutboundTag),
      },
    }));
  }

  async removeProxies(actorId: number, ids: number[]): Promise<ProxyRemoveResult> {
    return this.mutex.runExclusive(async () => {
      const proxies = ids.map((id) => this.requireProxy(id));
      if (!proxies.length) {
        return { removed: 0, upstreamLeftovers: [] };
      }
      const snapshot = await this.xui.getTemplate();
      const next = removeProxies(snapshot, proxies.map((proxy) => proxy.outbound.tag));
      const panelEmails = new Set((await this.xui.listClients()).map((client) => client.email.toLowerCase()));
      const deleted: ProxyRecord[] = [];
      let templateApplied = false;
      this.store.backupTemplate("proxy-remove", snapshot);
      try {
        for (const proxy of proxies) {
          if (panelEmails.has(proxy.email.toLowerCase())) {
            await this.xui.deleteClient(proxy);
            deleted.push(proxy);
          }
        }
        await this.xui.updateTemplate(next);
        templateApplied = true;
        for (const proxy of proxies) {
          this.store.deleteProxy(proxy.id);
        }
      } catch (error) {
        if (templateApplied) {
          await this.tryRestoreTemplate(snapshot);
        }
        for (const proxy of deleted) {
          await this.xui.createClient(proxy, this.config.inboundId).catch(() => {});
        }
        this.store.audit(actorId, "proxy-remove", null, false, safeMessage(error));
        throw error;
      }

      const upstreamLeftovers: string[] = [];
      for (const proxy of proxies) {
        if (!proxy.upstream) {
          continue;
        }
        const apiKey = this.store.getUrnetworkKey(proxy.subId);
        if (!apiKey || !await this.removeUpstream(apiKey, proxy.upstream)) {
          upstreamLeftovers.push(proxy.email);
        }
      }
      this.store.audit(
        actorId,
        "proxy-remove",
        null,
        true,
        `proxies=${proxies.map((proxy) => proxy.email).join(",")}, upstreamLeftovers=${upstreamLeftovers.length}`,
      );
      return { removed: proxies.length, upstreamLeftovers };
    });
  }

  private async addProxies(
    actorId: number,
    action: string,
    subscriptions: Subscription[],
    name: string,
    prepare: (
      subscription: Subscription,
      base: Pick<ProxyRecord, "subId" | "name" | "email" | "uuid" | "createdBy">,
      outboundTag: string,
    ) => Promise<ProxyDraft>,
  ): Promise<ProxyApplyResult> {
    return this.mutex.runExclusive(async () => {
      if (!subscriptions.length) {
        throw new Error("Не выбрано ни одной подписки");
      }
      const snapshot = await this.xui.getTemplate();
      assertGeOutbound(snapshot, this.config.geOutboundTag);
      const panelEmails = new Set((await this.xui.listClients()).map((client) => client.email.toLowerCase()));
      const drafts: ProxyDraft[] = [];
      const failed: ProxyApplyResult["failed"] = [];

      for (const subscription of subscriptions) {
        const email = proxyClientEmail(subscription.slug, name);
        let draft: ProxyDraft | undefined;
        try {
          if (this.store.listProxies(subscription.subId).some((proxy) => proxy.name === name)) {
            throw new Error(`прокси ${name} уже есть`);
          }
          if (panelEmails.has(email.toLowerCase())) {
            throw new Error(`клиент ${email} уже есть в 3x-ui`);
          }
          draft = await prepare(
            subscription,
            { subId: subscription.subId, name, email, uuid: crypto.randomUUID(), createdBy: actorId },
            proxyOutboundTag(subscription.slug, name),
          );
          const candidate = upsertProxies(snapshot, [{ outbound: draft.record.outbound, email }]);
          await this.xui.testOutbound(draft.record.outbound, candidate.outbounds);
          drafts.push(draft);
        } catch (error) {
          if (draft?.apiKey && draft.record.upstream) {
            await this.removeUpstream(draft.apiKey, draft.record.upstream);
          }
          failed.push({ slug: subscription.slug, reason: safeMessage(error) });
        }
      }
      if (!drafts.length) {
        this.store.audit(actorId, action, null, false, describeFailures(failed));
        return { added: [], failed };
      }

      const next = upsertProxies(snapshot, drafts.map((draft) => ({ outbound: draft.record.outbound, email: draft.record.email })));
      this.store.backupTemplate(action, snapshot);
      const added: ProxyRecord[] = [];
      let templateApplied = false;
      try {
        await this.xui.updateTemplate(next);
        templateApplied = true;
        for (const draft of drafts) {
          await this.xui.createClient(draft.record, this.config.inboundId);
          added.push(this.store.addProxy(draft.record));
        }
      } catch (error) {
        for (const proxy of [...added].reverse()) {
          await this.xui.deleteClient(proxy).catch(() => {});
          this.store.deleteProxy(proxy.id);
        }
        if (templateApplied) {
          await this.tryRestoreTemplate(snapshot);
        }
        for (const draft of drafts) {
          if (draft.apiKey && draft.record.upstream) {
            await this.removeUpstream(draft.apiKey, draft.record.upstream);
          }
        }
        this.store.audit(actorId, action, null, false, safeMessage(error));
        throw error;
      }
      this.store.audit(
        actorId,
        action,
        null,
        true,
        `added=${added.map((proxy) => proxy.email).join(",")}${failed.length ? `; ${describeFailures(failed)}` : ""}`,
      );
      return { added, failed };
    });
  }

  private async removeUpstream(apiKey: string, upstream: UrnetworkUpstream): Promise<boolean> {
    try {
      await this.urnetwork.removeProxy(apiKey, upstream.clientId);
      return true;
    } catch {
      // A leftover hosted proxy only occupies a slot on the account; ur.io removes unused ones after ~30 days.
      return false;
    }
  }

  private async tryRestoreTemplate(snapshot: XrayTemplate): Promise<void> {
    try {
      await this.xui.updateTemplate(snapshot);
    } catch {
      // Keep the original error and the backup for manual recovery.
    }
  }
}

function describeFailures(failed: ProxyApplyResult["failed"]): string {
  return `failed=${failed.map((item) => `${item.slug}: ${item.reason}`).join("; ")}`;
}

export function proxyDescription(proxy: Pick<ProxyRecord, "provider" | "source" | "outbound" | "upstream">): string {
  if (proxy.provider === "urnetwork") {
    const source = proxy.source as UrnetworkProxySource;
    const unique = source.uniqueExit
      ? `, unique exit${proxy.upstream?.exitLocation ? ` (${proxy.upstream.exitLocation})` : ""}`
      : "";
    return `URnetwork ${source.countryName}, ${source.kind === "socks" ? "SOCKS5" : "HTTPS"}${unique}`;
  }
  const endpoint = proxyServerEndpoint(proxy.outbound);
  return `свой ${proxy.outbound.protocol} ${endpoint ? `${endpoint.address}:${endpoint.port}` : "?"}`;
}
