import { AGENT_MODEL, summarizeUsage } from "@repo/cms-core/agent/cost";
import type {
  AltTextDeps,
  DescribeImageResult,
} from "@repo/services/agent/alt-text";
import { FALLBACK_BETA } from "@repo/services/agent/anthropic";
import { mediaKey } from "@repo/services/cms/media-bytes";
import { toBase64 } from "./anthropic";

/**
 * The alt-text service's ports (`@repo/services/agent/alt-text`): one small Claude vision call at
 * low effort (`describe`) and the image's bytes from R2 (`readBytes`).
 */

/** Thinking counts toward this, even at low effort. */
const MAX_TOKENS = 4000;

type VisionMessage = {
  id: string;
  model: string;
  usage: unknown;
  stop_reason: string | null;
  content: { type: string; text?: string }[];
};

/** The part of the Anthropic SDK client `describe` uses (`client.beta.messages.create`). */
export type VisionClient = {
  beta: {
    messages: {
      create: (params: {
        model: string;
        max_tokens: number;
        betas: string[];
        fallbacks: "default";
        output_config: { effort: "low" };
        messages: {
          role: "user";
          content: (
            | {
                type: "image";
                source: { type: "base64"; media_type: string; data: string };
              }
            | { type: "text"; text: string }
          )[];
        }[];
      }) => Promise<VisionMessage>;
    };
  };
};

function stopOf(reason: string | null): DescribeImageResult["stop"] {
  if (reason === "end_turn") {
    return "end";
  }
  return reason === "refusal" ? "refusal" : "other";
}

/** `describe` over Claude: the image as base64 plus the prompt, one user turn, no system prompt. */
export function describeWithClaude(
  client: VisionClient
): AltTextDeps["describe"] {
  return async ({ mime, bytes, prompt }) => {
    const response = await client.beta.messages.create({
      model: AGENT_MODEL,
      max_tokens: MAX_TOKENS,
      betas: [FALLBACK_BETA],
      fallbacks: "default",
      output_config: { effort: "low" },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: mime,
                data: toBase64(bytes),
              },
            },
            { type: "text", text: prompt },
          ],
        },
      ],
    });
    const { costUsd } = summarizeUsage(
      response.usage as Parameters<typeof summarizeUsage>[0],
      response.model
    );
    return {
      id: response.id,
      model: response.model,
      usage: response.usage,
      costUsd,
      stop: stopOf(response.stop_reason),
      text: response.content
        .flatMap((b) => (b.type === "text" && b.text ? [b.text] : []))
        .join(" "),
    };
  };
}

/** The part of R2 `readBytes` uses. */
export type MediaBlobs = {
  get: (
    key: string
  ) => Promise<{ arrayBuffer: () => Promise<ArrayBuffer> } | null>;
};

/** A media item's file from R2, or null when it is missing. */
export function readMediaBytes(blobs: MediaBlobs): AltTextDeps["readBytes"] {
  return async (id) => {
    const obj = await blobs.get(mediaKey(id));
    return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
  };
}
