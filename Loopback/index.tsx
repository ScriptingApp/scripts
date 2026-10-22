// 回环 —— 开发者通道的配对记录与连接设置，配一次给所有脚本用
// Copyright (C) 2026 ios151
//
// 这个脚本只做一件事：**把「连上本机」这件事办妥，然后把结果交出去。**
// 配对、连接设置、兼容性自检都在这儿；具体拿隧道去干什么（看设备信息、模拟定位、
// 装卸 App）是别的脚本的事。
//
// 交出去的方式是 ScriptSession 的状态服务，不再通过 shared Storage 暴露配对记录。
// 其他脚本拿到状态后，用 VPNLocalDevAPI.attachRSDTunnel 取得自己的原生句柄。
//
// 隧道句柄不能通过 ScriptSession.call 传递，服务连接由调用方自己管理。
// 新版原生 API 支持多个脚本 attach 同一条 ready tunnel。

import {
  Button,
  HStack,
  Image,
  List,
  Navigation,
  NavigationLink,
  NavigationStack,
  ProgressView,
  Script,
  Section,
  Spacer,
  Text,
  VStack,
  useEffect,
  useState,
  type Color,
} from "scripting";
import { describeError } from "./core/debug";
import { loadPairing } from "./core/pairing";
import { tx } from "./core/i18n";
import { holderText, readHolder, selfName } from "./core/shared";
import { deviceHub } from "./kit/hub";
import { LINK_LABEL, linkHint, needsAttention, watchLink, type LinkKind } from "./kit/network";
import { loadConnectionSettings } from "./kit/settings";
import { CheckPage } from "./pages/CheckPage";
import { PairingPage } from "./pages/PairingPage";
import { SettingsPage } from "./pages/SettingsPage";

let pageOpen = false;
let pageOpening = false;
let resumeListenerInstalled = false;

async function presentLoopbackPage(): Promise<void> {
  if (Script.env === "home_screen") return;
  if (pageOpen || pageOpening) return;
  pageOpening = true;
  try {
    pageOpen = true;
    await Navigation.present({ element: <App />, modalPresentationStyle: "fullScreen" });
  } finally {
    pageOpen = false;
    pageOpening = false;
  }
}

type LoopbackCommand = "status" | "ensureTunnel" | "releaseTunnel";

type LoopbackResult = {
  status: "paired" | "tunnel_open" | "not_paired" | "tunnel_closed" | "error";
  ready?: boolean;
  released?: boolean;
  message?: string;
};

function isCommand(value: unknown): value is LoopbackCommand {
  return value === "status" || value === "ensureTunnel" || value === "releaseTunnel";
}

function commandOf(message: unknown): LoopbackCommand {
  if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("Expected a command object");
  const command = (message as { command?: unknown }).command;
  if (!isCommand(command)) throw new Error("Unknown command");
  return command;
}

function statusResult(): LoopbackResult {
  return { status: deviceHub.connected ? "tunnel_open" : loadPairing() ? "paired" : "not_paired", ready: deviceHub.connected };
}

function Row({ title, subtitle, systemImage, color }: { title: string; subtitle: string; systemImage: string; color: Color }) {
  return (
    <HStack spacing={12}>
      <Image systemName={systemImage} foregroundStyle={color} font="title3" frame={{ width: 30 }} />
      <VStack alignment="leading" spacing={2}>
        <Text>{title}</Text>
        <Text font="caption" foregroundStyle="secondaryLabel">
          {subtitle}
        </Text>
      </VStack>
    </HStack>
  );
}

export function App() {
  const dismiss = Navigation.useDismiss();
  const [paired, setPaired] = useState(() => loadPairing() !== null);
  const [connected, setConnected] = useState(deviceHub.connected);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [occupied, setOccupied] = useState("");
  const [link, setLink] = useState<LinkKind>("unknown");

  useEffect(() => deviceHub.subscribe(setConnected), []);
  useEffect(() => watchLink(setLink), []);
  useEffect(() => {
    setOccupied(holderText(readHolder(), selfName()));
  }, []);

  /**
   * 验证配对记录：完整开一次隧道。
   *
   * 这是本脚本唯一会真的连设备的地方——配对记录「存下来了」和「真能用」是两回事，
   * 尤其是从别处导入的那种。验证完就断开，不占着隧道妨碍别的脚本。
   */
  async function verify() {
    setBusy(true);
    setError("");
    try {
      await deviceHub.get(setStatus);
      setStatus("");
      setError("");
      await deviceHub.disconnect();
      setOccupied("");
      setStatus("✓ 连得上，这份记录可以用");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : describeError(failure));
      setOccupied(holderText(readHolder(), selfName()));
    } finally {
      setBusy(false);
    }
  }

  const settings = loadConnectionSettings();
  const notice = occupied || (paired ? "" : tx("还没有配对。先跑一次兼容性自检，再去配对。", "Not paired. Run the compatibility check, then pair a device.")) || linkHint(link);

  return (
    <NavigationStack>
      <List
        navigationTitle={tx("回环", "Loopback")}
        listStyle="insetGroup"
        toolbar={Script.env === "home_screen" ? {} : { cancellationAction: <Button title={tx("关闭", "Close")} action={() => dismiss()} /> }}
      >
        <Section
          header={<Text>{tx("状态", "Status")}</Text>}
          footer={
            <Text foregroundStyle={error ? "systemRed" : notice ? "systemOrange" : "tertiaryLabel"}>
              {error ||
                status ||
                notice ||
                tx("配对记录只保存在本脚本 Keychain；其他脚本通过 ScriptSession 接入。", "Pairing stays in this script's Keychain; other scripts use ScriptSession.")}
            </Text>
          }
        >
          <HStack>
            <Text>{tx("配对记录", "Pairing")}</Text>
            <Spacer />
            <Text foregroundStyle={paired ? "systemGreen" : "systemOrange"}>{paired ? tx("已配对", "Paired") : tx("未配对", "Not paired")}</Text>
          </HStack>
          <HStack>
            <Text>{tx("隧道来源", "Tunnel source")}</Text>
            <Spacer />
            <Text foregroundStyle="secondaryLabel">
              {settings.source === "proxyApp" ? tx("代理工具提供", "External VPN") : tx("Scripting 自身", "Scripting")}
            </Text>
          </HStack>
          {link === "unknown" ? null : (
            <HStack>
              <Text>{tx("网络", "Network")}</Text>
              <Spacer />
              <Text foregroundStyle={needsAttention(link) ? "systemOrange" : "secondaryLabel"}>{LINK_LABEL[link]}</Text>
            </HStack>
          )}
          {busy ? (
            <HStack spacing={10}>
              <ProgressView />
              <Text foregroundStyle="secondaryLabel">{status || tx("连接设备…", "Connecting to device…")}</Text>
            </HStack>
          ) : paired ? (
            <Button
              title={connected ? tx("断开", "Disconnect") : tx("验证一次（实际连接测试）", "Verify connection")}
              systemImage={connected ? "xmark.circle" : "bolt.horizontal.circle"}
              action={() => void (connected ? deviceHub.disconnect() : verify())}
            />
          ) : null}
        </Section>

        <Section header={<Text>{tx("操作", "Actions")}</Text>}>
          <NavigationLink destination={<CheckPage />}>
            <Row title={tx("兼容性自检", "Compatibility Check")} subtitle={tx("检查设备和 Scripting 能力", "Check device and Scripting capabilities")} systemImage="checklist" color="systemBlue" />
          </NavigationLink>
          <NavigationLink destination={<PairingPage onChanged={() => setPaired(loadPairing() !== null)} />}>
            <Row title={tx("配对", "Pair Device")} subtitle={tx("配一次，其他脚本通过服务接入", "Pair once; other scripts use the service")} systemImage="link" color="systemGreen" />
          </NavigationLink>
          <NavigationLink destination={<SettingsPage />}>
            <Row title={tx("连接设置", "Connection Settings")} subtitle={tx("隧道来源、地址和日志", "Tunnel source, address and logs")} systemImage="slider.horizontal.3" color="systemIndigo" />
          </NavigationLink>
        </Section>

        <Section
          header={<Text>{tx("给其他脚本", "For Other Scripts")}</Text>}
          footer={
            <Text foregroundStyle="tertiaryLabel">
              {tx("其他脚本通过 ScriptSession 请求状态，再用 attachRSDTunnel 获取自己的原生句柄；配对记录不通过 shared Storage 暴露。", "Other scripts use ScriptSession, then attach their own tunnel handle; pairing is never exposed through shared Storage.")}
            </Text>
          }
        >
          <HStack>
            <Text font="caption" fontDesign="monospaced">ScriptSession command</Text>
            <Spacer />
            <Text font="caption" foregroundStyle="secondaryLabel">{tx("状态协议", "Status protocol")}</Text>
          </HStack>
          <HStack>
            <Text font="caption" fontDesign="monospaced">devtunnel.connection</Text>
            <Spacer />
            <Text font="caption" foregroundStyle="secondaryLabel">{tx("连接设置", "Connection settings")}</Text>
          </HStack>
          <HStack>
            <Text font="caption" fontDesign="monospaced">devtunnel.holder</Text>
            <Spacer />
            <Text font="caption" foregroundStyle="secondaryLabel">{tx("当前隧道持有者", "Current tunnel holder")}</Text>
          </HStack>
        </Section>
      </List>
    </NavigationStack>
  );
}

async function run() {
  if (!resumeListenerInstalled) {
    resumeListenerInstalled = true;
    Script.onResume(() => {
      // 用户再次点击脚本时，如果页面已经关闭才重新打开；页面仍在显示时不重复 present。
      if (!pageOpen && !pageOpening) void presentLoopbackPage();
    });
  }

  // A 只注册一个串行服务。服务回调完成不会退出脚本，因此 deviceHub 继续持有 A 的句柄。
  ScriptSession.serve(async (message) => {
      const command = commandOf(message);
      if (command === "status") return statusResult();
      if (command === "releaseTunnel") {
        await deviceHub.disconnect();
        return { status: "tunnel_closed", released: true } satisfies LoopbackResult;
      }
      // 页面由入口统一打开；服务回调只负责检查状态和准备隧道，不重复展示页面。
      if (!loadPairing()) return { status: "not_paired", ready: false, message: "配对未完成，请先在 Loopback 页面完成配对" } satisfies LoopbackResult;
      try {
        await deviceHub.get();
        return { status: "tunnel_open", ready: true } satisfies LoopbackResult;
      } catch (error) {
        return { status: "error", ready: false, message: error instanceof Error ? error.message : describeError(error) } satisfies LoopbackResult;
      }
    });

  // 用户从脚本列表启动、或 ScriptSession 冷启动时，都打开同一个页面。
  // 页面关闭后脚本仍存活；再次恢复脚本时，Script.onResume 会按需重新打开页面。
  await presentLoopbackPage();
}

void run();
