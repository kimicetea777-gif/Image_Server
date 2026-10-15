import { hashApiKey } from "../plugins/auth.js";
import { db } from "./client.js";
import { deactivateProjectsNotIn, upsertProject } from "./projects.repo.js";

const DEFAULT_RATE_LIMIT_PER_WINDOW = 10;

interface ProjectConfig {
  slug: string;
  apiKey: string;
  rateLimitPerWindow: number;
}

// env.PROJECTS 형식: "slug:apiKey[:rateLimit]"를 콤마로 구분 — .env 편집만으로 등록/키 교체/rate limit 변경이 끝나게 하기 위함
function parseProjectsEnv(raw: string): ProjectConfig[] {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const [slug, apiKey, rateLimitRaw] = entry.split(":").map((part) => part.trim());
      if (!slug || !apiKey) {
        throw new Error(`PROJECTS 형식이 잘못됨: "${entry}" (slug:apiKey[:rateLimit] 형식이어야 함)`);
      }
      const rateLimitPerWindow = rateLimitRaw ? Number(rateLimitRaw) : DEFAULT_RATE_LIMIT_PER_WINDOW;
      if (!Number.isFinite(rateLimitPerWindow) || rateLimitPerWindow <= 0) {
        throw new Error(`PROJECTS의 rate limit이 잘못됨: "${entry}"`);
      }
      return { slug, apiKey, rateLimitPerWindow };
    });
}

// 서버 시작 시 호출 — env.PROJECTS를 단일 소스로 projects 테이블을 맞춘다. 목록에 있는 프로젝트는 upsert
// (비활성이었다면 재활성화), 목록에서 빠진 프로젝트는 비활성화해서 그 키로는 더 이상 인증되지 않게 한다.
// upsert만 하면 목록에서 지워도 DB row가 남아 옛 키가 계속 통하기 때문.
export function syncProjectsFromEnv(raw: string): void {
  const projects = parseProjectsEnv(raw);
  // 빈 목록은 "모든 프로젝트 비활성화"가 되므로, .env 설정 누락이 조용한 전체 401로 이어지지 않게 기동 단계에서 막는다
  if (projects.length === 0) {
    throw new Error("PROJECTS가 비어 있음 — 최소 한 개의 프로젝트(slug:apiKey)를 등록해야 함");
  }

  db.exec("BEGIN");
  try {
    for (const { slug, apiKey, rateLimitPerWindow } of projects) {
      upsertProject({ slug, apiKeyHash: hashApiKey(apiKey), rateLimitPerWindow });
    }
    const deactivated = deactivateProjectsNotIn(projects.map((project) => project.slug));
    db.exec("COMMIT");
    if (deactivated.length > 0) {
      console.warn(`[projects] PROJECTS에 없는 프로젝트 비활성화: ${deactivated.join(", ")}`);
    }
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
