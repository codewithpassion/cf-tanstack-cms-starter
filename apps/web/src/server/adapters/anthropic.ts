import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { AgentClient, Hydrate } from "@repo/services/agent/anthropic";
import { mediaKey } from "@repo/services/cms/media-bytes";

/**
 * The Claude side of the agent's providers (the provider itself is `@repo/services/agent/anthropic`):
 * the SDK client, and the hydrator that turns stored image refs ("media:<id>" for the media
 * library, "r2:<key>" for agent screenshots) into base64 image blocks when a transcript is replayed.
 */

/** The SDK client with two retries, as the source used. */
export function anthropicClient(apiKey: string): Anthropic {
  return new Anthropic({ apiKey, maxRetries: 2 });
}

/** The client as the provider's port: the SDK's `beta.messages.stream` has the same call shape. */
export function agentClient(apiKey: string): AgentClient {
  return anthropicClient(apiKey) as unknown as AgentClient;
}

/** The part of R2 the hydrator reads. */
export type ImageBlobs = {
  get: (key: string) => Promise<{
    arrayBuffer: () => Promise<ArrayBuffer>;
    httpMetadata?: { contentType?: string };
  } | null>;
};

const ANTHROPIC_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

/** Missing or unsupported images become this note, so the transcript stays sendable. */
export const IMAGE_UNAVAILABLE =
  "[An image that is no longer available or can't be shown.]";

const CHUNK = 0x80_00;

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

/** The R2 key of a stored image ref, or null when it isn't one. */
export function refKey(ref: string): string | null {
  if (ref.startsWith("media:")) {
    return mediaKey(ref.slice("media:".length));
  }
  if (ref.startsWith("r2:")) {
    return ref.slice("r2:".length);
  }
  return null;
}

type Loaded = { data: string; mime: string } | null;

async function readRef(blobs: ImageBlobs, ref: string): Promise<Loaded> {
  const key = refKey(ref);
  if (!key) {
    return null;
  }
  const obj = await blobs.get(key);
  if (!obj) {
    return null;
  }
  return {
    data: toBase64(new Uint8Array(await obj.arrayBuffer())),
    mime: obj.httpMetadata?.contentType ?? "image/jpeg",
  };
}

type RefSource = { type?: unknown; ref?: unknown };

/**
 * Stored content → API content: image refs become base64 image blocks (a missing image becomes a
 * short note). Everything else passes through unchanged. Each hydrator caches the images it read,
 * so make one per request (Workers AI asks for a fresh one per model call).
 */
export function hydrator(blobs: ImageBlobs): Hydrate {
  const cache = new Map<string, Promise<Loaded>>();
  const read = (ref: string): Promise<Loaded> => {
    let pending = cache.get(ref);
    if (!pending) {
      pending = readRef(blobs, ref);
      cache.set(ref, pending);
    }
    return pending;
  };
  const walk = async (node: unknown): Promise<unknown> => {
    if (Array.isArray(node)) {
      return await Promise.all(node.map(walk));
    }
    if (typeof node !== "object" || node === null) {
      return node;
    }
    const o = node as Record<string, unknown>;
    const source = o.source as RefSource | undefined;
    if (
      o.type === "image" &&
      source?.type === "ref" &&
      typeof source.ref === "string"
    ) {
      const img = await read(source.ref);
      if (!(img && ANTHROPIC_IMAGE_TYPES.has(img.mime))) {
        return { type: "text", text: IMAGE_UNAVAILABLE };
      }
      return {
        type: "image",
        source: { type: "base64", media_type: img.mime, data: img.data },
      };
    }
    if (o.type === "tool_result" && Array.isArray(o.content)) {
      return { ...o, content: await walk(o.content) };
    }
    return node;
  };
  return async (content: unknown) =>
    (await walk(content)) as BetaMessageParam["content"];
}
