// 开发者镜像的五个文件：清单、镜像、信任缓存、cryptex 信息、卷哈希。
//
// 这些文件缓存在 app Documents 下的 Loopback/DDI，避免和 SideInstaller 等脚本的
// Documents/DDI 互相覆盖或误删。已存在且大小大于 0 的文件不再下载；下载交给
// DownloadManager 的后台队列，脚本退出后仍可继续。
//
// 这一层只负责“文件在不在、怎么下载”，不负责安装；安装由 Phase B 的 ddi/install 处理。

/** 镜像默认来源，与 SideInstaller 保持一致。 */
export const DEFAULT_DDI_BASE_URL =
  "https://github.com/doronz88/DeveloperDiskImage/raw/refs/heads/main/PersonalizedImages/Xcode_iOS_DDI_Cryptex";

const BASE_URL_KEY = "loopback.ddi.baseURL.v1";
const QUEUE_IDENTIFIER = "loopback-ddi";

export interface DdiFile {
  /** 日志和进度里显示的名字。 */
  name: string;
  /** 磁盘上的文件名，同时也是 URL 的最后一段。 */
  file: string;
}

/** 一个 Cryptex1 开发者镜像由这五个文件组成。 */
export const DDI_FILES: DdiFile[] = [
  { name: "build manifest", file: "BuildManifest.plist" },
  { name: "image", file: "Image.dmg" },
  { name: "trust cache", file: "Image.dmg.trustcache" },
  { name: "cryptex info", file: "Image.dmg.cryptex_info" },
  { name: "root hash", file: "Image.dmg.root_hash" },
];

export type DdiFileInfo = {
  file: string;
  size: number;
  present: boolean;
};

export type DdiFileState = {
  /** 已存在且大小大于 0 的文件数。 */
  present: number;
  total: number;
  /** 已存在文件的总字节数。 */
  bytes: number;
  ready: boolean;
  /** 还没就绪的文件名，包含缺失和 0 字节文件。 */
  missing: string[];
  /** 每个文件的磁盘大小，按 DDI_FILES 顺序。 */
  files: DdiFileInfo[];
};

/** 文件系统抽象，方便单测注入内存实现。 */
export interface DdiFileSystem {
  documentsDirectory: string;
  exists(path: string): Promise<boolean>;
  size(path: string): Promise<number>;
  read(path: string): Promise<Uint8Array>;
  createDirectory(path: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface DdiDownloader {
  /** 下载 url 到 destination，能报进度时把进度按 0..1 报出来。 */
  download(url: string, destination: string, onProgress?: (fraction: number) => void): Promise<void>;
}

export interface DdiCacheOptions {
  fs?: DdiFileSystem;
  /** 默认是 documentsDirectory/DDI。 */
  directory?: string;
}

export interface EnsureDdiFilesOptions extends DdiCacheOptions {
  /** 默认读本脚本保存的设置。 */
  baseUrl?: string;
  onProgress?: (index: number, fraction: number) => void;
}

function fileManager(): any {
  const manager: any = (globalThis as any).FileManager;
  if (manager === undefined) throw new Error("这个运行环境没有文件访问能力");
  return manager;
}

/** 把原生 FileManager 包成可注入的接口。 */
export function nativeFileSystem(): DdiFileSystem {
  const manager = fileManager();
  return {
    documentsDirectory: String(manager.documentsDirectory ?? ""),
    exists: async (path) => (await manager.exists?.(path)) === true,
    size: async (path) => {
      try {
        const stat = await manager.stat?.(path);
        return Number(stat?.size ?? 0);
      } catch {
        return 0;
      }
    },
    read: async (path) => {
      const bytes = await manager.readAsBytes?.(path);
      if (bytes instanceof Uint8Array) return bytes;
      throw new Error(`读取镜像文件失败：${path}`);
    },
    createDirectory: async (path) => {
      await manager.createDirectory?.(path, true);
    },
    remove: async (path) => {
      await manager.remove?.(path);
    },
  };
}

export function ddiDirectory(fs: DdiFileSystem = nativeFileSystem()): string {
  // FileManager.documentsDirectory 是 app 级共享目录；必须再套一层 Loopback，
  // 否则会和 SideInstaller 的 DDI 缓存共用同一批文件。
  return `${fs.documentsDirectory}/Loopback/DDI`;
}

/** 去掉尾部斜杠；空值或非 https 地址退回默认值。 */
export function normalizeDdiBaseUrl(text: string): string {
  const trimmed = String(text ?? "").trim().replace(/\/+$/, "");
  return /^https:\/\/[^\s]+$/i.test(trimmed) ? trimmed : DEFAULT_DDI_BASE_URL;
}

export function loadDdiBaseUrl(): string {
  if (typeof Storage === "undefined") return DEFAULT_DDI_BASE_URL;
  const saved = Storage.get<string>(BASE_URL_KEY);
  return normalizeDdiBaseUrl(saved ?? "");
}

/** 保存镜像源；默认值不落盘，避免以后改默认值时被旧值顶住。 */
export function saveDdiBaseUrl(text: string): string {
  const normalized = normalizeDdiBaseUrl(text);
  if (typeof Storage !== "undefined") {
    if (normalized === DEFAULT_DDI_BASE_URL) Storage.remove(BASE_URL_KEY);
    else Storage.set(BASE_URL_KEY, normalized);
  }
  return normalized;
}

export function ddiFileUrl(item: DdiFile, baseUrl: string): string {
  return `${normalizeDdiBaseUrl(baseUrl)}/${item.file}`;
}

/** 异步读取缓存里的一个文件。 */
export async function readDdiFile(
  directory: string,
  file: string,
  fs: DdiFileSystem = nativeFileSystem(),
): Promise<Uint8Array> {
  return fs.read(`${directory}/${file}`);
}

/** 读磁盘：文件本身就是状态，不另存一份。 */
export async function ddiFileState(options: DdiCacheOptions = {}): Promise<DdiFileState> {
  const fs = options.fs ?? nativeFileSystem();
  const directory = options.directory ?? ddiDirectory(fs);
  let present = 0;
  let bytes = 0;
  const missing: string[] = [];
  const files: DdiFileInfo[] = [];

  for (const item of DDI_FILES) {
    const path = `${directory}/${item.file}`;
    const size = (await fs.exists(path)) ? await fs.size(path) : 0;
    files.push({ file: item.file, size, present: size > 0 });
    if (size > 0) {
      present++;
      bytes += size;
    } else {
      missing.push(item.file);
    }
  }

  return { present, total: DDI_FILES.length, bytes, ready: missing.length === 0, missing, files };
}

/** 下载所有缺失或 0 字节的文件，返回目录。 */
export async function ensureDdiFiles(
  downloader: DdiDownloader,
  options: EnsureDdiFilesOptions = {},
): Promise<string> {
  const fs = options.fs ?? nativeFileSystem();
  const directory = options.directory ?? ddiDirectory(fs);
  const baseUrl = options.baseUrl ?? loadDdiBaseUrl();

  if (!(await fs.exists(directory))) await fs.createDirectory(directory);

  for (const [index, item] of DDI_FILES.entries()) {
    const destination = `${directory}/${item.file}`;
    if (await fs.exists(destination)) {
      if ((await fs.size(destination)) > 0) continue;
      // 上次留下一个 0 字节文件；DownloadManager 不会覆盖已有文件，先删掉。
      await fs.remove(destination);
    }
    const url = ddiFileUrl(item, baseUrl);
    await downloader.download(url, destination, (fraction) => {
      const clamped = Math.max(0, Math.min(1, fraction));
      options.onProgress?.(index, clamped);
    });
  }

  return directory;
}

/** 原生下载队列：后台传输、重试、进度都由 DownloadManager 负责。 */
export function nativeDdiDownloader(): DdiDownloader {
  return {
    async download(url, destination, onProgress) {
      const manager: any = (globalThis as any).DownloadManager;
      if (manager === undefined) throw new Error("这个运行环境没有下载管理器");
      const queue = await manager.open({ identifier: QUEUE_IDENTIFIER });

      // 已完成的旧记录如果对应文件不在了，直接下载会被回一个不存在的文件；先清掉记录。
      const previous = await queue.getTaskByURL?.(url);
      if (previous !== null && previous !== undefined) {
        const snapshot = await previous.getSnapshot();
        const fs = nativeFileSystem();
        const present = await fs.exists(destination);
        const size = present ? await fs.size(destination) : 0;
        if (snapshot?.state === "completed" && (!present || size === 0)) {
          await previous.remove();
        }
      }

      const task = await queue.download({ url, destination });
      if (onProgress !== undefined) {
        task.onProgress = (progress: any) => onProgress(Number(progress?.fractionCompleted ?? 0));
      }
      try {
        await task.waitUntilFinished();
      } finally {
        if (onProgress !== undefined) task.onProgress = undefined;
      }
    },
  };
}

/** 清空这个专用队列的记录；删文件或换镜像源后调用。 */
export async function forgetDdiDownloads(): Promise<void> {
  const manager: any = (globalThis as any).DownloadManager;
  if (manager === undefined) return;
  const queue = await manager.open({ identifier: QUEUE_IDENTIFIER });
  const tasks = await queue.getTasks?.();
  if (!Array.isArray(tasks)) return;
  for (const task of tasks) {
    try {
      await task.remove();
    } catch {
      // 已经结束或被移除的记录不影响下一次下载。
    }
  }
}

/** 删除缓存目录。只删本脚本下载的文件，不动设备上已挂载的镜像。 */
export async function deleteDdiFiles(options: DdiCacheOptions = {}): Promise<void> {
  const fs = options.fs ?? nativeFileSystem();
  const directory = options.directory ?? ddiDirectory(fs);
  if (await fs.exists(directory)) await fs.remove(directory);
}

/** iOS 26.4 起开发者镜像是通过 cryptexd 安装的 Cryptex1。 */
export function supportsCryptexImage(systemVersion: string): boolean {
  const [major, minor] = String(systemVersion ?? "")
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  return Number.isFinite(major) && (major > 26 || (major === 26 && minor >= 4));
}
