import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Menlo', 'monospace'],
      },
      colors: {
        bg: {
          primary: '#09090b',
          secondary: '#18181b',
          card: '#1c1c1f',
        },
        border: {
          DEFAULT: '#27272a',
          light: '#3f3f46',
        },
        bullish: '#22c55e',
        bearish: '#ef4444',
        unusual: '#fbbf24',
        power: '#f97316',
        sweep: '#8b5cf6',
        heat: {
          cold: '#6b7280',
          warm: '#3b82f6',
          hot: '#f97316',
          fire: '#fbbf24',
        },
      },
      backgroundImage: {
        'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))',
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'slide-in': 'slideIn 0.2s ease-out',
        'flash': 'flash 0.4s ease-out',
      },
      keyframes: {
        slideIn: { from: { opacity: '0', transform: 'translateY(-4px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        flash: { '0%,100%': { opacity: '1' }, '50%': { opacity: '0.3' } },
      },
    },
  },
  plugins: [],
}

export default config
