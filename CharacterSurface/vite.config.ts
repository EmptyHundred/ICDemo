import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  server: {
    host: "10.10.10.8",   // bind to the intranet address
    port: 5173,
    strictPort: true,     // fail rather than silently picking another port
  },
});
