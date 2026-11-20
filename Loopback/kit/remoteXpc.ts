// 一条服务端口上的 RemoteXPC 会话。
//
// RSD 控制连接上跑的是同一套协议：HTTP/2 握手后发 XPC 消息。服务端口的区别是回复走
// 流 3，而不是根流；大块 payload（开发者镜像）要另开流，并遵守对端的流控窗口。
//
// 这里不处理 RSDCheckin；cryptexd 这类服务直接用 RemoteXPC，mounter 那种才走 plist。

import { concat } from "../core/bytes";
import {
  http2DataFrame,
  http2HeadersFrame,
  parseHttp2Frame,
  rsdHandshakeFrames,
} from "../core/http2frames";
import { MAX_CHUNK, type ByteStream } from "../core/stream";
import { XpcFlag, decodeXpcMessage, encodeXpcMessage, type XpcValue } from "../core/xpc";

const INITIAL_WINDOW = 65535;
const MAX_FRAME = 16384;
const FIRST_OUTBOUND_STREAM = 5;
const ROOT_CHANNEL = 1;
const REPLY_CHANNEL = 3;

function isEmptyBody(body: unknown): boolean {
  if (body === null || body === undefined) return true;
  if (typeof body !== "object") return false;
  if (Array.isArray(body) || body instanceof Uint8Array) return false;
  return Object.keys(body as Record<string, unknown>).length === 0;
}

export class RemoteXpcSession {
  /** HTTP/2 帧可能跨多次 read，未成帧的尾巴留在这里。 */
  private h2: Uint8Array = new Uint8Array(0);
  /** 每条流上累积的 DATA。 */
  private readonly streamData = new Map<number, Uint8Array>();
  /** 每条流还可发送多少，以及连接级预算。 */
  private readonly streamWindows = new Map<number, number>();
  private connectionWindow = INITIAL_WINDOW;
  private defaultStreamWindow = INITIAL_WINDOW;
  private nextStream = FIRST_OUTBOUND_STREAM;

  private constructor(private readonly stream: ByteStream) {}

  /** 发服务端口握手；这里没有 RSD 的 device handshake。 */
  static async open(stream: ByteStream): Promise<RemoteXpcSession> {
    const session = new RemoteXpcSession(stream);
    for (const frame of rsdHandshakeFrames()) await stream.write(frame);
    return session;
  }

  /** 一次方法调用。回复走流 3。 */
  async send(value: XpcValue): Promise<void> {
    const flags = XpcFlag.DataFlag | XpcFlag.AlwaysSet | XpcFlag.WantingReply;
    await this.writeStream(ROOT_CHANNEL, encodeXpcMessage(flags, 1, value));
  }

  /** 下一条带正文的消息；空字典和无正文帧是 keepalive，跳过。 */
  async receive(): Promise<unknown> {
    for (;;) {
      const body = this.take(REPLY_CHANNEL);
      if (body !== undefined) {
        if (isEmptyBody(body)) continue;
        return body;
      }
      await this.readMore();
    }
  }

  /**
   * 把一份 payload 作为独立流发出去：HEADERS、file-transfer 前导、字节、结束流。
   *
   * `transferId` 是请求里 `xpcFileTransfer` 声明的 id；`index` 决定流的顺序。
   */
  async sendFileTransfer(index: number, transferId: bigint, payload: Uint8Array): Promise<void> {
    const streamId = this.nextStream + index * 2;
    await this.stream.write(http2HeadersFrame(streamId));
    const preamble = encodeXpcMessage(
      XpcFlag.FileTxStreamRequest | XpcFlag.AlwaysSet,
      Number(transferId),
    );
    await this.writeStream(streamId, preamble);
    await this.writeStream(streamId, payload);
    await this.stream.write(http2DataFrame(new Uint8Array(0), streamId, true));
  }

  async close(): Promise<void> {
    await this.stream.close().catch(() => undefined);
  }

  /** 发一条消息，按对端窗口切块并等待窗口更新。 */
  private async writeStream(streamId: number, bytes: Uint8Array): Promise<void> {
    let at = 0;
    while (at < bytes.length) {
      const room = await this.reserveWindow(streamId);
      const piece = bytes.subarray(at, at + room);
      await this.stream.write(http2DataFrame(piece, streamId));
      at += piece.length;
    }
  }

  /** 现在能发多少；窗口为 0 时先读帧等更新。 */
  private async reserveWindow(streamId: number): Promise<number> {
    for (;;) {
      const streamRoom = this.windowOf(streamId);
      const room = Math.min(streamRoom, this.connectionWindow, MAX_FRAME);
      if (room > 0) {
        this.streamWindows.set(streamId, streamRoom - room);
        this.connectionWindow -= room;
        return room;
      }
      await this.readMore();
    }
  }

  private windowOf(streamId: number): number {
    return this.streamWindows.get(streamId) ?? this.defaultStreamWindow;
  }

  private async readMore(): Promise<void> {
    const chunk = await this.stream.read(MAX_CHUNK);
    if (chunk === null) throw new Error("RemoteXPC：等待回复时设备关闭了连接");
    this.push(chunk);
  }

  /** 追加一块字节，并排空其中所有完整帧。 */
  private push(chunk: Uint8Array): void {
    this.h2 = concat(this.h2, chunk);
    for (;;) {
      const parsed = parseHttp2Frame(this.h2);
      if (parsed === null) return;
      this.h2 = this.h2.subarray(parsed.consumed);
      const frame = parsed.frame;

      if (frame.type === "settings") {
        for (const [id, value] of frame.settings) {
          if (id !== 0x04) continue;
          // 已经打开的流按差值同步移动，HTTP/2 的要求。
          const delta = value - this.defaultStreamWindow;
          this.defaultStreamWindow = value;
          for (const [stream, window] of this.streamWindows) {
            this.streamWindows.set(stream, window + delta);
          }
        }
        continue;
      }
      if (frame.type === "windowUpdate") {
        if (frame.streamId === 0) this.connectionWindow += frame.increment;
        else this.streamWindows.set(frame.streamId, this.windowOf(frame.streamId) + frame.increment);
        continue;
      }
      if (frame.type === "goAway") {
        throw new Error(`RemoteXPC：设备关闭了连接${frame.debug ? `：${frame.debug}` : ""}`);
      }
      if (frame.type === "rstStream") {
        throw new Error(`RemoteXPC：设备重置了流 ${frame.streamId}`);
      }
      if (frame.type !== "data") continue;

      const previous = this.streamData.get(frame.streamId);
      this.streamData.set(
        frame.streamId,
        previous === undefined ? frame.payload : concat(previous, frame.payload),
      );
    }
  }

  /** 从 `channel` 取一条完整消息；没有完整消息时返回 undefined。 */
  private take(channel: number): unknown | undefined {
    const buffer = this.streamData.get(channel);
    if (buffer === undefined || buffer.length === 0) return undefined;

    const decoded = decodeXpcMessage(buffer);
    if (decoded === null) return undefined;
    this.streamData.set(channel, buffer.subarray(decoded.consumed));

    return decoded.message.body;
  }
}
