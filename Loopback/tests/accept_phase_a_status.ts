import { Script } from "scripting";

async function main() {
  const status = await ScriptSession.call<{
    status: string;
    cache: {
      present: number;
      total: number;
      bytes: number;
      ready: boolean;
      busy: boolean;
      failure: string;
      baseUrl: string;
    };
  }>({
    name: "Loopback",
    message: { command: "developerImageStatus" },
    timeout: 15000,
  });
  console.log(JSON.stringify(status));
  Script.exit(status);
}

void main().catch((error) => {
  console.error(String(error));
  Script.exit({ error: String(error) });
});
