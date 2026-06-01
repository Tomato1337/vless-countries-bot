import { describe, expect, test } from "bun:test";
import { HttpXuiClient } from "../src/xui-client.ts";
import { buildCountryOutbound } from "../src/vless.ts";
import type { ManagedClient, XrayTemplate } from "../src/types.ts";
import { baseTemplate, REALITY_URI } from "./helpers.ts";

describe("HttpXuiClient", () => {
  test("uses the panel session, CSRF token and current 3x-ui routes", async () => {
    let template = baseTemplate();
    let testedOutbound = "";
    let clients = [{ id: "existing", email: "ilya-phone", subId: "Ilya", enable: true }];
    const clientSnapshots: typeof clients[] = [];
    let restartCalls = 0;
    let outboundTestResult: unknown = { success: true, delay: 42, mode: "http" };
    const mockFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.pathname === "/csrf-token") {
          return json({ success: true, obj: "csrf" }, { "Set-Cookie": "session=mock==; Path=/" });
        }
        if (url.pathname === "/login") {
          expect(request.headers.get("x-csrf-token")).toBe("csrf");
          return json({ success: true });
        }
        expect(request.headers.get("cookie")).toContain("session=mock==");
        if (request.method === "POST") {
          expect(request.headers.get("x-csrf-token")).toBe("csrf");
        }
        if (url.pathname === "/panel/xray/" && request.method === "POST") {
          return json({
            success: true,
            obj: JSON.stringify({ xraySetting: template, inboundTags: [], outboundTestUrl: "" }),
          });
        }
        if (url.pathname === "/panel/xray/update") {
          const form = await request.formData();
          template = JSON.parse(String(form.get("xraySetting"))) as XrayTemplate;
          return json({ success: true });
        }
        if (url.pathname === "/panel/api/server/restartXrayService") {
          restartCalls += 1;
          return json({ success: true });
        }
        if (url.pathname === "/panel/xray/testOutbound") {
          const form = await request.formData();
          testedOutbound = String(form.get("outbound"));
          expect(String(form.get("allOutbounds"))).toContain("germany");
          return json({ success: true, obj: outboundTestResult });
        }
        if (url.pathname === "/panel/api/inbounds/get/1") {
          return json({
            success: true,
            obj: { id: 1, protocol: "vless", settings: JSON.stringify({ clients }) },
          });
        }
        if (url.pathname === "/panel/api/clients/list") {
          return json({ success: true, obj: [{ email: "ilya-phone", subId: "Ilya", inboundIds: [1] }] });
        }
        if (url.pathname === "/panel/api/inbounds/update/1") {
          const body = await request.json() as { settings: string };
          clients = JSON.parse(body.settings).clients;
          clientSnapshots.push(structuredClone(clients));
          return json({ success: true });
        }
        return new Response("not found", { status: 404 });
      };

    const client = new HttpXuiClient({
      baseUrl: "http://xui.test",
      username: "admin",
      password: "secret",
    }, mockFetch as typeof fetch);
    await client.checkCompatibility("germany", 1);
    const outbound = buildCountryOutbound("usa", REALITY_URI, "germany");
    expect(await client.testOutbound(outbound, [...template.outbounds, outbound])).toEqual({
      success: true,
      delay: 42,
      mode: "http",
    });
    outboundTestResult = { success: false, error: "probe failed", mode: "http" };
    await expect(client.testOutbound(outbound, [...template.outbounds, outbound])).rejects.toThrow("probe failed");
    outboundTestResult = "42ms";
    expect(await client.testOutbound(outbound, [...template.outbounds, outbound])).toEqual({ success: true });
    await client.updateTemplate({ ...template, outbounds: [...template.outbounds, outbound] });
    expect(restartCalls).toBe(1);
    expect((await client.getTemplate()).outbounds.at(-1)?.tag).toBe("countries-exit-usa");
    expect(JSON.parse(testedOutbound).tag).toBe("countries-exit-usa");
    expect(await client.listClients()).toEqual([{ email: "ilya-phone", subId: "Ilya", inboundIds: [1] }]);

    const managed: ManagedClient = {
      exitSlug: "usa",
      email: "ilya-usa",
      subId: "Ilya",
      uuid: "74b0b096-5d02-11f1-a319-52cf4084cd34",
    };
    await client.createClient(managed, 1);
    await client.renameClient(managed, "🇺🇸-ilya-usa", 1);
    await client.deleteClient(managed);
    expect(clientSnapshots).toEqual([
      [
        { id: "existing", email: "ilya-phone", subId: "Ilya", enable: true },
        expect.objectContaining({ id: managed.uuid, email: "ilya-usa", subId: "Ilya" }),
      ],
      [
        { id: "existing", email: "ilya-phone", subId: "Ilya", enable: true },
        expect.objectContaining({ id: managed.uuid, email: "🇺🇸-ilya-usa", subId: "Ilya" }),
      ],
      [{ id: "existing", email: "ilya-phone", subId: "Ilya", enable: true }],
    ]);
    expect(clients).toEqual([{ id: "existing", email: "ilya-phone", subId: "Ilya", enable: true }]);
  });

  test("falls back to inbound client discovery when CSRF and /clients/list are absent", async () => {
    const template = baseTemplate();
    let clients = [
      { id: "existing", email: "ilya-phone", subId: "Ilya", enable: true },
    ];
    const clientSnapshots: typeof clients[] = [];
    const mockFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === "/csrf-token") {
        return json(null, {}, 404);
      }
      if (url.pathname === "/login") {
        expect(request.headers.get("x-csrf-token")).toBeNull();
        return json({ success: true, msg: "ok", obj: null }, { "Set-Cookie": "session=legacy; Path=/" });
      }
      expect(request.headers.get("cookie")).toContain("session=legacy");
      expect(request.headers.get("x-csrf-token")).toBeNull();
      if (url.pathname === "/panel/xray/") {
        return json({
          success: true,
          msg: "ok",
          obj: JSON.stringify({ xraySetting: template, inboundTags: [], outboundTestUrl: "" }),
        });
      }
      if (url.pathname === "/panel/api/inbounds/get/1") {
        return json({
          success: true,
          msg: "ok",
          obj: {
            id: 1,
            protocol: "vless",
            settings: JSON.stringify({ clients }),
          },
        });
      }
      if (url.pathname === "/panel/api/clients/list") {
        return json(null, {}, 404);
      }
      if (url.pathname === "/panel/api/inbounds/update/1") {
        const body = await request.json() as { settings: string };
        clients = JSON.parse(body.settings).clients;
        clientSnapshots.push(structuredClone(clients));
        return json({ success: true, msg: "ok", obj: null });
      }
      return json(null, {}, 404);
    };
    const client = new HttpXuiClient({
      baseUrl: "http://legacy-xui.test",
      username: "admin",
      password: "secret",
    }, mockFetch as typeof fetch);
    await client.checkCompatibility("germany", 1);
    expect(await client.listClients()).toEqual([
      { email: "ilya-phone", subId: "Ilya", inboundIds: [1] },
    ]);

    const managed: ManagedClient = {
      exitSlug: "usa",
      email: "ilya-usa",
      subId: "Ilya",
      uuid: "74b0b096-5d02-11f1-a319-52cf4084cd34",
    };
    await client.createClient(managed, 1);
    await client.renameClient(managed, "🇺🇸-ilya-usa", 1);
    await client.deleteClient(managed);

    expect(clientSnapshots).toEqual([
      [
        { id: "existing", email: "ilya-phone", subId: "Ilya", enable: true },
        expect.objectContaining({ id: managed.uuid, email: "ilya-usa", subId: "Ilya" }),
      ],
      [
        { id: "existing", email: "ilya-phone", subId: "Ilya", enable: true },
        expect.objectContaining({ id: managed.uuid, email: "🇺🇸-ilya-usa", subId: "Ilya" }),
      ],
      [{ id: "existing", email: "ilya-phone", subId: "Ilya", enable: true }],
    ]);
  });
});

function json(value: unknown, headers: HeadersInit = {}, status = 200): Response {
  return Response.json(value, { headers, status });
}
