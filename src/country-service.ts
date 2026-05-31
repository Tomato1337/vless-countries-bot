import { Mutex } from "./mutex.ts";
import { countryFlagFromSlug, managedClientEmail } from "./country-flag.ts";
import { safeMessage } from "./sanitize.ts";
import { Store } from "./store.ts";
import { assertGeOutbound, removeCountry, upsertCountry } from "./template.ts";
import type { ManagedClient, XuiApi, XuiClient, XrayTemplate } from "./types.ts";
import { buildCountryOutbound } from "./vless.ts";

export interface CountryServiceConfig {
  geOutboundTag: string;
  inboundId: number;
}

export interface SyncResult {
  created: string[];
  renamed: string[];
  skipped: number;
}

export interface SetCountryResult extends SyncResult {
  createdCountry: boolean;
}

export class CountryService {
  private readonly mutex = new Mutex();

  constructor(
    private readonly store: Store,
    private readonly xui: XuiApi,
    private readonly config: CountryServiceConfig,
  ) {}

  async checkCompatibility(): Promise<void> {
    await this.xui.checkCompatibility(this.config.geOutboundTag, this.config.inboundId);
  }

  listCountries(): string[] {
    return this.store.listCountries().map((country) => country.slug);
  }

  async setCountry(actorId: number, slug: string, uri: string): Promise<SetCountryResult> {
    return this.mutex.runExclusive(async () => {
      assertCountrySlug(slug);
      countryFlagFromSlug(slug);
      const previous = this.store.getCountry(slug);
      const snapshot = await this.xui.getTemplate();
      assertGeOutbound(snapshot, this.config.geOutboundTag);
      const outbound = buildCountryOutbound(slug, uri, this.config.geOutboundTag);
      const next = upsertCountry(snapshot, slug, outbound);
      await this.xui.testOutbound(outbound, next.outbounds);
      this.store.backupTemplate(`set:${slug}`, snapshot);

      let templateApplied = false;
      const created: ManagedClient[] = [];
      const renamed: RenamedClient[] = [];
      try {
        await this.xui.updateTemplate(next);
        templateApplied = true;
        this.store.upsertCountry(slug, uri, outbound);
        const sync = previous
          ? { created: [], renamed: [], skipped: 0 }
          : await this.syncCountry(slug, created, renamed);
        this.store.audit(actorId, "set", slug, true, previous ? "updated" : "created");
        return { createdCountry: !previous, ...sync };
      } catch (error) {
        await this.rollbackCreatedClients(created);
        await this.rollbackRenamedClients(renamed);
        if (previous) {
          this.store.upsertCountry(previous.slug, previous.uri, previous.outbound);
        } else {
          this.store.deleteCountry(slug);
        }
        if (templateApplied) {
          await this.tryRestoreTemplate(snapshot);
        }
        this.store.audit(actorId, "set", slug, false, safeMessage(error));
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
        for (const country of this.store.listCountries()) {
          const result = await this.syncCountry(country.slug, created, renamed);
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
      const country = this.store.getCountry(slug);
      if (!country) {
        throw new Error(`Country does not exist: ${slug}`);
      }

      const snapshot = await this.xui.getTemplate();
      const next = removeCountry(snapshot, slug);
      const clients = this.store.listManagedClients(slug);
      const deleted: ManagedClient[] = [];
      let templateApplied = false;
      this.store.backupTemplate(`remove:${slug}`, snapshot);

      try {
        for (const client of clients) {
          await this.xui.deleteClient(client);
          deleted.push(client);
        }
        await this.xui.updateTemplate(next);
        templateApplied = true;
        this.store.deleteCountry(slug);
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

  private async syncCountry(
    slug: string,
    created: ManagedClient[],
    renamed: RenamedClient[],
  ): Promise<SyncResult> {
    countryFlagFromSlug(slug);
    const clients = await this.xui.listClients();
    const subscriptions = collectSubscriptions(clients, this.config.inboundId);
    const panelEmails = new Set(
      clients.map((client) => client.email.toLowerCase()),
    );
    const pending: ManagedClient[] = [];
    const pendingRenames: RenamedClient[] = [];
    const managedBySubId = new Map<string, ManagedClient>();

    for (const client of this.store.listManagedClients(slug)) {
      if (managedBySubId.has(client.subId)) {
        throw new Error(`Multiple managed profiles exist for subscription ${JSON.stringify(client.subId)} and country ${slug}`);
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
        countrySlug: slug,
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
    throw new Error("Country code must contain lowercase letters, digits and single hyphens");
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
