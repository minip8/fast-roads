// A-weighting (IEC 61672) as a gain at f Hz: how loud a line of the sound is heard, for the engine sound tests.
export function aWeight(f: number) {
  const f2 = f * f;
  return 1.2589 * 12194 ** 2 * f2 * f2 / ((f2 + 20.6 ** 2) * Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12194 ** 2));
}
