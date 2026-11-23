import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import { env } from "./config/env.js";
import "./db/client.js"; // 임포트 시점에 스키마 부트스트랩 실행
import { syncProjectsFromEnv } from "./db/projectsSync.js";
import healthRoutes from "./routes/health.js";
import imageRoutes from "./routes/images.js";

export function buildApp() {
  syncProjectsFromEnv(env.PROJECTS);

  // Fastify 기본 ajv 설정은 coerceTypes: "array"라서 { ids: "abc" } → ["abc"], [123] → ["123"]처럼 타입을
  // 바꿔서 통과시킨다. 스키마에 적힌 타입 그대로만 받도록 끈다. querystring/params 스키마를 추가하면
  // 거기서도 문자열 → 숫자 변환이 일어나지 않으니, 숫자 쿼리가 필요해지면 이 설정을 다시 볼 것.
  const fastify = Fastify({ logger: true, ajv: { customOptions: { coerceTypes: false } } });

  fastify.register(multipart, {
    limits: {
      fileSize: env.MAX_UPLOAD_BYTES,
      files: 1,
    },
  });

  // 하위 스코프(images 라우트)에서 처리하지 않고 rethrow한 에러는 여기서 일괄 포맷
  fastify.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 500) {
      request.log.error(error);
    }
    reply.code(statusCode).send({ error: error.message });
  });

  fastify.register(healthRoutes);
  fastify.register(imageRoutes, { prefix: "/images" });

  return fastify;
}
