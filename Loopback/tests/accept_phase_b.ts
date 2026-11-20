import { Script } from "scripting";
import { ensureLoopbackDeveloperImage } from "../client/loopback";

async function main() {
  const result = await ensureLoopbackDeveloperImage();
  console.log(JSON.stringify(result));
  Script.exit(result);
}

void main().catch((error) => {
  console.error(String(error));
  Script.exit({ error: String(error) });
});
