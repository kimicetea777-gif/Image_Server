import { env } from "../config/env.js";
import {
  claimPendingForDeletion,
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

  // 목록은 조회 시점의 스냅샷이라, 앞선 이미지의 R2 삭제를 await하는 사이 뒤쪽 이미지가 confirm될 수
  // 있다. 지우기 직전에 PENDING -> DELETE_REQUESTED로 선점하고, 선점에 실패하면(이미 confirm됨) 건너뛴다.
  // 선점 후 R2 삭제가 실패해도 이미 DELETE_REQUESTED라 다음 스윕에서 재시도된다.
  const expiredPending = findExpiredPending(env.GC_PENDING_TTL_HOURS);
  let sweptCount = 0;
  for (const image of expiredPending) {
    if (!claimPendingForDeletion(image.id)) continue;
    await purge(image);
    sweptCount += 1;
  }

  if (sweptCount > 0 || deleteRequested.length > 0) {
    console.log(
      `[gc] swept ${sweptCount} expired PENDING, retried ${deleteRequested.length} DELETE_REQUESTED`,
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
