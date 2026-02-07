import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { CloudflareAdapter } from "elysia/adapter/cloudflare-worker";
import aesjs from "aes-js";

interface MegaStreamData {
  encryptedUrl: string;
  aesKey: Uint8Array;
  nonce: Uint8Array;
  fileName: string;
  fileSize: number;
}

interface CachedMegaInfo {
  data: MegaStreamData;
  timestamp: number;
}

// Cache for Mega API responses (5 min TTL)
const CACHE_TTL = 5 * 60 * 1000;
const megaCache = new Map<string, CachedMegaInfo>();

// Request timeouts
const MEGA_API_TIMEOUT = 8000; // 8 seconds for Mega API
const STREAM_TIMEOUT = 25000; // 25 seconds for streaming (CF Worker limit is 30s on free tier)

export default new Elysia({
  adapter: CloudflareAdapter,
})
  .use(cors())
  .get("/", () => ({
    message: "Mega Video Stream API (Optimized CF Worker)",
    endpoints: {
      info: "/api/info?url=<mega_url>",
      stream: "/stream?url=<mega_url>",
    },
    version: "2.0-optimized",
  }))
  .get("/api/info", async ({ query, request }) => {
    const { url: megaUrl } = query;

    if (!megaUrl) {
      return { error: "Missing url parameter" };
    }

    try {
      const info = await getMegaDownloadInfoCached(megaUrl);
      const baseUrl = new URL(request.url).origin;

      return {
        fileName: info.fileName,
        fileSize: info.fileSize,
        streamUrl: `${baseUrl}/stream?url=${encodeURIComponent(megaUrl)}`,
      };
    } catch (e) {
      console.error("Info error:", e);
      return { 
        error: (e as Error).message,
        hint: "Try again in a few seconds. If the problem persists, the file may be deleted or the URL invalid."
      };
    }
  })
  .get("/stream", async ({ query, request, set }) => {
    const { url: megaUrl } = query;

    if (!megaUrl) {
      set.status = 400;
      return { error: "Missing url parameter" };
    }

    try {
      // Get file info with caching
      const info = await getMegaDownloadInfoCached(megaUrl);

      // Handle Range Requests
      const range = request.headers.get("Range");
      let startByte = 0;
      let endByte = info.fileSize - 1;

      if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        startByte = parseInt(parts[0] as string, 10);
        endByte = parts[1] ? parseInt(parts[1], 10) : endByte;
      }

      // Validate range
      if (startByte >= info.fileSize || endByte >= info.fileSize || startByte > endByte) {
        set.status = 416; // Range Not Satisfiable
        return { error: "Invalid range" };
      }

      // Limit chunk size to prevent memory issues (max 10MB per request)
      const MAX_CHUNK_SIZE = 10 * 1024 * 1024;
      if (endByte - startByte + 1 > MAX_CHUNK_SIZE) {
        endByte = startByte + MAX_CHUNK_SIZE - 1;
      }

      // Align to AES block size (16 bytes)
      const blockAlignedStart = Math.floor(startByte / 16) * 16;
      const intraBlockOffset = startByte - blockAlignedStart;

      // Fetch encrypted data with timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), STREAM_TIMEOUT);

      try {
        const encryptedResponse = await fetch(info.encryptedUrl, {
          headers: { "Range": `bytes=${blockAlignedStart}-${endByte}` },
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!encryptedResponse.ok) {
          throw new Error(`Mega server error: ${encryptedResponse.status}`);
        }

        if (!encryptedResponse.body) {
          throw new Error("No response body from Mega");
        }

        // Prepare Web Crypto Key for CTR (Streaming)
        const cryptoKey = await crypto.subtle.importKey(
          "raw",
          info.aesKey,
          { name: "AES-CTR" },
          false,
          ["decrypt"]
        );

        // Optimized Transform Stream (Decrypt on the fly)
        let currentBlockIndex = BigInt(blockAlignedStart / 16);
        let isFirstChunk = true;
        let buffer = new Uint8Array(0);

        const transformer = new TransformStream({
          async transform(chunk, controller) {
            try {
              // Combine buffers efficiently
              const newBuffer = new Uint8Array(buffer.length + chunk.length);
              newBuffer.set(buffer);
              newBuffer.set(chunk, buffer.length);
              buffer = newBuffer;

              // Process in 16-byte blocks
              const processableLength = Math.floor(buffer.length / 16) * 16;

              if (processableLength > 0) {
                const toDecrypt = buffer.slice(0, processableLength);
                buffer = buffer.slice(processableLength);

                // Create counter block
                const counterBlock = new Uint8Array(16);
                counterBlock.set(info.nonce, 0);
                const view = new DataView(counterBlock.buffer);
                view.setBigUint64(8, currentBlockIndex, false);

                // Decrypt chunk
                const decryptedBuffer = await crypto.subtle.decrypt(
                  {
                    name: "AES-CTR",
                    counter: counterBlock,
                    length: 64,
                  },
                  cryptoKey,
                  toDecrypt
                );

                let decrypted = new Uint8Array(decryptedBuffer);

                // Handle first chunk offset
                if (isFirstChunk && intraBlockOffset > 0) {
                  decrypted = decrypted.slice(intraBlockOffset);
                  isFirstChunk = false;
                }

                controller.enqueue(decrypted);
                currentBlockIndex += BigInt(processableLength / 16);
              }
            } catch (err) {
              console.error("Transform error:", err);
              controller.error(err);
            }
          },
          async flush(controller) {
            try {
              // Process any remaining bytes
              if (buffer.length > 0) {
                const counterBlock = new Uint8Array(16);
                counterBlock.set(info.nonce, 0);
                const view = new DataView(counterBlock.buffer);
                view.setBigUint64(8, currentBlockIndex, false);

                const decryptedBuffer = await crypto.subtle.decrypt(
                  {
                    name: "AES-CTR",
                    counter: counterBlock,
                    length: 64,
                  },
                  cryptoKey,
                  buffer
                );

                let decrypted = new Uint8Array(decryptedBuffer);

                if (isFirstChunk && intraBlockOffset > 0) {
                  decrypted = decrypted.slice(intraBlockOffset);
                }

                controller.enqueue(decrypted);
              }
            } catch (err) {
              console.error("Flush error:", err);
              controller.error(err);
            }
          },
        });

        // Set headers
        set.headers["Content-Type"] = "video/mp4";
        set.headers["Accept-Ranges"] = "bytes";
        set.headers["Cache-Control"] = "public, max-age=3600";
        set.headers["Connection"] = "keep-alive";

        if (range) {
          set.status = 206;
          set.headers["Content-Range"] = `bytes ${startByte}-${endByte}/${info.fileSize}`;
          set.headers["Content-Length"] = String(endByte - startByte + 1);
        } else {
          set.headers["Content-Length"] = String(info.fileSize);
        }

        return new Response(encryptedResponse.body.pipeThrough(transformer), {
          // @ts-expect-error - Elysia typing issue
          headers: set.headers,
          // @ts-expect-error - Elysia typing issue
          status: set.status,
        });
      } catch (fetchError) {
        clearTimeout(timeoutId);
        
        if ((fetchError as Error).name === 'AbortError') {
          throw new Error("Request timeout - file may be too large or connection is slow");
        }
        throw fetchError;
      }
    } catch (e) {
      console.error("Stream error:", e);
      set.status = 503;
      return { 
        error: (e as Error).message,
        hint: "Service temporarily unavailable. Please try again.",
        retryAfter: 5
      };
    }
  })
  .compile();

// Cached version of getMegaDownloadInfo
async function getMegaDownloadInfoCached(megaUrl: string): Promise<MegaStreamData> {
  // Check cache first
  const cached = megaCache.get(megaUrl);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  // Fetch fresh data
  const data = await getMegaDownloadInfo(megaUrl);
  
  // Store in cache
  megaCache.set(megaUrl, {
    data,
    timestamp: Date.now(),
  });

  // Cleanup old cache entries (keep cache size manageable)
  if (megaCache.size > 100) {
    const entries = Array.from(megaCache.entries());
    entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
    megaCache.delete(entries[0][0]);
  }

  return data;
}

async function getMegaDownloadInfo(megaUrl: string): Promise<MegaStreamData> {
  try {
    const decodedUrl = decodeURIComponent(atob(megaUrl));
    const match = decodedUrl.match(/mega\.nz\/(?:file\/|#!)([^#!]+)[#!](.+)/);
    
    if (!match) {
      throw new Error("Invalid Mega URL format");
    }

    const [, handle, key] = match;

    if (!handle || !key) {
      throw new Error("Missing handle or key in URL");
    }

    // Add timeout to Mega API request
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), MEGA_API_TIMEOUT);

    try {
      const response = await fetch("https://g.api.mega.co.nz/cs?id=0", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([{ a: "g", g: 1, ssl: 0, p: handle }]),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Mega API error: ${response.status}`);
      }

      const data = (await response.json()) as Array<{
        at: string;
        g: string;
        s: number;
      }>;

      if (!data[0]) {
        throw new Error("File not found or has been deleted");
      }

      const megaData = data[0];

      if (!megaData.g || !megaData.at || !megaData.s) {
        throw new Error("Invalid response from Mega API");
      }

      const nodeKey = base64UrlToUint8Array(key);
      const { aesKey, nonce } = unpackNodeKey(nodeKey);

      const fileName = decryptAttributes(megaData.at, aesKey);

      return {
        encryptedUrl: megaData.g,
        aesKey,
        nonce,
        fileName,
        fileSize: megaData.s,
      };
    } catch (fetchError) {
      clearTimeout(timeoutId);
      
      if ((fetchError as Error).name === 'AbortError') {
        throw new Error("Mega API timeout - service may be slow or unavailable");
      }
      throw fetchError;
    }
  } catch (e) {
    throw new Error(`Failed to get Mega info: ${(e as Error).message}`);
  }
}

function base64UrlToUint8Array(str: string): Uint8Array {
  try {
    const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(
      base64.length + ((4 - (base64.length % 4)) % 4),
      "="
    );
    const binaryString = atob(padded);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  } catch (e) {
    throw new Error("Invalid base64 encoding in URL");
  }
}

function unpackNodeKey(nodeKey: Uint8Array) {
  if (nodeKey.length < 32) {
    throw new Error("Invalid node key length");
  }

  const view = new DataView(nodeKey.buffer);
  const aesKey = new Uint8Array(16);
  const aesView = new DataView(aesKey.buffer);

  for (let i = 0; i < 4; i++) {
    const offset = i * 4;
    const n1 = view.getUint32(offset, false);
    const n2 = view.getUint32(offset + 16, false);
    aesView.setUint32(offset, n1 ^ n2, false);
  }

  const nonce = nodeKey.slice(16, 24);
  return { aesKey, nonce };
}

function decryptAttributes(encryptedAttrs: string, key: Uint8Array): string {
  try {
    const ciphertext = base64UrlToUint8Array(encryptedAttrs);
    const iv = new Uint8Array(16).fill(0);

    // @ts-ignore - aes-js types might mismatch
    const aesCbc = new aesjs.ModeOfOperation.cbc(key, iv);
    const decryptedBytes = aesCbc.decrypt(ciphertext);

    // Remove padding
    let end = decryptedBytes.length;
    while (end > 0 && decryptedBytes[end - 1] === 0) {
      end--;
    }

    const jsonStr = new TextDecoder().decode(decryptedBytes.slice(0, end));
    const json = JSON.parse(jsonStr.substring(4));
    
    return json.n || "download.mp4";
  } catch (e) {
    throw new Error("Failed to decrypt file attributes");
  }
}