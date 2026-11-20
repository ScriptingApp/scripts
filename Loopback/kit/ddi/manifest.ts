// BuildManifest 里的 Cryptex1 开发者镜像身份：哪个 identity 是 DDI、四个 payload 在哪、
// 以及 Apple 票据服务器要的 tag。
//
// 协议来自 SideInstaller 的 lib/ddi/manifest.ts；只把 plist 类型换成 Loopback 的。

import { PUid, type PlistValue } from "../../core/bplist";
import { isPlistDict, type PlistDict } from "../plist";

/** cryptex 身份的 Variant 尾巴。 */
const CRYPTEX_VARIANT_SUFFIX = "Developer Disk Image Cryptex";

/** 安装时发送的四个 payload，对应 identity.Manifest 里的键。 */
const PAYLOAD_KEYS = {
  image: "Cryptex1,GenericDmg",
  trustcache: "Cryptex1,GenericTrustCache",
  info: "Cryptex1,CryptexInfoPlist",
  volumehash: "Cryptex1,GenericVolume",
} as const;

/** 原样带进票据请求的 tag。 */
const PASSTHROUGH_TAGS = [
  "Cryptex1,Type",
  "Cryptex1,SubType",
  "Cryptex1,UseProductClass",
  "Cryptex1,NonceDomain",
  "Cryptex1,Version",
  "Cryptex1,PreauthorizationVersion",
] as const;

export type CryptexPayloadPaths = {
  image: string;
  trustcache: string;
  info: string;
  volumehash: string;
};

export type CryptexProperties = {
  useProductClass: PlistValue;
  subType: bigint;
  nonceDomain: bigint;
  version: PlistValue;
  preauthVersion: PlistValue;
};

export type CryptexIdentity = {
  /** BuildIdentities 里的那个 identity。 */
  identity: PlistDict;
  /** 这个镜像对应哪个 nonce domain。 */
  nonceDomain: bigint;
  /** payload 路径，相对于 manifest 所在目录。 */
  payloads: CryptexPayloadPaths;
  /** install 请求里的 cryptex1-properties。 */
  properties: CryptexProperties;
};

/** 从 manifest 里找出唯一的 cryptex identity。 */
export function readCryptexIdentity(manifest: PlistDict): CryptexIdentity {
  const identities = manifest.BuildIdentities;
  if (!Array.isArray(identities)) throw new Error("BuildManifest 没有 BuildIdentities");

  const identity = identities
    .map((value) => (isPlistDict(value) ? value : null))
    .find((entry) => {
      const variant = entry === null ? undefined : strOf(entry.Info, "Variant");
      return variant !== undefined && variant.endsWith(CRYPTEX_VARIANT_SUFFIX);
    });
  if (identity === undefined || identity === null) {
    throw new Error("BuildManifest 里没有开发者镜像 cryptex identity");
  }

  const payloads = {
    image: payloadPath(identity, PAYLOAD_KEYS.image),
    trustcache: payloadPath(identity, PAYLOAD_KEYS.trustcache),
    info: payloadPath(identity, PAYLOAD_KEYS.info),
    volumehash: payloadPath(identity, PAYLOAD_KEYS.volumehash),
  };

  return {
    identity,
    nonceDomain: unsigned(required(identity, "Cryptex1,NonceDomain"), "Cryptex1,NonceDomain"),
    payloads,
    properties: cryptexProperties(identity),
  };
}

/**
 * 票据请求。
 *
 * Cryptex1 票据只靠 UDID 识别设备，personalized 组件各带自己的 digest；通用镜像
 * 声明为不 personalization，不放进 tags。
 */
export function cryptexTicketTags(identity: PlistDict, chip: PlistDict, nonce: Uint8Array): PlistDict {
  const tags: PlistDict = {
    "@Cryptex1,Ticket": true,
    "Cryptex1,ChipID": number(required(identity, "Cryptex1,ChipID"), "Cryptex1,ChipID"),
    "Cryptex1,ProductClass": number(required(identity, "Cryptex1,ProductClass"), "Cryptex1,ProductClass"),
  };
  for (const key of PASSTHROUGH_TAGS) tags[key] = required(identity, key);
  tags["Cryptex1,Nonce"] = nonce;
  tags["Cryptex1,ProductionMode"] = flag(required(chip, "img4_chip_cpro"), "img4_chip_cpro");
  tags["Cryptex1,UDID"] = cryptexUdid(chip);
  tags["Cryptex1,UniqueTagList"] = new Uint8Array(0);

  const manifest = required(identity, "Manifest");
  if (!isPlistDict(manifest)) throw new Error("cryptex identity 没有 Manifest");
  for (const [key, entry] of Object.entries(manifest)) {
    if (!key.startsWith("Cryptex1,") || !isPlistDict(entry)) continue;
    if (!flag(entry.Info === undefined ? false : dictOf(entry.Info, key).Personalize ?? false, key)) continue;
    tags[key] = { Digest: required(entry, "Digest") };
  }
  return tags;
}

/** `Cryptex1,UDID`：chip id 和 ECID，各 8 字节大端。 */
export function cryptexUdid(chip: PlistDict): Uint8Array {
  const out = new Uint8Array(16);
  const write = (value: bigint, at: number) => {
    let rest = value;
    for (let index = 7; index >= 0; index--) {
      out[at + index] = Number(rest & 0xffn);
      rest >>= 8n;
    }
  };
  write(unsigned(required(chip, "img4_chip_chip"), "img4_chip_chip"), 0);
  write(unsigned(required(chip, "img4_chip_ecid"), "img4_chip_ecid"), 8);
  return out;
}

/** cryptexd 的 nonce 外面有一层小头：两字节、nonce、四字节长度。 */
export function unwrapNonce(blob: Uint8Array): Uint8Array {
  if (blob.length < 6) throw new Error(`cryptex nonce 至少 6 字节，实际 ${blob.length}`);
  const length =
    blob[blob.length - 4] |
    (blob[blob.length - 3] << 8) |
    (blob[blob.length - 2] << 16) |
    (blob[blob.length - 1] << 24);
  if (length <= 0 || 2 + length > blob.length) {
    throw new Error(`cryptex nonce 声明 ${length} 字节，但总长只有 ${blob.length}`);
  }
  return blob.subarray(2, 2 + length);
}

function cryptexProperties(identity: PlistDict): CryptexProperties {
  return {
    useProductClass: required(identity, "Cryptex1,UseProductClass"),
    subType: unsigned(required(identity, "Cryptex1,SubType"), "Cryptex1,SubType"),
    nonceDomain: unsigned(required(identity, "Cryptex1,NonceDomain"), "Cryptex1,NonceDomain"),
    version: required(identity, "Cryptex1,Version"),
    // daemon 叫 PreauthVersion，manifest 拼成 PreauthorizationVersion。
    preauthVersion: required(identity, "Cryptex1,PreauthorizationVersion"),
  };
}

function payloadPath(identity: PlistDict, key: string): string {
  const manifest = required(identity, "Manifest");
  if (!isPlistDict(manifest)) throw new Error("cryptex identity 没有 Manifest");
  const entry = required(manifest, key);
  if (!isPlistDict(entry)) throw new Error(`${key} 不是 manifest 条目`);
  const path = strOf(entry.Info, "Path");
  if (path === undefined) throw new Error(`BuildManifest 没有 ${key} 的 Path`);
  return path;
}

function dictOf(value: PlistValue, label: string): PlistDict {
  if (!isPlistDict(value)) throw new Error(`${label} 不是字典`);
  return value;
}

function required(dict: PlistDict, key: string): PlistValue {
  const value = dict[key];
  if (value === undefined) throw new Error(`BuildManifest 没有 ${key}`);
  return value;
}

function strOf(value: PlistValue | undefined, key: string): string | undefined {
  if (!isPlistDict(value)) return undefined;
  const entry = value[key];
  return typeof entry === "string" ? entry : undefined;
}

/** manifest 里的整数：number、十进制/0x 字符串，或 bplist 的 UID。 */
function unsigned(value: PlistValue, label: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  if (value instanceof PUid) return BigInt(value.value);
  if (typeof value === "string") {
    const text = value.trim();
    const parsed = text.toLowerCase().startsWith("0x")
      ? BigInt(text)
      : BigInt(Number.parseInt(text, 10));
    return parsed;
  }
  throw new Error(`${label} 不是无符号整数`);
}

function number(value: PlistValue, label: string): number {
  const parsed = unsigned(value, label);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} 超出 number 范围`);
  return Number(parsed);
}

function flag(value: PlistValue, label: string): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "bigint") return value !== 0n;
  throw new Error(`${label} 不是布尔值或整数`);
}
