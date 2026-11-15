import { describe, expect, test } from "bun:test";
import { buildCountryOutbound, parseVlessRealityTcp, parseVlessUri } from "../src/vless.ts";
import { REALITY_URI } from "./helpers.ts";

const WS_URI =
  "vless://00000000-0000-4000-8000-000000000002@ws.vless.example.com:10002?encryption=none&security=tls&type=ws&path=%2fws#ws-example";
const XHTTP_URI =
  "vless://00000000-0000-4000-8000-000000000002@example.com:443?encryption=none&security=tls&type=xhttp&host=cdn.example.com&path=%2Fapi&mode=stream-one&sni=origin.example.com&fp=chrome&alpn=h2%2Chttp%2F1.1&allowInsecure=0";
const GRPC_URI =
  "vless://00000000-0000-4000-8000-000000000002@grpc.example.com:443?encryption=none&security=tls&type=grpc&serviceName=my-service&authority=cdn.example.com&mode=multi";

describe("VLESS Reality TCP parser", () => {
  test("parses the supported share URI", () => {
    expect(parseVlessRealityTcp(REALITY_URI)).toMatchObject({
      address: "usa.vless.example.com",
      port: 443,
      uuid: "00000000-0000-4000-8000-000000000001",
      encryption: "none",
      flow: "xtls-rprx-vision",
      transport: "tcp",
      security: "reality",
      serverName: "www.example.com",
      fingerprint: "chrome",
      publicKey: "ExampleRealityPublicKeyForUnitTests00000000",
      shortId: "0123456789abcdef",
    });
  });

  test("builds a GE-chained outbound", () => {
    const outbound = buildCountryOutbound("usa", REALITY_URI, "germany");
    expect(outbound.tag).toBe("countries-exit-usa");
    expect(outbound.settings).toEqual({
      address: "usa.vless.example.com",
      port: 443,
      id: "00000000-0000-4000-8000-000000000001",
      encryption: "none",
      flow: "xtls-rprx-vision",
    });
    expect(outbound.proxySettings).toBeUndefined();
    expect(outbound).toMatchObject({ streamSettings: { sockopt: { dialerProxy: "germany" } } });
  });

  test("keeps the compatibility parser limited to Reality TCP", () => {
    expect(() => parseVlessRealityTcp(WS_URI)).toThrow("Only VLESS Reality TCP");
  });
});

describe("VLESS share URI transports", () => {
  test("builds the provided TLS WebSocket outbound", () => {
    const outbound = buildCountryOutbound("usa", WS_URI, "germany");
    expect(outbound.streamSettings).toEqual({
      network: "ws",
      security: "tls",
      wsSettings: { path: "/ws" },
      tlsSettings: { serverName: "ws.vless.example.com" },
      sockopt: { dialerProxy: "germany" },
    });
  });

  test("builds XHTTP settings and common TLS options", () => {
    const outbound = buildCountryOutbound("usa", XHTTP_URI, "germany");
    expect(outbound.streamSettings).toEqual({
      network: "xhttp",
      security: "tls",
      xhttpSettings: {
        path: "/api",
        host: "cdn.example.com",
        mode: "stream-one",
      },
      tlsSettings: {
        serverName: "origin.example.com",
        fingerprint: "chrome",
        alpn: ["h2", "http/1.1"],
        allowInsecure: false,
      },
      sockopt: { dialerProxy: "germany" },
    });
  });

  test("builds gRPC settings with path fallback and multi mode", () => {
    const outbound = buildCountryOutbound("usa", GRPC_URI, "germany");
    expect(outbound.streamSettings).toEqual({
      network: "grpc",
      security: "tls",
      grpcSettings: {
        serviceName: "my-service",
        authority: "cdn.example.com",
        multiMode: true,
      },
      tlsSettings: { serverName: "grpc.example.com" },
      sockopt: { dialerProxy: "germany" },
    });
    expect(parseVlessUri(GRPC_URI.replace("serviceName=my-service", "path=%2Fmy-service")))
      .toMatchObject({ serviceName: "/my-service" });
  });

  test("ignores unknown query parameters but rejects unsupported transports", () => {
    expect(parseVlessUri(`${WS_URI}&client-extension=value`)).toMatchObject({ transport: "ws" });
    expect(() => parseVlessUri(WS_URI.replace("type=ws", "type=kcp")))
      .toThrow("Unsupported VLESS transport");
  });
});
