/**
 * A picture made small enough to hand an assistant, through Cloudflare's Images binding
 * (MAK-185, MAK-253). Only MCP's `get_attachment` uses it.
 *
 * Why it exists: `get_attachment` returns a picture as a base64 image block, and the
 * model's platforms cap that block by its length (5 MiB of base64 on Bedrock and Vertex),
 * so a phone photo of a tax form at 10 to 16 MB could not be handed over at all, and the
 * file stayed waiting until someone pressed Auto-fill. Sending more than the model looks at
 * is waste besides: Claude downscales a picture to a long edge of 1568 px (2576 px on the
 * newest models) before it reads it, so everything past that is paid for in transit and
 * thrown away at the far end. A pasted screenshot never had the problem because the
 * claude.ai client shrinks it before upload; this is the server doing the same.
 *
 * Why the binding and not JavaScript: a wasm codec is megabytes of bundle, and one phone
 * photo decodes to a 48 MB bitmap inside an isolate of 128 MB. The binding does the work
 * outside the isolate and is metered per unique transformation a month (5,000 free), so
 * reading the same picture at the same size again costs nothing more. It is optional:
 * `env.IMAGES` is absent on an instance that has not bound it, and the caller falls back
 * to handing over the original when it is small enough.
 */

/** The long edge Claude reads a picture at by default; what an assistant gets unless it asks. */
export const DEFAULT_MAX_EDGE = 1568;

/**
 * The most an assistant may ask for: the long edge the newest models read at. A dense
 * receipt or a page of small print may want it; anything past it the model would shrink.
 */
export const LARGEST_MAX_EDGE = 2576;

/** The smallest it may ask for. Below this a page of text is not legible to anyone. */
export const SMALLEST_MAX_EDGE = 512;

/**
 * What the binding accepts as input: "image bytes up to 20 MB from any source", in the
 * binding's documentation. Written in decimal megabytes, the lower reading of "MB", so a
 * file at the edge is refused with its size named rather than failing inside the call.
 */
export const MAX_DOWNSCALE_INPUT_BYTES = 20 * 1000 * 1000;

/**
 * JPEG at a moderate quality: the model reads text off it as well as off the original, and
 * at 1568 px it comes to a few hundred kilobytes. JPEG whatever went in, since every model
 * platform takes it and a PNG of a photo at the same size is several times larger.
 */
const QUALITY = 85;

/** Narrowed to what this file calls, so a test can stand in for the binding. */
export type Downscaler = Pick<ImagesBinding, 'input'>;

export interface Downscaled {
  bytes: ArrayBuffer;
  contentType: 'image/jpeg';
  /** As read back from the JPEG itself, or null if its header could not be read. */
  width: number | null;
  height: number | null;
}

/**
 * The picture as a JPEG no longer than `maxEdge` on either side. `scale-down` never
 * enlarges, so a picture already within the edge keeps its size and is only re-encoded.
 * Transparency is filled white rather than the black JPEG would otherwise give it, since
 * dark text on a transparent background would come out black on black.
 *
 * Throws what the binding throws (an `ImagesError`: not an image, too large, or the free
 * plan's month used up); the caller decides what to fall back to.
 */
export async function downscale(images: Downscaler, body: ReadableStream<Uint8Array>, maxEdge: number): Promise<Downscaled> {
  const result = await images
    .input(body)
    .transform(downscaleTransform(maxEdge))
    .output({ format: 'image/jpeg', quality: QUALITY, background: '#ffffff' });
  const bytes = await new Response(result.image()).arrayBuffer();
  const size = jpegSize(bytes);
  return { bytes, contentType: 'image/jpeg', width: size?.width ?? null, height: size?.height ?? null };
}

/** The transform `downscale` asks for, exported so the test can pin it. */
export function downscaleTransform(maxEdge: number): ImageTransform {
  return { width: maxEdge, height: maxEdge, fit: 'scale-down' };
}

/**
 * A JPEG's width and height, read from its frame header. The assistant is told the size
 * it was sent, since that is the unit the model bills an image in; reading it off the
 * output costs nothing, where asking the binding would be a second call per picture.
 *
 * Walks the markers from the start: every segment after SOI carries its own length, and
 * the first start-of-frame (C0 to CF, less C4 DHT, C8 JPG and CC DAC, which share the
 * range) holds the size. Null for anything that is not a JPEG or ends early.
 */
export function jpegSize(buffer: ArrayBuffer): { width: number; height: number } | null {
  const b = new Uint8Array(buffer);
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    // Fill bytes: a marker may be preceded by any number of 0xFF.
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    const length = (b[i + 2]! << 8) | b[i + 3]!;
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (i + 9 > b.length) return null;
      const height = (b[i + 5]! << 8) | b[i + 6]!;
      const width = (b[i + 7]! << 8) | b[i + 8]!;
      return width && height ? { width, height } : null;
    }
    // Start of scan with no frame before it, or end of image: not a JPEG worth trusting.
    if (marker === 0xda || marker === 0xd9) return null;
    i += 2 + length;
  }
  return null;
}
