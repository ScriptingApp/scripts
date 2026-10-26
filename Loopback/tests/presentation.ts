import { Script } from "scripting";
import { PageCoordinator, isServiceInvocation } from "../kit/presentation";

function assert(value: boolean, name: string) {
  if (!value) throw new Error(name);
  console.log(`PASS ${name}`);
}
function fixture() {
  let paired = false;
  let count = 0;
  let close: () => void = () => {};
  const pages = new PageCoordinator(() => {
    count++;
    return new Promise<void>(resolve => { close = resolve; });
  }, () => paired);
  return { pages, pair() { paired = true; pages.notifyPairingChanged(); }, close() { close(); }, count: () => count };
}
async function main() {
  assert(isServiceInvocation("scriptSessionCall") && isServiceInvocation("scriptSessionRequest") && !isServiceInvocation("other") && !isServiceInvocation("scriptRun"), "initial and resume source classification");
  const f = fixture();
  const first = f.pages.open();
  assert(first === f.pages.open(), "opening and visible presentation deduplicated");
  await Promise.resolve();
  const waiting = f.pages.waitForPairing(1000);
  f.pair();
  assert(await waiting, "pairing save resolves before UI closes");
  assert(f.count() === 1, "pairing reuses visible page");
  f.close(); await first;
  const reopened = f.pages.open(); await Promise.resolve();
  assert(f.count() === 2, "closed page can reopen"); f.close(); await reopened;
  const cancelled = fixture();
  const cancelWait = cancelled.pages.waitForPairing(1000);
  await Promise.resolve(); cancelled.close();
  assert(!(await cancelWait), "close without pairing returns false");
  const timed = fixture();
  assert(!(await timed.pages.waitForPairing(5)), "pairing wait is bounded");
  timed.pair();
  assert(await timed.pages.waitForPairing(5), "later save available to new request");
  timed.close();
  const broken = new PageCoordinator(async () => { throw new Error("present failed"); }, () => false);
  let failed = false;
  try { await broken.waitForPairing(100); } catch { failed = true; }
  assert(failed, "presentation error rejects and cleans wait");
  Script.exit({ passed: 9 });
}
void main().catch(error => { console.error(String(error)); Script.exit({ error: String(error) }); });
