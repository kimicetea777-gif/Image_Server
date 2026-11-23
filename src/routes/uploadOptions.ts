import {
  InvalidProcessingOptionsError,
  resolveProcessingOptions,
  type ProcessingOptions,
} from "../policies/imagePolicy.js";

// POST /images 의 multipart 텍스트 필드(maxWidth, quality)를 숫자로 꺼내는 곳 — 요청 형식(숫자인가)만 여기서 보고,
// 기본값과 허용 범위 판단은 policies/imagePolicy.ts에 맡긴다.

// multipart 텍스트 필드(배열 또는 단일 값 형태로 옴)에서 문자열 값만 뽑아냄.
// target을 unknown으로 명시하는 이유: Array.isArray 분기의 field[0]이 any라서, 명시하지 않으면 target 전체가
// any로 잡혀 아래 검사가 컴파일러 보호 없이 돌아간다.
function extractFieldValue(field: unknown): string | undefined {
  const target: unknown = Array.isArray(field) ? field[0] : field;
  if (typeof target === "object" && target !== null && "value" in target) {
    return typeof target.value === "string" ? target.value : undefined;
  }
  return undefined;
}

// maxWidth/quality 같은 선택적 숫자 필드를 파싱, 값이 없으면 undefined(정책의 기본값이 적용됨)
function parseOptionalIntField(field: unknown, name: string): number | undefined {
  const raw = extractFieldValue(field);
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new InvalidProcessingOptionsError(`${name} must be a number`);
  }
  return Math.trunc(parsed);
}

export function parseUploadOptions(fields: Record<string, unknown>): ProcessingOptions {
  // 두 필드의 형식 검사를 먼저 끝낸 뒤 범위를 검사한다(둘 다 틀렸을 때 보고되는 에러 순서 유지)
  return resolveProcessingOptions({
    maxWidth: parseOptionalIntField(fields.maxWidth, "maxWidth"),
    quality: parseOptionalIntField(fields.quality, "quality"),
  });
}
