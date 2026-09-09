import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      DATABASE_URL: "postgresql://test:test@localhost:5432/eccd_test",
      DIRECT_URL: "postgresql://test:test@localhost:5432/eccd_test",
      JWT_SECRET: "test-secret-at-least-32-characters-long",
      NODE_ENV: "test",
      CLIENT_ORIGIN: "http://localhost:5173",
    },
  },
});
