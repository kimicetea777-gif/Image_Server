import sharp from "sharp";
import { fileTypeFromBuffer } from "file-type";
import {
  assertAllowedMime,
  assertWithinPixelLimit,
  IMAGE_POLICY,
  type ProcessingOptions,
} from "../policies/imagePolicy.js";

export interface ProcessedImage {
  buffer: Buffer;
  width: number;
  height: number;
  format: string;
}

// 공개 함수는 이것 하나 — 검증 → 처리 순서를 여기서 보장한다. validateImage/processImage를 export하지 않는 이유:
// sharp는 허용 목록(IMAGE_POLICY) 밖의 형식(SVG, TIFF, GIF 등)도 읽을 수 있어서, 형식 검사는 sharp 앞의 관문이다.
// 둘을 따로 공개하면 호출 측이 검증을 빼먹고 processImage만 부를 수 있다.
// options는 정책 검사(resolveProcessingOptions)를 통과한 값이다 — 기본값·범위는 여기서 다시 검사하지 않는다.
export async function validateAndProcessImage(
  input: Buffer,
  options: ProcessingOptions,
): Promise<ProcessedImage> {
  await validateImage(input);
  return processImage(input, options);
}

// 형식은 매직바이트로만 판별 — 클라이언트가 보낸 Content-Type/확장자는 신뢰하지 않음
async function validateImage(input: Buffer): Promise<void> {
  const detected = await fileTypeFromBuffer(input);
  assertAllowedMime(detected?.mime);

  // 헤더만 읽어 해상도를 확인한다(픽셀 디코딩 없음). 그대로 sharp에 맡기면 한도 초과 시 일반 Error가 던져져
  // 500이 되므로, 여기서 먼저 정책 에러(413)로 바꿔 준다. limitInputPixels: false인 이유: 여기서는 sharp의
  // 기본 한도 에러가 아니라 우리 정책 에러가 나도록, 크기와 상관없이 헤더를 읽게 한다.
  const { width, height } = await sharp(input, { limitInputPixels: false }).metadata();
  if (width && height) assertWithinPixelLimit(width, height);
}

// validateImage를 통과한 입력만 들어온다는 전제 — 이 함수를 export하지 말 것(위 주석 참고)
async function processImage(input: Buffer, options: ProcessingOptions): Promise<ProcessedImage> {
  const { maxWidth, quality } = options;

  // 애니메이션 프레임은 의도적으로 유지하지 않음(animated: true 미사용) — 허용 mime엔 GIF가
  // 없고, 애니메이션 webp만 해당되는 좁은 케이스라 필요해지면 그때 옵션으로 추가한다.
  // limitInputPixels는 validateImage의 해상도 검사가 놓친 경우(헤더에서 크기를 못 읽은 이미지)를 위한 안전망
  const buffer = await sharp(input, { limitInputPixels: IMAGE_POLICY.maxInputPixels })
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
