import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Country, ManagedClient, XrayOutbound, XrayTemplate } from "./types.ts";

interface CountryRow {
  slug: string;
  uri: string;
  outbound_json: string;
  created_at: string;
  updated_at: string;
}

interface ManagedClientRow {
  country_slug: string;
  email: string;
  sub_id: string;
  uuid: string;
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
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS countries (
        slug TEXT PRIMARY KEY,
        uri TEXT NOT NULL,
        outbound_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS managed_clients (
        email TEXT PRIMARY KEY,
        country_slug TEXT NOT NULL REFERENCES countries(slug) ON DELETE CASCADE,
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
    `);
  }

  getCountry(slug: string): Country | undefined {
    const row = this.db.query<CountryRow, [string]>(
      "SELECT * FROM countries WHERE slug = ?",
    ).get(slug);
    return row ? countryFromRow(row) : undefined;
  }

  listCountries(): Country[] {
    return this.db.query<CountryRow, []>(
      "SELECT * FROM countries ORDER BY slug",
    ).all().map(countryFromRow);
  }

  upsertCountry(slug: string, uri: string, outbound: XrayOutbound): void {
    const now = new Date().toISOString();
    this.db.query(`
      INSERT INTO countries (slug, uri, outbound_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(slug) DO UPDATE SET
        uri = excluded.uri,
        outbound_json = excluded.outbound_json,
        updated_at = excluded.updated_at
    `).run(slug, uri, JSON.stringify(outbound), now, now);
  }

  deleteCountry(slug: string): void {
    this.db.query("DELETE FROM countries WHERE slug = ?").run(slug);
  }

  addManagedClient(client: ManagedClient): void {
    this.db.query(`
      INSERT INTO managed_clients (country_slug, email, sub_id, uuid)
      VALUES (?, ?, ?, ?)
    `).run(client.countrySlug, client.email, client.subId, client.uuid);
  }

  deleteManagedClient(email: string): void {
    this.db.query("DELETE FROM managed_clients WHERE email = ?").run(email);
  }

  renameManagedClient(currentEmail: string, nextEmail: string): void {
    this.db.query("UPDATE managed_clients SET email = ? WHERE email = ?").run(nextEmail, currentEmail);
  }

  listManagedClients(countrySlug?: string): ManagedClient[] {
    const rows = countrySlug
      ? this.db.query<ManagedClientRow, [string]>(
          "SELECT * FROM managed_clients WHERE country_slug = ? ORDER BY email",
        ).all(countrySlug)
      : this.db.query<ManagedClientRow, []>(
          "SELECT * FROM managed_clients ORDER BY email",
        ).all();
    return rows.map(managedClientFromRow);
  }

  isManagedEmail(email: string): boolean {
    return Boolean(this.db.query<{ count: number }, [string]>(
      "SELECT count(*) AS count FROM managed_clients WHERE email = ?",
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
    this.db.query("DELETE FROM trusted_users WHERE telegram_id = ?").run(telegramId);
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

  backupTemplate(reason: string, template: XrayTemplate): void {
    this.db.query(`
      INSERT INTO template_backups (reason, template_json, created_at)
      VALUES (?, ?, ?)
    `).run(reason, JSON.stringify(template), new Date().toISOString());
  }

  audit(
    actorId: number,
    action: string,
    countrySlug: string | null,
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
      countrySlug,
      success ? 1 : 0,
      details,
      new Date().toISOString(),
    );
  }
}

function countryFromRow(row: CountryRow): Country {
  return {
    slug: row.slug,
    uri: row.uri,
    outbound: JSON.parse(row.outbound_json) as XrayOutbound,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function managedClientFromRow(row: ManagedClientRow): ManagedClient {
  return {
    countrySlug: row.country_slug,
    email: row.email,
    subId: row.sub_id,
    uuid: row.uuid,
  };
}
