import { hashApiKey } from "../plugins/auth.js";
import { upsertProject } from "./projects.repo.js";

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

// 서버 시작 시 호출 — env.PROJECTS를 projects 테이블에 upsert해서 DB를 파생 캐시로 유지
export function syncProjectsFromEnv(raw: string): void {
  for (const { slug, apiKey, rateLimitPerWindow } of parseProjectsEnv(raw)) {
    upsertProject({ slug, apiKeyHash: hashApiKey(apiKey), rateLimitPerWindow });
  }
}
