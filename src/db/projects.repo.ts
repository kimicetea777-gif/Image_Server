import { db } from "./client.js";

export interface ProjectRow {
  id: number;
  slug: string;
  api_key_hash: string;
  rate_limit_per_window: number;
  created_at: string;
}

const findByApiKeyHashStmt = db.prepare("SELECT * FROM projects WHERE api_key_hash = ?");
const upsertStmt = db.prepare(`
  INSERT INTO projects (slug, api_key_hash, rate_limit_per_window)
  VALUES (?, ?, ?)
  ON CONFLICT(slug) DO UPDATE SET
    api_key_hash = excluded.api_key_hash,
    rate_limit_per_window = excluded.rate_limit_per_window
`);

export function findProjectByApiKeyHash(apiKeyHash: string): ProjectRow | undefined {
  return findByApiKeyHashStmt.get(apiKeyHash) as unknown as ProjectRow | undefined;
}

/** slug 기준 upsert — env.PROJECTS와 DB를 동기화하는 용도(projectsSync.ts) */
export function upsertProject(params: {
  slug: string;
  apiKeyHash: string;
  rateLimitPerWindow: number;
}): void {
  upsertStmt.run(params.slug, params.apiKeyHash, params.rateLimitPerWindow);
}
