import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import { redactTemplate } from "../src/store.ts";
import { baseTemplate } from "./helpers.ts";
import { NORD_PRIVATE_KEY } from "./helpers.ts";

describe("Store", () => {
  test("persists the trusted user allowlist and protects the SQLite file", () => {
    const dir = mkdtempSync(join(tmpdir(), "vless-countries-bot-"));
    const path = join(dir, "bot.sqlite");
    const store = new Store(path);
    try {
      store.addTrustedUser(123);
      store.addTrustedUser(456);
      store.deleteTrustedUser(123);

      expect(store.isTrustedUser(123)).toBeFalse();
      expect(store.isTrustedUser(456)).toBeTrue();
      expect(store.listTrustedUsers()).toEqual([456]);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("copies legacy countries once without resurrecting deleted exits", () => {
    const dir = mkdtempSync(join(tmpdir(), "vless-countries-bot-legacy-"));
    const path = join(dir, "bot.sqlite");
    const legacy = new Database(path, { create: true });
    legacy.exec(`
      CREATE TABLE countries (
        slug TEXT PRIMARY KEY,
        uri TEXT NOT NULL,
        outbound_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE managed_clients (
        email TEXT PRIMARY KEY,
        country_slug TEXT NOT NULL,
        sub_id TEXT NOT NULL,
        uuid TEXT NOT NULL
      );
    `);
    legacy.query("INSERT INTO countries VALUES (?, ?, ?, ?, ?)").run(
      "usa",
      "vless://secret",
      JSON.stringify({ tag: "countries-exit-usa", protocol: "vless" }),
      "created",
      "updated",
    );
    legacy.query("INSERT INTO managed_clients VALUES (?, ?, ?, ?)").run(
      "ilya-usa",
      "usa",
      "Ilya",
      "uuid",
    );
    legacy.close();

    const migrated = new Store(path);
    expect(migrated.getExit("usa")?.provider).toBe("manual-vless");
    expect(migrated.listManagedClients("usa")).toEqual([
      { exitSlug: "usa", email: "ilya-usa", subId: "Ilya", uuid: "uuid" },
    ]);
    migrated.deleteExit("usa");
    migrated.close();

    const reopened = new Store(path);
    expect(reopened.getExit("usa")).toBeUndefined();
    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("redacts managed NordVPN keys in persisted templates", () => {
    const template = baseTemplate();
    template.outbounds.push({
      tag: "countries-nord-exit-us-chicago",
      protocol: "wireguard",
      settings: { secretKey: NORD_PRIVATE_KEY },
    });

    expect((redactTemplate(template, NORD_PRIVATE_KEY).outbounds[2]?.settings as { secretKey: string }).secretKey)
      .toBe("<redacted>");
  });

  test("expires wizard sessions", () => {
    const store = new Store();
    store.upsertWizardSession({
      chatId: 1,
      userId: 2,
      flow: "search",
      step: "cities",
      payload: { countryId: 3 },
      expiresAt: new Date(Date.now() - 1).toISOString(),
    });
    expect(store.getWizardSession(1, 2)).toBeUndefined();
    store.close();
  });
});
