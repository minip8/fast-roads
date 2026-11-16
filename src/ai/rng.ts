// ============================================================================
// Seeded random numbers for the RL environment (no Math.random anywhere in it): sfc32, seeded through splitmix32,
// so a seed gives the same stream in every process and browser. 32-bit integer maths only (Math.imul, >>> 0).
// ============================================================================
export class Rng {
  private a = 0; private b = 0; private c = 0; private d = 0;
  constructor(seed: number) { this.seed(seed); }

  seed(seed: number) {
    let s = seed >>> 0;
    const next = () => {   // splitmix32
      s = (s + 0x9e3779b9) >>> 0;
      let z = s;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
      return (z ^ (z >>> 16)) >>> 0;
    };
    this.a = next(); this.b = next(); this.c = next(); this.d = next();
    for (let k = 0; k < 12; k++) this.u32();
  }

  u32(): number {
    const t = (((this.a + this.b) >>> 0) + this.d) >>> 0;
    this.d = (this.d + 1) >>> 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) >>> 0;
    this.c = ((this.c << 21) | (this.c >>> 11)) >>> 0;
    this.c = (this.c + t) >>> 0;
    return t;
  }
  // [0, 1)
  next(): number { return this.u32() / 4294967296; }
  range(lo: number, hi: number): number { return lo + (hi - lo) * this.next(); }
  pick<T>(items: readonly T[]): T { return items[Math.floor(this.next() * items.length)]; }
}
