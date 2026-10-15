import { removeTempDir } from "./helpers/setup-env.js";
import { LEGACY_API_KEY, LEGACY_SLUG } from "./helpers/create-legacy-db.js";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { db } from "../src/db/client.js";
import { findProjectByApiKeyHash } from "../src/db/projects.repo.js";
import { syncProjectsFromEnv } from "../src/db/projectsSync.js";
import { hashApiKey } from "../src/plugins/auth.js";

function slugForKey(apiKey: string): string | undefined {
  return findProjectByApiKeyHash(hashApiKey(apiKey))?.slug;
}

after(() => {
  db.close();
  removeTempDir();
});

// 아래 테스트들은 같은 DB를 이어서 쓰므로 순서대로 실행된다(node:test 기본 동작).

test("active 컬럼이 없던 기존 DB 파일에 컬럼을 추가하고, 기존 프로젝트는 활성으로 유지한다", () => {
  const columns = db.prepare("PRAGMA table_info(projects)").all() as unknown as { name: string }[];
  assert.ok(columns.some((column) => column.name === "active"));
  assert.equal(slugForKey(LEGACY_API_KEY), LEGACY_SLUG);
});

test("PROJECTS에서 빠진 프로젝트의 키는 더 이상 인증되지 않는다", () => {
  syncProjectsFromEnv("alpha:alpha-key-0123456789abcdef,beta:beta-key-0123456789abcdef");
  assert.equal(slugForKey("alpha-key-0123456789abcdef"), "alpha");
  assert.equal(slugForKey("beta-key-0123456789abcdef"), "beta");
  assert.equal(slugForKey(LEGACY_API_KEY), undefined, "목록에 없는 기존 프로젝트도 비활성화돼야 한다");

  syncProjectsFromEnv("alpha:alpha-key-0123456789abcdef");

  assert.equal(slugForKey("alpha-key-0123456789abcdef"), "alpha");
  assert.equal(slugForKey("beta-key-0123456789abcdef"), undefined);
});

test("목록에 다시 넣으면 새 키로 재활성화되고, 옛 키는 통하지 않는다", () => {
  syncProjectsFromEnv("alpha:alpha-key-0123456789abcdef,beta:beta-new-key-0123456789abcdef");

  assert.equal(slugForKey("beta-new-key-0123456789abcdef"), "beta");
  assert.equal(slugForKey("beta-key-0123456789abcdef"), undefined);
});

test("PROJECTS가 비어 있으면 시작을 거부하고 기존 프로젝트는 그대로 둔다", () => {
  assert.throws(() => syncProjectsFromEnv(""), /PROJECTS가 비어 있음/);
  assert.equal(slugForKey("alpha-key-0123456789abcdef"), "alpha");
  assert.equal(slugForKey("beta-new-key-0123456789abcdef"), "beta");
});
