import { Script } from "scripting";
import { fromUtf8, u32le, utf8 } from "../core/bytes";
import { http2DataFrame, parseHttp2Frame, rsdHandshakeFrames } from "../core/http2frames";
import { XpcFileTransfer, XpcUInt64, decodeXpcObject, encodeXpcObject } from "../core/xpc";
import { encodeXmlPlist, type PlistDict } from "../kit/plist";
import { DdiError, ensureDeveloperImage } from "../kit/ddi/install";
import type { DdiLink } from "../kit/ddi/link";
import { cryptexTicketTags, cryptexUdid, readCryptexIdentity, unwrapNonce } from "../kit/ddi/manifest";
import { IMAGE_MOUNTER_SERVICE } from "../kit/ddi/mounter";
import { fetchCryptexTicket } from "../kit/ddi/tss";

let passed = 0;
function assert(value: boolean, name: string) {
  if (!value) throw new Error(name);
  passed++;
  console.log(`PASS ${name}`);
}

const digest = new Uint8Array([1, 2, 3, 4]);
const manifest = {
  BuildIdentities: [
    {
      Info: { Variant: "iOS Customer Developer Disk Image Cryptex" },
      Manifest: {
        "Cryptex1,GenericDmg": { Digest: digest, Info: { Path: "Image.dmg", Personalize: true } },
        "Cryptex1,GenericTrustCache": { Digest: digest, Info: { Path: "Image.dmg.trustcache", Personalize: true } },
        "Cryptex1,CryptexInfoPlist": { Digest: digest, Info: { Path: "Image.dmg.cryptex_info", Personalize: true } },
        "Cryptex1,GenericVolume": { Digest: digest, Info: { Path: "Image.dmg.root_hash", Personalize: true } },
      },
      "Cryptex1,ChipID": "0xFF10",
      "Cryptex1,ProductClass": "0xF2",
      "Cryptex1,NonceDomain": 4,
      "Cryptex1,SubType": 2,
      "Cryptex1,Type": 3,
      "Cryptex1,UseProductClass": true,
      "Cryptex1,Version": "39.999.999.0.0,0",
      "Cryptex1,PreauthorizationVersion": "39.999.999.0.0,0",
    },
  ],
} as unknown as PlistDict;

const chip = {
  img4_chip_chip: 0x8015,
  img4_chip_ecid: 0x1234,
  img4_chip_cpro: true,
} as PlistDict;

async function main() {
  const identity = readCryptexIdentity(manifest);
  assert(identity.nonceDomain === 4n, "manifest nonce domain is parsed");
  assert(identity.payloads.image === "Image.dmg", "manifest image path is parsed");
  assert(identity.payloads.volumehash === "Image.dmg.root_hash", "manifest volume hash path is parsed");
  assert(identity.properties.subType === 2n, "manifest sub type is unsigned");
  assert(
    identity.properties.preauthVersion === "39.999.999.0.0,0",
    "manifest preauthorization version is forwarded",
  );

  const nonce = new Uint8Array(32).fill(7);
  const tags = cryptexTicketTags(identity.identity, chip, nonce);
  assert(tags["@Cryptex1,Ticket"] === true, "ticket request is marked Cryptex1");
  assert(tags["Cryptex1,ChipID"] === 0xff10, "ticket carries chip id");
  assert(tags["Cryptex1,ProductClass"] === 0xf2, "ticket carries product class");
  assert(tags["Cryptex1,ProductionMode"] === true, "ticket carries production mode");
  assert(tags["Cryptex1,Nonce"] === nonce, "ticket carries the nonce");
  assert(tags["Cryptex1,GenericDmg"] !== undefined, "personalized payload digest is included");

  const udidValue = tags["Cryptex1,UDID"];
  assert(udidValue instanceof Uint8Array && udidValue.length === 16, "UDID is 16 bytes");
  const udid = udidValue as Uint8Array;
  assert(udid[6] === 0x80 && udid[7] === 0x15, "UDID starts with the chip id");
  assert(udid[14] === 0x12 && udid[15] === 0x34, "UDID ends with the ECID");

  const expectedUdid = cryptexUdid(chip);
  assert(expectedUdid.length === 16 && expectedUdid[15] === 0x34, "cryptexUdid writes ECID big-endian");

  const wrapped = new Uint8Array(2 + nonce.length + 4);
  wrapped.set([0, 0], 0);
  wrapped.set(nonce, 2);
  wrapped.set(u32le(nonce.length), 2 + nonce.length);
  const unwrapped = unwrapNonce(wrapped);
  assert(unwrapped.length === nonce.length && unwrapped[0] === 7, "nonce header is unwrapped");

  const ticket = new Uint8Array([9, 8, 7]);
  const ticketPlist = fromUtf8(encodeXmlPlist({ "Cryptex1,Ticket": ticket }));
  const fetched = await fetchCryptexTicket(
    {},
    { post: async () => `STATUS=0&MESSAGE=SUCCESS&REQUEST_STRING=${ticketPlist}` },
  );
  assert(fetched.length === 3 && fetched[0] === 9, "TSS ticket is parsed from REQUEST_STRING");

  let refused = false;
  try {
    await fetchCryptexTicket({}, { post: async () => "STATUS=94&MESSAGE=Bad request" });
  } catch {
    refused = true;
  }
  assert(refused, "TSS refusal without a ticket throws");

  const encoded = encodeXpcObject({
    payload: new XpcFileTransfer(3n, { s: new XpcUInt64(5n) }),
  });
  const decoded = decodeXpcObject(encoded) as { payload: XpcFileTransfer };
  assert(decoded.payload instanceof XpcFileTransfer, "XPC file transfer round-trips");
  assert(decoded.payload.msgId === 3n, "XPC file transfer keeps its transfer id");
  const size = decoded.payload.value as { s: unknown };
  const sizeValue = size.s instanceof XpcUInt64 ? size.s.value : Number(size.s);
  assert(sizeValue === 5n || sizeValue === 5, "XPC file transfer keeps its size");

  const dataFrame = http2DataFrame(utf8("hi"), 5);
  const parsed = parseHttp2Frame(dataFrame);
  assert(parsed?.frame.type === "data" && parsed.frame.streamId === 5, "HTTP/2 DATA frame parses");
  const unknown = parseHttp2Frame(new Uint8Array([0, 0, 0, 0x06, 0, 0, 0, 0, 0]));
  assert(unknown?.frame.type === "other", "unknown HTTP/2 frames are skipped");
  const handshake = rsdHandshakeFrames();
  assert(handshake.length === 8, "RemoteXPC handshake has eight frames");
  assert(handshake[0][0] === "P".charCodeAt(0), "handshake starts with the HTTP/2 preface");

  const mounterLink: DdiLink = {
    hasService: (name) => name === IMAGE_MOUNTER_SERVICE,
    withService: async (_name, use) =>
      use({ request: async () => ({ EntryList: [{ DiskImageType: "Personalized" }] }) } as any),
    withRawService: async () => {
      throw new Error("raw service should not be used");
    },
    refreshServices: async () => undefined,
  };
  const mounted = await ensureDeveloperImage(mounterLink, { systemVersion: "18.5" });
  assert(mounted.kind === "already_mounted" && mounted.version === "Personalized", "mounter image short-circuits install");

  const emptyLink: DdiLink = {
    hasService: (name) => name === IMAGE_MOUNTER_SERVICE,
    withService: async (_name, use) => use({ request: async () => ({ EntryList: [] }) } as any),
    withRawService: async () => {
      throw new Error("raw service should not be used");
    },
    refreshServices: async () => undefined,
  };
  let unsupported: unknown = null;
  try {
    await ensureDeveloperImage(emptyLink, { systemVersion: "18.5" });
  } catch (error) {
    unsupported = error;
  }
  assert(
    unsupported instanceof DdiError && unsupported.stage === "check" && /另一套/.test(unsupported.message),
    "old iOS is rejected before download",
  );

  Script.exit({ passed });
}

void main().catch((error) => {
  console.error(String(error));
  Script.exit({ error: String(error) });
});
