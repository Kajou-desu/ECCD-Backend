import { env } from "./config/env.js"; // validates required env vars, fails closed if missing
import { app } from "./app.js";

app.listen(env.port, () => {
  console.log(`ECCD SmartTrack API running on port ${env.port}`);
});
