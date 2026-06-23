import { describe, it, expect } from 'vitest';
import {
  BODIES,
  AU_M,
  solveBigE,
  bodyPositionAU,
  bodyVelocityAU_s,
  gameTimeToEpochS,
  interceptBearing,
  navBodyGroups,
} from './orbital.js';

// Scenario epoch from star_system.json (NewGame dfEpoch), in absolute game seconds.
const EPOCH = 65627498854.0278;
const AU_KM = AU_M / 1000;

const posKm = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) * AU_KM;
const rFromSun = (name, t) => {
  const p = bodyPositionAU(name, t);
  return Math.hypot(p.x, p.y);
};

describe('solveBigE', () => {
  it('is identity at e=0 (E === M wrapped)', () => {
    for (const M of [0.1, 1.0, 3.0, 5.5]) {
      expect(solveBigE(M, 0)).toBeCloseTo(M, 9);
    }
  });

  it('satisfies Kepler equation E - e*sinE = M across eccentricities', () => {
    const cases = [
      [0.5, 0.0167], // Earth
      [1.0, 0.206], // Mercury
      [2.7, 0.441], // Eris
      [4.2, 0.855], // Sedna (high-e)
      [0.3, 0.5335], // 1036 Ganymed
    ];
    for (const [M, e] of cases) {
      const E = solveBigE(M, e);
      const recovered = E - e * Math.sin(E);
      expect(recovered).toBeCloseTo(M, 5);
    }
  });
});

describe('gameTimeToEpochS', () => {
  it('returns time-of-day seconds when no date is present', () => {
    expect(gameTimeToEpochS({ date: null, seconds: 1234 })).toBe(1234);
  });

  it('uses fixed 30-day months and 87,658.125 s days', () => {
    // One full year + one month + one day + 100 s above the y/mo/d base.
    const t = gameTimeToEpochS({ date: { y: 1, mo: 2, d: 2 }, seconds: 100 });
    expect(t).toBeCloseTo(31556926 + 30 * 87658.125 + 87658.125 + 100, 3);
  });
});

describe('bodyPositionAU — validated against the report values at epoch', () => {
  it('Sol is the origin', () => {
    expect(bodyPositionAU('Sol', EPOCH)).toEqual({ x: 0, y: 0 });
  });

  it('Venus is ~0.728 AU from the Sun', () => {
    expect(rFromSun('Venus', EPOCH)).toBeCloseTo(0.728, 2);
  });

  it('Earth is ~1.010 AU from the Sun', () => {
    expect(rFromSun('Earth', EPOCH)).toBeCloseTo(1.010, 2);
  });

  it('Mars is ~1.491 AU from the Sun', () => {
    expect(rFromSun('Mars', EPOCH)).toBeCloseTo(1.491, 2);
  });

  it('Luna sits ~366,000 km from Earth', () => {
    const d = posKm(bodyPositionAU('Luna', EPOCH), bodyPositionAU('Earth', EPOCH));
    expect(d).toBeGreaterThan(355_000);
    expect(d).toBeLessThan(375_000);
  });

  it('retrograde bodies (Triton) resolve to a finite position', () => {
    const p = bodyPositionAU('Triton', EPOCH);
    expect(Number.isFinite(p.x)).toBe(true);
    expect(Number.isFinite(p.y)).toBe(true);
  });

  it('throws on an unknown body', () => {
    expect(() => bodyPositionAU('Nibiru', EPOCH)).toThrow();
  });
});

describe('stations sit close to their parent bodies', () => {
  const within = (station, parent, maxKm) =>
    expect(posKm(bodyPositionAU(station, EPOCH), bodyPositionAU(parent, EPOCH))).toBeLessThan(maxKm);

  it('OKLG (GROUND) hugs 1036 Ganymed', () => within('OKLG', '1036 Ganymed', 100));
  it('EJDR (GROUND) hugs Luna', () => within('EJDR', 'Luna', 2_000));
  it('VNCA (EX) is a low Venus orbit', () => within('VNCA', 'Venus', 8_000));
  it('HQCH (GEO) orbits Mercury', () => within('HQCH', 'Mercury', 500_000));

  it('every body/station resolves to a finite position', () => {
    for (const b of BODIES) {
      const p = bodyPositionAU(b.name, EPOCH);
      expect(Number.isFinite(p.x), `${b.name}.x`).toBe(true);
      expect(Number.isFinite(p.y), `${b.name}.y`).toBe(true);
    }
  });
});

describe('bodyVelocityAU_s', () => {
  it('Earth orbital speed is ~30 km/s', () => {
    const v = bodyVelocityAU_s('Earth', EPOCH);
    const speed_ms = Math.hypot(v.vx, v.vy) * AU_M; // AU/s -> m/s
    expect(speed_ms).toBeGreaterThan(25_000);
    expect(speed_ms).toBeLessThan(35_000);
  });
});

describe('navBodyGroups', () => {
  it('exposes all five tiers and excludes hidden placeholders', () => {
    const groups = navBodyGroups();
    expect(groups.map((g) => g.tier)).toEqual([1, 2, 3, 4, 5]);
    const names = groups.flatMap((g) => g.members.map((m) => m.name));
    expect(names).not.toContain('OKLGAsteroidFieldCentral');
    expect(names).not.toContain('BCRS_Anchor');
    expect(names).toContain('OKLG');
    expect(names).toContain('Venus');
  });
});

describe('interceptBearing', () => {
  const baseInputs = {
    T0_s: EPOCH,
    v0_mps: 0,
    accel_ms2: 1 * 9.80665, // 1 G
    vArrival_mps: 0,
    flipTime_s: 60,
  };

  it('solves an OKLG -> Venus intercept with a sane bearing and Δt', () => {
    const r = interceptBearing({ ...baseInputs, originName: 'OKLG', destName: 'Venus' });
    expect(r.error).toBeUndefined();
    expect(r.bearing_deg).toBeGreaterThanOrEqual(0);
    expect(r.bearing_deg).toBeLessThan(360);
    expect(r.deltaT_s).toBeGreaterThan(0);
    expect(r.range_m).toBeGreaterThan(0);
  });

  it('refined range accounts for destination motion (pass 2 != pass 1)', () => {
    const r = interceptBearing({ ...baseInputs, originName: 'Earth', destName: 'Mars' });
    expect(r.error).toBeUndefined();
    // Straight-line range now vs. range to future position should differ.
    const now = bodyPositionAU('Mars', EPOCH);
    const origin = bodyPositionAU('Earth', EPOCH);
    const rangeNow = Math.hypot(now.x - origin.x, now.y - origin.y) * AU_M;
    expect(Math.abs(r.range_m - rangeNow)).toBeGreaterThan(0);
  });

  it('reports an error for an unknown body', () => {
    const r = interceptBearing({ ...baseInputs, originName: 'OKLG', destName: 'Nibiru' });
    expect(r.error).toBeTruthy();
  });
});
