// 全脚本共用的那一个设备会话。
//
// 放在模块级、不放进组件 state：各个页面都要借它，而页面里的回调拿到的常常是
// 首帧那份闭包——从这里现取，永远拿到的是最新的会话、配对记录和设置。
//
// 会话不在就建，建好了一直留着；隧道被系统收掉（锁屏、断网）时下一次取用会发现，
// 自动重建。同一时刻只会有一次建立在跑。
//
// 各功能页进来都会顺手建会话，首页靠 subscribe 跟着刷新「已连接 / 未连接」，
// 不然从功能页回来，首页还显示进去之前的状态。

import { debugLog, describeError } from "../core/debug";
import { loadPairing, type PairingRecord } from "../core/pairing";
import { HOLDER_RENEW_MS, claimHolder, holderText, readHolder, releaseHolder, selfName } from "../core/shared";
import { withLinkHint } from "./network";
import { DeviceSession, type StatusReporter } from "./session";
import { loadConnectionSettings } from "./settings";
import { VPNPreparationError } from "./vpn";

type ConnectionListener = (connected: boolean) => void;

class DeviceHub {
  private session: DeviceSession | null = null;
  private opening: Promise<DeviceSession> | null = null;
  private readonly listeners = new Set<ConnectionListener>();
  /** 占用标记的续租定时器。 */
  private lease: number | null = null;

  /** 当前已连上（不保证隧道此刻还活着，取用时会再确认）。 */
  get connected(): boolean {
    return this.session !== null;
  }

  /** 会话建立、断开时回调。返回取消订阅的函数，直接交给 useEffect 当清理。 */
  subscribe(listener: ConnectionListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private setSession(session: DeviceSession | null): void {
    this.session = session;
    if (session) this.startLease();
    else this.stopLease();
    for (const listener of this.listeners) listener(session !== null);
  }

  /**
   * 在共享域登记「隧道被本脚本占着」，并定时续租。
   *
   * 登记是自愿的，不是锁——别的脚本照样开得了隧道。有这一笔，别人连不上时
   * 能说清被谁占着，而不是只给一句协议层的报错。
   */
  private startLease(): void {
    claimHolder(selfName());
    if (this.lease !== null) return;
    this.lease = setInterval(() => claimHolder(selfName()), HOLDER_RENEW_MS);
  }

  private stopLease(): void {
    if (this.lease !== null) {
      clearInterval(this.lease);
      this.lease = null;
    }
    releaseHolder(selfName());
  }

  async get(log: StatusReporter = () => {}): Promise<DeviceSession> {
    if (this.session) {
      if (await this.session.isAlive()) return this.session;
      debugLog("hub", "隧道已不在，重建会话");
      await this.disconnect();
    }
    if (!this.opening) {
      this.opening = this.open(log).finally(() => {
        this.opening = null;
      });
    }
    return this.opening;
  }

  private async open(log: StatusReporter): Promise<DeviceSession> {
    try {
      const existing = await VPN.localDevVPN.attachRSDTunnel();
      if (existing) {
        const session = await DeviceSession.attach(existing, log);
        this.setSession(session);
        return session;
      }
      const record = loadPairing();
      if (!record) throw new Error("还没有配对。先在首页「配对」里配对这台设备，或导入配对文件。");
      const session = await DeviceSession.open(record, loadConnectionSettings(), log);
      this.setSession(session);
      return session;
    } catch (error) {
      // Preparation/permission failures must not be disguised as a stale holder warning.
      if (error instanceof VPNPreparationError) throw error;
      /*
        失败了先看看是不是被别的脚本占着——同时只能有一条隧道，这是最说得清的那种失败。
        标记只是自愿登记，没有也可能正被占着，所以查不到就按网络那条路继续说。
      */
      const occupied = holderText(readHolder(), selfName());
      if (occupied) throw new Error(occupied);
      // 蜂窝下 mDNS 找不到配对服务，这是另一个常见原因。统一在这里补上怎么办
      throw await withLinkHint(error);
    }
  }

  /**
   * 用一份**尚未保存**的配对记录建会话——配对完成后先验证再落盘，
   * 免得一份连不上的记录把钥匙串里能用的那份覆盖掉。
   */
  async openWith(record: PairingRecord, log: StatusReporter): Promise<DeviceSession> {
    await this.disconnect();
    const session = await DeviceSession.open(record, loadConnectionSettings(), log);
    this.setSession(session);
    return session;
  }

  /**
   * 核对隧道还在不在，不在就改成「未连接」。**不重连。**
   *
   * 给首页 Tab 用：那个界面常驻，切走的几分钟里隧道可能被系统收掉，
   * 切回来不核对的话会一直显示「已连接」，点进功能页才发现不是。
   */
  async refresh(): Promise<void> {
    const current = this.session;
    if (!current || (await current.isAlive())) return;
    debugLog("hub", "回到前台核对：隧道已不在");
    await this.disconnect();
  }

  async disconnect(): Promise<void> {
    const current = this.session;
    if (!current) return;
    // 先通知再关：界面立刻显示未连接，不用等隧道收完
    this.setSession(null);
    await current.close().catch((error) => debugLog("hub", "关闭会话出错", describeError(error)));
  }
}

export const deviceHub = new DeviceHub();
