/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{js,ts,bub.js}"],
  // Extension panels are served at runtime (not scanned by `content`), so keep
  // the arbitrary max-height utilities they rely on always compiled.
  safelist: ["max-h-[85vh]", "max-h-[90vh]"],
  theme: {
    extend: {},
  },
  plugins: [],
};
