import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";

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
});

