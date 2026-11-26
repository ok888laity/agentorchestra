import { defineConfig } from "vite";
import { gui } from "@opencode/plugin/gui/vite";

export default defineConfig({
  plugins: [gui({ entry: "gui-src/gui.jsx", outFile: "gui-experimental.cjs" })]
});
