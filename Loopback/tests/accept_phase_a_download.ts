import { Script } from "scripting";

async function main() {
  const result = await ScriptSession.call<{
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
    message: { command: "downloadDeveloperImage" },
    timeout: 15000,
  });
  console.log(JSON.stringify(result));
  Script.exit(result);
}

void main().catch((error) => {
  console.error(String(error));
  Script.exit({ error: String(error) });
});
