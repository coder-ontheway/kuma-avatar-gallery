import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  let base = env.VITE_BASE_PATH || "/";
  if (!base.startsWith("/")) base = "/" + base;
  if (!base.endsWith("/")) base += "/";
  return {
    base,
    plugins: [react()],
    build: { sourcemap: false, chunkSizeWarningLimit: 800 },
    test: { environment: "node", include: ["src/**/*.test.ts"] },
  };
});
