import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      colors: {
        meta: "#0866FF",
        ink: "#10213A",
        canvas: "#F0F2F5",
      },
      boxShadow: {
        soft: "0 20px 60px rgba(22, 42, 76, 0.10)",
        card: "0 8px 30px rgba(22, 42, 76, 0.08)",
      },
    },
  },
  plugins: [],
} satisfies Config;
