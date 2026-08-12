import type { FastifyReply, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { findProjectByApiKeyHash } from "../db/projects.repo.js";

export function hashApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey, "utf8").digest("hex");
}

// 모든 /images* 라우트에 preHandler로 등록 — X-Api-Key -> project 조회, request.project에 부착
export async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const apiKey = request.headers["x-api-key"];
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    await reply.code(401).send({ error: "Missing X-Api-Key header" });
    return;
  }

  const project = findProjectByApiKeyHash(hashApiKey(apiKey));
  if (!project) {
    await reply.code(401).send({ error: "Invalid API key" });
    return;
  }

  request.project = project;
}
