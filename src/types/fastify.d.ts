import type { ProjectRow } from "../db/projects.repo.js";

declare module "fastify" {
  interface FastifyRequest {
    project?: ProjectRow;
  }
}
