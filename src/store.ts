import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  ExitProvider,
  JsonObject,
  ManagedClient,
  ManualVlessSource,
  NordVpnSource,
  ProxyRecord,
  TelegramUserInfo,
  VpnExit,
  WizardSession,
  XrayOutbound,
  XrayTemplate,
} from "./types.ts";

interface ExitRow {
  id: number;
  slug: string;
  provider: ExitProvider;
  source_json: string;
  outbound_json: string;
  created_at: string;
  updated_at: string;
}

interface ManagedClientRow {
  exit_slug: string;
  email: string;
  sub_id: string;
  uuid: string;
}

interface WizardSessionRow {
  chat_id: number;
  user_id: number;
  flow: string;
  step: string;
  payload_json: string;
  expires_at: string;
}

interface ProxyRow {
  id: number;
  sub_id: string;
  name: string;
  provider: ProxyRecord["provider"];
  source_json: string;
  upstream_json: string | null;
  outbound_json: string;
  email: string;
  uuid: string;
  created_by: number;
  created_at: string;
}

interface TelegramUserRow {
  telegram_id: number;
  first_name: string | null;
  last_name: string | null;
  username: string | null;
  profile_sub_id: string | null;
}

export class Store {
  readonly db: Database;

  constructor(path = ":memory:") {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    this.db = new Database(path, { create: true });
    if (path !== ":memory:") {
      chmodSync(path, 0o600);
    }
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    const version = this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS exits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL UNIQUE,
        provider TEXT NOT NULL,
        source_json TEXT NOT NULL,
        outbound_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS exit_clients (
        email TEXT PRIMARY KEY,
        exit_slug TEXT NOT NULL REFERENCES exits(slug) ON DELETE CASCADE,
        sub_id TEXT NOT NULL,
        uuid TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS trusted_users (
        telegram_id INTEGER PRIMARY KEY,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS template_backups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reason TEXT NOT NULL,
        template_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_id INTEGER NOT NULL,
        action TEXT NOT NULL,
        country_slug TEXT,
        success INTEGER NOT NULL,
        details TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS wizard_sessions (
        chat_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        flow TEXT NOT NULL,
        step TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY (chat_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS nordvpn_server_selections (
        country_id INTEGER NOT NULL,
        city_id INTEGER NOT NULL,
        hostname TEXT NOT NULL,
        selected_at TEXT NOT NULL,
        PRIMARY KEY (country_id, city_id, hostname)
      );
      CREATE TABLE IF NOT EXISTS telegram_users (
        telegram_id INTEGER PRIMARY KEY,
        first_name TEXT,
        last_name TEXT,
        username TEXT,
        profile_sub_id TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS subscription_settings (
        sub_id TEXT PRIMARY KEY,
        urnetwork_api_key TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS proxies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sub_id TEXT NOT NULL,
        name TEXT NOT NULL,
        provider TEXT NOT NULL,
        source_json TEXT NOT NULL,
        upstream_json TEXT,
        outbound_json TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        uuid TEXT NOT NULL,
        created_by INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (sub_id, name)
      );
    `);
    if (version < 2) {
      this.copyLegacyData();
      this.db.exec("PRAGMA user_version = 2;");
    }
    if (version < 3) {
      // Servers chosen before selections were tracked: the exit's last update is the best known choice time.
      this.db.exec(`
        INSERT OR IGNORE INTO nordvpn_server_selections (country_id, city_id, hostname, selected_at)
        SELECT json_extract(source_json, '$.countryId'), json_extract(source_json, '$.cityId'),
          json_extract(source_json, '$.hostname'), updated_at
        FROM exits WHERE provider = 'nordvpn';
        PRAGMA user_version = 3;
      `);
    }
  }

  private copyLegacyData(): void {
    if (!this.tableExists("countries")) {
      return;
    }
    const legacyCountries = this.db.query<{
      slug: string;
      uri: string;
      outbound_json: string;
      created_at: string;
      updated_at: string;
    }, []>("SELECT * FROM countries").all();
    const insertExit = this.db.query(`
      INSERT INTO exits (slug, provider, source_json, outbound_json, created_at, updated_at)
      VALUES (?, 'manual-vless', ?, ?, ?, ?)
      ON CONFLICT(slug) DO NOTHING
    `);
    const insertClient = this.db.query(`
      INSERT INTO exit_clients (email, exit_slug, sub_id, uuid)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(email) DO NOTHING
    `);
    this.db.transaction(() => {
      for (const country of legacyCountries) {
        insertExit.run(
          country.slug,
          JSON.stringify({ uri: country.uri }),
          country.outbound_json,
          country.created_at,
          country.updated_at,
        );
      }
      if (this.tableExists("managed_clients")) {
        const clients = this.db.query<{
          email: string;
          country_slug: string;
          sub_id: string;
          uuid: string;
        }, []>("SELECT * FROM managed_clients").all();
        for (const client of clients) {
          insertClient.run(client.email, client.country_slug, client.sub_id, client.uuid);
        }
      }
    })();
  }

  private tableExists(name: string): boolean {
    return Boolean(this.db.query<{ count: number }, [string]>(
      "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(name)?.count);
  }

  getExit(slug: string): VpnExit | undefined {
    const row = this.db.query<ExitRow, [string]>(
      "SELECT * FROM exits WHERE slug = ?",
    ).get(slug);
    return row ? exitFromRow(row) : undefined;
  }

  getExitById(id: number): VpnExit | undefined {
    const row = this.db.query<ExitRow, [number]>(
      "SELECT * FROM exits WHERE id = ?",
    ).get(id);
    return row ? exitFromRow(row) : undefined;
  }

  listExits(provider?: ExitProvider): VpnExit[] {
    const rows = provider
      ? this.db.query<ExitRow, [ExitProvider]>(
          "SELECT * FROM exits WHERE provider = ? ORDER BY slug",
        ).all(provider)
      : this.db.query<ExitRow, []>("SELECT * FROM exits ORDER BY slug").all();
    return rows.map(exitFromRow);
  }

  upsertManualExit(slug: string, uri: string, outbound: XrayOutbound): void {
    this.upsertExit(slug, "manual-vless", { uri }, outbound);
  }

  upsertNordVpnExit(slug: string, source: NordVpnSource, outbound: XrayOutbound): void {
    this.upsertExit(slug, "nordvpn", source, redactOutbound(outbound));
  }

  private upsertExit(
    slug: string,
    provider: ExitProvider,
    source: ManualVlessSource | NordVpnSource,
    outbound: XrayOutbound,
  ): void {
    const now = new Date().toISOString();
    this.db.query(`
      INSERT INTO exits (slug, provider, source_json, outbound_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(slug) DO UPDATE SET
        provider = excluded.provider,
        source_json = excluded.source_json,
        outbound_json = excluded.outbound_json,
        updated_at = excluded.updated_at
    `).run(slug, provider, JSON.stringify(source), JSON.stringify(outbound), now, now);
  }

  deleteExit(slug: string): void {
    this.db.query("DELETE FROM exits WHERE slug = ?").run(slug);
  }

  markNordVpnServerSelected(source: NordVpnSource): void {
    this.db.query(`
      INSERT INTO nordvpn_server_selections (country_id, city_id, hostname, selected_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(country_id, city_id, hostname) DO UPDATE SET selected_at = excluded.selected_at
    `).run(source.countryId, source.cityId, source.hostname, new Date().toISOString());
  }

  /** Last selection time (ISO) per hostname within one NordVPN country and city. */
  listNordVpnServerSelections(countryId: number, cityId: number): Map<string, string> {
    const rows = this.db.query<{ hostname: string; selected_at: string }, [number, number]>(
      "SELECT hostname, selected_at FROM nordvpn_server_selections WHERE country_id = ? AND city_id = ?",
    ).all(countryId, cityId);
    return new Map(rows.map((row) => [row.hostname, row.selected_at]));
  }

  addManagedClient(client: ManagedClient): void {
    this.db.query(`
      INSERT INTO exit_clients (exit_slug, email, sub_id, uuid)
      VALUES (?, ?, ?, ?)
    `).run(client.exitSlug, client.email, client.subId, client.uuid);
  }

  deleteManagedClient(email: string): void {
    this.db.query("DELETE FROM exit_clients WHERE email = ?").run(email);
  }

  renameManagedClient(currentEmail: string, nextEmail: string): void {
    this.db.query("UPDATE exit_clients SET email = ? WHERE email = ?").run(nextEmail, currentEmail);
  }

  listManagedClients(exitSlug?: string): ManagedClient[] {
    const rows = exitSlug
      ? this.db.query<ManagedClientRow, [string]>(
          "SELECT * FROM exit_clients WHERE exit_slug = ? ORDER BY email",
        ).all(exitSlug)
      : this.db.query<ManagedClientRow, []>(
          "SELECT * FROM exit_clients ORDER BY email",
        ).all();
    return rows.map(managedClientFromRow);
  }

  isManagedEmail(email: string): boolean {
    return Boolean(this.db.query<{ count: number }, [string]>(
      "SELECT count(*) AS count FROM exit_clients WHERE email = ?",
    ).get(email)?.count);
  }

  addTrustedUser(telegramId: number): void {
    this.db.query(`
      INSERT INTO trusted_users (telegram_id, created_at)
      VALUES (?, ?)
      ON CONFLICT(telegram_id) DO NOTHING
    `).run(telegramId, new Date().toISOString());
  }

  deleteTrustedUser(telegramId: number): void {
    this.db.transaction(() => {
      this.db.query("DELETE FROM trusted_users WHERE telegram_id = ?").run(telegramId);
      this.db.query("UPDATE telegram_users SET profile_sub_id = NULL WHERE telegram_id = ?").run(telegramId);
    })();
  }

  isTrustedUser(telegramId: number): boolean {
    return Boolean(this.db.query<{ count: number }, [number]>(
      "SELECT count(*) AS count FROM trusted_users WHERE telegram_id = ?",
    ).get(telegramId)?.count);
  }

  listTrustedUsers(): number[] {
    return this.db.query<{ telegram_id: number }, []>(
      "SELECT telegram_id FROM trusted_users ORDER BY telegram_id",
    ).all().map((row) => row.telegram_id);
  }

  /** Refreshes the Telegram name and @username; keeps the owner-assigned profile binding. */
  rememberTelegramUser(user: Omit<TelegramUserInfo, "profileSubId">): void {
    this.db.query(`
      INSERT INTO telegram_users (telegram_id, first_name, last_name, username, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(telegram_id) DO UPDATE SET
        first_name = excluded.first_name,
        last_name = excluded.last_name,
        username = excluded.username,
        updated_at = excluded.updated_at
    `).run(
      user.telegramId,
      user.firstName ?? null,
      user.lastName ?? null,
      user.username ?? null,
      new Date().toISOString(),
    );
  }

  getTelegramUser(telegramId: number): TelegramUserInfo | undefined {
    const row = this.db.query<TelegramUserRow, [number]>(
      "SELECT * FROM telegram_users WHERE telegram_id = ?",
    ).get(telegramId);
    return row ? telegramUserFromRow(row) : undefined;
  }

  listTelegramUsersByProfile(subId: string): TelegramUserInfo[] {
    return this.db.query<TelegramUserRow, [string]>(
      "SELECT * FROM telegram_users WHERE profile_sub_id = ? ORDER BY telegram_id",
    ).all(subId).map(telegramUserFromRow);
  }

  setProfileBinding(telegramId: number, subId: string | undefined): void {
    this.db.query(`
      INSERT INTO telegram_users (telegram_id, profile_sub_id, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(telegram_id) DO UPDATE SET profile_sub_id = excluded.profile_sub_id
    `).run(telegramId, subId ?? null, new Date().toISOString());
  }

  getUrnetworkKey(subId: string): string | undefined {
    return this.db.query<{ urnetwork_api_key: string | null }, [string]>(
      "SELECT urnetwork_api_key FROM subscription_settings WHERE sub_id = ?",
    ).get(subId)?.urnetwork_api_key ?? undefined;
  }

  setUrnetworkKey(subId: string, apiKey: string | undefined): void {
    this.db.query(`
      INSERT INTO subscription_settings (sub_id, urnetwork_api_key, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(sub_id) DO UPDATE SET
        urnetwork_api_key = excluded.urnetwork_api_key,
        updated_at = excluded.updated_at
    `).run(subId, apiKey ?? null, new Date().toISOString());
  }

  addProxy(record: Omit<ProxyRecord, "id" | "createdAt">): ProxyRecord {
    const row = this.db.query<ProxyRow, [string, string, string, string, string | null, string, string, string, number, string]>(`
      INSERT INTO proxies
        (sub_id, name, provider, source_json, upstream_json, outbound_json, email, uuid, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `).get(
      record.subId,
      record.name,
      record.provider,
      JSON.stringify(record.source),
      record.upstream ? JSON.stringify(record.upstream) : null,
      JSON.stringify(record.outbound),
      record.email,
      record.uuid,
      record.createdBy,
      new Date().toISOString(),
    );
    return proxyFromRow(row!);
  }

  getProxy(id: number): ProxyRecord | undefined {
    const row = this.db.query<ProxyRow, [number]>("SELECT * FROM proxies WHERE id = ?").get(id);
    return row ? proxyFromRow(row) : undefined;
  }

  listProxies(subId?: string): ProxyRecord[] {
    const rows = subId === undefined
      ? this.db.query<ProxyRow, []>("SELECT * FROM proxies ORDER BY name, sub_id").all()
      : this.db.query<ProxyRow, [string]>("SELECT * FROM proxies WHERE sub_id = ? ORDER BY name").all(subId);
    return rows.map(proxyFromRow);
  }

  deleteProxy(id: number): void {
    this.db.query("DELETE FROM proxies WHERE id = ?").run(id);
  }

  listUrnetworkKeys(): Map<string, string> {
    const rows = this.db.query<{ sub_id: string; urnetwork_api_key: string }, []>(
      "SELECT sub_id, urnetwork_api_key FROM subscription_settings WHERE urnetwork_api_key IS NOT NULL ORDER BY sub_id",
    ).all();
    return new Map(rows.map((row) => [row.sub_id, row.urnetwork_api_key]));
  }

  backupTemplate(reason: string, template: XrayTemplate, nordVpnPrivateKey?: string): void {
    this.db.query(`
      INSERT INTO template_backups (reason, template_json, created_at)
      VALUES (?, ?, ?)
    `).run(reason, JSON.stringify(redactTemplate(template, nordVpnPrivateKey)), new Date().toISOString());
  }

  upsertWizardSession(session: WizardSession): void {
    this.db.query(`
      INSERT INTO wizard_sessions (chat_id, user_id, flow, step, payload_json, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id, user_id) DO UPDATE SET
        flow = excluded.flow,
        step = excluded.step,
        payload_json = excluded.payload_json,
        expires_at = excluded.expires_at
    `).run(
      session.chatId,
      session.userId,
      session.flow,
      session.step,
      JSON.stringify(session.payload),
      session.expiresAt,
    );
  }

  getWizardSession(chatId: number, userId: number): WizardSession | undefined {
    const row = this.db.query<WizardSessionRow, [number, number]>(
      "SELECT * FROM wizard_sessions WHERE chat_id = ? AND user_id = ?",
    ).get(chatId, userId);
    if (!row) {
      return undefined;
    }
    if (Date.parse(row.expires_at) <= Date.now()) {
      this.deleteWizardSession(chatId, userId);
      return undefined;
    }
    return wizardSessionFromRow(row);
  }

  deleteWizardSession(chatId: number, userId: number): void {
    this.db.query("DELETE FROM wizard_sessions WHERE chat_id = ? AND user_id = ?").run(chatId, userId);
  }

  audit(
    actorId: number,
    action: string,
    exitSlug: string | null,
    success: boolean,
    details: string,
  ): void {
    this.db.query(`
      INSERT INTO audit_events
        (actor_id, action, country_slug, success, details, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      actorId,
      action,
      exitSlug,
      success ? 1 : 0,
      details,
      new Date().toISOString(),
    );
  }

  // Compatibility aliases for existing callers and migrations.
  getCountry(slug: string): VpnExit | undefined {
    return this.getExit(slug);
  }

  listCountries(): VpnExit[] {
    return this.listExits();
  }

  upsertCountry(slug: string, uri: string, outbound: XrayOutbound): void {
    this.upsertManualExit(slug, uri, outbound);
  }

  deleteCountry(slug: string): void {
    this.deleteExit(slug);
  }
}

export function redactTemplate(template: XrayTemplate, nordVpnPrivateKey?: string): XrayTemplate {
  const next = structuredClone(template);
  for (const outbound of next.outbounds) {
    if (outbound.protocol !== "wireguard") {
      continue;
    }
    const settings = asObject(outbound.settings);
    if (!settings || typeof settings.secretKey !== "string") {
      continue;
    }
    if (outbound.tag.startsWith("countries-nord-exit-") || settings.secretKey === nordVpnPrivateKey) {
      settings.secretKey = "<redacted>";
    }
  }
  return next;
}

function redactOutbound(outbound: XrayOutbound): XrayOutbound {
  const next = structuredClone(outbound);
  const settings = asObject(next.settings);
  if (settings && typeof settings.secretKey === "string") {
    settings.secretKey = "<redacted>";
  }
  return next;
}

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function exitFromRow(row: ExitRow): VpnExit {
  return {
    id: row.id,
    slug: row.slug,
    provider: row.provider,
    source: JSON.parse(row.source_json) as ManualVlessSource | NordVpnSource,
    outbound: JSON.parse(row.outbound_json) as XrayOutbound,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function managedClientFromRow(row: ManagedClientRow): ManagedClient {
  return {
    exitSlug: row.exit_slug,
    email: row.email,
    subId: row.sub_id,
    uuid: row.uuid,
  };
}

function proxyFromRow(row: ProxyRow): ProxyRecord {
  return {
    id: row.id,
    subId: row.sub_id,
    name: row.name,
    provider: row.provider,
    source: JSON.parse(row.source_json) as ProxyRecord["source"],
    ...(row.upstream_json ? { upstream: JSON.parse(row.upstream_json) as ProxyRecord["upstream"] } : {}),
    outbound: JSON.parse(row.outbound_json) as XrayOutbound,
    email: row.email,
    uuid: row.uuid,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function telegramUserFromRow(row: TelegramUserRow): TelegramUserInfo {
  return {
    telegramId: row.telegram_id,
    ...(row.first_name ? { firstName: row.first_name } : {}),
    ...(row.last_name ? { lastName: row.last_name } : {}),
    ...(row.username ? { username: row.username } : {}),
    ...(row.profile_sub_id ? { profileSubId: row.profile_sub_id } : {}),
  };
}

function wizardSessionFromRow(row: WizardSessionRow): WizardSession {
  return {
    chatId: row.chat_id,
    userId: row.user_id,
    flow: row.flow,
    step: row.step,
    payload: JSON.parse(row.payload_json) as JsonObject,
    expiresAt: row.expires_at,
  };
}
