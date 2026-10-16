import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // DOCENT_API_PORT points a second web copy at a second API (see DOCENT_PORT in apps/server/src/dev.ts).
  server: { port: 5173, proxy: { "/api": `http://127.0.0.1:${process.env.DOCENT_API_PORT ?? 4477}` } },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 4000 },
});
