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
