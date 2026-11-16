/** `bun fake-server-main.ts PORT [VERSION]`: a fake MLflow process for sidecar supervision tests. */
import { FakeMlflow } from "./testing.ts";

const port = Number(process.argv[2]);
const fake = new FakeMlflow({
  port,
  ...(process.argv[3] ? { version: process.argv[3] } : {}),
}).start();
console.log(`fake mlflow on ${fake.url}`);
