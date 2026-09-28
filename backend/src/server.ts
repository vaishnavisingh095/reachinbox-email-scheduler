import { env, getApiPort } from "./config/env";
import { createApp } from "./app";

const app = createApp();
const port = getApiPort();

app.listen(port, () => {
  console.log(`API listening on port ${port} (${env.NODE_ENV})`);
  console.log(`Health check: http://localhost:${port}/health`);
});
