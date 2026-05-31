import { describe, expect, test } from "bun:test";
import { buildCountryOutbound, parseVlessRealityTcp, parseVlessUri } from "../src/vless.ts";
import { REALITY_URI } from "./helpers.ts";

const WS_URI =
  "vless://a27f5e28-5d2f-11f1-ba20-52ac0074670e@premiusa3.vpnjantit.com:10002?encryption=none&security=tls&type=ws&path=%2fvpnjantit#fgdfgdf-vpnjantit.com";
const XHTTP_URI =
  "vless://a27f5e28-5d2f-11f1-ba20-52ac0074670e@example.com:443?encryption=none&security=tls&type=xhttp&host=cdn.example.com&path=%2Fapi&mode=stream-one&sni=origin.example.com&fp=chrome&alpn=h2%2Chttp%2F1.1&allowInsecure=0";
const GRPC_URI =
  "vless://a27f5e28-5d2f-11f1-ba20-52ac0074670e@grpc.example.com:443?encryption=none&security=tls&type=grpc&serviceName=my-service&authority=cdn.example.com&mode=multi";

describe("VLESS Reality TCP parser", () => {
  test("parses the supported share URI", () => {
    expect(parseVlessRealityTcp(REALITY_URI)).toMatchObject({
      address: "usa12.vpnjantit.com",
      port: 443,
      uuid: "74b0b096-5d02-11f1-a319-52cf4084cd34",
      encryption: "none",
      flow: "xtls-rprx-vision",
      transport: "tcp",
      security: "reality",
      serverName: "cloudflare.com",
      fingerprint: "chrome",
      publicKey: "g03nwLrMnwsZs7posvVRTelixQToNkNV2-QQCZa1Mjo",
      shortId: "ea81553e93920d38",
    });
  });

  test("builds a GE-chained outbound", () => {
    const outbound = buildCountryOutbound("usa", REALITY_URI, "germany");
    expect(outbound.tag).toBe("countries-exit-usa");
    expect(outbound.settings).toEqual({
      address: "usa12.vpnjantit.com",
      port: 443,
      id: "74b0b096-5d02-11f1-a319-52cf4084cd34",
      encryption: "none",
      flow: "xtls-rprx-vision",
    });
    expect(outbound.proxySettings).toEqual({ tag: "germany", transportLayer: true });
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
      wsSettings: { path: "/vpnjantit" },
      tlsSettings: { serverName: "premiusa3.vpnjantit.com" },
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
