import { removeTempDir, TEST_API_KEY } from "./helpers/setup-env.js";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../src/app.js";
import { db } from "../src/db/client.js";

const app = buildApp(); // setup-env의 PROJECTS로 'test' 프로젝트가 등록된다
const projectId = (db.prepare("SELECT id FROM projects WHERE slug = 'test'").get() as { id: number }).id;

const insertImage = db.prepare(`
  INSERT INTO images (id, project_id, r2_key, width, height, format, size_bytes, status)
  VALUES (?, ?, ?, 1, 1, 'webp', 1, ?)
`);

function getImage(id: string) {
  return app.inject({ method: "GET", url: `/images/${id}`, headers: { "x-api-key": TEST_API_KEY } });
}

after(async () => {
  await app.close();
  db.close();
  removeTempDir();
});

test("삭제가 결정된(DELETE_REQUESTED) 이미지는 없는 이미지와 똑같이 404로 응답한다", async () => {
  insertImage.run("img-deleting", projectId, "test/img-deleting.webp", "DELETE_REQUESTED");

  const deleting = await getImage("img-deleting");
  const missing = await getImage("img-does-not-exist");

  assert.equal(deleting.statusCode, 404);
  assert.deepEqual(deleting.json(), missing.json());
});

test("확정된 이미지는 메타데이터를 반환한다", async () => {
  insertImage.run("img-committed", projectId, "test/img-committed.webp", "COMMITTED");

  const res = await getImage("img-committed");

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, "COMMITTED");
  assert.equal(res.json().url, "https://images.test.invalid/test/img-committed.webp");
});
