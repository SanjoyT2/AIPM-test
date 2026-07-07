import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev proxy: the API serves these routes; in prod Fastify serves the built SPA itself.
const api = "http://localhost:8000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": api, "/webhooks": api },
  },
});
