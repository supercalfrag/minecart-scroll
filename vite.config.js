import { defineConfig } from "vite";

export default defineConfig({
  base: "/minecart-scroll/",

  server: {
    cors: {
      origin: "https://www.owlbear.rodeo",
    },
  },
});