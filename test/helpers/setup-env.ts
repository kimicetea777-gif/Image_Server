// 테스트 파일에서 앱 모듈보다 반드시 먼저 import한다 — config/env.ts와 db/client.ts는 import 시점에
// process.env를 읽고 DB 파일을 열기 때문. dotenv는 이미 설정된 값을 덮어쓰지 않으므로, 여기서 정한 값이
// .env의 실제 R2 자격증명·DB 경로보다 우선한다. R2 호출은 각 테스트가 storage를 mock해서 막는다.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "image-server-test-"));

process.env.DATABASE_PATH = path.join(tempDir, "test.sqlite");
process.env.R2_ACCOUNT_ID = "test-account";
process.env.R2_ACCESS_KEY = "test-access-key";
process.env.R2_SECRET_KEY = "test-secret-key";
process.env.R2_BUCKET = "test-bucket";
process.env.R2_PUBLIC_URL = "https://images.test.invalid";
process.env.PROJECTS = "test:test-api-key-0123456789abcdef";
process.env.GC_PENDING_TTL_HOURS = "24";

export const TEST_API_KEY = "test-api-key-0123456789abcdef";

export function removeTempDir(): void {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
