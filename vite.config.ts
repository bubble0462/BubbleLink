import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 需要固定端口，且禁止浏览器自动打开
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "chrome110",
    minify: "esbuild",
    sourcemap: false,
  },
});
