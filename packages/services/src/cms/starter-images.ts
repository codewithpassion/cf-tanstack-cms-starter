// biome-ignore-all lint/suspicious/noBitwiseOperators: CRC-32 for the PNG chunks is bit arithmetic.
// biome-ignore-all lint/style/noNonNullAssertion: CRC_TABLE is indexed with `& 0xff`, always in range.
import type { StarterImageKey } from "@repo/cms-core/starter-content";

/**
 * Placeholder illustrations for the starter content, drawn in code and encoded as PNG (the media
 * library takes JPEG, PNG, WebP, GIF and AVIF, not SVG). Flat shapes over a soft gradient in the
 * theme's indigo and zinc. `CompressionStream` is in Workers and Bun, so no dependency is needed.
 */

export const STARTER_IMAGE_WIDTH = 1200;
export const STARTER_IMAGE_HEIGHT = 630;

type Rgb = readonly [number, number, number];
type Shape =
  | { kind: "circle"; x: number; y: number; r: number; color: Rgb }
  | {
      kind: "rect";
      x: number;
      y: number;
      w: number;
      h: number;
      radius: number;
      color: Rgb;
    };

type Scene = { top: Rgb; bottom: Rgb; shapes: Shape[] };

const INDIGO: Rgb = [79, 70, 229];
const INDIGO_SOFT: Rgb = [199, 210, 254];
const INDIGO_PALE: Rgb = [238, 242, 255];
const ZINC_100: Rgb = [244, 244, 245];
const ZINC_300: Rgb = [212, 212, 216];
const ZINC_900: Rgb = [24, 24, 27];
const SKY: Rgb = [14, 165, 233];
const WHITE: Rgb = [255, 255, 255];

const circle = (x: number, y: number, r: number, color: Rgb): Shape => ({
  kind: "circle",
  x,
  y,
  r,
  color,
});
const rect = (
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  color: Rgb
): Shape => ({ kind: "rect", x, y, w, h, radius, color });

const SCENES: Record<StarterImageKey, Scene> = {
  team: {
    top: INDIGO_PALE,
    bottom: ZINC_100,
    shapes: [
      circle(360, 330, 210, INDIGO_SOFT),
      circle(600, 300, 170, INDIGO),
      circle(820, 360, 190, WHITE),
      rect(300, 470, 600, 36, 18, ZINC_300),
      circle(600, 300, 70, WHITE),
    ],
  },
  post1: {
    top: INDIGO,
    bottom: [99, 102, 241],
    shapes: [
      circle(950, 140, 220, [129, 140, 248]),
      circle(240, 520, 260, [67, 56, 202]),
      rect(420, 220, 360, 190, 24, WHITE),
      rect(450, 255, 200, 20, 10, INDIGO_SOFT),
      rect(450, 300, 290, 20, 10, ZINC_300),
      rect(450, 345, 250, 20, 10, ZINC_300),
    ],
  },
  post2: {
    top: ZINC_100,
    bottom: WHITE,
    shapes: [
      rect(200, 380, 130, 160, 16, ZINC_300),
      rect(370, 300, 130, 240, 16, INDIGO_SOFT),
      rect(540, 220, 130, 320, 16, INDIGO),
      rect(710, 280, 130, 260, 16, SKY),
      rect(880, 180, 130, 360, 16, ZINC_900),
    ],
  },
  post3: {
    top: INDIGO_PALE,
    bottom: INDIGO_SOFT,
    shapes: [
      circle(300, 315, 150, WHITE),
      circle(600, 315, 150, INDIGO),
      circle(900, 315, 150, SKY),
      circle(450, 315, 60, INDIGO_SOFT),
      circle(750, 315, 60, WHITE),
    ],
  },
};

function inShape(shape: Shape, px: number, py: number): boolean {
  if (shape.kind === "circle") {
    return (px - shape.x) ** 2 + (py - shape.y) ** 2 <= shape.r ** 2;
  }
  const { x, y, w, h, radius } = shape;
  if (px < x || px >= x + w || py < y || py >= y + h) {
    return false;
  }
  const cx = Math.min(Math.max(px, x + radius), x + w - radius);
  const cy = Math.min(Math.max(py, y + radius), y + h - radius);
  return (px - cx) ** 2 + (py - cy) ** 2 <= radius ** 2;
}

/** Raw PNG scanlines (filter byte 0 + RGB) for a scene. */
function render(scene: Scene): Uint8Array<ArrayBuffer> {
  const rowBytes = 1 + STARTER_IMAGE_WIDTH * 3;
  const out = new Uint8Array(rowBytes * STARTER_IMAGE_HEIGHT);
  for (let y = 0; y < STARTER_IMAGE_HEIGHT; y += 1) {
    const t = y / (STARTER_IMAGE_HEIGHT - 1);
    const base = y * rowBytes;
    for (let x = 0; x < STARTER_IMAGE_WIDTH; x += 1) {
      let color: Rgb = [
        scene.top[0] + (scene.bottom[0] - scene.top[0]) * t,
        scene.top[1] + (scene.bottom[1] - scene.top[1]) * t,
        scene.top[2] + (scene.bottom[2] - scene.top[2]) * t,
      ];
      for (const shape of scene.shapes) {
        if (inShape(shape, x, y)) {
          ({ color } = shape);
        }
      }
      const at = base + 1 + x * 3;
      out[at] = color[0];
      out[at + 1] = color[1];
      out[at + 2] = color[2];
    }
  }
  return out;
}

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xed_b8_83_20 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xff_ff_ff_ff;
  for (const byte of bytes) {
    c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xff_ff_ff_ff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) {
    out[4 + i] = type.charCodeAt(i);
  }
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function deflate(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The PNG file for one starter image. */
export async function starterImagePng(
  key: StarterImageKey
): Promise<Uint8Array> {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, STARTER_IMAGE_WIDTH);
  view.setUint32(4, STARTER_IMAGE_HEIGHT);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  const parts = [
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    chunk("IHDR", header),
    chunk("IDAT", await deflate(render(SCENES[key]))),
    chunk("IEND", new Uint8Array(0)),
  ];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    png.set(part, at);
    at += part.length;
  }
  return png;
}

/** What each image shows, stored as the media library's alt text. */
export const STARTER_IMAGE_ALT: Record<StarterImageKey, string> = {
  team: "Abstract illustration of overlapping shapes in indigo and grey",
  post1: "Abstract indigo gradient with soft shapes",
  post2: "Abstract grey and indigo bars",
  post3: "Abstract indigo circles on a light background",
};
