import { Script } from "scripting";
import { ensureLoopbackImageFiles } from "../client/loopback";

async function main() {
  const cache = await ensureLoopbackImageFiles();
  console.log(JSON.stringify(cache));
  Script.exit(cache);
}

void main().catch((error) => {
  console.error(String(error));
  Script.exit({ error: String(error) });
});
