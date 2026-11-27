import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: {
    outDir: path.join(import.meta.dirname, "dist"),
    emptyOutDir: true,
    // React changes far less often than the app: its own chunk stays cached across app updates and keeps the entry chunk small.
    rolldownOptions: {
      output: { codeSplitting: { groups: [{ name: "react-vendor", test: /node_modules[\/](react|react-dom|scheduler)[\/]/ }] } },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    host: "127.0.0.1",
    proxy: { "/api": "http://127.0.0.1:4800", "/ws": { target: "ws://127.0.0.1:4800", ws: true } },
  },
});
