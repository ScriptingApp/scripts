// cryptexd：iOS 26.4+ 安装开发者镜像的 daemon。
//
// 每次调用一条自己的连接；install 会把五个 payload 作为独立的 XPC file transfer 流发出去。
// 协议来自 SideInstaller 的 lib/ddi/cryptexd.ts。

import { XpcFileTransfer, XpcUInt64, type XpcValue } from "../../core/xpc";
import { RemoteXpcSession } from "../remoteXpc";
import type { PlistDict } from "../plist";
import type { DdiLink } from "./link";
import { unwrapNonce, type CryptexProperties } from "./manifest";

/** daemon 在 RSD 服务表里的名字。 */
export const CRYPTEXD_SERVICE = "com.apple.security.cryptexd.remote";

/** 开发者镜像安装使用的 cryptex identifier。 */
export const DDI_CRYPTEX_IDENTIFIER = "com.apple.MobileAsset.DDI";

const CLIENT_VERSION = 3;
const DDI_IMAGE_TYPE_INDEX = 10;
const DDI_PERSISTENCE = 2;
const DDI_NONCE_PERSISTENCE = 1;

export interface CryptexPayloads {
  image: Uint8Array;
  trustcache: Uint8Array;
  im4m: Uint8Array;
  info: Uint8Array;
  volumehash: Uint8Array;
  properties: CryptexProperties;
}

/** daemon 拒绝的 routine，带它自己的话。 */
export class CryptexdError extends Error {
  constructor(
    readonly routine: string,
    message: string,
  ) {
    super(message);
  }
}

/** 设备的 AppleImage4 chip 信息。 */
export async function readPersonalizationIdentifiers(link: DdiLink): Promise<PlistDict> {
  const argv = await invoke(link, "read-personalization-id", {});
  if (argv === null) throw new CryptexdError("read-personalization-id", "daemon 没有返回识别码");
  return argv as PlistDict;
}

/** 某个 nonce domain 的 nonce，去掉 daemon 的小头。 */
export async function cryptexNonce(link: DdiLink, handle: bigint): Promise<Uint8Array> {
  const argv = await invoke(link, "get-nonce", { "nonce-domain-handle": new XpcUInt64(handle) });
  const nonce = argv?.nonce;
  if (!(nonce instanceof Uint8Array)) {
    throw new CryptexdError("get-nonce", "daemon 没有返回 nonce");
  }
  return unwrapNonce(nonce);
}

/** 已安装的开发者镜像版本；没有则 null。 */
export async function installedDeveloperImage(link: DdiLink): Promise<string | null> {
  const argv = await invoke(link, "copy-installed", {});
  const list = argv?.["remote-cryptex-array"];
  if (!Array.isArray(list)) return null;
  for (const entry of list) {
    if (!isDict(entry)) continue;
    if (entry["remote-cryptex-identifier"] !== DDI_CRYPTEX_IDENTIFIER) continue;
    const version = entry["remote-cryptex-version"];
    return typeof version === "string" ? version : "";
  }
  return null;
}

/** personalize 并安装；daemon 收齐所有 payload 后才回复。 */
export async function installCryptex(link: DdiLink, payloads: CryptexPayloads): Promise<void> {
  const transfers: Array<[string, Uint8Array]> = [
    ["image", payloads.image],
    ["trustcache", payloads.trustcache],
    ["im4m", payloads.im4m],
    ["info", payloads.info],
    ["volumehash", payloads.volumehash],
  ];

  const argv: { [key: string]: XpcValue } = {
    auth: new XpcUInt64(0n),
    "client-version": new XpcUInt64(BigInt(CLIENT_VERSION)),
    "cryptex1-properties": propertiesValue(payloads.properties),
    "image-type-index": DDI_IMAGE_TYPE_INDEX,
    "nonce-persistence": new XpcUInt64(BigInt(DDI_NONCE_PERSISTENCE)),
    persistence: new XpcUInt64(BigInt(DDI_PERSISTENCE)),
  };
  transfers.forEach(([key, payload], index) => {
    argv[key] = new XpcFileTransfer(BigInt(index + 1), {
      s: new XpcUInt64(BigInt(payload.length)),
    });
  });

  await withDaemon(link, async (session) => {
    await session.send({ routine: "install", argv });
    for (const [index, [, payload]] of transfers.entries()) {
      await session.sendFileTransfer(index, BigInt(index + 1), payload);
    }
    unwrapReply("install", await session.receive());
  });
}

/**
 * cryptex1-properties，按 Xcode 的拼法。
 *
 * SubType / NonceDomain 必须是无符号 64 位；用有符号会被整体拒绝。
 */
function propertiesValue(properties: CryptexProperties): XpcValue {
  return {
    "Cryptex1,UseProductClass": properties.useProductClass,
    MountedCryptex: false,
    "Cryptex1,SubType": new XpcUInt64(properties.subType),
    "Cryptex1,NonceDomain": new XpcUInt64(properties.nonceDomain),
    "Cryptex1,Version": properties.version,
    "Cryptex1,PreauthVersion": properties.preauthVersion,
  };
}

/** 一次 routine，一条独立连接。 */
async function invoke(
  link: DdiLink,
  routine: string,
  argv: XpcValue,
): Promise<Record<string, unknown> | null> {
  return withDaemon(link, async (session) => {
    await session.send({ routine, argv });
    return unwrapReply(routine, await session.receive());
  });
}

async function withDaemon<T>(link: DdiLink, body: (session: RemoteXpcSession) => Promise<T>): Promise<T> {
  if (!link.hasService(CRYPTEXD_SERVICE)) {
    throw new CryptexdError("connect", `设备没有提供 ${CRYPTEXD_SERVICE}`);
  }
  return link.withRawService(CRYPTEXD_SERVICE, async (stream) => {
    const session = await RemoteXpcSession.open(stream);
    try {
      return await body(session);
    } finally {
      await session.close();
    }
  });
}

/** 拒绝时 daemon 可能把原因放在 cferr_userinfo 里。 */
function extra(detail: Record<string, unknown>): string {
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (key === "cferr_code" || key === "cferr_domain" || key === "cferr_userinfo") continue;
    rest[key] = value;
  }
  const info = detail.cferr_userinfo;
  if (isDict(info)) {
    for (const [key, value] of Object.entries(info)) {
      if (key === "NSLocalizedDescription") continue;
      rest[`userinfo.${key}`] = value;
    }
  }
  const keys = Object.keys(rest);
  if (keys.length === 0) return "";
  try {
    const text = JSON.stringify(rest);
    return ` — ${text.length > 300 ? `${text.slice(0, 300)}…` : text}`;
  } catch {
    return ` — ${keys.join(", ")}`;
  }
}

/** 从回复里取 argv，或把 daemon 的错误转成异常。 */
function unwrapReply(routine: string, reply: unknown): Record<string, unknown> | null {
  if (!isDict(reply)) throw new CryptexdError(routine, "daemon 的回复不是字典");

  const failure = reply.cferr;
  if (isDict(failure)) {
    const info = failure.cferr_userinfo;
    const description = isDict(info) ? info.NSLocalizedDescription : undefined;
    const said = typeof description === "string" ? description : "failed";
    throw new CryptexdError(
      routine,
      `${routine} 失败：${said} (${String(failure.cferr_domain)}: ${String(failure.cferr_code)})${extra(failure)}`,
    );
  }

  const error = reply.error;
  if (typeof error === "number" && error !== 0) {
    throw new CryptexdError(routine, `errno ${error}`);
  }

  const argv = reply.argv;
  return isDict(argv) ? argv : null;
}

function isDict(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array)
  );
}
