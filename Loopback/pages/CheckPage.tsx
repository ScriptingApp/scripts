// 兼容性自检。进页面跑一遍，也能手动再跑。
//
// 只查本地问得出来的，不连设备、不开隧道——所以几百毫秒就有结果，
// 用户不用先配对才知道这台机器到底行不行。

import {
  Button,
  HStack,
  Image,
  List,
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
import { debugLog, describeError } from "../core/debug";
import { holderText, readHolder, selfName } from "../core/shared";
import {
  VERDICT_TEXT,
  checkAccess,
  checkBonjour,
  checkDeveloperMode,
  checkSharedDomain,
  checkSystem,
  checkTunnelApi,
  verdict,
  type Check,
  type CheckState,
} from "../kit/capability";
import { LINK_LABEL, classifyLink, linkHint, needsAttention, type LinkKind } from "../kit/network";
import { currentVpnApi, vpnSupportOf } from "../kit/apiSupport";
import { tx } from "../core/i18n";

const STATE_SYMBOL: Record<CheckState, string> = {
  ok: "checkmark.circle.fill",
  warn: "exclamationmark.triangle.fill",
  fail: "xmark.octagon.fill",
  unknown: "questionmark.circle.fill",
};

const STATE_COLOR: Record<CheckState, Color> = {
  ok: "systemGreen",
  warn: "systemOrange",
  fail: "systemRed",
  unknown: "secondaryLabel",
};

/** 链路也算一条：蜂窝下配对基本成不了，属于「能用但得先弄一下」。 */
function checkLink(link: LinkKind): Check {
  if (link === "unknown") return { label: tx("网络", "Network"), state: "unknown", detail: tx("读不到当前链路", "The current link is unavailable") };
  if (!needsAttention(link)) return { label: tx("网络", "Network"), state: "ok", detail: LINK_LABEL[link] };
  return { label: tx("网络", "Network"), state: "warn", detail: linkHint(link) };
}

/** 隧道被别的脚本占着也算一条：不是坏了，是现在轮不到。 */
function checkHolder(): Check {
  const occupied = holderText(readHolder(), selfName());
  return occupied
    ? { label: tx("设备隧道", "Device tunnel"), state: "warn", detail: occupied }
    : { label: tx("设备隧道", "Device tunnel"), state: "ok", detail: tx("没有别的脚本占着", "No other script is holding it") };
}

export function CheckPage() {
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    if (busy) return;
    setBusy(true);
    try {
      /*
        权限要先问：`requestAccess` 在「按脚本授权」开着时会弹窗，
        而弹窗必须由用户的动作引出来，不能等到后面再补。
        版本没有 VPN 接口时只请求 fileSystem：不要为一个不存在的权限弹窗。
      */
      const support = vpnSupportOf(currentVpnApi());
      let granted: string[] = [];
      try {
        granted = await Script.requestAccess(support.supported ? ["localDevVPN", "vpn", "fileSystem"] : ["fileSystem"]);
      } catch (error) {
        debugLog("check", "requestAccess 失败", describeError(error));
      }

      let link: LinkKind = "unknown";
      try {
        link = classifyLink(await Device.getNetworkState());
      } catch (error) {
        debugLog("check", "读不到链路", describeError(error));
      }

      setChecks([
        checkSystem(Device.systemVersion, Device.systemName),
        checkTunnelApi(currentVpnApi(), Device.appVersion),
        checkAccess(granted, support.supported),
        checkBonjour(typeof Bonjour !== "undefined"),
        checkSharedDomain(),
        checkLink(link),
        checkHolder(),
        checkDeveloperMode(),
      ]);
    } finally {
      setBusy(false);
    }
  }

  // 进页面就跑一遍：这一页的全部意义就是「告诉我行不行」，不该还要再点一下
  useEffect(() => {
    void run();
  }, []);

  const state = checks ? verdict(checks) : "unknown";

  return (
    <List
      navigationTitle={tx("兼容性自检", "Compatibility Check")}
      navigationBarTitleDisplayMode="inline"
      listStyle="insetGroup"
      toolbar={{
        topBarTrailing: <Button title={tx("重新检查", "Check Again")} systemImage="arrow.clockwise" disabled={busy} action={() => void run()} />,
      }}
    >
      <Section
        footer={
          <Text foregroundStyle="tertiaryLabel">
            只查本地问得出来的，不连设备、不开隧道。「开发者模式」这类要连上才知道的，这里只能提醒。
          </Text>
        }
      >
        {busy && !checks ? (
          <HStack spacing={10}>
            <ProgressView />
            <Text foregroundStyle="secondaryLabel">{tx("检查中…", "Checking…")}</Text>
          </HStack>
        ) : (
          <HStack spacing={10}>
            <Image systemName={STATE_SYMBOL[state]} foregroundStyle={STATE_COLOR[state]} font="title2" />
            <Text fontWeight="medium">{VERDICT_TEXT[state]}</Text>
            <Spacer />
          </HStack>
        )}
      </Section>

      {checks ? (
        <Section header={<Text>{tx("逐项", "Details")}</Text>}>
          {checks.map((check) => (
            <HStack key={check.label} spacing={10} alignment="top">
              {/* 图标列定宽，不然每行文字起点都不一样 */}
              <Image
                systemName={STATE_SYMBOL[check.state]}
                foregroundStyle={STATE_COLOR[check.state]}
                frame={{ width: 24 }}
              />
              <VStack alignment="leading" spacing={2}>
                <Text foregroundStyle="label">{check.label}</Text>
                <Text font="caption" foregroundStyle="secondaryLabel">
                  {check.detail}
                </Text>
              </VStack>
              <Spacer />
            </HStack>
          ))}
        </Section>
      ) : null}
    </List>
  );
}
