module.exports = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx}",
    "./pages/**/*.{js,ts,jsx,tsx}",
    "./components/**/*.{js,ts,jsx,tsx}",
    "./src/**/*.{js,ts,jsx,tsx}", // Yeh line add ki hai safe side ke liye
  ],
  theme: {
    extend: {
      colors: {
        // 'premium' object hata kar direct premium- prefix de diya
        "premium-bg": "#0B0E14",
        "premium-card": "#131A24",
        "premium-border": "#1F2937",
        "premium-accent": "#3B82F6",
        "premium-accent-glow": "#60A5FA",
        "premium-text": "#E2E8F0",
        "premium-muted": "#94A3B8",
        "premium-success": "#10B981",
        "premium-error": "#EF4444",
      },
    },
  },
  plugins: [],
}
