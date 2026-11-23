import { buildApp } from "./app.js";
import { env } from "./config/env.js";
import { db } from "./db/client.js";
import { startGcSweep } from "./services/gc.js";

// 종료 신호를 받은 뒤 이 시간 안에 app.close()가 끝나지 않으면(응답이 안 끝나는 요청 등) 강제 종료한다.
// Docker는 기본 10초 뒤 SIGKILL을 보내므로, 그보다 먼저 로그를 남기고 스스로 끝내려고 짧게 잡는다.
const SHUTDOWN_TIMEOUT_MS = 8_000;

async function main(): Promise<void> {
  const app = buildApp();

  // DB는 onClose 훅에서 닫는다 — 이 훅은 새 연결을 막고 진행 중이던 요청이 모두 끝난 뒤에 실행되므로
  // 처리 중인 요청이 닫힌 DB를 쓰는 일이 없다. buildApp()이 아니라 여기서 등록하는 이유: 테스트는
  // app.close() 뒤에 직접 db.close()를 호출하는데, 둘 다 닫으면 두 번째 close가 예외를 던진다.
  app.addHook("onClose", async () => {
    db.close();
  });

  startGcSweep();

  let shuttingDown = false;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      if (shuttingDown) return; // Ctrl+C 연타 등으로 신호가 또 와도 종료 절차는 한 번만
      shuttingDown = true;
      app.log.info(`${signal} received, shutting down`);

      setTimeout(() => {
        app.log.error(`Shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms, forcing exit`);
        process.exit(1);
      }, SHUTDOWN_TIMEOUT_MS);

      app.close().then(
        () => process.exit(0),
        (err) => {
          app.log.error(err);
          process.exit(1);
        },
      );
    });
  }

  try {
    await app.listen({ port: env.PORT, host: "0.0.0.0" });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
