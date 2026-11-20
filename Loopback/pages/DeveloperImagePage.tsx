// 开发者镜像：缓存文件、下载进度、镜像源，以及检查/安装。
//
// 页面不自动连设备，也不改 VPN；安装按钮按需取会话。缺文件由安装流程自动下载。

import {
  Button,
  HStack,
  List,
  ProgressView,
  Section,
  Spacer,
  Text,
  TextField,
  VStack,
  useEffect,
  useState,
} from "scripting";
import { tx } from "../core/i18n";
import { DEFAULT_DDI_BASE_URL, loadDdiBaseUrl, supportsCryptexImage, type DdiStage } from "../kit/ddi";
import { developerImage, megabytes } from "../kit/developerImage";
import { deviceHub } from "../kit/hub";
import { currentVpnApi, unsupportedMessage, vpnSupportOf } from "../kit/apiSupport";

const STAGE_LABEL: Record<DdiStage, [string, string]> = {
  check: ["检查", "Checking"],
  download: ["下载", "Downloading"],
  identify: ["读取设备识别码", "Reading device identifiers"],
  nonce: ["读取 nonce", "Reading nonce"],
  ticket: ["请求 Apple 票据", "Requesting Apple ticket"],
  install: ["安装", "Installing"],
  verify: ["确认", "Verifying"],
};

export function DeveloperImagePage() {
  const [baseUrl, setBaseUrl] = useState(() => loadDdiBaseUrl());
  const [note, setNote] = useState("");
  const [installError, setInstallError] = useState("");
  const [, force] = useState(0);

  useEffect(() => {
    void developerImage.refresh();
    return developerImage.subscribe(() => {
      force((value) => value + 1);
    });
  }, []);

  const state = developerImage.state;
  const install = state.install;
  const supported = supportsCryptexImage(Device.systemVersion);
  // 下载/删除只靠 HTTP 与文件系统，商店版照旧；只有"检查并安装"需要开发者通道。
  const channel = vpnSupportOf(currentVpnApi());

  async function removeFiles() {
    const confirmed = await Dialog.confirm(
      tx(
        "要删除已下载的镜像文件吗？下次需要时会重新下载；设备上已经安装的镜像不受影响。",
        "Delete the downloaded image files? They will be downloaded again when needed. An image already installed on the device is not affected.",
      ),
    );
    if (!confirmed) return;
    await developerImage.deleteFiles();
    setNote(tx("✓ 已删除缓存文件", "✓ Cached files deleted"));
  }

  async function installImage() {
    setInstallError("");
    setNote("");
    try {
      const session = await deviceHub.get();
      await developerImage.ensure(session);
      setNote(tx("✓ 开发者镜像已就绪", "✓ Developer image is ready"));
    } catch (error) {
      setInstallError(error instanceof Error ? error.message : String(error));
    }
  }

  function saveSource() {
    setBaseUrl(developerImage.setBaseUrl(baseUrl));
    setNote(tx("✓ 镜像源已保存", "✓ Image source saved"));
  }

  function resetSource() {
    setBaseUrl(developerImage.setBaseUrl(""));
    setNote(tx("✓ 已恢复默认镜像源", "✓ Default source restored"));
  }

  const statusColor = state.failure ? "systemRed" : state.ready ? "systemGreen" : "systemOrange";

  return (
    <List
      navigationTitle={tx("开发者镜像", "Developer Image")}
      navigationBarTitleDisplayMode="inline"
      listStyle="insetGroup"
    >
      <Section
        header={<Text>{tx("状态", "Status")}</Text>}
        footer={
          <Text foregroundStyle="tertiaryLabel">
            {tx(
              "镜像文件约 18 MB，下载后缓存到 app Documents 下的 Loopback/DDI，与 SideInstaller 隔离。下载默认不走蜂窝网络。",
              "The image is about 18 MB and is cached in Loopback/DDI under the app Documents directory, isolated from SideInstaller. Downloads do not use cellular data by default.",
            )}
          </Text>
        }
      >
        <HStack>
          <Text>{tx("系统版本", "System")}</Text>
          <Spacer />
          <Text foregroundStyle="secondaryLabel">{Device.systemVersion}</Text>
        </HStack>
        <HStack>
          <Text>{tx("安装支持", "Install support")}</Text>
          <Spacer />
          <Text foregroundStyle={supported ? "secondaryLabel" : "systemOrange"}>
            {supported ? tx("iOS 26.4+", "iOS 26.4+") : tx("需要 iOS 26.4+", "Requires iOS 26.4+")}
          </Text>
        </HStack>
        <HStack>
          <Text>{tx("缓存文件", "Cached files")}</Text>
          <Spacer />
          <Text foregroundStyle={statusColor}>
            {state.present}/{state.total}
          </Text>
        </HStack>
        <HStack>
          <Text>{tx("已下载", "Downloaded")}</Text>
          <Spacer />
          <Text foregroundStyle="secondaryLabel">{megabytes(state.bytes)}</Text>
        </HStack>
        {state.progress !== null ? (
          <VStack alignment="leading" spacing={6}>
            <ProgressView value={state.progress} total={1} />
            <Text font="caption" foregroundStyle="secondaryLabel">
              {tx("下载中…", "Downloading…")} {Math.round(state.progress * 100)}%
            </Text>
          </VStack>
        ) : null}
        {state.failure ? (
          <Text font="caption" foregroundStyle="systemRed">
            {state.failure}
          </Text>
        ) : null}
      </Section>

      <Section header={<Text>{tx("文件", "Files")}</Text>}>
        <Button
          title={
            state.busy
              ? tx("下载中…", "Downloading…")
              : state.ready
                ? tx("文件已就绪", "Files are ready")
                : tx("下载镜像文件", "Download image files")
          }
          systemImage="arrow.down.circle"
          disabled={state.busy || state.ready}
          action={() => {
            void developerImage.download();
          }}
        />
        {state.present > 0 ? (
          <Button
            title={tx("删除缓存文件", "Delete cached files")}
            systemImage="trash"
            role="destructive"
            disabled={state.busy}
            action={() => {
              void removeFiles();
            }}
          />
        ) : null}
      </Section>

      <Section
        header={<Text>{tx("镜像源", "Image Source")}</Text>}
        footer={
          <Text foregroundStyle="tertiaryLabel">
            {tx(
              `默认地址：${DEFAULT_DDI_BASE_URL}\n\n只接受 https 地址；留空或填错会恢复默认。改源不会删除已下载的文件，只清理旧下载记录。`,
              `Default: ${DEFAULT_DDI_BASE_URL}\n\nOnly https URLs are accepted; an empty or invalid value restores the default. Changing the source keeps downloaded files and only clears old download records.`,
            )}
          </Text>
        }
      >
        <TextField
          title=""
          value={baseUrl}
          prompt={DEFAULT_DDI_BASE_URL}
          keyboardType="URL"
          onChanged={(value: string) => setBaseUrl(value)}
        />
        <Button
          title={tx("保存镜像源", "Save Source")}
          systemImage="checkmark.circle"
          disabled={state.busy}
          action={saveSource}
        />
        <Button
          title={tx("恢复默认", "Restore Default")}
          systemImage="arrow.counterclockwise"
          disabled={state.busy || baseUrl === DEFAULT_DDI_BASE_URL}
          action={resetSource}
        />
        {note ? (
          <Text font="caption" foregroundStyle="systemGreen">
            {note}
          </Text>
        ) : null}
      </Section>

      <Section
        header={<Text>{tx("安装", "Install")}</Text>}
        footer={
          <Text foregroundStyle="tertiaryLabel">
            {tx(
              "缺文件时会自动下载；安装后镜像持续到设备重启。删除缓存只删文件，不卸载。",
              "Missing files are downloaded automatically; an installed image stays until the device restarts. Deleting the cache does not unmount it.",
            )}
          </Text>
        }
      >
        <HStack>
          <Text>{tx("状态", "Status")}</Text>
          <Spacer />
          <Text foregroundStyle={install.ready ? "systemGreen" : "secondaryLabel"}>
            {install.busy
              ? tx("安装中…", "Installing…")
              : install.ready
                ? install.version
                : tx("未检查", "Not checked")}
          </Text>
        </HStack>
        {install.busy ? (
          <VStack alignment="leading" spacing={4}>
            <ProgressView />
            <Text font="caption" foregroundStyle="secondaryLabel">
              {tx(...STAGE_LABEL[install.stage ?? "check"])}
              {install.detail ? ` — ${install.detail}` : ""}
            </Text>
          </VStack>
        ) : null}
        {installError || install.failure ? (
          <Text font="caption" foregroundStyle="systemRed">
            {installError || install.failure}
          </Text>
        ) : null}
        <Button
          title={install.busy ? tx("安装中…", "Installing…") : tx("检查并安装", "Check and Install")}
          systemImage="wrench.and.screwdriver"
          disabled={install.busy || state.busy || !supported || !channel.supported}
          action={() => {
            void installImage();
          }}
        />
        {!channel.supported ? (
          <Text font="caption" foregroundStyle="systemOrange">
            {unsupportedMessage(channel.missing)}
          </Text>
        ) : !supported ? (
          <Text font="caption" foregroundStyle="systemOrange">
            {tx("当前系统不支持 Cryptex1 安装，需要 iOS 26.4+。", "This system does not support Cryptex1 installation; iOS 26.4+ is required.")}
          </Text>
        ) : null}
      </Section>
    </List>
  );
}
