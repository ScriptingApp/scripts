# Loopback

Loopback is a Scripting script for pairing an iOS device and keeping a shared native RSD tunnel ready for other scripts.

The script stores pairing credentials **only in its own Keychain**. It never returns a pairing record, private key, PSK, or pairing file to another script.

## User flow

Run Loopback manually from Scripting or launch it via `Script.run` to open its pairing UI. If a pairing already exists, the same page shows the current record and connection controls. The UI supports PIN pairing and importing/exporting pairing files.

Invocation and pairing behavior:

- A ScriptSession cold start or a service-originated resume does not automatically open the UI.
- Only a user-originated resume reopens the page when needed; an already visible page is reused rather than duplicated.
- Closing the page only dismisses the UI; the script remains alive and keeps serving ScriptSession commands.
- For an already paired device, `ensureTunnel` opens a tunnel directly when needed without opening the UI.
- If no pairing exists, `ensureTunnel` opens or reuses the pairing page and waits up to 120 seconds for the pairing record to be saved successfully before opening the tunnel. Successful pairing does not require closing the page.
- Closing the page while still unpaired returns `not_paired` to the waiting `ensureTunnel` call.
- After pairing, close the page if desired. Other scripts can call `ensureTunnel` and then attach their own RSD tunnel handle.
- `status` and `releaseTunnel` never open the UI.

The UI chooses Simplified Chinese when `Device.systemLocale` starts with `zh`; all other locales fall back to English.

## VPN preparation

Choose a tunnel source in Connection Settings:

- **Scripting**: before creating a new device session, Loopback checks LocalDevVPN, enables it if needed, starts Scripting's VPN when disconnected, and waits up to 30 seconds for LocalDevVPN readiness. First use may require VPN permission. Starting Scripting's VPN may replace an external VPN.
- **External VPN**: Loopback does not start, stop, or reconfigure Scripting's VPN. Configure local reflection in your external VPN tool yourself.

Existing live sessions and ready RSD tunnels are reused without changing VPN settings. New pairing verification also goes through VPN preparation before connecting. Closing the UI or releasing Loopback's RSD handle never stops the VPN. The VPN state API reports Scripting's VPN, not arbitrary third-party VPNs. A preparation timeout does not undo a native operation already accepted.

## Public ScriptSession service

Loopback registers one serial public service with `ScriptSession.serve`. Commands are JSON-only:

| Command | Result | UI |
| --- | --- | --- |
| `status` | `paired`, `tunnel_open`, or `not_paired` | Never opens UI |
| `ensureTunnel` | Ensures Loopback's own tunnel handle is ready; if unpaired, waits up to 120 seconds for a successfully saved pairing record before opening the tunnel; closing the page while unpaired returns `not_paired` | If unpaired, opens or reuses the pairing page; success does not require closing it. If paired, never opens UI |
| `releaseTunnel` | Releases Loopback's own handle | Never opens UI |
| `developerImageStatus` | Returns the developer-image cache state; no device connection | Never opens UI |
| `downloadDeveloperImage` | Starts or reuses a background download and returns immediately; poll `developerImageStatus` for progress | Never opens UI |
| `ensureDeveloperImage` | Downloads when needed and installs the image; returns `not_paired` when not paired | Never opens UI |

The recommended total client timeout is `180000` ms to allow for pairing and tunnel preparation. The service processes commands serially, so concurrent calls also queue; a client timeout does not cancel work already accepted by Loopback.

### Build compatibility

`VPN`, `VPN.localDevVPN`, and `VPNRSDTunnel` are VPN-family APIs that some builds (App Store, older versions) do not ship. Loopback probes before acting; when they are missing it connects to nothing, never opens the pairing page, and answers the affected commands with "this build is not supported":

```json
{
  "status": "unsupported",
  "supported": false,
  "ready": false,
  "missing": ["VPN.localDevVPN.openRSDTunnel"],
  "message": "This Scripting build does not provide the developer-channel APIs (missing VPN.localDevVPN.openRSDTunnel)..."
}
```

- Affected commands: `status`, `ensureTunnel`, `releaseTunnel`, `ensureDeveloperImage` (the last one also carries `stage: "api"` and the current `cache`).
- `developerImageStatus` / `downloadDeveloperImage` are unaffected: they only use HTTPS and the filesystem, so cache download and deletion still work.
- A build that only lacks `cancelRSDTunnelOpening` still counts as supported; the connection is opened and only the cancel step is skipped.
- Clients can ask first with `loopbackSupport()` from `client/loopback.ts`; `attachLoopbackTunnel()` returns `null` on such builds instead of throwing `ReferenceError`.

Example client:

```ts
// Script B: no import is needed for ScriptSession, VPN, or DeviceServices.
async function main() {
  const state = await ScriptSession.call<{
    status: "paired" | "tunnel_open" | "not_paired" | "unsupported" | "error";
    ready?: boolean;
    supported?: boolean;
    missing?: string[];
    message?: string;
  }>({
    name: "Loopback",
    message: { command: "ensureTunnel" },
    timeout: 180000,
  });

  // This build has no VPN / RSD APIs: show what Loopback returned and stop.
  if (state.status === "unsupported") {
    console.log(state.message, state.missing);
    return;
  }

  if (state.status !== "tunnel_open" || state.ready !== true) {
    throw new Error(state.message ?? `Loopback is not ready: ${state.status}`);
  }

  // The reply is only an acknowledgement. B owns a separate native handle.
  const tunnel = await VPN.localDevVPN.attachRSDTunnel();
  if (!tunnel) throw new Error("The tunnel is no longer ready");

  try {
    const services = await tunnel.listServices({ refresh: true });
    const name = "com.apple.mobile.diagnostics_relay.shim.remote";
    if (!services.some(service => service.name === name)) {
      throw new Error(`Service not found: ${name}`);
    }

    const session = await DeviceServices.openRSDSession(tunnel);
    try {
      const service = await session.openService({ serviceName: name });
      try {
        await service.connection.writePlist({
          Request: "IORegistry",
          EntryClass: "IOPMPowerSource",
        });
        const response = await service.connection.readPlist({ timeout: 30000 });
        if (response === null) throw new Error("The device closed the service");
        console.log(response);
      } finally {
        await service.close();
      }
    } finally {
      await session.close();
    }
  } finally {
    // B releases only B's handle. Do not call releaseTunnel here.
    await tunnel.close();
  }
}

void main().catch(console.error);
```

A reusable client wrapper is available at `client/loopback.ts`:

```ts
import {
  attachLoopbackTunnel,
  loopbackStatus,
  openLoopback,
} from "./kit/loopback";

let state = await loopbackStatus();
if (state.status !== "tunnel_open") state = await openLoopback();
if (state.status !== "tunnel_open") throw new Error(state.message ?? state.status);

const tunnel = await attachLoopbackTunnel();
if (!tunnel) throw new Error("Loopback tunnel unavailable");
```

## Developer image (cache, download and install)

Loopback manages the five developer-image files (BuildManifest, Image.dmg, trustcache, cryptex_info, root_hash) and installs them when needed. The entry is **Developer Image** on the home page:

- Files are cached in `Loopback/DDI` under the app Documents directory, isolated from SideInstaller's `Documents/DDI`; downloads use a DownloadManager background queue.
- The page shows `n/5`, total size and download progress. Deleting cached files does not unmount an image already installed on the device.
- The default source matches SideInstaller. The page can override it with any `https://` mirror; changing it clears old download records but keeps downloaded files.
- Downloads do not use cellular data by default.
- **Installation requires iOS 26.4+**. If files are missing, `ensureDeveloperImage` downloads them automatically, checks whether an image is already installed/mounted, reads device identifiers, requests the Apple ticket, installs, verifies, and refreshes the RSD service table. The image stays until the device restarts.

When another script needs the image, call the automatic entry instead of asking the user to tap a button:

```ts
import { ensureLoopbackImageFiles, ensureLoopbackDeveloperImage } from "./kit/loopback";

// Prepare only the cache: missing files are downloaded and polled automatically.
const cache = await ensureLoopbackImageFiles();

// Check and install: missing files are downloaded automatically too; use timeout 300000.
const image = await ensureLoopbackDeveloperImage();
if (!image.ready) throw new Error(image.message ?? image.status);
```

`ensureDeveloperImage` occupies Loopback's serial service while it runs; other commands queue. After success, callers should still call `tunnel.listServices({ refresh: true })` themselves. Use `developerImageStatus` / `downloadDeveloperImage` separately only for progress or background prefetching.

When per-script permissions are enabled, allow `fileSystem`; the compatibility check, download/delete and install actions request it.

Note: if Loopback was started by `Script.run({ singleMode: true })` or another script under “run without permissions”, that instance may still be unable to access files. Open Loopback manually from Scripting and allow `fileSystem` in the script permissions. This is a one-time grant; later automatic calls download without prompting.

## Ownership and cleanup

Loopback owns the handle it creates or attaches. A client script owns the handle returned by `attachRSDTunnel()`.

- B closes its service with `service.close()`.
- B closes its `RSDSession` with `session.close()`.
- B closes its own tunnel handle with `tunnel.close()`.
- B must not call Loopback's `releaseTunnel` during normal cleanup.
- Call `releaseTunnel` only when you explicitly want Loopback to release its own handle.
- Closing one handle does not close other scripts' handles.
- The last native handle is reclaimed after its connections are closed.

`ScriptSession.call` timeouts do not roll back work already accepted by Loopback. `ScriptSession.serve` is serial, so concurrent `ensureTunnel` requests are queued and reuse the same ready handle.

## Security boundary

Pairing records contain private credentials. They remain in Loopback's Keychain and are used only by Loopback's pairing/tunnel implementation. Client scripts receive status only and use native attach; they never need pairing data.

The shared Storage domain may contain non-secret connection settings and an informational tunnel-holder marker, but it must not contain pairing credentials.

## Files

- `index.tsx`: UI entry and ScriptSession service.
- `core/i18n.ts`: locale selection and bilingual helper.
- `client/loopback.ts`: client-side ScriptSession and attach wrapper.
- `core/pairing.ts`: Keychain-only pairing storage and import/export.
- `kit/session.ts`: pairing, tunnel creation, and native RSD service discovery.
- `kit/hub.ts`: the single Loopback-owned session.
- `kit/ddi/cache.ts`: developer-image file list, cache detection, download queue and source URL.
- `kit/ddi/install.ts`: check/download/ticket/install/verify orchestration.
- `kit/ddi/manifest.ts`, `tss.ts`, `cryptexd.ts`, `mounter.ts`: image protocol implementation.
- `kit/remoteXpc.ts`, `core/http2frames.ts`: service-port RemoteXPC and flow control.
- `kit/developerImage.ts`: cache/install state machine shared by the page and service commands.
- `pages/`: pairing, compatibility, settings, developer image, and shared UI.

See [README-zh.md](README-zh.md) for the Chinese version.
