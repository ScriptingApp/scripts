// 兼容性自检：这台设备、这个版本的 Scripting，到底能不能走开发者通道。
//
// 为什么要有这一页：整条链路很长（权限 → 回环 → 配对 → 隧道 → RSD），
// 缺哪一环都只会在最后报一句「连不上」。先把能当场查的都查了，剩下的才值得去试。
//
// **判断一律用「能力探测」，不是比版本号。** 版本号对不上不一定不能用，对得上
// 也不一定能用；而 `typeof VPN.localDevVPN.openRSDTunnel === "function"` 这种问法
// 问的就是眼下这个运行时到底有没有这个东西。版本号只作为「报给用户看」的信息。
//
// 自检本身**不连设备、不开隧道**：全是本地能问出来的。要真连一次，那是「验证配对记录」。

import { SHARED_KEYS, readShared, writeShared, removeShared } from "../core/shared";
import { tx } from "../core/i18n";
import { vpnSupportOf } from "./apiSupport";

export type CheckState = "ok" | "warn" | "fail" | "unknown";

export interface Check {
  /** 这一条查的是什么。 */
  label: string;
  state: CheckState;
  /** 查出来是什么，以及不行的话该怎么办。 */
  detail: string;
}

/** 最终结论：有 fail 就是不能用，只有 warn 是能用但得先弄点什么。 */
export function verdict(checks: Check[]): CheckState {
  if (checks.some((check) => check.state === "fail")) return "fail";
  if (checks.some((check) => check.state === "warn")) return "warn";
  if (checks.some((check) => check.state === "unknown")) return "unknown";
  return "ok";
}

export const VERDICT_TEXT: Record<CheckState, string> = {
  ok: tx("都齐了，可以配对", "Everything is ready for pairing"),
  warn: tx("能用，但有一两处要先弄一下", "Usable, but one or two things need attention"),
  fail: tx("这台设备 / 这个版本用不了", "This device or version is not supported"),
  unknown: tx("有查不出来的，先试试配对", "Some checks are inconclusive; try pairing"),
};

// ── 一条一条查 ────────────────────────────────────────────────────────────

/**
 * iOS 主版本号。取不到返回 0。
 *
 * `systemVersion` 形如 "26.1"、"18.0.1"，取第一段。
 */
export function majorVersion(text: string): number {
  const first = /^(\d+)/.exec(text.trim());
  return first ? Number(first[1]) : 0;
}

/** 走 RemotePairing / RSD 这条路最低要 iOS 17。再早的系统是另一套协议，本脚本不支持。 */
export const MIN_IOS_MAJOR = 17;

export function checkSystem(systemVersion: string, systemName = "iOS"): Check {
  const major = majorVersion(systemVersion);
  if (major === 0) {
    return { label: "系统版本", state: "unknown", detail: `读不出版本号（${systemVersion || "空"}）` };
  }
  if (major < MIN_IOS_MAJOR) {
    return {
      label: "系统版本",
      state: "fail",
      detail: `${systemName} ${systemVersion}。开发者通道（RemotePairing / RSD）要 ${systemName} ${MIN_IOS_MAJOR} 以上，再早的系统是另一套协议，本脚本不支持。`,
    };
  }
  return { label: "系统版本", state: "ok", detail: `${systemName} ${systemVersion}` };
}

/**
 * 这个版本的 Scripting 有没有开隧道的那套接口。
 *
 * 探测而不是比版本：`openRSDTunnel`、`attachRSDTunnel`、`listServices` 都是后加的，
 * 旧版本/商店版缺的就只是其中几个。逐个报出来，用户才知道差在哪里。
 */
export function checkTunnelApi(api: unknown, appVersion: string): Check {
  const support = vpnSupportOf(api);
  const version = appVersion ? `Scripting ${appVersion}` : "Scripting";
  if (!support.supported) {
    return {
      label: "隧道接口",
      state: "fail",
      detail: `${version} 不支持开发者通道：缺 ${support.missing.join("、")}。商店版没有这套 VPN / RSD 接口，需要带该接口的版本。`,
    };
  }
  if (support.optional.length > 0) {
    return {
      label: "隧道接口",
      state: "warn",
      detail: `${version} 可用，但缺 ${support.optional.join("、")}；取消打开会被跳过。`,
    };
  }
  return { label: "隧道接口", state: "ok", detail: `${version}，localDevVPN 齐全` };
}

/** 没有 Bonjour 就只能退回端口扫描，慢而且蜂窝下基本找不到——能用，但该说一声。 */
export function checkBonjour(present: boolean): Check {
  return present
    ? { label: "Bonjour 发现", state: "ok", detail: "能按公告找到配对服务" }
    : {
        label: "Bonjour 发现",
        state: "warn",
        detail: "这个版本没有 Bonjour，只能挨个端口试，慢；蜂窝下基本找不到。更新 Scripting 会好很多。",
      };
}

/**
 * 共享域能不能用。**真写一笔再读回来**，不是看 API 在不在：
 * 接口在而写不进（存储满了、被限制）的话，配对记录就传不给别的脚本，
 * 那正是这个脚本存在的意义。
 */
export function checkSharedDomain(): Check {
  if (typeof Storage === "undefined") {
    return { label: "共享域", state: "fail", detail: "这个运行时没有 Storage，配置没法传给别的脚本。" };
  }
  const probe = `${SHARED_KEYS.connection}.probe`;
  const token = `probe-${Date.now()}`;
  try {
    writeShared(probe, token);
    const back = readShared<string>(probe);
    removeShared(probe);
    return back === token
      ? { label: "共享域", state: "ok", detail: "写得进也读得出，其他脚本能读到这里的配置" }
      : { label: "共享域", state: "fail", detail: "写进去读不回来，配置没法传给别的脚本。" };
  } catch {
    removeShared(probe);
    return { label: "共享域", state: "fail", detail: "共享域读写报错，配置没法传给别的脚本。" };
  }
}

/**
 * 权限。
 *
 * 「按脚本授权」没开的时候，`requestAccess` 会把要的都给回来；开了的话会弹窗问用户。
 * 两种情况都当成「给了就行」。
 */
export function checkAccess(granted: string[], supported = true): Check {
  const need = ["localDevVPN", "vpn", "fileSystem"];
  const missing = need.filter((api) => !granted.includes(api));
  if (missing.length === 0) return { label: "权限", state: "ok", detail: "localDevVPN、vpn、fileSystem 都已授权" };
  // 版本本身就没有这些权限项时，别催用户去授权一个不存在的东西。
  if (!supported && missing.every((api) => api !== "fileSystem")) {
    return {
      label: "权限",
      state: "warn",
      detail: `${missing.join("、")} 在本版本不存在，不需要也无法授权。`,
    };
  }
  return {
    label: "权限",
    state: "fail",
    detail: `还缺 ${missing.join("、")}。在 Scripting 的脚本设置里允许，或者重新点一次自检。`,
  };
}

/** 开发者模式没开的话配对那一步会直接失败，但本地问不出来，只能提醒。 */
export function checkDeveloperMode(): Check {
  return {
    label: "开发者模式",
    state: "unknown",
    detail: "本地查不到，要连上设备才知道。配对前先确认「设置 → 隐私与安全性 → 开发者模式」是开着的。",
  };
}
