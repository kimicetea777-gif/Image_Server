import { removeTempDir, TEST_API_KEY } from "./helpers/setup-env.js";
import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import sharp from "sharp";
import { buildApp } from "../src/app.js";
import { db } from "../src/db/client.js";
import { InvalidProcessingOptionsError } from "../src/policies/imagePolicy.js";
import { parseUploadOptions } from "../src/routes/uploadOptions.js";
import { storage } from "../src/services/r2.js";

// multipart 필드가 파싱되면 { value: "..." } 형태(또는 그 배열)로 온다
const field = (value: string) => ({ value });

// ---- parseUploadOptions 단위 테스트: 필드 → 숫자 변환만 확인(기본값·범위 판단은 image-policy.test.ts) ----

test("필드가 없거나 빈 문자열이면 '값 없음'으로 보고 정책 기본값이 적용된다", () => {
  assert.deepEqual(parseUploadOptions({}), { maxWidth: 1280, quality: 85 });
  assert.deepEqual(parseUploadOptions({ maxWidth: field(""), quality: field("  ") }), {
    maxWidth: 1280,
    quality: 85,
  });
});

test("단일 값과 배열 형태 필드를 모두 읽고, 소수는 버림한다", () => {
  assert.deepEqual(parseUploadOptions({ maxWidth: field("640.9"), quality: [field("70")] }), {
    maxWidth: 640,
    quality: 70,
  });
});

test("버림한 결과가 범위 밖이면 정책 검사에서 걸린다(0.5 → 0)", () => {
  assert.throws(
    () => parseUploadOptions({ maxWidth: field("0.5") }),
    (err: unknown) => err instanceof InvalidProcessingOptionsError && err.message === "maxWidth must be between 1 and 4096",
  );
});

test("숫자가 아니면 InvalidProcessingOptionsError", () => {
  for (const value of ["abc", "Infinity", "NaN"]) {
    assert.throws(
      () => parseUploadOptions({ quality: field(value) }),
      (err: unknown) => err instanceof InvalidProcessingOptionsError && err.message === "quality must be a number",
      value,
    );
  }
});

test("형식 오류가 범위 오류보다 먼저 보고된다(maxWidth 범위 밖 + quality 숫자 아님)", () => {
  assert.throws(
    () => parseUploadOptions({ maxWidth: field("5000"), quality: field("abc") }),
    (err: unknown) => err instanceof InvalidProcessingOptionsError && err.message === "quality must be a number",
  );
});

// ---- 라우트 통합 테스트: 옵션이 실제로 요청에서 이미지 처리까지 전달되는지 ----

const app = buildApp();
const BOUNDARY = "----image-server-options-test";

async function upload(fields: Record<string, string>) {
  const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#ff0000" } })
    .png()
    .toBuffer();
  const textParts = Object.entries(fields).map(
    ([name, value]) => `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
  );
  const payload = Buffer.concat([
    Buffer.from(textParts.join("")), // 필드는 파일보다 앞에 둔다
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`,
    ),
    png,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);
  return app.inject({
    method: "POST",
    url: "/images",
    headers: { "x-api-key": TEST_API_KEY, "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
    payload,
  });
}

beforeEach(() => {
  mock.restoreAll();
  db.exec("DELETE FROM images");
  mock.method(storage, "putObject", async () => {});
});

after(async () => {
  await app.close();
  db.close();
  removeTempDir();
});

test("업로드: maxWidth가 이미지 리사이즈에 반영된다", async () => {
  const res = await upload({ maxWidth: "10" });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().width, 10);
});

test("업로드: 옵션이 없으면 원본보다 키우지 않고 그대로 둔다(기본 maxWidth 1280)", async () => {
  const res = await upload({});
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().width, 20);
});

test("업로드: 범위를 벗어난 옵션은 400, R2에도 DB에도 기록하지 않는다", async () => {
  const putObject = storage.putObject as unknown as { mock: { callCount(): number } };
  for (const [fields, message] of [
    [{ maxWidth: "5000" }, "maxWidth must be between 1 and 4096"],
    [{ quality: "0" }, "quality must be between 1 and 100"],
    [{ quality: "abc" }, "quality must be a number"],
  ] as const) {
    const res = await upload(fields);
    assert.equal(res.statusCode, 400, JSON.stringify(fields));
    assert.equal(res.json().error, message);
  }
  assert.equal(putObject.mock.callCount(), 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM images").get() as { n: number }).n, 0);
});
