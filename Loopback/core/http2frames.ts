// RemoteXPC 服务端口用的 HTTP/2 帧工具。
//
// 和 core/http2.ts 的 RSD 客户端不同：这里需要自己收发 SETTINGS / WINDOW_UPDATE，
// 并在发送大文件时遵守对端的流控窗口。只实现 XPC 用得到的四种帧，其余帧跳过。

import { concat, utf8 } from "./bytes";
import { XpcFlag, encodeXpcMessage } from "./xpc";

export const HTTP2_PREFACE = "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n";

export type Http2Frame =
  | { type: "data"; streamId: number; payload: Uint8Array }
  | { type: "headers"; streamId: number }
  | { type: "settings"; streamId: number; flags: number; settings: Array<[number, number]> }
  | { type: "windowUpdate"; streamId: number; increment: number }
  | { type: "rstStream"; streamId: number }
  | { type: "goAway"; lastStreamId: number; debug: string }
  | { type: "other"; streamId: number };

function frameHeader(length: number, type: number, flags: number, streamId: number): Uint8Array {
  return new Uint8Array([
    (length >>> 16) & 0xff,
    (length >>> 8) & 0xff,
    length & 0xff,
    type,
    flags,
    (streamId >>> 24) & 0xff,
    (streamId >>> 16) & 0xff,
    (streamId >>> 8) & 0xff,
    streamId & 0xff,
  ]);
}

/** SETTINGS：(identifier, value) 对，每项 6 字节大端。 */
export function http2SettingsFrame(settings: Array<[number, number]>, streamId = 0, flags = 0): Uint8Array {
  const body = new Uint8Array(settings.length * 6);
  settings.forEach((entry, index) => {
    const at = index * 6;
    body[at] = (entry[0] >>> 8) & 0xff;
    body[at + 1] = entry[0] & 0xff;
    body[at + 2] = (entry[1] >>> 24) & 0xff;
    body[at + 3] = (entry[1] >>> 16) & 0xff;
    body[at + 4] = (entry[1] >>> 8) & 0xff;
    body[at + 5] = entry[1] & 0xff;
  });
  return concat(frameHeader(body.length, 0x04, flags, streamId), body);
}

export function http2WindowUpdateFrame(increment: number, streamId = 0): Uint8Array {
  const body = new Uint8Array([
    (increment >>> 24) & 0xff,
    (increment >>> 16) & 0xff,
    (increment >>> 8) & 0xff,
    increment & 0xff,
  ]);
  return concat(frameHeader(4, 0x08, 0, streamId), body);
}

/** 空 HEADERS + END_HEADERS，只用来开一条通道。 */
export function http2HeadersFrame(streamId: number): Uint8Array {
  return frameHeader(0, 0x01, 0x04, streamId);
}

export function http2DataFrame(payload: Uint8Array, streamId: number, endStream = false): Uint8Array {
  return concat(frameHeader(payload.length, 0x00, endStream ? 0x01 : 0x00, streamId), payload);
}

/** 解析一帧；数据不够一帧时返回 null。未知帧类型归为 other，交给调用方跳过。 */
export function parseHttp2Frame(bytes: Uint8Array): { frame: Http2Frame; consumed: number } | null {
  if (bytes.length < 9) return null;
  const length = (bytes[0] << 16) | (bytes[1] << 8) | bytes[2];
  const type = bytes[3];
  const flags = bytes[4];
  const streamId = ((bytes[5] << 24) | (bytes[6] << 16) | (bytes[7] << 8) | bytes[8]) >>> 0;
  if (bytes.length < 9 + length) return null;
  const body = bytes.subarray(9, 9 + length);
  const consumed = 9 + length;

  if (type === 0x00) return { frame: { type: "data", streamId, payload: body }, consumed };
  if (type === 0x01) return { frame: { type: "headers", streamId }, consumed };
  if (type === 0x03) return { frame: { type: "rstStream", streamId }, consumed };
  if (type === 0x04) {
    const settings: Array<[number, number]> = [];
    for (let at = 0; at + 6 <= body.length; at += 6) {
      const id = (body[at] << 8) | body[at + 1];
      const value = ((body[at + 2] << 24) | (body[at + 3] << 16) | (body[at + 4] << 8) | body[at + 5]) >>> 0;
      settings.push([id, value]);
    }
    return { frame: { type: "settings", streamId, flags, settings }, consumed };
  }
  if (type === 0x07) {
    const lastStreamId = length >= 4 ? ((body[0] << 24) | (body[1] << 16) | (body[2] << 8) | body[3]) >>> 0 : 0;
    const debug = length > 8 ? new TextDecoder().decode(body.subarray(8)) : "";
    return { frame: { type: "goAway", lastStreamId, debug }, consumed };
  }
  if (type === 0x08) {
    if (body.length !== 4) throw new Error("HTTP/2 WINDOW_UPDATE 长度不是 4 字节");
    const increment = ((body[0] << 24) | (body[1] << 16) | (body[2] << 8) | body[3]) >>> 0;
    return { frame: { type: "windowUpdate", streamId, increment }, consumed };
  }
  return { frame: { type: "other", streamId }, consumed };
}

/**
 * 服务端口握手：preface、SETTINGS、WINDOW_UPDATE、根/回复两条流，再发空根字典和 0x201。
 * 和服务端口一样，不包含 RSD 的 device handshake。
 */
export function rsdHandshakeFrames(): Uint8Array[] {
  return [
    utf8(HTTP2_PREFACE),
    http2SettingsFrame([[0x03, 100], [0x04, 1048576]]),
    http2WindowUpdateFrame(983041, 0),
    http2HeadersFrame(1),
    http2DataFrame(encodeXpcMessage(XpcFlag.AlwaysSet, 1, {}), 1),
    http2HeadersFrame(3),
    http2DataFrame(encodeXpcMessage(XpcFlag.InitHandshake | XpcFlag.AlwaysSet, 1), 3),
    http2DataFrame(encodeXpcMessage(0x201, 1), 1),
  ];
}
