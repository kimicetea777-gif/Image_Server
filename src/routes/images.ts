import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { authenticate } from "../plugins/auth.js";
import { enforceRateLimit } from "../plugins/rateLimit.js";
import {
  InvalidProcessingOptionsError,
  UnsupportedImageTypeError,
  validateAndProcessImage,
} from "../services/imageProcessing.js";
import { publicUrlFor, storage } from "../services/r2.js";
import {
  confirmImage,
  createPendingImage,
  findAllByProject,
  findImageForProject,
  hardDeleteImage,
  markDeleteRequested,
} from "../db/images.repo.js";

const idsBodySchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(20),
});

interface MultipartFieldValue {
  value?: unknown;
}

// multipart 텍스트 필드(배열 또는 단일 값 형태로 옴)에서 문자열 값만 뽑아냄
function extractFieldValue(field: unknown): string | undefined {
  const target = Array.isArray(field) ? field[0] : field;
  if (target && typeof target === "object" && "value" in target) {
    const value = (target as MultipartFieldValue).value;
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

// maxWidth/quality 같은 선택적 숫자 필드를 파싱, 값이 없으면 undefined(호출 측 기본값 사용)
function parseOptionalIntField(field: unknown, name: string): number | undefined {
  const raw = extractFieldValue(field);
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new InvalidProcessingOptionsError(`${name} must be a number`);
  }
  return Math.trunc(parsed);
}

// /images 하위 라우트 전체를 등록하는 Fastify 플러그인 — 업로드/확정/취소/조회
export default async function imageRoutes(fastify: FastifyInstance): Promise<void> {
  // 이 플러그인 스코프(=/images*) 전체에 인증 적용
  fastify.addHook("preHandler", authenticate);

  // POST /images — 업로드: 검증/리사이즈/webp 변환 후 DB에 PENDING row 생성 + R2 저장
  fastify.post("/", { preHandler: [enforceRateLimit] }, async (request, reply) => {
    const project = request.project!;

    const data = await request.file();
    if (!data) {
      return reply.code(400).send({ error: "Multipart field 'file' is required" });
    }

    const buffer = await data.toBuffer();
    if (buffer.length === 0) {
      return reply.code(400).send({ error: "Empty file" });
    }

    const maxWidth = parseOptionalIntField(data.fields.maxWidth, "maxWidth");
    const quality = parseOptionalIntField(data.fields.quality, "quality");

    const processed = await validateAndProcessImage(buffer, { maxWidth, quality });

    const id = randomUUID();
    const r2Key = `${project.slug}/${id}.webp`;

    // DB(PENDING) 기록을 R2 업로드보다 먼저 한다 — R2와 DB는 한 트랜잭션으로 묶을 수 없으니, 복구 가능한
    // 쪽(GC가 훑는 DB)에 먼저 남겨야 어느 지점에서 실패하거나 프로세스가 죽어도 GC가 정리할 수 있다.
    // 반대 순서면 "R2 업로드 후 DB 기록 전" 실패 시 GC도 못 찾는 고아 파일이 남는다.
    // id는 업로드가 끝난 뒤에야 응답으로 나가므로, 업로드 중인 row를 외부에서 볼 방법은 없다.
    createPendingImage({
      id,
      projectId: project.id,
      r2Key,
      width: processed.width,
      height: processed.height,
      format: processed.format,
      sizeBytes: processed.buffer.length,
    });

    try {
      await storage.putObject(r2Key, processed.buffer, "image/webp");
    } catch (err) {
      // 타임아웃 등으로 실제 업로드 여부가 불확실하니 row를 지우지 않고 DELETE_REQUESTED로 넘겨,
      // 다음 GC 스윕이 키 삭제(없는 키여도 R2는 성공 응답)와 row 정리를 하게 한다. 이 표시마저
      // 실패해도 row는 PENDING으로 남아 TTL 만료 후 GC가 정리한다.
      try {
        markDeleteRequested(id);
      } catch (markErr) {
        request.log.error({ err: markErr, imageId: id }, "Failed to mark DELETE_REQUESTED after R2 upload failure");
      }
      throw err;
    }

    return reply.code(201).send({
      id,
      url: publicUrlFor(r2Key),
      width: processed.width,
      height: processed.height,
      format: processed.format,
    });
  });

  // POST /images/confirm — 확정: PENDING -> COMMITTED로 전환해 GC 대상에서 제외
  fastify.post("/confirm", async (request, reply) => {
    const project = request.project!;
    const parsed = idsBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid body", details: parsed.error.flatten() });
    }

    const confirmed: string[] = [];
    for (const id of parsed.data.ids) {
      const changed = confirmImage(id, project.id);
      if (changed) {
        confirmed.push(id);
        continue;
      }
      // 이미 COMMITTED였던 경우엔 멱등하게 성공 처리, 소유가 아니거나 없는 id는 조용히 무시
      const existing = findImageForProject(id, project.id);
      if (existing?.status === "COMMITTED") {
        confirmed.push(id);
      }
    }

    return reply.send({ confirmed });
  });

  // POST /images/release — 취소: 업로드는 됐지만 안 쓰기로 한 이미지를 R2 + DB에서 즉시 제거
  fastify.post("/release", async (request, reply) => {
    const project = request.project!;
    const parsed = idsBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid body", details: parsed.error.flatten() });
    }

    const released: string[] = [];
    for (const id of parsed.data.ids) {
      const image = findImageForProject(id, project.id);
      if (!image) continue; // 소유가 아니거나 없는 id는 조용히 무시

      try {
        await storage.deleteObject(image.r2_key);
        hardDeleteImage(image.id);
      } catch (err) {
        request.log.warn({ err, imageId: image.id }, "R2 delete failed, marking DELETE_REQUESTED");
        markDeleteRequested(image.id);
      }
      released.push(id);
    }

    return reply.send({ released });
  });

  // DELETE /images — 이 프로젝트가 가진 이미지 전부(PENDING/COMMITTED/DELETE_REQUESTED 무관) 즉시 삭제.
  // 되돌릴 수 없음 — 개발/테스트용 프로젝트(test) 정리 전용. slug를 하드 게이트해서, 실 서비스
  // 프로젝트(mbti_board 등) API 키가 유출돼도 이 라우트로는 전체 삭제가 불가능하게 막는다.
  fastify.delete("/", async (request, reply) => {
    const project = request.project!;
    if (project.slug !== "test") {
      return reply.code(403).send({ error: "This endpoint is only available for the test project" });
    }
    const images = findAllByProject(project.id);

    let deletedCount = 0;
    for (const image of images) {
      try {
        await storage.deleteObject(image.r2_key);
        hardDeleteImage(image.id);
        deletedCount += 1;
      } catch (err) {
        request.log.warn({ err, imageId: image.id }, "R2 delete failed, marking DELETE_REQUESTED");
        markDeleteRequested(image.id);
      }
    }

    return reply.send({ deletedCount, totalCount: images.length });
  });

  // GET /images/:id — 조회: 프로젝트 스코프 내에서 이미지 메타데이터 반환
  fastify.get<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const project = request.project!;
    const image = findImageForProject(request.params.id, project.id);
    if (!image) {
      return reply.code(404).send({ error: "Not found" });
    }

    return reply.send({
      id: image.id,
      url: publicUrlFor(image.r2_key),
      width: image.width,
      height: image.height,
      format: image.format,
      sizeBytes: image.size_bytes,
      status: image.status,
      createdAt: image.created_at,
    });
  });

  // 이 스코프에서 던져진 이미지 검증 관련 에러를 알맞은 상태 코드로 변환, 그 외는 app.ts의 전역 핸들러로 위임
  fastify.setErrorHandler((error, _request, reply) => {
    if (error instanceof UnsupportedImageTypeError) {
      return reply.code(415).send({ error: error.message });
    }
    if (error instanceof InvalidProcessingOptionsError) {
      return reply.code(400).send({ error: error.message });
    }
    throw error;
  });
}
