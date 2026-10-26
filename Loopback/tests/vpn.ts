import { Script } from "scripting";
import { prepareVPN } from "../kit/vpn";

async function main() {
  let passed = 0;
  async function check(name: string, enabled: boolean, status: VPNState["status"], mode: string, expected: string, external = false) {
    const calls: string[] = [];
    let reads = 0;
    const local = (): VPNLocalDevState => ({ enabled, active: mode === "ready", effectiveStatus: mode === "ready" ? "active" : mode === "error" ? "error" : "pending", vpnStatus: status, addresses: [], resolvedAddresses: [], effectiveAddresses: [], expectedState: "test-token", profileId: null, problem: mode === "error" ? "mock failure" : null });
    const control = {
      async getState(): Promise<VPNState> { calls.push("vpn"); return { status, active: status === "connected", selectedConfigurationId: null, selectedConfigurationName: null, providerBundleId: null, effectiveConfigurationId: null, operation: null, problem: null }; },
      async start(): Promise<VPNState> { calls.push("start"); status = "connected"; return this.getState(); },
      localDevVPN: {
        async getState() { calls.push("local"); reads++; return local(); },
        async setEnabled(value: boolean, options?: {expectedState?: string}) { if (options?.expectedState !== "test-token") throw new Error("Missing expectedState"); calls.push("enable"); enabled = value; return local(); },
      },
    };
    let failed = false;
    try { await prepareVPN({ source: external ? "proxyApp" : "builtIn", host: "10.7.0.1" }, () => {}, control, 20); } catch { failed = true; }
    const ok = expected === "external" ? calls.length === 0 : expected === "start" ? !failed && calls.includes("enable") && calls.includes("start") : expected === "ready" ? !failed && !calls.includes("start") && !calls.includes("enable") : expected === "waiting" ? failed && !calls.includes("start") && reads > 1 : failed;
    if (!ok) throw new Error(`${name}: unexpected ${JSON.stringify(calls)}, failed=${failed}`);
    console.log(`PASS ${name}`); passed++;
  }
  await check("external never touches VPN", false, "disconnected", "pending", "external", true);
  await check("enable then start", false, "disconnected", "ready", "start");
  await check("ready is idempotent", true, "connected", "ready", "ready");
  await check("connecting waits without restarting", true, "connecting", "pending", "waiting");
  await check("local error is explicit", true, "connected", "error", "error");
  await check("stopping does not restart", true, "disconnecting", "pending", "error");
  Script.exit({ passed });
}
void main().catch(error => { console.error(String(error)); Script.exit({ error: String(error) }); });
