import { removeTempDir, TEST_API_KEY } from "./helpers/setup-env.js";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../src/app.js";
import { db } from "../src/db/client.js";

const app = buildApp();

// 키 없는 요청은 null로 표현한다 — undefined를 넘기면 기본값(TEST_API_KEY)이 대신 들어가기 때문
function post(url: string, payload: unknown, apiKey: string | null = TEST_API_KEY) {
  return app.inject({
    method: "POST",
    url,
    headers: apiKey ? { "x-api-key": apiKey } : {},
    payload: payload as object,
  });
}

after(async () => {
  await app.close();
  db.close();
  removeTempDir();
});

// /confirm, /release는 같은 schema.body를 쓰므로 두 라우트에 똑같이 확인한다
for (const url of ["/images/confirm", "/images/release"]) {
  test(`${url}: ids가 없으면 400`, async () => {
    const res = await post(url, {});
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /ids/);
  });

  test(`${url}: ids가 빈 배열이면 400`, async () => {
    const res = await post(url, { ids: [] });
    assert.equal(res.statusCode, 400);
  });

  test(`${url}: ids가 20개를 넘으면 400`, async () => {
    const ids = Array.from({ length: 21 }, (_, i) => `img-${i}`);
    const res = await post(url, { ids });
    assert.equal(res.statusCode, 400);
  });

  test(`${url}: 빈 문자열 id는 400`, async () => {
    const res = await post(url, { ids: [""] });
    assert.equal(res.statusCode, 400);
  });

  test(`${url}: 타입을 강제 변환하지 않는다(문자열 하나, 숫자 id는 400)`, async () => {
    assert.equal((await post(url, { ids: "img-1" })).statusCode, 400);
    assert.equal((await post(url, { ids: [123] })).statusCode, 400);
  });

  test(`${url}: API 키가 없으면 body가 틀려도 검증보다 인증이 먼저라 401`, async () => {
    const res = await post(url, {}, null);
    assert.equal(res.statusCode, 401);
  });

  test(`${url}: 올바른 body면 핸들러까지 도달한다(없는 id는 조용히 무시)`, async () => {
    const res = await post(url, { ids: ["img-does-not-exist"], extra: "removed" });
    assert.equal(res.statusCode, 200);
    const key = url.endsWith("confirm") ? "confirmed" : "released";
    assert.deepEqual(res.json(), { [key]: [] });
  });
}
