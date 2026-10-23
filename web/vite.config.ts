import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const apiPort = process.env.PORT ?? "3001";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // The browser only talks to Vite; Vite forwards /api to Fastify.
    // Same origin in dev means no CORS configuration to get wrong.
    proxy: { "/api": `http://localhost:${apiPort}` },
  },
});
