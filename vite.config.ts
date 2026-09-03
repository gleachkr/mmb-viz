import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [solid()],
  base: "./",
  build: { target: "es2022" },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
