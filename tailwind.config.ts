import type { Config } from 'tailwindcss';

/**
 * Dark industrial DAW palette.
 *
 * Design rule enforced structurally rather than by convention: there are no
 * boxShadow or gradient utilities configured, and borderRadius tops out at 4px.
 * If a utility does not exist, nobody can accidentally use it.
 *
 * The five lane colours are the ONLY chroma in the app and belong exclusively to
 * their note lanes (and the lane buttons that mirror them). All other chrome is
 * strictly monochrome.
 */
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    // Replaces (not extends) the defaults so shadows/gradients/large radii are gone.
    boxShadow: { none: 'none' },
    borderRadius: {
      none: '0',
      DEFAULT: '0',
      sm: '2px',
      md: '4px',
    },
    extend: {
      colors: {
        bg: '#0a0a0a',
        panel: '#121212',
        panel2: '#181818',
        edge: '#262626',
        edge2: '#333333',
        fg: '#e5e5e5',
        muted: '#8a8a8a',
        faint: '#5a5a5a',
        danger: '#c6413b',
        lane: {
          green: '#46C646',
          red: '#C6413B',
          yellow: '#C6C13B',
          blue: '#3B6EC6',
          orange: '#E88A2E',
        },
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', 'Inter', 'Helvetica Neue', 'Arial', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      fontSize: {
        '2xs': ['10px', '14px'],
      },
    },
  },
  plugins: [],
};

export default config;
