# Polaris Astronautics Manual Torch Burn Guidance Computer

A single-page trajectory calculator for torch drive burns in [Ostranauts](https://bluebottlegames.com/games/ostranauts).

**Live:** https://bandus.github.io/torch-burn-computer

---

## What it does

Given your ship's current nav readings (range, relative velocity, cross-track velocity) and vessel parameters (max acceleration, flip time), the computer outputs:

- **Burn Plan mode** — flip-and-burn trajectory: accel duration, flip time, brake duration, total travel time, and game-clock targets for each phase
- **Final Approach mode** — constant-brake approach: coast time and brake duration to reach a target cutoff speed

---

## Quick start

1. Open the live URL above (or run locally — see below)
2. Enter your current readings from the in-game nav panel: Range, VREL, VCRS
3. Enter your vessel parameters: Max Acceleration (in G), Flip Time (in seconds)
4. Results appear automatically

---

## Running locally

```
npm install
npm run dev
```

Dev server runs at `http://localhost:5173`.

---

## Deploying

```
npm run build          # verify the build is clean
npm run deploy         # builds and pushes to gh-pages branch
```

Always confirm `APP_VERSION` before deploying:

```
grep APP_VERSION src/App.jsx
```

---

## Running tests

```
npm test
```

Tests cover all physics solvers, parsers, and formatters in `src/physics.js`.

---

## Stack

- React 19 + Vite 8
- `src/App.jsx` — React components
- `src/physics.js` — pure solvers, parsers, and formatters
- `src/styles.css` — all styles
- Deployed to GitHub Pages via `gh-pages`

---

## Physics notes

| Constant | Value | Notes |
|---|---|---|
| G | 9.80665 m/s² | Standard gravity |
| DAY | 87,659 s | Ostranauts game day (24h + untime through 24:20:58) |
| NO_WAKE_M | 300,000 m | No-wake zone radius |
| AU | 149,597,870,700 m | Astronomical unit |

VREL and VCRS are independent axes in-game — no vector combination is applied.
