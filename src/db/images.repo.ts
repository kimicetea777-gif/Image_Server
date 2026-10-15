import { db } from "./client.js";

export type ImageStatus = "PENDING" | "COMMITTED" | "DELETE_REQUESTED";

export interface ImageRow {
  id: string;
  project_id: number;
  r2_key: string;
  width: number;
  height: number;
  format: string;
  size_bytes: number;
  status: ImageStatus;
  created_at: string;
  confirmed_at: string | null;
}

const insertStmt = db.prepare(`
  INSERT INTO images (id, project_id, r2_key, width, height, format, size_bytes, status)
  VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING')
`);
const findByIdForProjectStmt = db.prepare(
  "SELECT * FROM images WHERE id = ? AND project_id = ?",
);
const confirmStmt = db.prepare(`
  UPDATE images SET status = 'COMMITTED', confirmed_at = datetime('now')
  WHERE id = ? AND project_id = ? AND status = 'PENDING'
`);
const hardDeleteStmt = db.prepare("DELETE FROM images WHERE id = ?");
const markDeleteRequestedStmt = db.prepare(
  "UPDATE images SET status = 'DELETE_REQUESTED' WHERE id = ?",
);
const claimPendingForDeletionStmt = db.prepare(
  "UPDATE images SET status = 'DELETE_REQUESTED' WHERE id = ? AND status = 'PENDING'",
);
const findExpiredPendingStmt = db.prepare(
  "SELECT * FROM images WHERE status = 'PENDING' AND created_at < datetime('now', ?)",
);
const findDeleteRequestedStmt = db.prepare("SELECT * FROM images WHERE status = 'DELETE_REQUESTED'");
const findAllByProjectStmt = db.prepare("SELECT * FROM images WHERE project_id = ?");

export function createPendingImage(params: {
  id: string;
  projectId: number;
  r2Key: string;
  width: number;
  height: number;
  format: string;
  sizeBytes: number;
}): void {
  insertStmt.run(
    params.id,
    params.projectId,
    params.r2Key,
    params.width,
    params.height,
    params.format,
    params.sizeBytes,
  );
}

export function findImageForProject(id: string, projectId: number): ImageRow | undefined {
  return findByIdForProjectStmt.get(id, projectId) as unknown as ImageRow | undefined;
}

/** true면 PENDING -> COMMITTED 전환 성공. 이미 COMMITTED였던 경우엔 false를 반환하니
 *  호출 측(routes)에서 findImageForProject로 현재 상태를 다시 확인해 멱등 처리할 것. */
export function confirmImage(id: string, projectId: number): boolean {
  const result = confirmStmt.run(id, projectId);
  return result.changes > 0;
}

export function hardDeleteImage(id: string): void {
  hardDeleteStmt.run(id);
}

export function markDeleteRequested(id: string): void {
  markDeleteRequestedStmt.run(id);
}

/** 아직 PENDING일 때만 DELETE_REQUESTED로 바꿔 삭제 대상으로 선점한다. false면 그사이 confirm 등으로
 *  상태가 바뀐 것이니 지우면 안 된다 — GC가 조회 시점의 스냅샷만 믿고 지우면, R2 삭제를 await하는
 *  동안 끼어든 confirm이 "확정됨"으로 응답한 이미지까지 지워버린다. */
export function claimPendingForDeletion(id: string): boolean {
  return claimPendingForDeletionStmt.run(id).changes > 0;
}

export function findExpiredPending(ttlHours: number): ImageRow[] {
  return findExpiredPendingStmt.all(`-${ttlHours} hours`) as unknown as ImageRow[];
}

export function findDeleteRequested(): ImageRow[] {
  return findDeleteRequestedStmt.all() as unknown as ImageRow[];
}

export function findAllByProject(projectId: number): ImageRow[] {
  return findAllByProjectStmt.all(projectId) as unknown as ImageRow[];
}
