// API 兼容层单测：全部注入对象，不碰真 VPN、不开隧道。
//
// 重点不是"能跑"，而是三条：
//   1. 商店版（整个 VPN 全局缺失）走的是 unsupported，不是 ReferenceError。
//   2. 缺口清单精确到成员，UI 和服务命令共用同一份。
//   3. 服务契约里该拦的命令被拦、不该拦的镜像下载照旧。

import { Script } from "scripting";
import {
  VpnUnsupportedError,
  assertSupported,
  connectionSupport,
  missingMembers,
  requireConnection,
  requireTunnel,
  requireVpnSupport,
  tunnelSupport,
  unsupportedMessage,
  vpnSupportOf,
} from "../kit/apiSupport";
import { needsVpn, unsupportedReply } from "../kit/serviceResult";
import { VPNPreparationError, prepareVPN } from "../kit/vpn";

function noop() {}

function fullLocalDev() {
  return {
    async getState() { return {}; },
    async setEnabled() { return {}; },
    async openRSDTunnel() { return {}; },
    async attachRSDTunnel() { return null; },
    async cancelRSDTunnelOpening() {},
  };
}

function fullApi() {
  return {
    async getState() { return {}; },
    async start() { return {}; },
    localDevVPN: fullLocalDev(),
  };
}

async function main() {
  let passed = 0;
  function check(name: string, ok: boolean, detail = "") {
    if (!ok) throw new Error(`${name}${detail ? `: ${detail}` : ""}`);
    console.log(`PASS ${name}`);
    passed++;
  }

  // ── 能力探测 ──────────────────────────────────────────────────────────
  const absent = vpnSupportOf(undefined);
  check("missing VPN global", !absent.supported && absent.missing.join() === "VPN" && absent.api === undefined);

  const noLocal = vpnSupportOf({ async getState() { return {}; } });
  check("VPN without localDevVPN", !noLocal.supported && noLocal.missing.join() === "VPN.localDevVPN");

  const emptyLocal = vpnSupportOf({ localDevVPN: {} });
  check(
    "empty localDevVPN lists every member",
    !emptyLocal.supported && emptyLocal.missing.length === 4 && emptyLocal.missing.every((item) => item.startsWith("VPN.localDevVPN.")),
    JSON.stringify(emptyLocal.missing),
  );

  const partial = fullApi();
  delete (partial.localDevVPN as Record<string, unknown>).openRSDTunnel;
  const partialSupport = vpnSupportOf(partial);
  check(
    "single missing member is named",
    !partialSupport.supported && partialSupport.missing.join() === "VPN.localDevVPN.openRSDTunnel",
    JSON.stringify(partialSupport.missing),
  );

  const full = fullApi();
  const fullSupport = vpnSupportOf(full);
  check("complete api is supported", fullSupport.supported && fullSupport.missing.length === 0 && fullSupport.api !== undefined);

  const noCancel = fullApi();
  delete (noCancel.localDevVPN as Record<string, unknown>).cancelRSDTunnelOpening;
  const noCancelSupport = vpnSupportOf(noCancel);
  check(
    "cancelRSDTunnelOpening is optional only",
    noCancelSupport.supported && noCancelSupport.optional.join() === "VPN.localDevVPN.cancelRSDTunnelOpening",
    JSON.stringify(noCancelSupport),
  );

  check("requireVpnSupport returns the api", requireVpnSupport(full).api !== undefined);

  // 商店版模拟：注入一份“什么也没有”的能力表，走的就是真机上的同一条分支。
  // （离线运行时会把 VPN 垫成万用桓，所以不能靠无参探测来模拟缺失。）
  let absentError: unknown;
  try {
    assertSupported(vpnSupportOf(undefined));
  } catch (error) {
    absentError = error;
  }
  check(
    "absent api throws VpnUnsupportedError, not ReferenceError",
    absentError instanceof VpnUnsupportedError && absentError.code === "unsupported" && absentError.missing.join() === "VPN",
    String(absentError),
  );

  check("unsupported message names the gap", unsupportedMessage(["VPN.localDevVPN"]).includes("VPN.localDevVPN"));

  // ── 句柄级探测 ────────────────────────────────────────────────────────
  const tunnel = {
    async getState() { return {}; },
    async connect() { return {}; },
    async listServices() { return []; },
    async close() {},
  };
  check("tunnel probe is all true", Object.values(tunnelSupport(tunnel)).every(Boolean) && (requireTunnel(tunnel), true));

  let tunnelError: unknown;
  try {
    requireTunnel({ async getState() { return {}; } });
  } catch (error) {
    tunnelError = error;
  }
  check(
    "old tunnel handle reports missing members",
    tunnelError instanceof VpnUnsupportedError && tunnelError.missing.length === 3,
    String(tunnelError),
  );

  const connection = { async read() { return null; }, async write() {}, async close() {} };
  check("connection probe is all true", Object.values(connectionSupport(connection)).every(Boolean) && (requireConnection(connection), true));
  check("missingMembers prefixes names", missingMembers("X", {}, ["a"]).join() === "X.a");

  let connectionError: unknown;
  try {
    requireConnection({ async read() { return null; } });
  } catch (error) {
    connectionError = error;
  }
  check("connection without write/close throws", connectionError instanceof VpnUnsupportedError);

  // ── 服务契约 ──────────────────────────────────────────────────────────
  check(
    "vpn commands are a whitelist",
    ["status", "ensureTunnel", "releaseTunnel", "ensureDeveloperImage"].every((command) => needsVpn(command)) &&
      !needsVpn("developerImageStatus") &&
      !needsVpn("downloadDeveloperImage"),
  );

  const missing = ["VPN"];
  const tunnelReply = unsupportedReply("ensureTunnel", missing);
  check(
    "ensureTunnel reply is unsupported",
    tunnelReply.status === "unsupported" && tunnelReply.supported === false && tunnelReply.ready === false && tunnelReply.missing.join() === "VPN" && tunnelReply.message.length > 0,
  );
  check("releaseTunnel reply is not released", unsupportedReply("releaseTunnel", missing).released === false);
  check("ensureDeveloperImage reply marks the api stage", unsupportedReply("ensureDeveloperImage", missing).stage === "api");

  // ── 准备阶段不把版本问题说成网络问题 ──────────────────────────────────
  let prepareError: unknown;
  try {
    await prepareVPN({ source: "builtIn", host: "10.7.0.1" }, noop, {} as never, 20);
  } catch (error) {
    prepareError = error;
  }
  check(
    "prepareVPN rethrows unsupported untouched",
    prepareError instanceof VpnUnsupportedError && !(prepareError instanceof VPNPreparationError),
    String(prepareError),
  );

  let externalFailed = false;
  try {
    await prepareVPN({ source: "proxyApp", host: "10.7.0.1" }, noop, {} as never, 20);
  } catch {
    externalFailed = true;
  }
  check("proxyApp does not touch the API", !externalFailed);

  Script.exit({ passed });
}

void main().catch((error) => {
  console.error(String(error));
  Script.exit({ error: String(error) });
});
