// orbital.js — Ostranauts orbital position + intercept-bearing math.
//
// All math here is a faithful re-implementation of the game's `BodyOrbit` class
// from Assembly-CSharp.dll (see ORBITAL_INTERCEPT_REPORT.md). The model is a
// planar, Sun-at-origin, AU-based, fully Keplerian solve:
//   mean anomaly -> eccentric anomaly (Newton's method) -> focus-shifted rotated
//   ellipse -> recursive parent addition.
//
// This file is intentionally self-contained except for `computePlan`, the burn
// solver it shares with the main tool. No orbital logic lives in physics.js.

import { computePlan } from './physics.js';

// ───── constants (DLL-confirmed) ────────────────────────────────────────────
const SECY = 31_556_926.0;            // seconds per year (DLL: fPeriod = years * this)
const GRAV = 2e-44;                   // fGravAccelConstant, AU^3 * kg^-1 * s^-2
const M_SOL = 1.9891e30;             // Sol mass (kg), Kepler scaling base (boStar.fMass)
const DAY = 87_658.125;              // game day (s); rotation period = days * DAY
const AU_KM = 149_597_870;           // km per AU (used for body radius -> AU)
// Meters per AU. We use the main tool's AU value for solver consistency; the DLL
// itself mixes 149597872 km and 149597863936 m — the ~1e-5 delta is irrelevant.
export const AU_M = 149_597_870_000;
// Ground-station surface offset: MINSTATIONSIZE (1500 m) converted to AU.
const MIN_STATION_AU = 1500 * 6.684587e-12;

// ───── body/station data (baked from star_systems/star_system.json, NewGame) ──
// Generated and numerically validated against the DLL formula. Fields are the
// raw spawn values; orbital geometry is derived at runtime in resolveOrbit().
//   nav      — true if shown in the dropdowns (false = placeholder used only as
//              a parent in the position chain).
//   tier     — 1 Planets, 2 Major Moons, 3 Minor Bodies & Asteroids,
//              4 Minor Moons, 5 Stations (0 = hidden placeholder).
//   orbitType— station spawn type: GEO | GROUND | ORBIT | EX (null for bodies).
//   period   — fOrbitalPeriodYears (negative = retrograde; null = derive it).
//   periAU/apoAU — fPeriapsisAU/fApoapsisAU (null = derive from period).
export const BODIES = [
  { name: "Mercury", parent: "Sol", kind: "body", nav: true, tier: 1, orbitType: null, deg: 48.3, ecc: 0.206, period: 0.241, periAU: null, apoAU: null, mass: 3.3e+23, rotDays: 59, radiusKM: 2440 },
  { name: "Venus", parent: "Sol", kind: "body", nav: true, tier: 1, orbitType: null, deg: 76.7, ecc: 0.0067, period: 0.615, periAU: null, apoAU: null, mass: 4.7e+24, rotDays: 243, radiusKM: 6052 },
  { name: "Earth", parent: "Sol", kind: "body", nav: true, tier: 1, orbitType: null, deg: -11.2, ecc: 0.0167, period: 1, periAU: null, apoAU: null, mass: 5.97e+24, rotDays: 0.99, radiusKM: 6371 },
  { name: "Mars", parent: "Sol", kind: "body", nav: true, tier: 1, orbitType: null, deg: 49.6, ecc: 0.094, period: 1.88, periAU: null, apoAU: null, mass: 6.4e+23, rotDays: 1.02, radiusKM: 3390 },
  { name: "1036 Ganymed", parent: "Sol", kind: "body", nav: true, tier: 3, orbitType: null, deg: 215.556, ecc: 0.5335, period: 4.35, periAU: null, apoAU: null, mass: 33000000000000000, rotDays: 0.416, radiusKM: 17.5 },
  { name: "OKLGAsteroidFieldCentral", parent: "Sol", kind: "body", nav: false, tier: 0, orbitType: null, deg: 215.5599, ecc: 0.5335, period: 4.35, periAU: null, apoAU: null, mass: 10, rotDays: 0.416, radiusKM: 17.5 },
  { name: "Ceres", parent: "Sol", kind: "body", nav: true, tier: 3, orbitType: null, deg: 80.32, ecc: 0.08, period: 4.6, periAU: null, apoAU: null, mass: 940000000000000000000, rotDays: 0.375, radiusKM: 476 },
  { name: "CeresAsteroidFieldCentral", parent: "Sol", kind: "body", nav: false, tier: 0, orbitType: null, deg: 80.322, ecc: 0.08, period: 4.6, periAU: null, apoAU: null, mass: 10, rotDays: 0.375, radiusKM: 500 },
  { name: "BCRS_Anchor", parent: "Sol", kind: "body", nav: false, tier: 0, orbitType: null, deg: 80.3241, ecc: 0.08, period: 4.6, periAU: null, apoAU: null, mass: 10, rotDays: 0.375, radiusKM: 500 },
  { name: "Vesta", parent: "Sol", kind: "body", nav: true, tier: 3, orbitType: null, deg: 103.8, ecc: 0.08874, period: 3.63, periAU: null, apoAU: null, mass: 259000000000000000000, rotDays: 0.2226, radiusKM: 262 },
  { name: "Pallas", parent: "Sol", kind: "body", nav: true, tier: 3, orbitType: null, deg: 173.08, ecc: 0.2305, period: 4.62, periAU: null, apoAU: null, mass: 210000000000000000000, rotDays: 0.325, radiusKM: 256 },
  { name: "Hygeia", parent: "Sol", kind: "body", nav: true, tier: 3, orbitType: null, deg: 283.2, ecc: 0.1125, period: 5.27, periAU: null, apoAU: null, mass: 85500000000000000000, rotDays: 1.15, radiusKM: 222 },
  { name: "Jupiter", parent: "Sol", kind: "body", nav: true, tier: 1, orbitType: null, deg: 100.464, ecc: 0.0489, period: 11.862, periAU: null, apoAU: null, mass: 1.9e+27, rotDays: 0.414, radiusKM: 69812 },
  { name: "Saturn", parent: "Sol", kind: "body", nav: true, tier: 1, orbitType: null, deg: 113.6, ecc: 0.056, period: 29.46, periAU: null, apoAU: null, mass: 5.7e+26, rotDays: 0, radiusKM: 58133 },
  { name: "Uranus", parent: "Sol", kind: "body", nav: true, tier: 1, orbitType: null, deg: 74, ecc: 0.047, period: 84.02, periAU: null, apoAU: null, mass: 8.7e+25, rotDays: 0, radiusKM: 25263 },
  { name: "Neptune", parent: "Sol", kind: "body", nav: true, tier: 1, orbitType: null, deg: 131.8, ecc: 0.0113, period: 164.8, periAU: null, apoAU: null, mass: 1.02e+26, rotDays: 0, radiusKM: 24522 },
  { name: "588 Achilles", parent: "Sol", kind: "body", nav: true, tier: 3, orbitType: null, deg: 315.54, ecc: 0.1463, period: 11.862, periAU: null, apoAU: null, mass: 2600000000000000000, rotDays: 0.304, radiusKM: 65 },
  { name: "617 Patroclus", parent: "Sol", kind: "body", nav: true, tier: 3, orbitType: null, deg: 44.354, ecc: 0.1382, period: 11.862, periAU: null, apoAU: null, mass: 1360000000000000000, rotDays: 4.29, radiusKM: 70 },
  { name: "Pluto", parent: "Sol", kind: "body", nav: true, tier: 3, orbitType: null, deg: 11.3, ecc: 0.245, period: 247.7, periAU: null, apoAU: null, mass: 1.3e+22, rotDays: 0, radiusKM: 1184 },
  { name: "Makemake", parent: "Sol", kind: "body", nav: true, tier: 3, orbitType: null, deg: 79, ecc: 0.156, period: 309.1, periAU: null, apoAU: null, mass: 8.3e+21, rotDays: 0, radiusKM: 716 },
  { name: "Haumea", parent: "Sol", kind: "body", nav: true, tier: 3, orbitType: null, deg: 122, ecc: 0.191, period: 284.1, periAU: null, apoAU: null, mass: 4e+21, rotDays: 0, radiusKM: 620 },
  { name: "Eris", parent: "Sol", kind: "body", nav: true, tier: 3, orbitType: null, deg: 35.9, ecc: 0.441, period: 558, periAU: null, apoAU: null, mass: 1.7e+22, rotDays: 0, radiusKM: 1164 },
  { name: "Sedna", parent: "Sol", kind: "body", nav: true, tier: 3, orbitType: null, deg: 144.5, ecc: 0.855, period: 11400, periAU: null, apoAU: null, mass: 9.5e+21, rotDays: 0, radiusKM: 996 },
  { name: "2007OR10", parent: "Sol", kind: "body", nav: true, tier: 3, orbitType: null, deg: 337, ecc: 0.506, period: 546.6, periAU: null, apoAU: null, mass: 1.6e+22, rotDays: 0, radiusKM: 1280 },
  { name: "Quaoar", parent: "Sol", kind: "body", nav: true, tier: 3, orbitType: null, deg: 189, ecc: 0.039, period: 286, periAU: null, apoAU: null, mass: 1.4e+21, rotDays: 0, radiusKM: 1111 },
  { name: "Orcus", parent: "Sol", kind: "body", nav: true, tier: 3, orbitType: null, deg: 267, ecc: 0.227, period: 245.2, periAU: null, apoAU: null, mass: 640000000000000000000, rotDays: 0, radiusKM: 917 },
  { name: "Ultima Thule", parent: "Sol", kind: "body", nav: true, tier: 3, orbitType: null, deg: 158, ecc: 0.041, period: 298, periAU: null, apoAU: null, mass: 10000000000000000, rotDays: 0, radiusKM: 16 },
  { name: "Bowie", parent: "Sol", kind: "body", nav: true, tier: 3, orbitType: null, deg: 131.8, ecc: 0.467, period: 15392, periAU: null, apoAU: null, mass: 2.13e+23, rotDays: 0, radiusKM: 3637 },
  { name: "79au", parent: "Sol", kind: "body", nav: true, tier: 3, orbitType: null, deg: 196.967, ecc: 0, period: 702.047, periAU: null, apoAU: null, mass: 371000000000, rotDays: 0, radiusKM: 166 },
  { name: "Luna", parent: "Earth", kind: "body", nav: true, tier: 2, orbitType: null, deg: 80, ecc: 0.0549, period: 0.074794521, periAU: null, apoAU: null, mass: 7.34e+22, rotDays: 27.32, radiusKM: 1737 },
  { name: "Phobos", parent: "Mars", kind: "body", nav: true, tier: 2, orbitType: null, deg: 48, ecc: 0.0151, period: 0.000873973, periAU: null, apoAU: null, mass: 10700000000000000, rotDays: 0.3189, radiusKM: 11.267 },
  { name: "Deimos", parent: "Mars", kind: "body", nav: true, tier: 2, orbitType: null, deg: 56, ecc: 0.0003, period: 0.003460274, periAU: null, apoAU: null, mass: 1480000000000000, rotDays: 1.263, radiusKM: 6.2 },
  { name: "Ganymede", parent: "Jupiter", kind: "body", nav: true, tier: 2, orbitType: null, deg: 40, ecc: 0.0013, period: 0.0196, periAU: null, apoAU: null, mass: 1.48e+23, rotDays: 7.155, radiusKM: 2634.1 },
  { name: "Io", parent: "Jupiter", kind: "body", nav: true, tier: 2, orbitType: null, deg: 264, ecc: 0.0041, period: 0.004846575, periAU: null, apoAU: null, mass: 8.93e+22, rotDays: 1.769, radiusKM: 1821.6 },
  { name: "Europa", parent: "Jupiter", kind: "body", nav: true, tier: 2, orbitType: null, deg: 176, ecc: 0.009, period: 0.009728767, periAU: null, apoAU: null, mass: 4.8e+22, rotDays: 3.551, radiusKM: 1560.8 },
  { name: "Amalthea", parent: "Jupiter", kind: "body", nav: true, tier: 4, orbitType: null, deg: 264, ecc: 0.003, period: 0.001364384, periAU: null, apoAU: null, mass: 2080000000000000000, rotDays: 0.498, radiusKM: 83.5 },
  { name: "Himalia", parent: "Jupiter", kind: "body", nav: true, tier: 4, orbitType: null, deg: 112, ecc: 0.16, period: 0.686465753, periAU: null, apoAU: null, mass: 6700000000000000000, rotDays: 0.32425, radiusKM: 75 },
  { name: "Thebe", parent: "Jupiter", kind: "body", nav: true, tier: 4, orbitType: null, deg: 96, ecc: 0.0175, period: 0.001846575, periAU: null, apoAU: null, mass: 430000000000000000, rotDays: 0.675, radiusKM: 49.3 },
  { name: "Elara", parent: "Jupiter", kind: "body", nav: true, tier: 4, orbitType: null, deg: 136, ecc: 0.22, period: 0.711342466, periAU: null, apoAU: null, mass: 870000000000000000, rotDays: 0.5, radiusKM: 43 },
  { name: "Pasiphae", parent: "Jupiter", kind: "body", nav: true, tier: 4, orbitType: null, deg: 192, ecc: 0.2953, period: -2.093369863, periAU: null, apoAU: null, mass: 300000000000000000, rotDays: 764.08, radiusKM: 20 },
  { name: "Metis", parent: "Jupiter", kind: "body", nav: true, tier: 4, orbitType: null, deg: 128, ecc: 0.0002, period: 0.000794521, periAU: null, apoAU: null, mass: 36000000000000000, rotDays: 0.295, radiusKM: 21.5 },
  { name: "Carme", parent: "Jupiter", kind: "body", nav: true, tier: 4, orbitType: null, deg: 264, ecc: 0.25, period: -1.924054795, periAU: null, apoAU: null, mass: 130000000000000000, rotDays: 702.28, radiusKM: 23 },
  { name: "Sinope", parent: "Jupiter", kind: "body", nav: true, tier: 4, orbitType: null, deg: 48, ecc: 0.25, period: -1.983835616, periAU: null, apoAU: null, mass: 75000000000000000, rotDays: 724.1, radiusKM: 19 },
  { name: "Lysithea", parent: "Jupiter", kind: "body", nav: true, tier: 4, orbitType: null, deg: 56, ecc: 0.11, period: 0.710136986, periAU: null, apoAU: null, mass: 63000000000000000, rotDays: 259.2, radiusKM: 18 },
  { name: "Ananke", parent: "Jupiter", kind: "body", nav: true, tier: 4, orbitType: null, deg: 312, ecc: 0.24, period: -1.672465753, periAU: null, apoAU: null, mass: 30000000000000000, rotDays: 610.45, radiusKM: 14 },
  { name: "Callisto", parent: "Jupiter", kind: "body", nav: true, tier: 2, orbitType: null, deg: 0, ecc: 0.0074, period: 0.045723288, periAU: null, apoAU: null, mass: 1.08e+23, rotDays: 16.689, radiusKM: 2410.3 },
  { name: "Titan", parent: "Saturn", kind: "body", nav: true, tier: 2, orbitType: null, deg: 120, ecc: 0.0288, period: 0.043684932, periAU: null, apoAU: null, mass: 1.35e+23, rotDays: 15.945, radiusKM: 2575 },
  { name: "Rhea", parent: "Saturn", kind: "body", nav: true, tier: 2, orbitType: null, deg: 328, ecc: 0.00126, period: 0.012378082, periAU: null, apoAU: null, mass: 2.31e+21, rotDays: 4.518, radiusKM: 763.8 },
  { name: "Iapetus", parent: "Saturn", kind: "body", nav: true, tier: 2, orbitType: null, deg: 56, ecc: 0.02768, period: 0.217320548, periAU: null, apoAU: null, mass: 1.81e+21, rotDays: 79.322, radiusKM: 734.5 },
  { name: "Dione", parent: "Saturn", kind: "body", nav: true, tier: 2, orbitType: null, deg: 264, ecc: 0.0022, period: 0.00749863, periAU: null, apoAU: null, mass: 1.1e+21, rotDays: 2.737, radiusKM: 561.4 },
  { name: "Tethys", parent: "Saturn", kind: "body", nav: true, tier: 2, orbitType: null, deg: 168, ecc: 0.0001, period: 0.005172603, periAU: null, apoAU: null, mass: 617000000000000000000, rotDays: 1.888, radiusKM: 531.1 },
  { name: "Enceladus", parent: "Saturn", kind: "body", nav: true, tier: 2, orbitType: null, deg: 144, ecc: 0.0047, period: 0.003753425, periAU: null, apoAU: null, mass: 108000000000000000000, rotDays: 1.37, radiusKM: 252.1 },
  { name: "Mimas", parent: "Saturn", kind: "body", nav: true, tier: 2, orbitType: null, deg: 96, ecc: 0.0196, period: 0.002580822, periAU: null, apoAU: null, mass: 37500000000000000000, rotDays: 0.942, radiusKM: 198.2 },
  { name: "Triton", parent: "Neptune", kind: "body", nav: true, tier: 2, orbitType: null, deg: 312, ecc: 0.000016, period: -0.015890411, periAU: null, apoAU: null, mass: 30000000000000000, rotDays: 0, radiusKM: 14 },
  { name: "HQCH", parent: "Mercury", kind: "station", nav: true, tier: 5, orbitType: "GEO", deg: 0, ecc: 0, period: null, periAU: null, apoAU: null, mass: 100000, rotDays: null, radiusKM: 1 },
  { name: "VNCA", parent: "Venus", kind: "station", nav: true, tier: 5, orbitType: "EX", deg: 180, ecc: 0, period: 0.0327626, periAU: 0.0000407910137, apoAU: 0.0000407910137, mass: 100000, rotDays: null, radiusKM: 1 },
  { name: "VNCA_SD", parent: "Venus", kind: "station", nav: true, tier: 5, orbitType: "EX", deg: 179.8, ecc: 0, period: 0.0327626, periAU: 0.0000407910137, apoAU: 0.0000407910137, mass: 100000, rotDays: null, radiusKM: 1 },
  { name: "VLA00", parent: "Venus", kind: "station", nav: true, tier: 5, orbitType: "EX", deg: 180.5, ecc: 0, period: 0.0327626, periAU: 0.0000407910137, apoAU: 0.0000407910137, mass: 100000, rotDays: null, radiusKM: 1 },
  { name: "VLA01", parent: "Venus", kind: "station", nav: true, tier: 5, orbitType: "EX", deg: 180.1, ecc: 0, period: 0.0327626, periAU: 0.0000407910137, apoAU: 0.0000407910137, mass: 100000, rotDays: null, radiusKM: 1 },
  { name: "VLA02", parent: "Venus", kind: "station", nav: true, tier: 5, orbitType: "EX", deg: 182, ecc: 0, period: 0.0327626, periAU: 0.0000407910137, apoAU: 0.0000407910137, mass: 100000, rotDays: null, radiusKM: 1 },
  { name: "VLA03", parent: "Venus", kind: "station", nav: true, tier: 5, orbitType: "EX", deg: 183, ecc: 0, period: 0.0327626, periAU: 0.0000407910137, apoAU: 0.0000407910137, mass: 100000, rotDays: null, radiusKM: 1 },
  { name: "VLA04", parent: "Venus", kind: "station", nav: true, tier: 5, orbitType: "EX", deg: 184, ecc: 0, period: 0.0327626, periAU: 0.0000407910137, apoAU: 0.0000407910137, mass: 100000, rotDays: null, radiusKM: 1 },
  { name: "VLA05", parent: "Venus", kind: "station", nav: true, tier: 5, orbitType: "EX", deg: 185, ecc: 0, period: 0.0327626, periAU: 0.0000407910137, apoAU: 0.0000407910137, mass: 100000, rotDays: null, radiusKM: 1 },
  { name: "VCBR", parent: "Venus", kind: "station", nav: true, tier: 5, orbitType: "EX", deg: 174.4, ecc: 0, period: 0.0327626, periAU: 0.0000407910137, apoAU: 0.0000407910137, mass: 100000, rotDays: null, radiusKM: 1 },
  { name: "VENC", parent: "Venus", kind: "station", nav: true, tier: 5, orbitType: "EX", deg: 185.6, ecc: 0, period: 0.0327626, periAU: 0.0000407910137, apoAU: 0.0000407910137, mass: 100000, rotDays: null, radiusKM: 1 },
  { name: "VENC_SVL", parent: "Venus", kind: "station", nav: true, tier: 5, orbitType: "EX", deg: 185.65, ecc: 0, period: 0.0327626, periAU: 0.0000407910137, apoAU: 0.0000407910137, mass: 100000, rotDays: null, radiusKM: 1 },
  { name: "VENC_GRN", parent: "Venus", kind: "station", nav: true, tier: 5, orbitType: "EX", deg: 185.66, ecc: 0, period: 0.0327626, periAU: 0.0000407910137, apoAU: 0.0000407910137, mass: 100000, rotDays: null, radiusKM: 1 },
  { name: "VORB", parent: "Venus", kind: "station", nav: true, tier: 5, orbitType: "EX", deg: 0, ecc: 0, period: null, periAU: 0.00004345, apoAU: 0.000116, mass: 100000, rotDays: null, radiusKM: 1 },
  { name: "VORB_HAB", parent: "Venus", kind: "station", nav: true, tier: 5, orbitType: "EX", deg: 0.2, ecc: 0, period: null, periAU: 0.00004345, apoAU: 0.000116, mass: 100000, rotDays: null, radiusKM: 1 },
  { name: "VORB|Aux", parent: "Venus", kind: "station", nav: true, tier: 5, orbitType: "EX", deg: 0, ecc: 0, period: null, periAU: 0.00004345, apoAU: 0.000116, mass: 100000, rotDays: null, radiusKM: 1 },
  { name: "EJDR", parent: "Luna", kind: "station", nav: true, tier: 5, orbitType: "GROUND", deg: 0, ecc: 0, period: null, periAU: null, apoAU: null, mass: 100000, rotDays: null, radiusKM: 1 },
  { name: "MTRS", parent: "Mars", kind: "station", nav: true, tier: 5, orbitType: "GROUND", deg: 0, ecc: 0, period: null, periAU: null, apoAU: null, mass: 100000, rotDays: null, radiusKM: 1 },
  { name: "MLAB", parent: "Mars", kind: "station", nav: true, tier: 5, orbitType: "GROUND", deg: 12, ecc: 0, period: null, periAU: null, apoAU: null, mass: 100000, rotDays: null, radiusKM: 1 },
  { name: "MHNG", parent: "Sol", kind: "station", nav: true, tier: 5, orbitType: "ORBIT", deg: 109.6, ecc: 0.094, period: 1.88, periAU: null, apoAU: null, mass: 100000, rotDays: null, radiusKM: 1 },
  { name: "MSUZ", parent: "Sol", kind: "station", nav: true, tier: 5, orbitType: "ORBIT", deg: 349.6, ecc: 0.094, period: 1.88, periAU: null, apoAU: null, mass: 100000, rotDays: null, radiusKM: 1 },
  { name: "MVOL", parent: "Deimos", kind: "station", nav: true, tier: 5, orbitType: "GROUND", deg: 0, ecc: 0, period: null, periAU: null, apoAU: null, mass: 100000, rotDays: null, radiusKM: 1 },
  { name: "COHO", parent: "CeresAsteroidFieldCentral", kind: "station", nav: true, tier: 5, orbitType: "EX", deg: 60, ecc: 0, period: 4.6, periAU: 0.00001, apoAU: 0.00001, mass: 100000, rotDays: null, radiusKM: 1 },
  { name: "BCER", parent: "Ceres", kind: "station", nav: true, tier: 5, orbitType: "GROUND", deg: 0, ecc: 0, period: null, periAU: null, apoAU: null, mass: 100000, rotDays: null, radiusKM: 1 },
  { name: "BCER_ROOF", parent: "Ceres", kind: "station", nav: true, tier: 5, orbitType: "GROUND", deg: 0.01, ecc: 0, period: null, periAU: null, apoAU: null, mass: 100000, rotDays: null, radiusKM: 1 },
  { name: "BCRS", parent: "BCRS_Anchor", kind: "station", nav: true, tier: 5, orbitType: "EX", deg: 0, ecc: 0, period: 0.416, periAU: 0.00001, apoAU: 0.00001, mass: 100000, rotDays: null, radiusKM: 1 },
  { name: "BCRS_OFF", parent: "BCRS_Anchor", kind: "station", nav: true, tier: 5, orbitType: "EX", deg: 0.01, ecc: 0, period: 0.416, periAU: 0.00001, apoAU: 0.00001, mass: 100000, rotDays: null, radiusKM: 1 },
  { name: "BCRS_RES", parent: "BCRS_Anchor", kind: "station", nav: true, tier: 5, orbitType: "EX", deg: -0.01, ecc: 0, period: 0.416, periAU: 0.00001, apoAU: 0.00001, mass: 100000, rotDays: null, radiusKM: 1 },
  { name: "BCRS_OLD", parent: "BCRS_Anchor", kind: "station", nav: true, tier: 5, orbitType: "EX", deg: -0.02, ecc: 0, period: 0.416, periAU: 0.00001, apoAU: 0.00001, mass: 100000, rotDays: null, radiusKM: 1 },
  { name: "BPAL", parent: "Pallas", kind: "station", nav: true, tier: 5, orbitType: "GROUND", deg: 0, ecc: 0, period: null, periAU: null, apoAU: null, mass: 100000, rotDays: null, radiusKM: 1 },
  { name: "OKLG", parent: "1036 Ganymed", kind: "station", nav: true, tier: 5, orbitType: "GROUND", deg: 0, ecc: 0, period: null, periAU: null, apoAU: null, mass: 100000, rotDays: null, radiusKM: 1 },
  { name: "OKLG_BIZ", parent: "1036 Ganymed", kind: "station", nav: true, tier: 5, orbitType: "GROUND", deg: 355, ecc: 0, period: null, periAU: null, apoAU: null, mass: 100000, rotDays: null, radiusKM: 1 },
  { name: "OKLG_MES", parent: "1036 Ganymed", kind: "station", nav: true, tier: 5, orbitType: "GROUND", deg: 5, ecc: 0, period: null, periAU: null, apoAU: null, mass: 100000, rotDays: null, radiusKM: 1 },
  { name: "OKLG_RES", parent: "1036 Ganymed", kind: "station", nav: true, tier: 5, orbitType: "GROUND", deg: 352, ecc: 0, period: null, periAU: null, apoAU: null, mass: 100000, rotDays: null, radiusKM: 1 },
  { name: "OKLG_UNK", parent: "1036 Ganymed", kind: "station", nav: true, tier: 5, orbitType: "GROUND", deg: 10, ecc: 0, period: null, periAU: null, apoAU: null, mass: 100000, rotDays: null, radiusKM: 1 },
  { name: "OKLG_FLOT", parent: "1036 Ganymed", kind: "station", nav: true, tier: 5, orbitType: "EX", deg: 312, ecc: 0, period: 500, periAU: 0.000010695339395629512, apoAU: 0.000010695339395629512, mass: 100000, rotDays: null, radiusKM: 1 },
  { name: "OKLG_ATC", parent: "1036 Ganymed", kind: "station", nav: true, tier: 5, orbitType: "EX", deg: 240, ecc: 0, period: 0.416, periAU: 0.000026738348489073784, apoAU: 0.000026738348489073784, mass: 100000, rotDays: null, radiusKM: 1 },
  { name: "OKLG_SEC", parent: "1036 Ganymed", kind: "station", nav: true, tier: 5, orbitType: "EX", deg: 120, ecc: 0, period: 0.416, periAU: 0.000026738348489073784, apoAU: 0.000026738348489073784, mass: 100000, rotDays: null, radiusKM: 1 },
  { name: "OKLG_NAV0", parent: "1036 Ganymed", kind: "station", nav: true, tier: 5, orbitType: "EX", deg: 0, ecc: 0, period: 0.416, periAU: 0.000026738348489073784, apoAU: 0.000026738348489073784, mass: 100000, rotDays: null, radiusKM: 1 },
  { name: "OKLG_NAV1", parent: "1036 Ganymed", kind: "station", nav: true, tier: 5, orbitType: "EX", deg: 60, ecc: 0, period: 0.416, periAU: 0.000026738348489073784, apoAU: 0.000026738348489073784, mass: 100000, rotDays: null, radiusKM: 1 },
  { name: "OKLG_NAV2", parent: "1036 Ganymed", kind: "station", nav: true, tier: 5, orbitType: "EX", deg: 180, ecc: 0, period: 0.416, periAU: 0.000026738348489073784, apoAU: 0.000026738348489073784, mass: 100000, rotDays: null, radiusKM: 1 },
  { name: "OKLG_NAV3", parent: "1036 Ganymed", kind: "station", nav: true, tier: 5, orbitType: "EX", deg: 300, ecc: 0, period: 0.416, periAU: 0.000026738348489073784, apoAU: 0.000026738348489073784, mass: 100000, rotDays: null, radiusKM: 1 },
  { name: "BWVN", parent: "OKLGAsteroidFieldCentral", kind: "station", nav: true, tier: 5, orbitType: "EX", deg: 100, ecc: 0, period: 500, periAU: null, apoAU: null, mass: 100000, rotDays: null, radiusKM: 0.5 },
  { name: "JFTS", parent: "Ganymede", kind: "station", nav: true, tier: 5, orbitType: "GROUND", deg: 0, ecc: 0, period: null, periAU: null, apoAU: null, mass: 100000, rotDays: null, radiusKM: 1 },
  { name: "JATL", parent: "Europa", kind: "station", nav: true, tier: 5, orbitType: "GROUND", deg: 0, ecc: 0, period: null, periAU: null, apoAU: null, mass: 100000, rotDays: null, radiusKM: 1 },
  { name: "JATL_SUB", parent: "Europa", kind: "station", nav: true, tier: 5, orbitType: "GROUND", deg: 359, ecc: 0, period: null, periAU: null, apoAU: null, mass: 100000, rotDays: null, radiusKM: 1 },
  { name: "JPTN", parent: "Europa", kind: "station", nav: true, tier: 5, orbitType: "GEO", deg: 0, ecc: 0, period: null, periAU: null, apoAU: null, mass: 100000, rotDays: null, radiusKM: 1 },
  { name: "SVIR", parent: "Titan", kind: "station", nav: true, tier: 5, orbitType: "GROUND", deg: 0, ecc: 0, period: null, periAU: null, apoAU: null, mass: 100000, rotDays: null, radiusKM: 1 },
];

// Special-case: Sol is the coordinate origin and the recursion base. Not in the
// dropdowns; held here so the parent chain can resolve to it.
const SOL = { name: "Sol", parent: null, mass: M_SOL, period: 1, rotDays: 24.47, radiusKM: 695510, deg: 0, ecc: 0, periAU: null, apoAU: null, orbitType: null };

const BODY_MAP = (() => {
  const m = new Map();
  m.set("Sol", SOL);
  for (const b of BODIES) m.set(b.name, b);
  return m;
})();

export const TIER_LABELS = {
  1: 'Planets',
  2: 'Major Moons',
  3: 'Minor Bodies & Asteroids',
  4: 'Minor Moons',
  5: 'Stations',
};

// ───── time helpers ─────────────────────────────────────────────────────────

/**
 * Convert a parsed game clock ({date:{y,mo,d}, seconds}) to absolute game
 * seconds (the same epoch axis the DLL uses). Calendar is fixed: 12 months of
 * 30 game-days, no leap years. When no date is present, returns the time-of-day
 * seconds only (caller should require a full date for intercept use).
 * @param {{date:{y:number,mo:number,d:number}|null, seconds:number}} parsed
 * @returns {number} absolute game seconds
 */
export function gameTimeToEpochS(parsed) {
  if (!parsed) return NaN;
  const { date, seconds } = parsed;
  if (!date) return seconds;
  return (
    date.y * SECY +
    (date.mo - 1) * (30 * DAY) +
    (date.d - 1) * DAY +
    seconds
  );
}

// ───── Kepler solver (mirrors DLL BodyOrbit.SolveBigE) ───────────────────────

/**
 * Solve Kepler's equation E - e*sin(E) = M by Newton's method.
 * Matches the DLL exactly: 10-iter cap, initial guess M (e<0.8) or PI, tol 1e-6,
 * result wrapped to [0,2PI) plus the full-revolution count from M.
 * @param {number} meanAnomaly
 * @param {number} eccentricity
 * @returns {number} eccentric anomaly E
 */
export function solveBigE(meanAnomaly, eccentricity) {
  const wrap = (E) => {
    const turns = Math.floor(meanAnomaly / (Math.PI * 2));
    let r = E % (Math.PI * 2);
    if (r < 0) r += Math.PI * 2;
    return r + Math.PI * 2 * turns;
  };
  let E = eccentricity < 0.8 ? meanAnomaly : Math.PI;
  for (let i = 0; i < 10; i++) {
    const f = E - eccentricity * Math.sin(E) - meanAnomaly;
    if (Math.abs(f) < 1e-6) return wrap(E);
    let d = 1.0 - eccentricity * Math.cos(E);
    if (Math.abs(d) < 1e-10) d = d >= 0 ? 1e-10 : -1e-10;
    E -= f / d;
  }
  return wrap(E);
}

// ───── orbit resolution (mirrors DLL spawn paths + constructor) ──────────────

function parentRotPeriodSec(parent) {
  // BodyOrbit ctor: if rotation period is 0/absent, falls back to orbital years*365.
  let rd = parent.rotDays;
  if (rd == null || rd === 0) rd = Math.abs(parent.period) * 365;
  return rd * DAY;
}

// Kepler third law as the DLL does it (CalculatePAFromET): semi-major axis in AU
// from period (years) and parent/star mass ratio, then peri/apo from eccentricity.
function paFromET(ecc, periodYr, parent) {
  const k = Math.pow(parent.mass / M_SOL, 1 / 3);
  const a = Math.pow(Math.abs(periodYr), 2 / 3) * k;
  return [a * (1 - ecc), a * (1 + ecc)];
}

// Inverse (CalculatePeriodFromPAET): period (years) from AU peri/apo + parent mass.
function periodFromPA(peri, apo, massParent) {
  const a = (peri + apo) / 2;
  return (Math.PI * 2 * Math.sqrt((a * a * a) / GRAV / massParent)) / SECY;
}

/**
 * Resolve a body/station entry to its ellipse geometry, replicating the exact
 * DLL spawn path for its type. Returns peri/apo (AU), eccentricity, orbit
 * rotation (deg), and the signed period in seconds (negative = retrograde).
 */
function resolveOrbit(entry) {
  const parent = BODY_MAP.get(entry.parent) || SOL;
  let perih, aph, periodYr;
  let ecc = entry.ecc;

  if (entry.orbitType === 'GEO') {
    // AddGeoStation: period = parent rotation period; PA derived from period+ecc.
    periodYr = parentRotPeriodSec(parent) / SECY;
    [perih, aph] = paFromET(ecc, periodYr, parent);
  } else if (entry.orbitType === 'GROUND') {
    // AddGroundStation: sits at parent surface; period = parent rotation period.
    periodYr = parentRotPeriodSec(parent) / SECY;
    const r = parent.radiusKM / AU_KM + MIN_STATION_AU;
    perih = r;
    aph = r;
  } else if (entry.orbitType === 'ORBIT') {
    // AddOrbitStation: PA derived from the station's own period+ecc.
    periodYr = entry.period;
    [perih, aph] = paFromET(ecc, periodYr, parent);
  } else if (entry.periAU != null && entry.apoAU != null) {
    // EX station (or any entry) with explicit AU peri/apo.
    perih = entry.periAU;
    aph = entry.apoAU;
    periodYr = entry.period != null ? entry.period : periodFromPA(perih, aph, parent.mass);
    // BodyOrbit ctor derives eccentricity from peri/apo when ecc was left 0.
    if (ecc === 0 && Math.abs(perih - aph) > 1e-7) ecc = (aph - perih) / (aph + perih);
  } else {
    // Plain body, or EX station given only a period: derive PA via Kepler.
    periodYr = entry.period;
    [perih, aph] = paFromET(ecc, periodYr, parent);
  }
  return { perih, aph, ecc, deg: entry.deg, Psec: periodYr * SECY };
}

// ───── position / velocity ──────────────────────────────────────────────────

/**
 * Position of a named body at game time T_s (absolute game seconds), in AU,
 * Sun at origin. Mirrors BodyOrbit.UpdateTime (bCorrectTimes=true), including
 * the recursive parent-position addition. fPeriodShift is 0 for all spawn
 * bodies, so it is omitted.
 * @param {string} name
 * @param {number} T_s
 * @returns {{x:number, y:number}}
 */
export function bodyPositionAU(name, T_s) {
  if (name === 'Sol') return { x: 0, y: 0 };
  const entry = BODY_MAP.get(name);
  if (!entry) throw new Error(`Unknown body: ${name}`);
  const { perih, aph, ecc, deg, Psec } = resolveOrbit(entry);

  const axis1 = perih + aph;                       // 2a
  const axis2 = axis1 * Math.sqrt(1 - ecc * ecc);  // 2b
  const M = (Math.PI * 2 * (T_s % Psec)) / Psec;   // mean anomaly (Psec may be < 0 = retrograde)
  const E = solveBigE(M, ecc);

  const xTrack = (axis1 / 2) * Math.cos(E);        // a*cosE
  const yTrack = (axis2 / 2) * Math.sin(E);        // b*sinE  (nOrbitDirection = 1 for spawn bodies)
  const dx = xTrack - (axis1 / 2 - perih);         // shift focus to parent: -a*e
  const dy = yTrack;

  const ang = (deg % 360) * (Math.PI / 180);
  const c = Math.cos(ang), s = Math.sin(ang);
  let x = dx * c - dy * s;
  let y = dx * s + dy * c;

  const p = bodyPositionAU(entry.parent || 'Sol', T_s);
  x += p.x;
  y += p.y;
  return { x, y };
}

/**
 * Velocity of a named body at game time T_s, in AU/s, via the same one-second
 * finite difference the DLL uses (UpdateTime bCalcV path).
 * @param {string} name
 * @param {number} T_s
 * @returns {{vx:number, vy:number}}
 */
export function bodyVelocityAU_s(name, T_s) {
  const a = bodyPositionAU(name, T_s - 1);
  const b = bodyPositionAU(name, T_s);
  return { vx: b.x - a.x, vy: b.y - a.y };
}

// ───── dropdown helpers ─────────────────────────────────────────────────────

/** Display label for a body/station — annotates moons/stations with their parent. */
export function bodyLabel(entry) {
  if (entry.kind === 'station' || entry.tier === 2 || entry.tier === 4) {
    return `${entry.name} (${entry.parent})`;
  }
  return entry.name;
}

/** Grouped, dropdown-ready structure: tiers 1..5 with their nav-visible bodies. */
export function navBodyGroups() {
  const groups = [];
  for (const tier of [1, 2, 3, 4, 5]) {
    const members = BODIES.filter((b) => b.nav && b.tier === tier);
    if (members.length) groups.push({ tier, label: TIER_LABELS[tier], members });
  }
  return groups;
}

// ───── intercept solve ──────────────────────────────────────────────────────

function distAU(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Normalize an angle in degrees to [0, 360). */
function normalize360(deg) {
  let d = deg % 360;
  if (d < 0) d += 360;
  return d;
}

/**
 * Two-pass intercept solve. The ship departs the origin body at T0; we compute
 * where the destination body will be after the burn travel time, then the
 * bearing to fly. The burn solver runs twice — once with the straight-line range
 * now, then again with the range to the destination's future position.
 *
 * NOTE on bearing convention: the returned bearing assumes +Y = "north/up" and
 * clockwise degrees (atan2(ΔX, ΔY)). The game does not expose coordinates, so
 * this handedness is UNCONFIRMED and must be validated in-game before the
 * bearing readout is trusted. Position math (range, Δt) is unaffected.
 *
 * @param {object} p
 * @param {string} p.originName
 * @param {string} p.destName
 * @param {number} p.T0_s              departure time, absolute game seconds
 * @param {number} p.v0_mps           current VREL (m/s; + = closing)
 * @param {number} p.accel_ms2        acceleration (m/s²)
 * @param {number} p.vArrival_mps     desired arrival velocity (m/s)
 * @param {number} p.flipTime_s       flip time (s)
 * @returns {{bearing_deg:number, deltaT_s:number, range_m:number,
 *           originPos:{x,y}, destPos:{x,y}, plan:object} | {error:string, plan?:object}}
 */
export function interceptBearing({
  originName,
  destName,
  T0_s,
  v0_mps,
  accel_ms2,
  vArrival_mps,
  flipTime_s,
}) {
  if (!BODY_MAP.has(originName)) return { error: `Unknown origin: ${originName}` };
  if (!BODY_MAP.has(destName)) return { error: `Unknown destination: ${destName}` };
  if (!isFinite(T0_s)) return { error: 'INVALID GAME TIME' };

  const originPos = bodyPositionAU(originName, T0_s);

  const solveAt = (range_m) =>
    computePlan({
      distance_m: range_m,
      v0_mps,
      a_mps2: accel_ms2,
      v_arrival_mps: vArrival_mps,
      t_rotate_s: flipTime_s,
    });

  // Pass 1 — range to the destination's present position.
  let range_m = distAU(originPos, bodyPositionAU(destName, T0_s)) * AU_M;
  let plan = solveAt(range_m);
  if (plan.error) return { error: plan.error, plan };
  if (plan.overshoot) return { error: 'CANNOT BRAKE IN TIME', plan };

  // Pass 2 — range to where the destination will be at arrival.
  let destPos = bodyPositionAU(destName, T0_s + plan.t_total);
  range_m = distAU(originPos, destPos) * AU_M;
  plan = solveAt(range_m);
  if (plan.error) return { error: plan.error, plan };
  if (plan.overshoot) return { error: 'CANNOT BRAKE IN TIME', plan };

  // Final destination position at the refined arrival time.
  destPos = bodyPositionAU(destName, T0_s + plan.t_total);
  range_m = distAU(originPos, destPos) * AU_M;

  const dxe = destPos.x - originPos.x;
  const dye = destPos.y - originPos.y;
  const bearing_deg = normalize360((Math.atan2(dxe, dye) * 180) / Math.PI);

  return {
    bearing_deg,
    deltaT_s: plan.t_total,
    range_m,
    originPos,
    destPos,
    plan,
  };
}
