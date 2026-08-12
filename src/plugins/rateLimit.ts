import type { FastifyReply, FastifyRequest } from "fastify";

const WINDOW_MS = 10_000;
const CLEANUP_INTERVAL_MS = 10 * 60_000;

// 프로젝트 단위 인메모리 슬라이딩 윈도우 — 키 개수는 등록된 프로젝트 수만큼으로 제한되어
// 무한정 늘어나지 않지만, 위생 차원에서 주기적으로 빈 항목을 정리한다.
const requestLog = new Map<number, number[]>();

// POST /images 라우트에만 적용 — confirm/release/GET은 DB 조회 수준이라 제한하지 않는다
export async function enforceRateLimit(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const project = request.project;
  if (!project) {
    await reply.code(500).send({ error: "Rate limit check ran before authentication" });
    return;
  }

  const now = Date.now();
  const windowStart = now - WINDOW_MS;
  const recent = (requestLog.get(project.id) ?? []).filter((t) => t > windowStart);

  if (recent.length >= project.rate_limit_per_window) {
    requestLog.set(project.id, recent);
    await reply.code(429).send({ error: "Rate limit exceeded" });
    return;
  }

  recent.push(now);
  requestLog.set(project.id, recent);
}

const cleanupTimer = setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [projectId, timestamps] of requestLog) {
    const recent = timestamps.filter((t) => t > cutoff);
    if (recent.length === 0) {
      requestLog.delete(projectId);
    } else {
      requestLog.set(projectId, recent);
    }
  }
}, CLEANUP_INTERVAL_MS);
cleanupTimer.unref();
