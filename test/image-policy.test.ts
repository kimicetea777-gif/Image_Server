// 정책 모듈은 순수 함수만 있으므로 앱·DB·환경변수 없이 바로 검사한다
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertAllowedMime,
  assertWithinPixelLimit,
  ImageTooLargeError,
  InvalidProcessingOptionsError,
  resolveProcessingOptions,
  UnsupportedImageTypeError,
} from "../src/policies/imagePolicy.js";

// ---- 허용 형식 ----

test("허용 형식(jpeg, png, webp, bmp)은 통과한다", () => {
  for (const mime of ["image/jpeg", "image/png", "image/webp", "image/bmp"]) {
    assert.doesNotThrow(() => assertAllowedMime(mime), mime);
  }
});

test("허용 목록에 없는 형식은 UnsupportedImageTypeError", () => {
  for (const mime of ["image/gif", "image/svg+xml", "application/pdf"]) {
    assert.throws(
      () => assertAllowedMime(mime),
      (err: unknown) => err instanceof UnsupportedImageTypeError && err.message === `Unsupported image type: ${mime}`,
      mime,
    );
  }
});

test("형식을 알아내지 못한 경우(undefined)는 Unrecognized file type", () => {
  assert.throws(
    () => assertAllowedMime(undefined),
    (err: unknown) => err instanceof UnsupportedImageTypeError && err.message === "Unrecognized file type",
  );
});

// ---- 입력 해상도(총 픽셀 수) ----

test("총 픽셀 수가 8000×8000(6400만) 이하면 통과한다 — 한 변이 8000을 넘어도 총량이 이내면 허용", () => {
  assert.doesNotThrow(() => assertWithinPixelLimit(8000, 8000)); // 정확히 상한
  assert.doesNotThrow(() => assertWithinPixelLimit(12000, 5000)); // 6000만, 가로로 긴 파노라마
  assert.doesNotThrow(() => assertWithinPixelLimit(1, 1));
});

test("상한을 1픽셀이라도 넘으면 ImageTooLargeError", () => {
  for (const [w, h] of [
    [8001, 8000],
    [8000, 8001],
    [10000, 7000],
    [16000, 16000],
  ] as const) {
    assert.throws(
      () => assertWithinPixelLimit(w, h),
      (err: unknown) => err instanceof ImageTooLargeError && err.message.includes(`${w}x${h}`),
      `${w}x${h}`,
    );
  }
});

// ---- 옵션 기본값과 범위 ----

test("값이 없으면 기본값(maxWidth 1280, quality 85)을 적용한다", () => {
  assert.deepEqual(resolveProcessingOptions({}), { maxWidth: 1280, quality: 85 });
  assert.deepEqual(resolveProcessingOptions({ maxWidth: undefined, quality: 50 }), { maxWidth: 1280, quality: 50 });
});

test("경계값(1, 4096 / 1, 100)은 허용한다", () => {
  assert.deepEqual(resolveProcessingOptions({ maxWidth: 1, quality: 1 }), { maxWidth: 1, quality: 1 });
  assert.deepEqual(resolveProcessingOptions({ maxWidth: 4096, quality: 100 }), { maxWidth: 4096, quality: 100 });
});

test("0은 '값 없음'이 아니라 범위 밖으로 본다(?? 이므로 기본값으로 바뀌지 않음)", () => {
  assert.throws(() => resolveProcessingOptions({ maxWidth: 0 }), InvalidProcessingOptionsError);
  assert.throws(() => resolveProcessingOptions({ quality: 0 }), InvalidProcessingOptionsError);
});

test("범위를 벗어나면 InvalidProcessingOptionsError", () => {
  for (const [raw, message] of [
    [{ maxWidth: 4097 }, "maxWidth must be between 1 and 4096"],
    [{ maxWidth: -5 }, "maxWidth must be between 1 and 4096"],
    [{ quality: 101 }, "quality must be between 1 and 100"],
    [{ maxWidth: 5000, quality: 0 }, "maxWidth must be between 1 and 4096"], // 둘 다 틀리면 maxWidth부터
  ] as const) {
    assert.throws(
      () => resolveProcessingOptions(raw),
      (err: unknown) => err instanceof InvalidProcessingOptionsError && err.message === message,
      JSON.stringify(raw),
    );
  }
});
