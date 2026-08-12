import sharp from "sharp";
import { fileTypeFromBuffer } from "file-type";

const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/bmp"]);

const DEFAULT_MAX_WIDTH = 1280;
const DEFAULT_QUALITY = 85;
const MIN_MAX_WIDTH = 1;
const MAX_MAX_WIDTH = 4096;
const MIN_QUALITY = 1;
const MAX_QUALITY = 100;

export class UnsupportedImageTypeError extends Error {}
export class InvalidProcessingOptionsError extends Error {}

export interface ProcessedImage {
  buffer: Buffer;
  width: number;
  height: number;
  format: string;
}

export interface ProcessingOptions {
  maxWidth?: number;
  quality?: number;
}

// 매직바이트로만 판별 — 클라이언트가 보낸 Content-Type/확장자는 신뢰하지 않음
export async function validateAndProcessImage(
  input: Buffer,
  options: ProcessingOptions = {},
): Promise<ProcessedImage> {
  const detected = await fileTypeFromBuffer(input);
  if (!detected || !ALLOWED_MIME_TYPES.has(detected.mime)) {
    throw new UnsupportedImageTypeError(
      detected ? `Unsupported image type: ${detected.mime}` : "Unrecognized file type",
    );
  }

  const maxWidth = options.maxWidth ?? DEFAULT_MAX_WIDTH;
  const quality = options.quality ?? DEFAULT_QUALITY;
  if (maxWidth < MIN_MAX_WIDTH || maxWidth > MAX_MAX_WIDTH) {
    throw new InvalidProcessingOptionsError(
      `maxWidth must be between ${MIN_MAX_WIDTH} and ${MAX_MAX_WIDTH}`,
    );
  }
  if (quality < MIN_QUALITY || quality > MAX_QUALITY) {
    throw new InvalidProcessingOptionsError(
      `quality must be between ${MIN_QUALITY} and ${MAX_QUALITY}`,
    );
  }

  // 애니메이션 프레임은 의도적으로 유지하지 않음(animated: true 미사용) — 허용 mime엔 GIF가
  // 없고, 애니메이션 webp만 해당되는 좁은 케이스라 필요해지면 그때 옵션으로 추가한다.
  const buffer = await sharp(input, { limitInputPixels: 16000 * 16000 })
    .rotate()
    .resize({ width: maxWidth, withoutEnlargement: true })
    .webp({ quality, effort: 4 })
    .toBuffer();

  const metadata = await sharp(buffer).metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error("Failed to read processed image dimensions");
  }

  return { buffer, width: metadata.width, height: metadata.height, format: "webp" };
}
