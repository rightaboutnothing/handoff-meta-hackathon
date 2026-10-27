import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { createLocalLiveMiddleware } from "./server/local-live.mjs";
import { createCompanyMiddleware } from "./server/company-data.mjs";

function localLiveApi(): Plugin {
  const middleware = createLocalLiveMiddleware();
  const companyMiddleware = createCompanyMiddleware();
  return {
    name: "handoff-local-live-api",
    configureServer(server) {
      server.middlewares.use(middleware);
      server.middlewares.use(companyMiddleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
      server.middlewares.use(companyMiddleware);
    },
  };
}

export default defineConfig({
  plugins: [react(), localLiveApi()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("recharts") || id.includes("d3-")) return "charts";
          if (id.includes("framer-motion")) return "motion";
          if (id.includes("react") || id.includes("scheduler")) return "react";
          return undefined;
        },
      },
    },
  },
  server: {
    port: 4173,
    strictPort: true,
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
});
