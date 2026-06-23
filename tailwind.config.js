module.exports = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx}",
    "./pages/**/*.{js,ts,jsx,tsx}",
    "./components/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        premium: {
          bg: "#0B0E14",
          card: "#131A24",
          border: "#1F2937",
          accent: "#3B82F6",
          "accent-glow": "#60A5FA",
          text: "#E2E8F0",
          muted: "#94A3B8",
          success: "#10B981",
          error: "#EF4444",
        }
      }
    }
  },
  plugins: [],
}
