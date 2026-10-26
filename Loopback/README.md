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

The recommended total client timeout is `180000` ms to allow for pairing and tunnel preparation. The service processes commands serially, so concurrent calls also queue; a client timeout does not cancel work already accepted by Loopback.

Example client:

```ts
// Script B: no import is needed for ScriptSession, VPN, or DeviceServices.
async function main() {
  const state = await ScriptSession.call<{
    status: "paired" | "tunnel_open" | "not_paired" | "error";
    ready?: boolean;
    message?: string;
  }>({
    name: "Loopback",
    message: { command: "ensureTunnel" },
    timeout: 180000,
  });

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
- `pages/`: pairing, compatibility, settings, and shared UI.

See [README-zh.md](README-zh.md) for the Chinese version.
