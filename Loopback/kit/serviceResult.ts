// ScriptSession 服务命令的「不支持」应答。
//
// 单独抽一份，是为了能脱机断言契约：不必把 index.tsx 整个跑起来（它会注册服务、
// 可能弹页面），也能证明哪些命令该被拦、返回的字段长什么样。

import { unsupportedMessage } from "./apiSupport";

/**
 * 依赖 VPN / RSD 的命令。
 *
 * 镜像下载与缓存查询故意不在内：它们只走 HTTPS 和文件系统，商店版照样能用。
 */
const VPN_COMMANDS = ["status", "ensureTunnel", "releaseTunnel", "ensureDeveloperImage"] as const;

export type UnsupportedReply = {
  status: "unsupported";
  supported: false;
  ready: false;
  released?: false;
  stage?: "api";
  missing: string[];
  message: string;
};

/** 这条命令是否需要开发者通道。 */
export function needsVpn(command: string): boolean {
  return (VPN_COMMANDS as readonly string[]).includes(command);
}

/** 缺接口时统一返回的形状：明说版本不支持，并把缺口交出去。 */
export function unsupportedReply(command: string, missing: string[]): UnsupportedReply {
  const reply: UnsupportedReply = {
    status: "unsupported",
    supported: false,
    ready: false,
    missing,
    message: unsupportedMessage(missing),
  };
  if (command === "releaseTunnel") reply.released = false;
  if (command === "ensureDeveloperImage") reply.stage = "api";
  return reply;
}
