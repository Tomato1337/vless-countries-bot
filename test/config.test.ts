import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";

const env = {
  TELEGRAM_BOT_TOKEN: "token",
  TELEGRAM_OWNER_ID: "123",
  XUI_BASE_URL: "http://127.0.0.1:2053",
  XUI_USERNAME: "admin",
  XUI_PASSWORD: "secret",
  XUI_INBOUND_ID: "1",
  GE_OUTBOUND_TAG: "germany",
  DATABASE_PATH: ":memory:",
};

describe("loadConfig", () => {
  test("accepts an existing GE outbound tag", () => {
    expect(loadConfig(env).geOutboundTag).toBe("germany");
  });

  test("rejects a VLESS link in GE_OUTBOUND_TAG", () => {
    expect(() => loadConfig({
      ...env,
      GE_OUTBOUND_TAG: "vless://uuid@example.com:443",
    })).toThrow("must be an existing Xray outbound tag");
  });
});

