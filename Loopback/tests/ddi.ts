import { Script } from "scripting";
import {
  DDI_FILES,
  DEFAULT_DDI_BASE_URL,
  deleteDdiFiles,
  ddiDirectory,
  ddiFileState,
  ddiFileUrl,
  ensureDdiFiles,
  normalizeDdiBaseUrl,
  supportsCryptexImage,
  type DdiDownloader,
  type DdiFileSystem,
} from "../kit/ddi";

let passed = 0;
function assert(value: boolean, name: string) {
  if (!value) throw new Error(name);
  passed++;
  console.log(`PASS ${name}`);
}

class MemoryFileSystem implements DdiFileSystem {
  readonly documentsDirectory = "/documents";
  private readonly files = new Map<string, number>();
  private readonly directories = new Set<string>();

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.directories.has(path);
  }

  async size(path: string): Promise<number> {
    return this.files.get(path) ?? 0;
  }

  async read(path: string): Promise<Uint8Array> {
    return new Uint8Array(this.files.get(path) ?? 0);
  }

  async createDirectory(path: string): Promise<void> {
    this.directories.add(path);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
    this.directories.delete(path);
    for (const file of [...this.files.keys()]) {
      if (file.startsWith(`${path}/`)) this.files.delete(file);
    }
  }

  put(path: string, size: number): void {
    const parent = path.slice(0, path.lastIndexOf("/"));
    if (parent) this.directories.add(parent);
    this.files.set(path, size);
  }
}

function pathOf(fs: MemoryFileSystem, file: string): string {
  return `${ddiDirectory(fs)}/${file}`;
}

async function main() {
  assert(normalizeDdiBaseUrl("") === DEFAULT_DDI_BASE_URL, "empty source falls back to default");
  assert(normalizeDdiBaseUrl("http://example.com") === DEFAULT_DDI_BASE_URL, "non-https source is rejected");
  assert(
    normalizeDdiBaseUrl("https://example.com/ddi///") === "https://example.com/ddi",
    "source trailing slashes are removed",
  );
  assert(
    ddiFileUrl(DDI_FILES[1], "https://example.com/ddi") === "https://example.com/ddi/Image.dmg",
    "file URL is built from the source",
  );

  const empty = new MemoryFileSystem();
  assert(ddiDirectory(empty) === "/documents/Loopback/DDI", "cache lives in an isolated Loopback directory");
  const emptyState = await ddiFileState({ fs: empty });
  assert(
    emptyState.present === 0 && emptyState.total === 5 && emptyState.bytes === 0 && !emptyState.ready,
    "empty cache is reported as not ready",
  );
  assert(emptyState.missing.length === 5, "all five files are missing at first");

  const partial = new MemoryFileSystem();
  partial.put(pathOf(partial, "BuildManifest.plist"), 100);
  partial.put(pathOf(partial, "Image.dmg"), 0);
  const partialState = await ddiFileState({ fs: partial });
  assert(partialState.present === 1 && partialState.bytes === 100, "only non-empty files count as present");
  assert(partialState.missing.includes("Image.dmg"), "zero-byte file is treated as missing");
  assert(partialState.files.length === 5, "per-file state covers all five files");
  assert(
    partialState.files.find((item) => item.file === "BuildManifest.plist")?.size === 100,
    "per-file state reports the manifest size",
  );

  const complete = new MemoryFileSystem();
  for (const item of DDI_FILES) complete.put(pathOf(complete, item.file), 10);
  const completeState = await ddiFileState({ fs: complete });
  assert(completeState.ready && completeState.present === 5 && completeState.bytes === 50, "complete cache is ready");

  const calls: Array<{ url: string; destination: string }> = [];
  const progress: Array<[number, number]> = [];
  const downloader: DdiDownloader = {
    async download(url, destination, onProgress) {
      calls.push({ url, destination });
      onProgress?.(0.5);
    },
  };

  const fresh = new MemoryFileSystem();
  const directory = await ensureDdiFiles(downloader, {
    fs: fresh,
    baseUrl: "https://example.com/ddi",
    onProgress: (index, fraction) => progress.push([index, fraction]),
  });
  assert(directory === ddiDirectory(fresh), "ensure returns the cache directory");
  assert(await fresh.exists(directory), "the cache directory is created");
  assert(calls.length === 5, "all five files are downloaded");
  assert(
    calls[0].url === "https://example.com/ddi/BuildManifest.plist",
    "download uses the configured source",
  );
  assert(progress.length === 5 && progress[0][0] === 0 && progress[0][1] === 0.5, "progress is forwarded");

  const existing = new MemoryFileSystem();
  existing.put(pathOf(existing, "BuildManifest.plist"), 123);
  calls.length = 0;
  await ensureDdiFiles(downloader, { fs: existing, baseUrl: "https://example.com/ddi" });
  assert(calls.length === 4, "existing non-empty files are skipped");
  assert(!calls.some((call) => call.url.endsWith("BuildManifest.plist")), "the manifest is not downloaded twice");

  const zero = new MemoryFileSystem();
  zero.put(pathOf(zero, "Image.dmg"), 0);
  calls.length = 0;
  await ensureDdiFiles(downloader, { fs: zero, baseUrl: "https://example.com/ddi" });
  assert(calls.length === 5, "zero-byte file is downloaded again");
  assert(!(await zero.exists(pathOf(zero, "Image.dmg"))), "zero-byte file is removed before the retry");

  const removable = new MemoryFileSystem();
  for (const item of DDI_FILES) removable.put(pathOf(removable, item.file), 10);
  await deleteDdiFiles({ fs: removable });
  assert(!(await removable.exists(ddiDirectory(removable))), "deleting the cache removes the directory");

  assert(supportsCryptexImage("26.4"), "iOS 26.4 supports cryptex images");
  assert(!supportsCryptexImage("26.3"), "iOS 26.3 does not support cryptex images");
  assert(supportsCryptexImage("27.0"), "newer iOS supports cryptex images");
  assert(!supportsCryptexImage("18.5"), "older iOS is rejected");
  assert(!supportsCryptexImage(""), "unknown version is rejected");

  Script.exit({ passed });
}

void main().catch((error) => {
  console.error(String(error));
  Script.exit({ error: String(error) });
});
