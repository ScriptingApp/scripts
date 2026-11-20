// 安装开发者镜像：没有它，debug proxy 和 app service 根本不会出现在服务表里。
//
// iOS 26.4+ 是 cryptex：设备侧不签名，Apple 的票据服务器按本机 nonce 签一张
// Cryptex1 ticket，cryptexd 安装。镜像挂载持续到设备重启。
//
// 流程来自 SideInstaller 的 lib/ddi/install.ts；这里把 DeviceLink 换成 DdiLink，
// 并把“缺文件”改成自动下载。

import { decodePlist, isPlistDict } from "../plist";
import { CRYPTEXD_SERVICE, cryptexNonce, installCryptex, installedDeveloperImage, readPersonalizationIdentifiers } from "./cryptexd";
import {
  DDI_FILES,
  ensureDdiFiles,
  loadDdiBaseUrl,
  nativeDdiDownloader,
  readDdiFile,
  supportsCryptexImage,
  type DdiDownloader,
  type DdiFileSystem,
} from "./cache";
import type { DdiLink } from "./link";
import { cryptexTicketTags, readCryptexIdentity } from "./manifest";
import { mountedImageTypes } from "./mounter";
import { fetchCryptexTicket, type TssOptions } from "./tss";

export type DdiStage = "check" | "download" | "identify" | "nonce" | "ticket" | "install" | "verify";

export type EnsureDdiOptions = {
  /** 文件从哪里来；默认用 DownloadManager。 */
  downloader?: DdiDownloader;
  /** 测试用：替换 TSS。 */
  tss?: TssOptions;
  onProgress?: (stage: DdiStage, detail?: string) => void;
  /** 测试用：注入文件系统/目录/系统版本。 */
  fs?: DdiFileSystem;
  directory?: string;
  systemVersion?: string;
};

export type EnsureDdiResult = {
  kind: "installed" | "already_installed" | "already_mounted";
  /** 设备报告的版本（already_mounted 时是挂载类型拼接）。 */
  version: string;
  /** 这次是否真的安装了，而不是发现已经有了。 */
  installed: boolean;
};

/** 哪一步失败，就带哪一步。 */
export class DdiError extends Error {
  constructor(
    readonly stage: DdiStage,
    message: string,
  ) {
    super(message);
  }
}

/** 设备上安装的开发者镜像版本，没有则 null。 */
export async function developerImageVersion(link: DdiLink): Promise<string | null> {
  return installedDeveloperImage(link);
}

/**
 * 确保设备有开发者镜像。缺文件会自动下载，不要求用户先去页面点按钮。
 *
 * 第一次会比较慢：镜像约 18 MB，票据还要一次 Apple 往返，所以每个阶段都回报。
 */
export async function ensureDeveloperImage(
  link: DdiLink,
  options: EnsureDdiOptions = {},
): Promise<EnsureDdiResult> {
  const say = options.onProgress ?? (() => undefined);
  const systemVersion = options.systemVersion ?? String((globalThis as any).Device?.systemVersion ?? "");
  const fs = options.fs;
  let stage: DdiStage = "check";

  try {
    const cryptexSupported = supportsCryptexImage(systemVersion);

    // 先问 cryptex；copy-installed 看不到 mounter 挂载的镜像，但 mounter 可能看到 cryptex，
    // 所以已安装 cryptex 时优先返回 already_installed。
    if (cryptexSupported && link.hasService(CRYPTEXD_SERVICE)) {
      const mounted = await developerImageVersion(link);
      if (mounted !== null) return { kind: "already_installed", version: mounted, installed: false };
    }

    try {
      const byMounter = await mountedImageTypes(link);
      say("check", byMounter.length > 0 ? `已挂载：${byMounter.join(", ")}` : "未挂载");
      if (byMounter.length > 0) {
        return { kind: "already_mounted", version: byMounter.join(", "), installed: false };
      }
    } catch (error) {
      say("check", `无法询问 image mounter：${messageOf(error)}`);
    }

    if (!cryptexSupported) {
      throw new DdiError(
        "check",
        `这个 iOS 版本（${systemVersion || "未知"}）使用另一套镜像挂载方式，当前还不支持`,
      );
    }
    if (!link.hasService(CRYPTEXD_SERVICE)) {
      throw new DdiError("check", `设备没有提供 ${CRYPTEXD_SERVICE}`);
    }

    stage = "download";
    say("download");
    let reported = -1;
    const downloader = options.downloader ?? nativeDdiDownloader();
    const directory = await ensureDdiFiles(downloader, {
      fs,
      directory: options.directory,
      baseUrl: loadDdiBaseUrl(),
      onProgress: (index, fraction) => {
        const percent = Math.round(fraction * 100);
        if (percent === reported || percent % 25 !== 0) return;
        reported = percent;
        say("download", `${DDI_FILES[index].name} ${percent}%`);
      },
    });

    const manifestValue = decodePlist(await readDdiFile(directory, "BuildManifest.plist", fs));
    if (!isPlistDict(manifestValue)) throw new DdiError("download", "BuildManifest 不是字典");
    let cryptex: ReturnType<typeof readCryptexIdentity>;
    try {
      cryptex = readCryptexIdentity(manifestValue);
    } catch (error) {
      throw new DdiError("download", messageOf(error));
    }

    stage = "identify";
    say("identify");
    const chip = await readPersonalizationIdentifiers(link);

    stage = "nonce";
    say("nonce");
    const nonce = await cryptexNonce(link, cryptex.nonceDomain);

    stage = "ticket";
    say("ticket");
    const ticket = await fetchCryptexTicket(cryptexTicketTags(cryptex.identity, chip, nonce), options.tss);
    say("ticket", `${ticket.length} 字节`);

    stage = "install";
    say("install");
    const payloads = {
      image: await readDdiFile(directory, cryptex.payloads.image, fs),
      trustcache: await readDdiFile(directory, cryptex.payloads.trustcache, fs),
      im4m: ticket,
      info: await readDdiFile(directory, cryptex.payloads.info, fs),
      volumehash: await readDdiFile(directory, cryptex.payloads.volumehash, fs),
      properties: cryptex.properties,
    };
    say("install", `${payloads.image.length} 字节`);
    await installCryptex(link, payloads);

    stage = "verify";
    say("verify");
    const version = await developerImageVersion(link);
    if (version === null) throw new DdiError("verify", "安装后设备没有列出开发者镜像");
    await link.refreshServices();
    return { kind: "installed", version, installed: true };
  } catch (error) {
    if (error instanceof DdiError) throw error;
    throw new DdiError(stage, messageOf(error));
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// 保留导出，方便 UI 预判系统版本；真正的门禁在 ensure 里。
export { supportsCryptexImage };
