import { env } from "../config/env.js";
import {
  findDeleteRequested,
  findExpiredPending,
  hardDeleteImage,
  markDeleteRequested,
  type ImageRow,
} from "../db/images.repo.js";
import { deleteObject } from "./r2.js";

async function purge(image: ImageRow): Promise<void> {
  try {
    await deleteObject(image.r2_key);
    hardDeleteImage(image.id);
  } catch (err) {
    // R2 삭제 실패 시 DB row는 지우지 않고 DELETE_REQUESTED로 유지 — 다음 스윕에서 재시도
    console.warn(`[gc] R2 delete failed for ${image.r2_key}, will retry:`, err);
    markDeleteRequested(image.id);
  }
}

export async function runGcSweep(): Promise<void> {
  // DELETE_REQUESTED를 먼저 조회·처리한 뒤 PENDING 만료분을 처리한다 — 순서를 반대로 하면
  // R2 삭제에 실패해 방금 DELETE_REQUESTED로 바뀐 행이 같은 스윕 실행 안에서 곧바로
  // findDeleteRequested()에 다시 걸려 한 번의 스윕에서 중복 처리된다.
  const deleteRequested = findDeleteRequested();
  for (const image of deleteRequested) {
    await purge(image);
  }

  const expiredPending = findExpiredPending(env.GC_PENDING_TTL_HOURS);
  for (const image of expiredPending) {
    await purge(image);
  }

  if (expiredPending.length > 0 || deleteRequested.length > 0) {
    console.log(
      `[gc] swept ${expiredPending.length} expired PENDING, retried ${deleteRequested.length} DELETE_REQUESTED`,
    );
  }
}

export function startGcSweep(): void {
  void runGcSweep();
  const timer = setInterval(() => {
    void runGcSweep();
  }, env.GC_SWEEP_INTERVAL_MS);
  timer.unref();
}
