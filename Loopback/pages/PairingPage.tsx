// Pairing UI. Credentials are stored only in this script's Keychain.

import { Button, HStack, Image, List, Section, Spacer, Text, VStack, useState } from "scripting";
import { utf8 } from "../core/bytes";
import { describeError } from "../core/debug";
import { createHostIdentity, createPIN, pairThisDevice } from "../core/pair_setup";
import {
  PAIRING_EXPORT_FORMATS,
  deletePairing,
  exportPairingAsBinary,
  exportPairingAsJson,
  exportPairingAsXml,
  loadPairing,
  parsePairingFile,
  savePairing,
  type PairingExportFormat,
  type PairingRecord,
} from "../core/pairing";
import { copyWithFeedback } from "./common";
import { tx } from "../core/i18n";
import { deviceHub } from "../kit/hub";
import { releaseKeepAlive, retainKeepAlive } from "../utils/keepalive";
import { PIN_ORDER_HINT, clearPinNotice, showPinNotice } from "../kit/pinNotice";

export function PairingPage({ onChanged, onPaired, onClose }: { onChanged: () => void; onPaired?: (record: PairingRecord) => void; onClose?: () => void }) {
  const [record, setRecord] = useState<PairingRecord | null>(() => loadPairing());
  const [status, setStatus] = useState("");
  const [isError, setIsError] = useState(false);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  /** 共享域里有没有一份。配完、导入完、删完都要重新读。 */

  function report(message: string, error = false) {
    setStatus(message);
    setIsError(error);
  }

  async function runPairing() {
    setBusy(true);
    report("");
    let lease = false;
    try {
      /*
        保活照 utils/keepalive.ts 那三条规矩：在前台就申请、看返回值、只走 retain/release。
        输 PIN 要切到「设置」，本页在后台等，保活没起来就可能被回收。
      */
      try {
        const started = await retainKeepAlive("pairing");
        lease = true;
        if (!started) report("后台保活没起来，切到「设置」时本页可能被回收。多半是音频被别的 App 占着，停掉再试。", true);
      } catch (error) {
        report(`这个入口拿不到后台保活（${describeError(error)}），从脚本列表打开本脚本再配对更稳。`, true);
      }

      const host = await createHostIdentity();
      const code = createPIN();
      setPin(code);
      // 配对要切去「设置」，界面上的 PIN 就看不见了——推一条通知带着走
      await showPinNotice(code);
      const paired = await pairThisDevice(host, code, (message) => report(message));

      // 先用新记录真的连一次，过了才落盘——免得一份连不上的记录覆盖掉能用的那份。
      report("验证新配对记录…");
      await deviceHub.openWith(paired, (message) => report(message));
      savePairing(paired);
      setRecord(paired);
       onPaired?.(paired);
      onChanged();
      report(tx("✓ 配对完成，已连上设备。现在可以关闭此页面，其他脚本会通过命令开启隧道并连接。", "✓ Pairing complete and the device is connected. You can close this page now; other scripts can open the tunnel and connect through ScriptSession."));
    } catch (error) {
      report(`配对失败：${describeError(error)}`, true);
    } finally {
      if (lease) await releaseKeepAlive("pairing").catch(() => undefined);
      // PIN 是一次性的：不管成没成，都别把它留在通知中心里
      await clearPinNotice();
      setPin("");
      setBusy(false);
    }
  }

  /**
   * 导出。纯文本走分享面板（可以直接粘进别处），二进制存成文件。
   * 两条路导出的东西本脚本都读得回来。
   */
  async function exportRecord(id: PairingExportFormat) {
    if (!record) return;
    const format = PAIRING_EXPORT_FORMATS.find((item) => item.id === id);
    if (!format) return;
    try {
      if (format.text) {
        const text = id === "json" ? exportPairingAsJson(record) : exportPairingAsXml(record);
        report((await ShareSheet.present([text])) ? `✓ 已导出 ${format.label}` : "已取消导出");
        return;
      }
      const data = Data.fromUint8Array(exportPairingAsBinary(record));
      if (!data) throw new Error("无法构造导出数据");
      const name = `${record.deviceName || "pairing"}.${format.extension}`;
      const saved = await DocumentPicker.exportFiles({ files: [{ data, name }] });
      report(saved.length > 0 ? `✓ 已导出 ${name}` : "已取消导出");
    } catch (error) {
      report(`导出失败：${describeError(error)}`, true);
    }
  }

  function importBytes(bytes: Uint8Array) {
    try {
      const imported = parsePairingFile(bytes);
      savePairing(imported);
      setRecord(imported);
      void deviceHub.disconnect();
      onChanged();
      report(`✓ 已导入：${imported.deviceName || imported.identifier}`);
    } catch (error) {
      report(`解析失败：${describeError(error)}`, true);
    }
  }

  async function importFromFile() {
    try {
      const files = await DocumentPicker.pickFiles({ types: ["public.data", "public.item"] });
      if (!files || files.length === 0) return;
      // 二进制 plist 也要能读，按字节读而不是按字符串
      importBytes(FileManager.readAsBytesSync(files[0]));
    } catch (error) {
      report(`读取文件失败：${describeError(error)}`, true);
    }
  }

  async function importFromClipboard() {
    const text = await Pasteboard.getString();
    if (!text) {
      report("剪贴板为空", true);
      return;
    }
    importBytes(utf8(text));
  }

  /** Delete the Keychain-only pairing record. */
  async function remove() {
    const ok = await Dialog.confirm({
      title: tx("删除配对记录？", "Delete pairing record?"),
      message: tx("配对记录只保存在本脚本 Keychain。", "The pairing record is stored only in this script’s Keychain."),
      confirmLabel: tx("删除", "Delete"),
    });
    if (!ok) return;
    deletePairing();
    await deviceHub.disconnect();
    setRecord(null);
    onChanged();
    report(tx("已删除配对记录", "Pairing record deleted"));
  }

  return (
    <List navigationTitle={tx("配对", "Pair Device")} navigationBarTitleDisplayMode="inline" listStyle="insetGroup"
      toolbar={onClose ? { cancellationAction: <Button title={tx("关闭", "Close")} action={onClose} /> } : undefined}>
      <Section header={<Text>{tx("当前记录", "Current Record")}</Text>}>
        {record ? (
          <VStack alignment="leading" spacing={4}>
            <Text>{record.deviceName || tx("已配对的设备", "Paired Device")}</Text>
            <Text font="caption" foregroundStyle="secondaryLabel" fontDesign="monospaced">
              {record.identifier}
            </Text>
          </VStack>
        ) : (
          <Text foregroundStyle="secondaryLabel">{tx("还没有配对", "Not paired")}</Text>
        )}
      </Section>

      {pin ? (
        <Section
          header={<Text>{tx("输入这个 PIN", "Enter this PIN")}</Text>}
          footer={
            <Text foregroundStyle="secondaryLabel">
              打开「设置 → 隐私与安全性 → 开发者 → 配对」，选中本机。{PIN_ORDER_HINT}
              这个 PIN 已经推成一条通知，切过去也看得到，不用来回切。
            </Text>
          }
        >
          <HStack>
            <Text font={40} fontWeight="semibold" fontDesign="monospaced">
              {pin}
            </Text>
            <Spacer />
            <Button title={tx("复制", "Copy")} systemImage="doc.on.doc" action={() => copyWithFeedback(pin)} />
          </HStack>
        </Section>
      ) : null}

      <Section
        header={<Text>{tx("配对这台设备", "Pair This Device")}</Text>}
        footer={
          <Text foregroundStyle="tertiaryLabel">
            需要先打开开发者模式（设置 → 隐私与安全性 → 开发者模式）。点开始后，本页会显示一个 PIN。
          </Text>
        }
      >
        <Button title={busy ? tx("配对中…", "Pairing…") : tx("开始配对", "Start Pairing")} systemImage="link" action={() => void (busy ? undefined : runPairing())} />
      </Section>

      <Section
        header={<Text>{tx("导入配对文件", "Import Pairing File")}</Text>}
        footer={
          <Text foregroundStyle="tertiaryLabel">
            这台设备在别的工具里配过的话，把那份配对记录导出来，在这儿导入就不用重新输 PIN。
            导入后同样会写进共享域。支持 XML / 二进制 plist 和 JSON。
          </Text>
        }
      >
        <Button title={tx("从文件导入", "Import from File")} systemImage="doc" action={() => void importFromFile()} />
        <Button title={tx("从剪贴板粘贴", "Paste from Clipboard")} systemImage="doc.on.clipboard" action={() => void importFromClipboard()} />
      </Section>

      {record ? (
        <Section
          header={<Text>导出配对记录</Text>}
          footer={
            <Text foregroundStyle="tertiaryLabel">
              搬到别的设备、或者给别的工具用。导出来的是连本机的凭据，拿到它就能走开发者通道连这台设备，别随手发群里。
            </Text>
          }
        >
          {PAIRING_EXPORT_FORMATS.map((format) => (
            <Button key={format.id} action={() => void exportRecord(format.id)}>
              <HStack spacing={10}>
                <Image systemName="square.and.arrow.up" foregroundStyle="systemBlue" frame={{ width: 26 }} />
                <VStack alignment="leading" spacing={2}>
                  <Text foregroundStyle="label">{format.label}</Text>
                  <Text font="caption" foregroundStyle="tertiaryLabel" lineLimit={2}>
                    {format.detail}
                  </Text>
                </VStack>
                <Spacer />
              </HStack>
            </Button>
          ))}
        </Section>
      ) : null}

      {status ? (
        <Section>
          <Text foregroundStyle={isError ? "systemRed" : "secondaryLabel"}>{status}</Text>
        </Section>
      ) : null}
    </List>
  );
}
