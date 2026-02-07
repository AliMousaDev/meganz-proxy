import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { CloudflareAdapter } from "elysia/adapter/cloudflare-worker";

interface MegaStreamData {
  encryptedUrl: string;
  aesKey: Buffer;
  nonce: Buffer;
  fileName: string;
  fileSize: number;
}

interface CacheEntry {
  data: MegaStreamData;
  timestamp: number;
}

// Simple in-memory cache (expires after 1 hour)
const infoCache = new Map<string, CacheEntry>();
const CACHE_TTL = 3600000; // 1 hour in ms

export default new Elysia({
  adapter: CloudflareAdapter,
})
  .use(cors())
  .get("/", () => ({
    message: "Mega Video Stream API - Enhanced Version",
    version: "2.0",
    endpoints: {
      info: "/api/info?url=<base64_mega_url>",
      stream: "/stream?url=<base64_mega_url>",
      health: "/health",
    },
    features: [
      "Range requests support",
      "Auto-retry on failures",
      "Block-aligned decryption",
      "Response caching",
      "Optimized streaming"
    ]
  }))
  
  // Health check endpoint
  .get("/health", () => ({
    status: "ok",
    timestamp: new Date().toISOString(),
    cache_size: infoCache.size
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
        success: true,
        fileName: info.fileName,
        fileSize: info.fileSize,
        fileSizeMB: (info.fileSize / (1024 * 1024)).toFixed(2),
        streamUrl: `${baseUrl}/stream?url=${encodeURIComponent(megaUrl)}`,
      };
    } catch (error) {
      console.error("Error in /api/info:", error);
      return { 
        error: "Failed to fetch file info",
        details: error instanceof Error ? error.message : "Unknown error"
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
      const info = await getMegaDownloadInfoCached(megaUrl);
      const range = request.headers.get("Range");
      let startByte = 0;
      let endByte = info.fileSize - 1;

      if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        startByte = parseInt(parts[0] as string, 10);
        endByte = parts[1] ? parseInt(parts[1], 10) : endByte;
      }

      // ⭐ Align to AES block boundaries (16 bytes)
      const alignedStart = Math.floor(startByte / 16) * 16;
      const intraBlockOffset = startByte - alignedStart;

      // Setup decryption
      const crypto = await import("node:crypto");
      const blockOffset = Math.floor(alignedStart / 16);
      const counter = Buffer.alloc(16);
      info.nonce.copy(counter, 0);
      counter.writeBigUInt64BE(BigInt(blockOffset), 8);

      const decipher = crypto.createDecipheriv(
        "aes-128-ctr",
        info.aesKey,
        counter,
      );

      // ⭐ Enhanced streaming with retry logic and chunking
      const readable = new ReadableStream({
        async start(controller) {
          let retryCount = 0;
          const MAX_RETRIES = 3;
          const CHUNK_SIZE = 1024 * 1024; // 1MB chunks
          let currentPosition = alignedStart;
          let totalBytesRead = 0;

          while (currentPosition <= endByte) {
            try {
              // Calculate chunk end
              const chunkEnd = Math.min(currentPosition + CHUNK_SIZE - 1, endByte);
              
              const headers: Record<string, string> = {
                "Range": `bytes=${currentPosition}-${chunkEnd}`
              };

              // ⭐ Fetch with timeout
              const encryptedResponse = await fetch(info.encryptedUrl, { 
                headers,
                signal: AbortSignal.timeout(30000) // 30 second timeout
              });

              if (!encryptedResponse.ok) {
                throw new Error(`Fetch failed with status: ${encryptedResponse.status}`);
              }

              if (!encryptedResponse.body) {
                throw new Error("Response body is null");
              }

              const reader = encryptedResponse.body.getReader();
              let isFirstChunkOfRequest = true;

              // Read stream
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                let decrypted = decipher.update(value);

                // ⭐ Handle intra-block offset only on very first chunk
                if (totalBytesRead === 0 && intraBlockOffset > 0) {
                  decrypted = decrypted.subarray(intraBlockOffset);
                }

                controller.enqueue(decrypted);
                currentPosition += value.length;
                totalBytesRead += decrypted.length;
              }

              // Reset retry count on successful chunk
              retryCount = 0;

            } catch (error) {
              console.error(`Stream error at position ${currentPosition}:`, error);
              retryCount++;
              
              if (retryCount >= MAX_RETRIES) {
                console.error("Max retries reached, aborting stream");
                controller.error(error);
                return;
              }

              // ⭐ Exponential backoff
              const backoffTime = Math.min(1000 * Math.pow(2, retryCount - 1), 5000);
              console.log(`Retrying in ${backoffTime}ms... (attempt ${retryCount}/${MAX_RETRIES})`);
              await new Promise(r => setTimeout(r, backoffTime));
            }
          }
          
          controller.close();
        },
      });

      // ⭐ Enhanced response headers
      set.headers["Content-Type"] = "video/mp4";
      set.headers["Accept-Ranges"] = "bytes";
      set.headers["Cache-Control"] = "public, max-age=3600";
      set.headers["X-Content-Type-Options"] = "nosniff";

      if (range) {
        set.status = 206; // Partial Content
        set.headers["Content-Range"] = `bytes ${startByte}-${endByte}/${info.fileSize}`;
        set.headers["Content-Length"] = String(endByte - startByte + 1);
      } else {
        set.headers["Content-Length"] = String(info.fileSize);
      }

      // @ts-expect-error - Elysia typing issue
      return new Response(readable, { headers: set.headers });
      
    } catch (error) {
      console.error("Error in /stream:", error);
      set.status = 500;
      return { 
        error: "Streaming failed",
        details: error instanceof Error ? error.message : "Unknown error"
      };
    }
  })
  .compile();

// ⭐ Cached version of getMegaDownloadInfo
async function getMegaDownloadInfoCached(megaUrl: string): Promise<MegaStreamData> {
  // Check cache
  const cached = infoCache.get(megaUrl);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    console.log("Cache hit for:", megaUrl.substring(0, 20) + "...");
    return cached.data;
  }

  // Fetch fresh data
  console.log("Cache miss, fetching:", megaUrl.substring(0, 20) + "...");
  const data = await getMegaDownloadInfo(megaUrl);
  
  // Store in cache
  infoCache.set(megaUrl, {
    data,
    timestamp: Date.now()
  });

  // Clean old cache entries (simple cleanup)
  if (infoCache.size > 100) {
    const now = Date.now();
    for (const [key, entry] of infoCache.entries()) {
      if (now - entry.timestamp > CACHE_TTL) {
        infoCache.delete(key);
      }
    }
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

    const [, handle, key] = match as [unknown, string, string];

    const response = await fetch("https://g.api.mega.co.nz/cs?id=0", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{ a: "g", g: 1, ssl: 0, p: handle }]),
    });

    if (!response.ok) {
      throw new Error(`Mega API error: ${response.status}`);
    }

    const data = (await response.json()) as {
      at: string;
      g: string;
      s: number;
    }[];

    if (!data || !data[0]) {
      throw new Error("Invalid response from Mega API");
    }

    const megaData = data[0];

    const nodeKey = base64UrlDecode(key);
    const { aesKey, nonce } = unpackNodeKey(nodeKey);
    const fileName = await decryptAttributes(megaData.at, aesKey);

    return {
      encryptedUrl: megaData.g,
      aesKey,
      nonce,
      fileName,
      fileSize: megaData.s,
    };
  } catch (error) {
    console.error("Error in getMegaDownloadInfo:", error);
    throw error;
  }
}

function base64UrlDecode(str: string): Buffer {
  let base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) base64 += "=";
  return Buffer.from(base64, "base64");
}

function unpackNodeKey(nodeKey: Buffer) {
  const aesKey = Buffer.alloc(16);
  for (let i = 0; i < 4; i++) {
    const offset = i * 4;
    aesKey.writeUInt32BE(
      nodeKey.readUInt32BE(offset) ^ nodeKey.readUInt32BE(offset + 16),
      offset,
    );
  }
  const nonce = nodeKey.subarray(16, 24);
  return { aesKey, nonce };
}

async function decryptAttributes(
  encryptedAttrs: string,
  key: Buffer,
): Promise<string> {
  const crypto = await import("node:crypto");
  const ciphertext = base64UrlDecode(encryptedAttrs);
  const iv = Buffer.alloc(16, 0);

  const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
  decipher.setAutoPadding(false);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  const str = decrypted.toString("utf8").replace(/\0+$/, "");

  const json = JSON.parse(str.substring(4));
  return json.n || "download";
}