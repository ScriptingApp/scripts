import { Script } from "scripting";

type Cache = {
  present: number;
  total: number;
  bytes: number;
  ready: boolean;
  busy: boolean;
  failure: string;
  progress: number | null;
  files: Array<{ file: string; size: number; present: boolean }>;
};

type StatusResult = { status: string; cache: Cache };
type DownloadResult = { status: string; cache: Cache };

function status(timeout: number): Promise<StatusResult> {
  return ScriptSession.call<StatusResult>({ name: "Loopback", message: { command: "developerImageStatus" }, timeout });
}

function download(timeout: number): Promise<DownloadResult> {
  return ScriptSession.call<DownloadResult>({ name: "Loopback", message: { command: "downloadDeveloperImage" }, timeout });
}

async function main() {
  let state = (await status(15000)).cache;
  console.log(`start ${state.present}/${state.total} ${state.bytes}`);

  if (!state.ready && !state.busy) {
    const started = await download(15000);
    console.log(`download ${started.status}`);
    state = started.cache;
  }

  let last = state;
  for (let index = 0; index < 150; index++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 2000, undefined));
    const snapshot = await status(15000);
    last = snapshot.cache;
    if (index % 5 === 0 || last.ready || last.failure) {
      console.log(
        `${index} ${last.present}/${last.total} bytes=${last.bytes} progress=${last.progress ?? "-"} busy=${last.busy} failure=${last.failure}`,
      );
    }
    if (last.ready) {
      Script.exit({ status: "ready", cache: last });
      return;
    }
    if (!last.busy && last.failure) {
      Script.exit({ status: "failed", cache: last });
      return;
    }
  }

  Script.exit({ status: "timeout", cache: last });
}

void main().catch((error) => {
  console.error(String(error));
  Script.exit({ error: String(error) });
});
