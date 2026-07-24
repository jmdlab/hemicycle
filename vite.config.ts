import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  base: "/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    proxy: {
      "/api/hemicycle": "http://127.0.0.1:3206",
      "/storage": "http://127.0.0.1:3206",
    },
  },
});
