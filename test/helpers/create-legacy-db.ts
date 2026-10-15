// setup-env 다음, 앱 모듈보다 먼저 import한다 — projects.active 컬럼이 생기기 전 스키마로 DB 파일을 미리
// 만들어 두고, 앱(db/client.ts)이 운영 중인 기존 볼륨을 여는 상황을 재현한다.
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export const LEGACY_SLUG = "legacy";
export const LEGACY_API_KEY = "legacy-api-key-0123456789abcdef";

const legacyDb = new DatabaseSync(process.env.DATABASE_PATH!);
legacyDb.exec(`
  CREATE TABLE projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    api_key_hash TEXT NOT NULL,
    rate_limit_per_window INTEGER NOT NULL DEFAULT 100,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
legacyDb
  .prepare("INSERT INTO projects (slug, api_key_hash) VALUES (?, ?)")
  .run(LEGACY_SLUG, createHash("sha256").update(LEGACY_API_KEY, "utf8").digest("hex"));
legacyDb.close();
