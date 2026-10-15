import { db } from "./client.js";

export interface ProjectRow {
  id: number;
  slug: string;
  api_key_hash: string;
  rate_limit_per_window: number;
  active: number;
  created_at: string;
}

// 비활성 프로젝트(PROJECTS에서 빠진 것)의 키는 인증에 통과시키지 않는다
const findByApiKeyHashStmt = db.prepare("SELECT * FROM projects WHERE api_key_hash = ? AND active = 1");
const upsertStmt = db.prepare(`
  INSERT INTO projects (slug, api_key_hash, rate_limit_per_window, active)
  VALUES (?, ?, ?, 1)
  ON CONFLICT(slug) DO UPDATE SET
    api_key_hash = excluded.api_key_hash,
    rate_limit_per_window = excluded.rate_limit_per_window,
    active = 1
`);
// 이미지 row가 project_id로 참조하고 있어 삭제 대신 비활성화한다. 목록은 JSON 배열로 넘겨 json_each로 펼친다.
const deactivateMissingStmt = db.prepare(`
  UPDATE projects SET active = 0
  WHERE active = 1 AND slug NOT IN (SELECT value FROM json_each(?))
  RETURNING slug
`);

export function findProjectByApiKeyHash(apiKeyHash: string): ProjectRow | undefined {
  return findByApiKeyHashStmt.get(apiKeyHash) as unknown as ProjectRow | undefined;
}

/** 주어진 slug 목록에 없는 활성 프로젝트를 비활성화하고, 비활성화한 slug를 반환한다(projectsSync.ts) */
export function deactivateProjectsNotIn(slugs: string[]): string[] {
  const rows = deactivateMissingStmt.all(JSON.stringify(slugs)) as unknown as { slug: string }[];
  return rows.map((row) => row.slug);
}

/** slug 기준 upsert, 비활성이었다면 다시 활성화 — env.PROJECTS와 DB를 동기화하는 용도(projectsSync.ts) */
export function upsertProject(params: {
  slug: string;
  apiKeyHash: string;
  rateLimitPerWindow: number;
}): void {
  upsertStmt.run(params.slug, params.apiKeyHash, params.rateLimitPerWindow);
}
