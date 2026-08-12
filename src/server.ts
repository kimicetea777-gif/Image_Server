import { buildApp } from "./app.js";
import { env } from "./config/env.js";
import { startGcSweep } from "./services/gc.js";

async function main(): Promise<void> {
  const app = buildApp();

  startGcSweep();

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      app.log.info(`${signal} received, shutting down`);
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
