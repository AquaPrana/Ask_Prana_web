import { app } from "./app.js";
import { env, requireServerSecrets } from "./config.js";
import { pool } from "./db.js";

// No top-level await in this file: Hostinger (LiteSpeed lsnode) loads the
// entry file with require(), which cannot load an ES module that uses
// top-level await. Files live in MySQL, so no upload folder is created here.
requireServerSecrets();

const server = app.listen(env.PORT, "0.0.0.0", () => console.log(`Ask Prana backend listening on :${env.PORT}`));

const stop = async () => {
  server.close();
  await pool.end();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
