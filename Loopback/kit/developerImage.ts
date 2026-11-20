// 开发者镜像的页面/服务共用状态机。
//
// 状态以磁盘为准：有没有文件、多大、齐不齐。这里只额外保存“正在下载”和“上次失败”，
// 不把安装状态混进来；安装由 Phase B 的 ensureDeveloperImage 负责。
//
// FileManager 只使用异步 API；state 返回的是最近一次 refresh/下载/删除后的快照，
// 页面打开或服务查询时再调用 refresh() 读盘。下载是后台队列，页面关掉也会继续。

import { tx } from "../core/i18n";
import {
  DDI_FILES,
  DdiError,
  deleteDdiFiles,
  ddiFileState,
  ensureDeveloperImage,
  ensureDdiFiles,
  forgetDdiDownloads,
  loadDdiBaseUrl,
  nativeDdiDownloader,
  saveDdiBaseUrl,
  type DdiFileState,
  type DdiLink,
  type DdiStage,
  type EnsureDdiResult,
} from "./ddi";

export type DeveloperImageInstallState = {
  busy: boolean;
  stage: DdiStage | null;
  detail: string;
  /** 已安装/已挂载的版本；空字符串表示还没确认。 */
  version: string;
  ready: boolean;
  failure: string;
};

export type DeveloperImageState = DdiFileState & {
  /** 0..1；没有下载时为 null。 */
  progress: number | null;
  busy: boolean;
  /** 上一次下载/删除/改源失败的原因，空字符串表示没有。 */
  failure: string;
  baseUrl: string;
  install: DeveloperImageInstallState;
};

function emptyFileState(): DdiFileState {
  return {
    present: 0,
    total: DDI_FILES.length,
    bytes: 0,
    ready: false,
    missing: DDI_FILES.map((item) => item.file),
    files: DDI_FILES.map((item) => ({ file: item.file, size: 0, present: false })),
  };
}

/** 文件系统是敏感能力；按脚本授权开启时，下载/删除前先问一次。 */
export async function requestFileAccess(): Promise<boolean> {
  const api: any = (globalThis as any).Script;
  if (api?.requestAccess === undefined) return true;
  try {
    const granted = await api.requestAccess(["fileSystem"]);
    return Array.isArray(granted) && granted.includes("fileSystem");
  } catch {
    return false;
  }
}

class DeveloperImage {
  private readonly listeners = new Set<() => void>();
  private cache: DdiFileState = emptyFileState();
  private progress: number | null = null;
  private busy = false;
  private failure = "";
  private lastPercent = -1;
  private installBusy = false;
  private installStage: DdiStage | null = null;
  private installDetail = "";
  private installVersion = "";
  private installReady = false;
  private installFailure = "";

  /** 最近一次读盘/下载/删除后的快照；不会同步访问文件系统。 */
  get state(): DeveloperImageState {
    return {
      ...this.cache,
      progress: this.progress,
      busy: this.busy,
      failure: this.failure,
      baseUrl: loadDdiBaseUrl(),
      install: {
        busy: this.installBusy,
        stage: this.installStage,
        detail: this.installDetail,
        version: this.installVersion,
        ready: this.installReady,
        failure: this.installFailure,
      },
    };
  }

  /** 异步读盘；页面打开、服务查询前调用。 */
  async refresh(): Promise<DeveloperImageState> {
    try {
      this.cache = await ddiFileState();
    } catch (error) {
      this.cache = emptyFileState();
      this.failure = error instanceof Error ? error.message : String(error);
    }
    this.notify();
    return this.state;
  }

  /** 下载缺失文件；已经在下载时是 no-op。 */
  async download(): Promise<void> {
    if (this.busy || this.installBusy) return;

    this.busy = true;
    this.failure = "";
    this.progress = 0;
    this.lastPercent = -1;
    this.notify();

    try {
      if (!(await requestFileAccess())) {
        this.failure = tx(
          "需要文件系统权限：请在 Scripting 的脚本权限里允许 Loopback 读写文件。",
          "File access is not allowed. Allow fileSystem for Loopback in Scripting's script permissions.",
        );
        return;
      }

      const before = await ddiFileState();
      this.cache = before;
      if (before.ready) {
        this.progress = null;
        return;
      }

      await ensureDdiFiles(nativeDdiDownloader(), {
        baseUrl: loadDdiBaseUrl(),
        onProgress: (index, fraction) => {
          this.progress = (index + fraction) / DDI_FILES.length;
          const percent = Math.round(this.progress * 100);
          if (percent === this.lastPercent) return;
          this.lastPercent = percent;
          this.notify();
        },
      });
      this.progress = 1;
      this.cache = await ddiFileState();
    } catch (error) {
      this.failure = error instanceof Error ? error.message : String(error);
    } finally {
      this.progress = null;
      this.busy = false;
      this.notify();
    }
  }

  /** 删除缓存文件和下载记录；不卸载设备上已经安装/挂载的镜像。 */
  async deleteFiles(): Promise<void> {
    if (this.busy || this.installBusy) return;

    this.busy = true;
    this.notify();

    try {
      if (!(await requestFileAccess())) {
        this.failure = tx(
          "需要文件系统权限：请在 Scripting 的脚本权限里允许 Loopback 读写文件。",
          "File access is not allowed. Allow fileSystem for Loopback in Scripting's script permissions.",
        );
        return;
      }
      await deleteDdiFiles();
      await forgetDdiDownloads();
      this.failure = "";
      this.progress = null;
      this.cache = await ddiFileState();
    } catch (error) {
      this.failure = error instanceof Error ? error.message : String(error);
    } finally {
      this.busy = false;
      this.notify();
    }
  }

  /** 检查并安装；缺文件时 install 内部会自动下载。 */
  async ensure(link: DdiLink): Promise<EnsureDdiResult> {
    if (this.installBusy) throw new Error("正在安装开发者镜像，请稍候");
    if (this.busy) throw new Error("正在下载开发者镜像，请稍候");

    this.installBusy = true;
    this.installStage = "check";
    this.installDetail = "";
    this.installFailure = "";
    this.notify();

    try {
      const result = await ensureDeveloperImage(link, {
        onProgress: (stage, detail) => {
          this.installStage = stage;
          this.installDetail = detail ?? "";
          this.notify();
        },
      });
      this.installVersion = result.version;
      this.installReady = true;
      this.installFailure = "";
      try {
        this.cache = await ddiFileState();
      } catch {
        // 安装已经成功；缓存快照刷新失败不影响结果。
      }
      return result;
    } catch (error) {
      this.installFailure = error instanceof Error ? error.message : String(error);
      this.installReady = false;
      if (error instanceof DdiError) this.installStage = error.stage;
      throw error;
    } finally {
      this.installBusy = false;
      this.notify();
    }
  }

  /** 保存镜像源并清掉旧队列记录；返回规范化后的地址。 */
  setBaseUrl(text: string): string {
    if (this.busy) return loadDdiBaseUrl();
    const saved = saveDdiBaseUrl(text);
    this.failure = "";
    void forgetDdiDownloads().catch((error) => {
      this.failure = error instanceof Error ? error.message : String(error);
      this.notify();
    });
    this.notify();
    return saved;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

export const developerImage = new DeveloperImage();

/** 文件大小按页面显示的一行格式化："15.2 MB"。 */
export function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
