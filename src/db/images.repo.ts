import { db } from "./client.js";

// 상태 문자열의 단일 출처 — 같은 이름의 타입을 이 값에서 파생하고, SQL에는 문자열을 직접 쓰지 않고 `?`로 바인딩한다.
// (DB의 CHECK 제약은 schema.sql에 따로 있으니 상태를 추가하면 그쪽도 같이 바꿔야 한다)
export const ImageStatus = {
  PENDING: "PENDING",
  COMMITTED: "COMMITTED",
  DELETE_REQUESTED: "DELETE_REQUESTED",
} as const;
export type ImageStatus = (typeof ImageStatus)[keyof typeof ImageStatus];

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
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const findByIdForProjectStmt = db.prepare(
  "SELECT * FROM images WHERE id = ? AND project_id = ?",
);
const confirmStmt = db.prepare(`
  UPDATE images SET status = ?, confirmed_at = datetime('now')
  WHERE id = ? AND project_id = ? AND status = ?
`);
const hardDeleteStmt = db.prepare("DELETE FROM images WHERE id = ?");
const markDeleteRequestedStmt = db.prepare("UPDATE images SET status = ? WHERE id = ?");
const claimPendingForDeletionStmt = db.prepare(
  "UPDATE images SET status = ? WHERE id = ? AND status = ?",
);
const findExpiredPendingStmt = db.prepare(
  "SELECT * FROM images WHERE status = ? AND created_at < datetime('now', ?)",
);
const findDeleteRequestedStmt = db.prepare("SELECT * FROM images WHERE status = ?");
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
    ImageStatus.PENDING,
  );
}

export function findImageForProject(id: string, projectId: number): ImageRow | undefined {
  return findByIdForProjectStmt.get(id, projectId) as unknown as ImageRow | undefined;
}

/** true면 PENDING -> COMMITTED 전환 성공. 이미 COMMITTED였던 경우엔 false를 반환하니
 *  호출 측(routes)에서 findImageForProject로 현재 상태를 다시 확인해 멱등 처리할 것. */
export function confirmImage(id: string, projectId: number): boolean {
  const result = confirmStmt.run(ImageStatus.COMMITTED, id, projectId, ImageStatus.PENDING);
  return result.changes > 0;
}

export function hardDeleteImage(id: string): void {
  hardDeleteStmt.run(id);
}

export function markDeleteRequested(id: string): void {
  markDeleteRequestedStmt.run(ImageStatus.DELETE_REQUESTED, id);
}

/** 아직 PENDING일 때만 DELETE_REQUESTED로 바꿔 삭제 대상으로 선점한다. false면 그사이 confirm 등으로
 *  상태가 바뀐 것이니 지우면 안 된다 — GC가 조회 시점의 스냅샷만 믿고 지우면, R2 삭제를 await하는
 *  동안 끼어든 confirm이 "확정됨"으로 응답한 이미지까지 지워버린다. */
export function claimPendingForDeletion(id: string): boolean {
  return claimPendingForDeletionStmt.run(ImageStatus.DELETE_REQUESTED, id, ImageStatus.PENDING).changes > 0;
}

export function findExpiredPending(ttlHours: number): ImageRow[] {
  return findExpiredPendingStmt.all(ImageStatus.PENDING, `-${ttlHours} hours`) as unknown as ImageRow[];
}

export function findDeleteRequested(): ImageRow[] {
  return findDeleteRequestedStmt.all(ImageStatus.DELETE_REQUESTED) as unknown as ImageRow[];
}

export function findAllByProject(projectId: number): ImageRow[] {
  return findAllByProjectStmt.all(projectId) as unknown as ImageRow[];
}
