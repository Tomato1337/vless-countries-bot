import { countryFlagFromSlug, managedClientEmail } from "./country-flag.ts";
import { Mutex } from "./mutex.ts";
import {
  assertNordVpnPrivateKey,
  buildNordVpnOutbound,
  buildNordVpnSource,
  NordVpnCatalog,
  nordVpnRegionSlug,
} from "./nordvpn.ts";
import type { NordVpnCity, NordVpnCountry, NordVpnServer } from "./nordvpn.ts";
import { safeMessage } from "./sanitize.ts";
import { Store } from "./store.ts";
import { assertGeOutbound, removeExit, upsertExit } from "./template.ts";
import type {
  ManagedClient,
  ManualVlessSource,
  NordVpnSource,
  VpnExit,
  XuiApi,
  XuiClient,
  XrayOutbound,
  XrayTemplate,
} from "./types.ts";
import { buildCountryOutbound } from "./vless.ts";

export interface CountryServiceConfig {
  geOutboundTag: string;
  inboundId: number;
  nordVpnPrivateKey?: string;
}

export interface SyncResult {
  created: string[];
  renamed: string[];
  skipped: number;
}

export interface SetCountryResult extends SyncResult {
  createdCountry: boolean;
}

export interface NordVpnApplyResult extends SyncResult {
  slug: string;
  source: NordVpnSource;
  attemptedHostnames: string[];
}

export interface NordVpnRepairResult {
  slug: string;
  source: NordVpnSource;
  attemptedHostnames: string[];
}

export interface NordVpnCityOption {
  city: NordVpnCity;
  slug: string;
  existing?: VpnExit;
}

export class CountryService {
  private readonly mutex = new Mutex();

  constructor(
    private readonly store: Store,
    private readonly xui: XuiApi,
    private readonly config: CountryServiceConfig,
    private readonly nordCatalog = new NordVpnCatalog(),
  ) {}

  async checkCompatibility(): Promise<void> {
    await this.xui.checkCompatibility(this.config.geOutboundTag, this.config.inboundId);
  }

  listCountries(): string[] {
    return this.store.listExits().map((vpnExit) => vpnExit.slug);
  }

  listExits(): VpnExit[] {
    return this.store.listExits();
  }

  getExit(slug: string): VpnExit | undefined {
    return this.store.getExit(slug);
  }

  getExitById(id: number): VpnExit | undefined {
    return this.store.getExitById(id);
  }

  findNordVpnExit(countryId: number, cityId: number): VpnExit | undefined {
    return this.store.listExits("nordvpn").find((vpnExit) => {
      const source = nordVpnSource(vpnExit);
      return source.countryId === countryId && source.cityId === cityId;
    });
  }

  nordVpnAvailabilityError(): string | undefined {
    try {
      assertNordVpnPrivateKey(this.config.nordVpnPrivateKey);
      return undefined;
    } catch (error) {
      return safeMessage(error);
    }
  }

  async listNordVpnCountries(force = false): Promise<NordVpnCountry[]> {
    this.requireNordVpnPrivateKey();
    return this.nordCatalog.listCountries(force);
  }

  async listNordVpnCities(countryId: number, force = false): Promise<NordVpnCity[]> {
    this.requireNordVpnPrivateKey();
    return this.nordCatalog.listCities(countryId, force);
  }

  async listNordVpnCityOptions(countryId: number, force = false): Promise<NordVpnCityOption[]> {
    const [countries, cities] = await Promise.all([
      this.listNordVpnCountries(force),
      this.listNordVpnCities(countryId, force),
    ]);
    const country = requireById(countries, countryId, "NordVPN country");
    return cities.map((city) => {
      const slug = this.nordVpnSlug(country, city, cities);
      return { city, slug, existing: this.store.getExit(slug) };
    });
  }

  async listNordVpnServers(countryId: number, cityId?: number, force = false): Promise<NordVpnServer[]> {
    this.requireNordVpnPrivateKey();
    const servers = await this.nordCatalog.listServers(countryId, force);
    return cityId === undefined ? servers : servers.filter((server) => server.cityId === cityId);
  }

  async setCountry(actorId: number, slug: string, uri: string): Promise<SetCountryResult> {
    return this.mutex.runExclusive(async () => {
      assertCountrySlug(slug);
      countryFlagFromSlug(slug);
      const previous = this.store.getExit(slug);
      if (previous?.provider === "nordvpn") {
        throw new Error(`Exit ${slug} is managed by NordVPN and cannot be overwritten with /set`);
      }
      const snapshot = await this.xui.getTemplate();
      assertGeOutbound(snapshot, this.config.geOutboundTag);
      const outbound = buildCountryOutbound(slug, uri, this.config.geOutboundTag);
      const next = upsertExit(snapshot, slug, outbound);
      await this.xui.testOutbound(outbound, next.outbounds);
      this.store.backupTemplate(`set:${slug}`, snapshot, this.config.nordVpnPrivateKey);

      let templateApplied = false;
      const created: ManagedClient[] = [];
      const renamed: RenamedClient[] = [];
      try {
        await this.xui.updateTemplate(next);
        templateApplied = true;
        this.store.upsertManualExit(slug, uri, outbound);
        const sync = previous
          ? { created: [], renamed: [], skipped: 0 }
          : await this.syncExit(slug, created, renamed);
        this.store.audit(actorId, "set", slug, true, previous ? "updated" : "created");
        return { createdCountry: !previous, ...sync };
      } catch (error) {
        await this.rollbackCreatedClients(created);
        await this.rollbackRenamedClients(renamed);
        if (previous) {
          this.store.upsertManualExit(previous.slug, manualUri(previous), previous.outbound);
        } else {
          this.store.deleteExit(slug);
        }
        if (templateApplied) {
          await this.tryRestoreTemplate(snapshot);
        }
        this.store.audit(actorId, "set", slug, false, safeMessage(error));
        throw error;
      }
    });
  }

  async addNordVpnRegion(
    actorId: number,
    countryId: number,
    cityId: number,
    serverId?: number,
  ): Promise<NordVpnApplyResult> {
    return this.mutex.runExclusive(async () => {
      const privateKey = this.requireNordVpnPrivateKey();
      const [countries, cities, cityServers] = await Promise.all([
        this.nordCatalog.listCountries(),
        this.nordCatalog.listCities(countryId),
        this.listNordVpnServers(countryId, cityId),
      ]);
      const country = requireById(countries, countryId, "NordVPN country");
      const city = requireById(cities, cityId, "NordVPN city");
      const slug = this.nordVpnSlug(country, city, cities);
      const existing = this.store.getExit(slug);
      if (existing) {
        throw new Error(
          existing.provider === "nordvpn"
            ? `NordVPN region already exists: ${slug}`
            : `Exit slug is already occupied by a manual VLESS profile: ${slug}`,
        );
      }
      const snapshot = await this.xui.getTemplate();
      assertGeOutbound(snapshot, this.config.geOutboundTag);
      const chosen = await this.chooseNordVpnCandidate(
        snapshot,
        slug,
        country,
        city,
        selectServers(cityServers, serverId),
        privateKey,
      );
      this.store.backupTemplate(`nord-add:${slug}`, snapshot, privateKey);
      const created: ManagedClient[] = [];
      const renamed: RenamedClient[] = [];
      let templateApplied = false;
      try {
        await this.xui.updateTemplate(chosen.template);
        templateApplied = true;
        this.store.upsertNordVpnExit(slug, chosen.source, chosen.outbound);
        const sync = await this.syncExit(slug, created, renamed);
        this.store.audit(actorId, "nord-add", slug, true, `hostname=${chosen.source.hostname}`);
        return { slug, source: chosen.source, attemptedHostnames: chosen.attemptedHostnames, ...sync };
      } catch (error) {
        await this.rollbackCreatedClients(created);
        await this.rollbackRenamedClients(renamed);
        this.store.deleteExit(slug);
        if (templateApplied) {
          await this.tryRestoreTemplate(snapshot);
        }
        this.store.audit(actorId, "nord-add", slug, false, safeMessage(error));
        throw error;
      }
    });
  }

  async repairNordVpnRegion(
    actorId: number,
    slug: string,
    serverId?: number,
  ): Promise<NordVpnRepairResult> {
    return this.mutex.runExclusive(async () => {
      const privateKey = this.requireNordVpnPrivateKey();
      const current = this.requireNordVpnExit(slug);
      const previousSource = nordVpnSource(current);
      const [countries, cities, servers] = await Promise.all([
        this.nordCatalog.listCountries(true),
        this.nordCatalog.listCities(previousSource.countryId, true),
        this.listNordVpnServers(previousSource.countryId, previousSource.cityId, true),
      ]);
      const country = requireById(countries, previousSource.countryId, "NordVPN country");
      const city = requireById(cities, previousSource.cityId, "NordVPN city");
      const ordered = selectRepairServers(servers, previousSource.hostname, serverId);
      const snapshot = await this.xui.getTemplate();
      assertGeOutbound(snapshot, this.config.geOutboundTag);
      const chosen = await this.chooseNordVpnCandidate(snapshot, slug, country, city, ordered, privateKey);
      this.store.backupTemplate(`nord-repair:${slug}`, snapshot, privateKey);
      try {
        await this.xui.updateTemplate(chosen.template);
        this.store.upsertNordVpnExit(slug, chosen.source, chosen.outbound);
        this.store.audit(actorId, "nord-repair", slug, true, `hostname=${chosen.source.hostname}`);
        return { slug, source: chosen.source, attemptedHostnames: chosen.attemptedHostnames };
      } catch (error) {
        await this.tryRestoreTemplate(snapshot);
        this.store.upsertNordVpnExit(slug, previousSource, current.outbound);
        this.store.audit(actorId, "nord-repair", slug, false, safeMessage(error));
        throw error;
      }
    });
  }

  async sync(actorId: number): Promise<SyncResult> {
    return this.mutex.runExclusive(async () => {
      const created: ManagedClient[] = [];
      const renamed: RenamedClient[] = [];
      try {
        let skipped = 0;
        for (const vpnExit of this.store.listExits()) {
          const result = await this.syncExit(vpnExit.slug, created, renamed);
          skipped += result.skipped;
        }
        this.store.audit(actorId, "sync", null, true, `created=${created.length}, renamed=${renamed.length}`);
        return {
          created: created.map((client) => client.email),
          renamed: renamed.map(({ after }) => after.email),
          skipped,
        };
      } catch (error) {
        await this.rollbackCreatedClients(created);
        await this.rollbackRenamedClients(renamed);
        this.store.audit(actorId, "sync", null, false, safeMessage(error));
        throw error;
      }
    });
  }

  async removeCountry(actorId: number, slug: string): Promise<number> {
    return this.mutex.runExclusive(async () => {
      assertCountrySlug(slug);
      const vpnExit = this.store.getExit(slug);
      if (!vpnExit) {
        throw new Error(`Exit does not exist: ${slug}`);
      }

      const snapshot = await this.xui.getTemplate();
      const next = removeExit(snapshot, slug, vpnExit.outbound.tag);
      const clients = this.store.listManagedClients(slug);
      const deleted: ManagedClient[] = [];
      let templateApplied = false;
      this.store.backupTemplate(`remove:${slug}`, snapshot, this.config.nordVpnPrivateKey);

      try {
        for (const client of clients) {
          await this.xui.deleteClient(client);
          deleted.push(client);
        }
        await this.xui.updateTemplate(next);
        templateApplied = true;
        this.store.deleteExit(slug);
        this.store.audit(actorId, "remove", slug, true, `clients=${deleted.length}`);
        return deleted.length;
      } catch (error) {
        if (templateApplied) {
          await this.tryRestoreTemplate(snapshot);
        }
        await this.restoreDeletedClients(deleted);
        this.store.audit(actorId, "remove", slug, false, safeMessage(error));
        throw error;
      }
    });
  }

  private async chooseNordVpnCandidate(
    snapshot: XrayTemplate,
    slug: string,
    country: NordVpnCountry,
    city: NordVpnCity,
    servers: NordVpnServer[],
    privateKey: string,
  ): Promise<{
    outbound: XrayOutbound;
    source: NordVpnSource;
    template: XrayTemplate;
    attemptedHostnames: string[];
  }> {
    const attemptedHostnames: string[] = [];
    for (const server of servers) {
      attemptedHostnames.push(server.hostname);
      const source = buildNordVpnSource(country, city, server);
      const outbound = buildNordVpnOutbound(slug, source, privateKey, this.config.geOutboundTag);
      const template = upsertExit(snapshot, slug, outbound);
      try {
        await this.xui.testOutbound(outbound, template.outbounds);
        return { outbound, source, template, attemptedHostnames };
      } catch {
        // The caller reports only safe hostnames and offers a manual selection.
      }
    }
    throw new Error(`NordVPN outbound test failed for: ${attemptedHostnames.join(", ") || "no available servers"}`);
  }

  private nordVpnSlug(country: NordVpnCountry, city: NordVpnCity, cities: NordVpnCity[]): string {
    const plain = nordVpnRegionSlug(country.code, city.name);
    const collisions = cities.filter((item) => nordVpnRegionSlug(country.code, item.name) === plain);
    return collisions.length > 1 ? nordVpnRegionSlug(country.code, city.name, city.id) : plain;
  }

  private requireNordVpnPrivateKey(): string {
    return assertNordVpnPrivateKey(this.config.nordVpnPrivateKey);
  }

  private requireNordVpnExit(slug: string): VpnExit {
    const vpnExit = this.store.getExit(slug);
    if (!vpnExit || vpnExit.provider !== "nordvpn") {
      throw new Error(`NordVPN region does not exist: ${slug}`);
    }
    return vpnExit;
  }

  private async syncExit(
    slug: string,
    created: ManagedClient[],
    renamed: RenamedClient[],
  ): Promise<SyncResult> {
    countryFlagFromSlug(slug);
    const clients = await this.xui.listClients();
    const subscriptions = collectSubscriptions(clients, this.config.inboundId);
    const panelEmails = new Set(clients.map((client) => client.email.toLowerCase()));
    const pending: ManagedClient[] = [];
    const pendingRenames: RenamedClient[] = [];
    const managedBySubId = new Map<string, ManagedClient>();

    for (const client of this.store.listManagedClients(slug)) {
      if (managedBySubId.has(client.subId)) {
        throw new Error(`Multiple managed profiles exist for subscription ${JSON.stringify(client.subId)} and exit ${slug}`);
      }
      managedBySubId.set(client.subId, client);
    }

    for (const subscription of subscriptions) {
      const email = managedClientEmail(subscription.slug, slug);
      const existing = managedBySubId.get(subscription.subId);
      if (existing?.email === email) {
        continue;
      }
      if (panelEmails.has(email.toLowerCase()) && existing?.email.toLowerCase() !== email.toLowerCase()) {
        throw new Error(`Managed email collides with an existing 3x-ui client: ${email}`);
      }
      if (existing) {
        pendingRenames.push({ before: existing, after: { ...existing, email } });
        continue;
      }
      pending.push({
        exitSlug: slug,
        email,
        subId: subscription.subId,
        uuid: crypto.randomUUID(),
      });
    }

    for (const rename of pendingRenames) {
      await this.xui.renameClient(rename.before, rename.after.email, this.config.inboundId);
      try {
        this.store.renameManagedClient(rename.before.email, rename.after.email);
      } catch (error) {
        await this.xui.renameClient(rename.after, rename.before.email, this.config.inboundId);
        throw error;
      }
      renamed.push(rename);
    }

    for (const client of pending) {
      await this.xui.createClient(client, this.config.inboundId);
      this.store.addManagedClient(client);
      created.push(client);
    }
    return {
      created: pending.map((client) => client.email),
      renamed: pendingRenames.map(({ after }) => after.email),
      skipped: subscriptions.length - pending.length - pendingRenames.length,
    };
  }

  private async rollbackCreatedClients(created: ManagedClient[]): Promise<void> {
    for (const client of [...created].reverse()) {
      try {
        await this.xui.deleteClient(client);
      } catch {
        // Preserve the original error. The audit event still records the failed operation.
      }
      this.store.deleteManagedClient(client.email);
    }
  }

  private async restoreDeletedClients(deleted: ManagedClient[]): Promise<void> {
    for (const client of deleted) {
      try {
        await this.xui.createClient(client, this.config.inboundId);
      } catch {
        // The local record remains, making the incomplete rollback visible to a later /sync.
      }
    }
  }

  private async rollbackRenamedClients(renamed: RenamedClient[]): Promise<void> {
    for (const rename of [...renamed].reverse()) {
      try {
        await this.xui.renameClient(rename.after, rename.before.email, this.config.inboundId);
        this.store.renameManagedClient(rename.after.email, rename.before.email);
      } catch {
        // Keep the original error. The stored record makes an incomplete rollback visible.
      }
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

interface RenamedClient {
  before: ManagedClient;
  after: ManagedClient;
}

export function assertCountrySlug(slug: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error("Exit slug must contain lowercase letters, digits and single hyphens");
  }
}

export function normalizeSubscriptionSlug(subId: string): string {
  const trimmed = subId.trim();
  if (!trimmed || !/^[\x20-\x7e]+$/.test(trimmed)) {
    throw new Error(`Subscription must be a non-empty ASCII value: ${JSON.stringify(subId)}`);
  }
  const slug = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!slug) {
    throw new Error(`Subscription cannot be normalized to a slug: ${JSON.stringify(subId)}`);
  }
  return slug;
}

export function collectSubscriptions(
  clients: XuiClient[],
  inboundId: number,
): Array<{ subId: string; slug: string }> {
  const bySubId = new Map<string, string>();
  const bySlug = new Map<string, string>();
  for (const client of clients) {
    if (!client.inboundIds.includes(inboundId) || !client.subId.trim()) {
      continue;
    }
    const slug = normalizeSubscriptionSlug(client.subId);
    const existingSubId = bySlug.get(slug);
    if (existingSubId && existingSubId !== client.subId) {
      throw new Error(
        `Subscription slug collision: ${JSON.stringify(existingSubId)} and ${JSON.stringify(client.subId)} both become ${slug}`,
      );
    }
    bySlug.set(slug, client.subId);
    bySubId.set(client.subId, slug);
  }
  return [...bySubId].map(([subId, slug]) => ({ subId, slug }));
}

function manualUri(vpnExit: VpnExit): string {
  return (vpnExit.source as ManualVlessSource).uri;
}

function nordVpnSource(vpnExit: VpnExit): NordVpnSource {
  return vpnExit.source as NordVpnSource;
}

function requireById<T extends { id: number }>(items: T[], id: number, label: string): T {
  const item = items.find((value) => value.id === id);
  if (!item) {
    throw new Error(`${label} does not exist: ${id}`);
  }
  return item;
}

function selectServers(servers: NordVpnServer[], serverId?: number): NordVpnServer[] {
  if (serverId !== undefined) {
    return [requireById(servers, serverId, "NordVPN server")];
  }
  return servers.slice(0, 5);
}

function selectRepairServers(
  servers: NordVpnServer[],
  currentHostname: string,
  serverId?: number,
): NordVpnServer[] {
  if (serverId !== undefined) {
    return [requireById(servers, serverId, "NordVPN server")];
  }
  const current = servers.find((server) => server.hostname === currentHostname);
  const alternatives = servers.filter((server) => server.hostname !== currentHostname).slice(0, 4);
  return current ? [...alternatives, current] : alternatives.slice(0, 5);
}
