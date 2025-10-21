import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [
    // Run Worker runtime in dev; avoids bundling Node deps into the browser
    cloudflare({ viteEnvironment: { name: "cf_chat_agent" } }),
    react(),
    tailwindcss(),
  ],
});
