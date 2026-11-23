// "어떤 이미지를, 어떤 옵션으로 받는가" — 이미지 업로드 정책을 한 곳에 모은 모듈.
// 순수 함수만 둔다(파일 읽기·sharp 호출 없음). 매직바이트 감지는 서비스가, multipart 필드 파싱은 라우트가 하고,
// 둘 다 판단은 여기에 맡긴다. 정책(허용 형식, 기본값, 범위)을 바꿀 때는 이 파일만 고치면 된다.
// 값을 바꾸면 Document/connect_manual.md, manual.md의 "1~4096 / 1~100", 허용 형식 설명도 같이 고칠 것.

interface IntRange {
  readonly default: number;
  readonly min: number;
  readonly max: number;
}

export const IMAGE_POLICY: {
  readonly allowedMimeTypes: ReadonlySet<string>;
  readonly maxInputPixels: number;
  readonly maxWidth: IntRange;
  readonly quality: IntRange;
} = {
  allowedMimeTypes: new Set(["image/jpeg", "image/png", "image/webp", "image/bmp"]),
  // 가로×세로 "총 픽셀 수" 상한(한 변의 길이가 아님 — 12000×5000 파노라마는 통과). 파일 크기(MAX_UPLOAD_BYTES)와
  // 별개로 둔다: 단색 PNG는 16000×16000도 3MB라 업로드 제한을 통과하는데, 처리할 때는 픽셀 수에 비례해
  // 메모리를 쓴다(실측: 6400만 픽셀 PNG 약 105MB, 2억 5600만 픽셀 약 205MB 증가 — 컨테이너 mem_limit 384MB).
  maxInputPixels: 8000 * 8000,
  maxWidth: { default: 1280, min: 1, max: 4096 },
  quality: { default: 85, min: 1, max: 100 },
};

// 라우트의 setErrorHandler가 415로 변환한다
export class UnsupportedImageTypeError extends Error {}
// 라우트의 setErrorHandler가 413으로 변환한다
export class ImageTooLargeError extends Error {}
// 라우트의 setErrorHandler가 400으로 변환한다
export class InvalidProcessingOptionsError extends Error {}

// 정책 검사를 통과한, 기본값까지 채워진 옵션 — 서비스는 이 타입만 받는다
export interface ProcessingOptions {
  maxWidth: number;
  quality: number;
}

/** 감지된 mime이 허용 형식인지 확인한다. undefined는 형식을 알아내지 못한 경우(매직바이트 불일치). */
export function assertAllowedMime(mime: string | undefined): void {
  if (mime === undefined) {
    throw new UnsupportedImageTypeError("Unrecognized file type");
  }
  if (!IMAGE_POLICY.allowedMimeTypes.has(mime)) {
    throw new UnsupportedImageTypeError(`Unsupported image type: ${mime}`);
  }
}

/** 입력 이미지의 해상도(총 픽셀 수)가 상한 이내인지 확인한다. 헤더에서 읽은 크기를 넘겨받는다. */
export function assertWithinPixelLimit(width: number, height: number): void {
  if (width * height > IMAGE_POLICY.maxInputPixels) {
    throw new ImageTooLargeError(
      `Image resolution is too large: ${width}x${height} (max ${IMAGE_POLICY.maxInputPixels} total pixels)`,
    );
  }
}

function assertInRange(name: string, value: number, range: IntRange): void {
  if (value < range.min || value > range.max) {
    throw new InvalidProcessingOptionsError(`${name} must be between ${range.min} and ${range.max}`);
  }
}

/** 요청에서 온 옵션(없으면 undefined)에 기본값을 채우고 허용 범위를 검사한다. */
export function resolveProcessingOptions(raw: { maxWidth?: number; quality?: number }): ProcessingOptions {
  const maxWidth = raw.maxWidth ?? IMAGE_POLICY.maxWidth.default;
  const quality = raw.quality ?? IMAGE_POLICY.quality.default;
  assertInRange("maxWidth", maxWidth, IMAGE_POLICY.maxWidth);
  assertInRange("quality", quality, IMAGE_POLICY.quality);
  return { maxWidth, quality };
}
