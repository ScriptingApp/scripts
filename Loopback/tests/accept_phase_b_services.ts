import { Script } from "scripting";

async function main() {
  const tunnel = await VPN.localDevVPN.attachRSDTunnel();
  if (!tunnel) {
    Script.exit({ error: "no ready tunnel" });
    return;
  }
  try {
    const services = await tunnel.listServices({ refresh: true });
    const names = services
      .map((service) => service.name)
      .filter((name) => /instruments|debugserver|dtservicehub|developer/i.test(name));
    console.log(JSON.stringify(names));
    Script.exit({ count: services.length, names });
  } finally {
    await tunnel.close();
  }
}

void main().catch((error) => {
  console.error(String(error));
  Script.exit({ error: String(error) });
});
