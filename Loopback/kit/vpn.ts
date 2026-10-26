import { tx } from "../core/i18n";
import { withTimeout } from "../core/stream";
import type { ConnectionSettings } from "./settings";

type VPNControl = Pick<VPNAPI, "getState" | "start"> & {
  localDevVPN: Pick<VPNLocalDevAPI, "getState" | "setEnabled">;
};

export class VPNPreparationError extends Error {}

/** Prepare Scripting's VPN in builtIn mode; proxyApp never changes VPN state.
 * The optional control is a test seam; callers normally use the native global API.
 */
export async function prepareVPN(
  settings: ConnectionSettings,
  log: (message: string) => void = () => {},
  control: VPNControl = VPN,
  timeoutMs = 30_000,
): Promise<void> {
  if (settings.source === "proxyApp") {
    log(tx("使用外部 VPN，请确保已开启本机反射。", "Using an external VPN; ensure local reflection is enabled."));
    return;
  }

  const deadline = Date.now() + timeoutMs;
  const timeoutMessage = tx("准备 Scripting VPN 超时，请检查 VPN 权限和本机开发 VPN 状态。", "Scripting VPN preparation timed out. Check VPN permission and LocalDevVPN status.");
  function bounded<T>(operation: Promise<T>): Promise<T> {
    return withTimeout(operation, Math.max(1, deadline - Date.now()), timeoutMessage);
  }

  try {
    log(tx("检查本机开发 VPN…", "Checking LocalDevVPN…"));
    let local = await bounded(control.localDevVPN.getState());
    if (!local.enabled) {
      log(tx("启用本机开发 VPN…", "Enabling LocalDevVPN…"));
      local = await bounded(control.localDevVPN.setEnabled(true, { expectedState: local.expectedState }));
      if (!local.enabled) throw new Error(local.problem || tx("本机开发 VPN 未能启用。", "LocalDevVPN could not be enabled."));
    }

    const vpn = await bounded(control.getState());
    if (vpn.operation === "stopping" || vpn.status === "disconnecting") {
      throw new Error(tx("VPN 正在停止，请稍后重试。", "VPN is stopping; retry shortly."));
    }
    if (vpn.status !== "connected" && vpn.status !== "connecting" && vpn.status !== "reasserting" && vpn.operation !== "starting") {
      log(tx("启动 Scripting VPN…", "Starting Scripting VPN…"));
      await bounded(control.start());
    }

    log(tx("等待本机开发 VPN 就绪…", "Waiting for LocalDevVPN to become ready…"));
    while (Date.now() < deadline) {
      local = await bounded(control.localDevVPN.getState());
      if (local.enabled && local.active && local.effectiveStatus === "active") return;
      if (!local.enabled || local.effectiveStatus === "error" || local.problem) {
        throw new Error(local.problem || tx("本机开发 VPN 未就绪，设置可能已被更改。", "LocalDevVPN is not ready; its settings may have changed."));
      }
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))));
    }
    throw new Error(timeoutMessage);
  } catch (error) {
    // Do not roll back shared VPN intent or stop a VPN that other scripts may use.
    throw new VPNPreparationError(tx("准备 Scripting VPN 失败：", "Failed to prepare Scripting VPN: ") + (error instanceof Error ? error.message : String(error)));
  }
}
