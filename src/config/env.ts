import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_PATH: z.string().min(1).default("./data/image_server.sqlite"),

  // "slug:apiKey[:rateLimit]"를 콤마로 구분 — 등록된 프로젝트 목록의 단일 소스. 서버 시작 시 이 값으로 projects 테이블을 upsert한다
  PROJECTS: z.string().optional().default(""),

  R2_ACCOUNT_ID: z.string().min(1),
  R2_ACCESS_KEY: z.string().min(1),
  R2_SECRET_KEY: z.string().min(1),
  R2_BUCKET: z.string().min(1),
  R2_PUBLIC_URL: z.string().url(),

  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),

  GC_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(60 * 60 * 1000),
  GC_PENDING_TTL_HOURS: z.coerce.number().int().positive().default(24),
});

export const env = schema.parse(process.env);
