import { removeTempDir } from "./helpers/setup-env.js";
import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import { db } from "../src/db/client.js";
import { confirmImage, findImageForProject } from "../src/db/images.repo.js";
import { runGcSweep } from "../src/services/gc.js";
import { storage } from "../src/services/r2.js";

db.exec("INSERT INTO projects (slug, api_key_hash) VALUES ('gc', 'unused-hash')");
const projectId = (db.prepare("SELECT id FROM projects WHERE slug = 'gc'").get() as { id: number }).id;

const insertExpiredPending = db.prepare(`
  INSERT INTO images (id, project_id, r2_key, width, height, format, size_bytes, status, created_at)
  VALUES (?, ?, ?, 1, 1, 'webp', 1, 'PENDING', datetime('now', '-25 hours'))
`);

function addExpiredPending(id: string): string {
  const r2Key = `gc/${id}.webp`;
  insertExpiredPending.run(id, projectId, r2Key);
  return r2Key;
}

beforeEach(() => {
  mock.restoreAll();
  db.exec("DELETE FROM images");
});

after(() => {
  db.close();
  removeTempDir();
});

// GC는 만료 목록을 먼저 조회한 뒤 하나씩 R2 삭제를 await한다. 그 await 사이에 confirm이 끼어들어
// 목록 뒤쪽 이미지를 확정해도, GC는 조회 시점 스냅샷을 믿고 지우면 안 된다.
test("GC가 R2 삭제를 기다리는 사이 confirm된 이미지는 지우지 않는다", async () => {
  const keys = { first: addExpiredPending("img-1"), second: addExpiredPending("img-2") };
  const idByKey = new Map([[keys.first, "img-1"], [keys.second, "img-2"]]);
  const deletedKeys: string[] = [];
  let confirmedDuringSweep: string | undefined;

  mock.method(storage, "deleteObject", async (key: string) => {
    deletedKeys.push(key);
    if (confirmedDuringSweep === undefined) {
      // 첫 R2 삭제를 기다리는 동안 이벤트 루프가 다른 요청(confirm)을 처리한 상황을 재현
      confirmedDuringSweep = idByKey.get(key) === "img-1" ? "img-2" : "img-1";
      assert.equal(confirmImage(confirmedDuringSweep, projectId), true);
    }
  });

  await runGcSweep();

  assert.equal(deletedKeys.length, 1, "확정된 이미지의 R2 객체는 삭제를 시도하지 않아야 한다");
  const confirmed = findImageForProject(confirmedDuringSweep!, projectId);
  assert.equal(confirmed?.status, "COMMITTED");
  const deletedId = idByKey.get(deletedKeys[0]!)!;
  assert.equal(findImageForProject(deletedId, projectId), undefined);
});

test("GC가 먼저 선점한 이미지는 confirm이 실패한다", async () => {
  addExpiredPending("img-3");
  let confirmResult: boolean | undefined;

  mock.method(storage, "deleteObject", async () => {
    // GC가 선점(PENDING -> DELETE_REQUESTED)한 뒤 R2 삭제를 기다리는 사이 confirm이 도착한 상황
    confirmResult = confirmImage("img-3", projectId);
  });

  await runGcSweep();

  assert.equal(confirmResult, false, "삭제가 결정된 이미지를 확정됐다고 응답하면 안 된다");
  assert.equal(findImageForProject("img-3", projectId), undefined);
});
