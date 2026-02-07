import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { CloudflareAdapter } from "elysia/adapter/cloudflare-worker";
import aesjs from "aes-js";

interface MegaStreamData {
  encryptedUrl: string;
  aesKey: Uint8Array;
  nonce: Uint8Array;
  cryptoKey: CryptoKey;
  fileName: string;
  fileSize: number;
}

interface CachedMegaData {
  encryptedUrl: string;
  aesKey: number[];
  nonce: number[];
  fileName: string;
  fileSize: number;
}

export default new Elysia({
  adapter: CloudflareAdapter,
})
  .use(cors())

  .get("/", () => ({
    message: "Mega Video Stream API (FINAL FIXED)",
  }))

  .get("/api/info", async ({ query, request }) => {
    const megaUrl = query.url;
    if (!megaUrl) return { error: "Missing url" };

    const info = await getMegaInfoCached(megaUrl, request);

    return {
      fileName: info.fileName,
      fileSize: info.fileSize,
      streamUrl: `${new URL(request.url).origin}/stream?url=${encodeURIComponent(
        megaUrl,
      )}`,
    };
  })

  .get("/stream", async ({ query, request, set }) => {
    const megaUrl = query.url;
    if (!megaUrl) {
      set.status = 400;
      return { error: "Missing url" };
    }

    const info = await getMegaInfoCached(megaUrl, request);

    const range = request.headers.get("Range");
    let start = 0;
    let end = info.fileSize - 1;

    if (range) {
      const [s, e] = range.replace("bytes=", "").split("-");
      start = parseInt(s, 10);
      if (e) end = parseInt(e, 10);
    } else {
      end = Math.min(end, 256 * 1024);
    }

    const alignedStart = Math.floor(start / 16) * 16;
    const offset = start - alignedStart;

    const res = await fetch(info.encryptedUrl, {
      headers: { Range: `bytes=${alignedStart}-${end}` },
    });

    if (!res.body) throw new Error("No response body");

    let blockIndex = BigInt(alignedStart / 16);
    let first = true;
    let buffer = new Uint8Array(0);

    const transformer = new TransformStream<Uint8Array, Uint8Array>({
      async transform(chunk, controller) {
        const tmp = new Uint8Array(buffer.length + chunk.length);
        tmp.set(buffer);
        tmp.set(chunk, buffer.length);
        buffer = tmp;

        const size = Math.floor(buffer.length / 16) * 16;
        if (!size) return;

        const toDecrypt = buffer.slice(0, size);
        buffer = buffer.slice(size);

        const counter = new Uint8Array(16);
        counter.set(info.nonce);
        new DataView(counter.buffer).setBigUint64(8, blockIndex, false);

        const decrypted = new Uint8Array(
          await crypto.subtle.decrypt(
            { name: "AES-CTR", counter, length: 64 },
            info.cryptoKey,
            toDecrypt,
          ),
        );

        controller.enqueue(
          first && offset ? decrypted.slice(offset) : decrypted,
        );

        first = false;
        blockIndex += BigInt(size / 16);
      },
    });

    set.headers = {
      "Content-Type": "video/mp4",
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=3600",
      "Content-Disposition": `inline; filename="${info.fileName}"`,
    };

    if (range) {
      set.status = 206;
      set.headers["Content-Range"] = `bytes ${start}-${end}/${info.fileSize}`;
      set.headers["Content-Length"] = String(end - start + 1);
    } else {
      set.headers["Content-Length"] = String(info.fileSize);
    }

    return new Response(res.body.pipeThrough(transformer), {
      status: set.status,
      headers: set.headers,
    });
  })

  .compile();

/* ================= HELPERS ================= */

function safeDecodeMegaUrl(input: string): string {
  try {
    const decoded = atob(input);
    if (decoded.includes("mega.nz")) return decoded;
  } catch {}
  return decodeURIComponent(input);
}

async function getMegaInfoCached(
  megaUrl: string,
  request: Request,
): Promise<MegaStreamData> {
  const cache = caches.default;
  const cacheKey = new Request(
    `${new URL(request.url).origin}/__mega__?u=${encodeURIComponent(megaUrl)}`,
  );

  const cached = await cache.match(cacheKey);
  if (cached) {
    const data = (await cached.json()) as CachedMegaData;

    const aesKey = new Uint8Array(data.aesKey);
    const nonce = new Uint8Array(data.nonce);

    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      aesKey.buffer,
      { name: "AES-CTR" },
      false,
      ["decrypt"],
    );

    return {
      encryptedUrl: data.encryptedUrl,
      aesKey,
      nonce,
      cryptoKey,
      fileName: data.fileName,
      fileSize: data.fileSize,
    };
  }

  const info = await getMegaInfo(megaUrl);

  const toCache: CachedMegaData = {
    encryptedUrl: info.encryptedUrl,
    aesKey: Array.from(info.aesKey),
    nonce: Array.from(info.nonce),
    fileName: info.fileName,
    fileSize: info.fileSize,
  };

  await cache.put(
    cacheKey,
    new Response(JSON.stringify(toCache), {
      headers: { "Cache-Control": "public, max-age=900" },
    }),
  );

  return info;
}

async function getMegaInfo(megaUrl: string): Promise<MegaStreamData> {
  const decodedUrl = safeDecodeMegaUrl(megaUrl);

  const match = decodedUrl.match(
    /mega\.nz\/(?:file\/|#!)([^#!]+)[#!]([^?]+)/,
  );
  if (!match) throw new Error("Invalid Mega URL");

  const [, handle, key] = match;

  const res = await fetch("https://g.api.mega.co.nz/cs?id=0", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([{ a: "g", g: 1, p: handle }]),
  });

  const data = await res.json();
  if (!data[0]) throw new Error("File not found");

  const nodeKey = base64UrlToUint8Array(key);
  const { aesKey, nonce } = unpackNodeKey(nodeKey);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    aesKey.buffer,
    { name: "AES-CTR" },
    false,
    ["decrypt"],
  );

  return {
    encryptedUrl: data[0].g,
    aesKey,
    nonce,
    cryptoKey,
    fileName: decryptAttributes(data[0].at, aesKey),
    fileSize: data[0].s,
  };
}

function base64UrlToUint8Array(str: string): Uint8Array {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}

function unpackNodeKey(nodeKey: Uint8Array) {
  const view = new DataView(nodeKey.buffer);
  const aesKey = new Uint8Array(16);

  for (let i = 0; i < 4; i++) {
    const n1 = view.getUint32(i * 4, false);
    const n2 = view.getUint32(i * 4 + 16, false);
    new DataView(aesKey.buffer).setUint32(i * 4, n1 ^ n2, false);
  }

  return { aesKey, nonce: nodeKey.slice(16, 24) };
}

function decryptAttributes(at: string, key: Uint8Array): string {
  const aes = new aesjs.ModeOfOperation.cbc(key, new Uint8Array(16));
  const decrypted = aes.decrypt(base64UrlToUint8Array(at));
  const json = new TextDecoder().decode(decrypted).replace(/\0+$/, "");
  return JSON.parse(json.slice(4)).n ?? "video.mp4";
}
