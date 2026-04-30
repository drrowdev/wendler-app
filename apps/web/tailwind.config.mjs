/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0b0b0c',
        fg: '#f5f5f5',
        muted: '#9ca3af',
        accent: '#fb923c',
        card: '#16171a',
        border: '#27272a',
      },
    },
  },
  plugins: [],
};
