import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1520,
    strictPort: true,
    // Explicit IPv4 loopback rather than Vite's default "localhost" binding -
    // WebView2 resolving "localhost" was taking ~79s before falling back from
    // IPv6 to IPv4 on this machine (confirmed via boot-timing instrumentation:
    // the entire delay sat between page-parse-start and the first script
    // executing, identical whether Vite's dependency cache was warm or cold -
    // a fixed-duration stall like that points at network resolution, not app
    // code). Binding here and pointing tauri.conf.json's devUrl straight at
    // 127.0.0.1 skips hostname resolution for the dev server entirely.
    host: host || "127.0.0.1",
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1521,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
