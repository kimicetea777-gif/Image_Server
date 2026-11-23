import { removeTempDir, TEST_API_KEY } from "./helpers/setup-env.js";
import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import sharp from "sharp";
import { buildApp } from "../src/app.js";
import { db } from "../src/db/client.js";
import type { ImageRow } from "../src/db/images.repo.js";
import { storage } from "../src/services/r2.js";

const app = buildApp();

const BOUNDARY = "----image-server-test";

async function multipartPngBody(): Promise<Buffer> {
  const png = await sharp({
    create: { width: 20, height: 20, channels: 3, background: "#ff0000" },
  })
    .png()
    .toBuffer();
  return Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`,
    ),
    png,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);
}

async function upload() {
  return app.inject({
    method: "POST",
    url: "/images",
    headers: {
      "x-api-key": TEST_API_KEY,
      "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
    },
    payload: await multipartPngBody(),
  });
}

function allImages(): ImageRow[] {
  return db.prepare("SELECT * FROM images").all() as unknown as ImageRow[];
}

beforeEach(() => {
  mock.restoreAll();
  db.exec("DELETE FROM images");
});

after(async () => {
  await app.close();
  db.close();
  removeTempDir();
});

// R2와 DB는 한 트랜잭션으로 묶을 수 없으니, GC가 훑는 DB에 먼저 기록해야 R2 업로드 도중
// 실패하거나 프로세스가 죽어도 GC가 정리할 수 있다.
test("R2 업로드 시점에 PENDING row가 이미 기록돼 있다", async () => {
  const statusAtUpload: (string | undefined)[] = [];
  const putObject = mock.method(storage, "putObject", async (key: string) => {
    const row = db.prepare("SELECT status FROM images WHERE r2_key = ?").get(key) as
      | { status: string }
      | undefined;
    statusAtUpload.push(row?.status);
  });

  const res = await upload();

  assert.equal(res.statusCode, 201);
  assert.equal(putObject.mock.callCount(), 1);
  assert.deepEqual(statusAtUpload, ["PENDING"]);
  const rows = allImages();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, "PENDING");
  assert.equal(rows[0]!.id, res.json().id);
});

test("이미지가 아닌 파일은 415, R2에도 DB에도 기록하지 않는다", async () => {
  const putObject = mock.method(storage, "putObject", async () => {});
  const textFile = Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`,
    ),
    Buffer.from("not an image — Content-Type과 확장자만 png로 속인 텍스트"),
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);

  const res = await app.inject({
    method: "POST",
    url: "/images",
    headers: { "x-api-key": TEST_API_KEY, "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
    payload: textFile,
  });

  assert.equal(res.statusCode, 415);
  assert.equal(res.json().error, "Unrecognized file type");
  assert.equal(putObject.mock.callCount(), 0);
  assert.equal(allImages().length, 0);
});

test("해상도가 상한(총 6400만 픽셀)을 넘으면 500이 아니라 413, R2에도 DB에도 기록하지 않는다", async () => {
  const putObject = mock.method(storage, "putObject", async () => {});
  // 단색 PNG는 용량이 작아서 파일 크기 제한(10MB)은 통과한다 — 해상도 제한이 별도로 필요한 이유
  const tooBig = await sharp({ create: { width: 8001, height: 8000, channels: 3, background: "#3366cc" } })
    .png()
    .toBuffer();
  assert.ok(tooBig.length < 10 * 1024 * 1024, "테스트 이미지는 파일 크기 제한 안이어야 한다");

  const res = await app.inject({
    method: "POST",
    url: "/images",
    headers: { "x-api-key": TEST_API_KEY, "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
    payload: Buffer.concat([
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="big.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      tooBig,
      Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
    ]),
  });

  assert.equal(res.statusCode, 413);
  assert.match(res.json().error, /8001x8000/);
  assert.equal(putObject.mock.callCount(), 0);
  assert.equal(allImages().length, 0);
});

test("R2 업로드가 실패하면 row를 지우지 않고 DELETE_REQUESTED로 남긴다", async () => {
  // 타임아웃처럼 실제 업로드 여부를 알 수 없는 실패 — row를 지우면 고아 파일이 생길 수 있다
  mock.method(storage, "putObject", async () => {
    throw new Error("simulated R2 timeout");
  });

  const res = await upload();

  assert.equal(res.statusCode, 500);
  const rows = allImages();
  assert.equal(rows.length, 1, "GC가 정리할 수 있도록 row가 남아 있어야 한다");
  assert.equal(rows[0]!.status, "DELETE_REQUESTED");
});
