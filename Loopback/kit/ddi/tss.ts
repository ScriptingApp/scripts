// Apple 票据服务器：只请求 cryptex 需要的 Cryptex1 ticket。
//
// 返回不是 JSON 也不是纯 plist：是 form 状态行 + `REQUEST_STRING=` + plist。
// 协议来自 SideInstaller 的 lib/ddi/tss.ts。

import { fromUtf8, utf8 } from "../../core/bytes";
import { withTimeout } from "../../core/stream";
import { decodePlist, encodeXmlPlist, isPlistDict, type PlistDict } from "../plist";

const TSS_ENDPOINT = "https://gs.apple.com/TSS/controller?action=2";
const CLIENT_VERSION = "libauthinstall-1033.0.2";

export type TssOptions = {
  /** 测试用：替换 endpoint。 */
  endpoint?: string;
  /** 测试用：替换 POST。 */
  post?: (url: string, body: string) => Promise<string>;
};

/** 为指定 identity/nonce 取一张 Cryptex1 票据。 */
export async function fetchCryptexTicket(tags: PlistDict, options: TssOptions = {}): Promise<Uint8Array> {
  const request: PlistDict = {
    "@HostPlatformInfo": "mac",
    "@VersionInfo": CLIENT_VERSION,
    "@UUID": upperUuid(),
    ...tags,
  };

  const body = fromUtf8(encodeXmlPlist(request));
  const post = options.post ?? ((url, text) => postXml(url, text));
  const response = await post(options.endpoint ?? TSS_ENDPOINT, body);

  const text = response.trimStart();
  if (!text.includes("REQUEST_STRING=")) {
    throw new Error(`票据服务器拒绝了请求：${summarise(response)}`);
  }
  const head = text.split("REQUEST_STRING=")[0];
  if (!head.startsWith("STATUS=0") || !head.includes("SUCCESS")) {
    throw new Error(`票据服务器返回 ${summarise(head)}`);
  }

  const payload = text.split("REQUEST_STRING=")[1];
  const parsed = decodePlist(utf8(payload));
  if (!isPlistDict(parsed)) throw new Error("票据服务器的 plist 不是字典");
  const ticket = parsed["Cryptex1,Ticket"] ?? parsed.ApImg4Ticket;
  if (!(ticket instanceof Uint8Array)) throw new Error("票据服务器没有返回 Cryptex1 ticket");
  return ticket;
}

async function postXml(url: string, body: string): Promise<string> {
  const anyGlobal: any = globalThis as any;
  if (anyGlobal.fetch === undefined) throw new Error("这个运行环境没有网络");
  const response: any = await withTimeout(
    anyGlobal.fetch(url, {
      method: "POST",
      headers: {
        "Cache-Control": "no-cache",
        "Content-type": 'text/xml; charset="utf-8"',
        "User-Agent": "InetURL/1.0",
      },
      body,
      timeout: 30,
      debugLabel: "tss",
    }),
    30_000,
    "票据服务器请求超时",
  );
  if (response.ok === false) throw new Error(`票据服务器返回 HTTP ${response.status}`);
  return fromUtf8(new Uint8Array(await response.arrayBuffer()));
}

function summarise(text: string): string {
  const line = text.split("&REQUEST_STRING=")[0].trim();
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}

function upperUuid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
