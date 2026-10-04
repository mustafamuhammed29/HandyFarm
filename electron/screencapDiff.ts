// Phase 5: cross-device screenshot diffing.
//
// Pure functions. Frame normalization (resize → grayscale → mask status/nav
// bars) is done in the caller; this module takes pre-normalized 8x8 grayscale
// buffers for pHash and full-resolution grayscale for SSIM.
//
// pHash is the fast candidate filter (Hamming distance on 64-bit hash). SSIM
// is the confirming check; we only run SSIM on frames whose pHash differs by
// more than `phashDistanceThreshold` bits. This keeps the diff cheap on the
// hot path while still catching subtle pixel-level regressions.

/**
 * Default DCT config. pHash distance threshold of 6 means: if 6 or more of
 * the 64 hash bits differ between two frames, treat them as candidate
 * non-matches and confirm with SSIM. SSIM >= 0.92 is "matches golden".
 */
export const DEFAULT_DIFF_CONFIG: DiffConfig = {
  phashDistanceThreshold: 6,
  ssimMatchThreshold: 0.92,
  statusBarRows: 7,
  navBarRows: 5,
};

export interface DiffConfig {
  phashDistanceThreshold: number;
  ssimMatchThreshold: number;
  statusBarRows: number;
  navBarRows: number;
}

/**
 * 64-bit perceptual hash from an 8x8 grayscale buffer. Layout: bit i (0..63)
 * encodes whether pixel[i] > mean(64 pixels). Bigint is convenient for
 * Hamming distance via XOR.
 */
export function computePHash(grayscale8x8: Uint8Array | number[]): bigint {
  if (grayscale8x8.length !== 64) {
    throw new Error(`computePHash expects 64 pixels, got ${grayscale8x8.length}`);
  }
  let sum = 0;
  for (let i = 0; i < 64; i++) sum += grayscale8x8[i];
  const mean = sum / 64;
  let hash = 0n;
  for (let i = 0; i < 64; i++) {
    if (grayscale8x8[i] >= mean) {
      hash |= (1n << BigInt(63 - i));
    }
  }
  return hash;
}

/**
 * Hamming distance between two 64-bit perceptual hashes (count of differing
 * bits). 0 = identical pHash; 64 = total mismatch.
 */
export function phashHammingDistance(a: bigint, b: bigint): number {
  const xor = a ^ b;
  let n = xor;
  let count = 0;
  // For 64-bit input we can popcount safely in O(64).
  while (n !== 0n) {
    n &= (n - 1n);
    count++;
  }
  return count;
}

/**
 * Simplified Structural Similarity Index on a single channel. Standard SSIM
 * with K1=0.01, K2=0.03, L=255. Returns a value in [0, 1] where 1 = identical.
 *
 * Inputs are 1-D buffers of grayscale pixels, length `w*h`.
 */
export function computeSSIM(a: Uint8Array | number[], b: Uint8Array | number[], w: number, h: number): number {
  if (a.length !== b.length) {
    throw new Error(`SSIM input length mismatch: ${a.length} vs ${b.length}`);
  }
  if (a.length !== w * h) {
    throw new Error(`SSIM input length ${a.length} != w*h ${w * h}`);
  }
  const N = a.length;
  let sumA = 0, sumB = 0;
  for (let i = 0; i < N; i++) { sumA += a[i]; sumB += b[i]; }
  const muA = sumA / N, muB = sumB / N;

  let varA = 0, varB = 0, cov = 0;
  for (let i = 0; i < N; i++) {
    const dA = a[i] - muA;
    const dB = b[i] - muB;
    varA += dA * dA;
    varB += dB * dB;
    cov += dA * dB;
  }
  varA /= N; varB /= N; cov /= N;

  const C1 = (0.01 * 255) ** 2; // ~6.5025
  const C2 = (0.03 * 255) ** 2;  // ~58.5225
  const num = (2 * muA * muB + C1) * (2 * cov + C2);
  const den = (muA * muA + muB * muB + C1) * (varA + varB + C2);
  return den === 0 ? 1 : num / den;
}

// ----------------- Diff record types -----------------

export interface GoldenBaseline {
  /** Owning app package, e.g. "com.handyfarm.clipper". */
  package: string;
  /** Scenario name, e.g. "settings-page-loaded". */
  scenario: string;
  /** Device fingerprint key (Phase 1 immutable fingerprint or phys_id). */
  deviceFingerprint: string;
  /** Pre-normalized 8x8 grayscale for pHash. */
  pHash: bigint;
  /** Full-resolution grayscale for SSIM. */
  grayscale: Uint8Array;
  width: number;
  height: number;
  capturedAt: number;
}

export interface DiffResult {
  /** Same key as GoldenBaseline. */
  package: string;
  scenario: string;
  deviceFingerprint: string;
  deviceSerial: string;
  matchesGolden: boolean;
  pHashDistance: number;
  ssim: number;
  observedAt: number;
  /** Path to the captured frame that produced this result. */
  capturePath?: string;
}

/**
 * Compare a candidate frame against a golden baseline. Returns a DiffResult
 * with the pHash distance (Hamming on 64 bits) and the SSIM (1 = identical).
 *
 * `matchesGolden` is true iff either:
 *   - pHash distance ≤ threshold (fast no-op identical), OR
 *   - SSIM ≥ match threshold (structurally identical even with sub-pixel
 *     differences from encoding / clock drift).
 */
export function diffAgainstGolden(
  candidateGrayscale: Uint8Array,
  candidatePHash: bigint,
  candidateWidth: number,
  candidateHeight: number,
  golden: GoldenBaseline,
  deviceSerial: string,
  capturePath: string | undefined,
  cfg: DiffConfig = DEFAULT_DIFF_CONFIG,
): DiffResult {
  const pHashDistance = phashHammingDistance(candidatePHash, golden.pHash);
  const fastMatch = pHashDistance <= cfg.phashDistanceThreshold;

  let ssim = 1;
  if (!fastMatch) {
    if (candidateWidth !== golden.width || candidateHeight !== golden.height) {
      // Different dimensions → SSIM is undefined; treat as a mismatch with
      // SSIM=0. Caller is expected to ensure candidate and golden are
      // normalized to the same resolution in normal use.
      ssim = 0;
    } else {
      ssim = computeSSIM(candidateGrayscale, golden.grayscale, candidateWidth, candidateHeight);
    }
  }

  const matchesGolden = fastMatch || ssim >= cfg.ssimMatchThreshold;

  return {
    package: golden.package,
    scenario: golden.scenario,
    deviceFingerprint: golden.deviceFingerprint,
    deviceSerial,
    matchesGolden,
    pHashDistance,
    ssim,
    observedAt: Date.now(),
    capturePath,
  };
}

/**
 * Cluster key for cross-device grouping. Same (package, scenario, fingerprint)
 * + non-match → collapsed into one entry. Property: any two diffs with the
 * same clusterKey should appear as one row in the failure UI regardless of
 * how many devices exhibit them.
 */
export function clusterKey(d: DiffResult): string {
  return `${d.package}|${d.scenario}|${d.deviceFingerprint}`;
}

/**
 * Group non-matching diffs by clusterKey. Each group contains the device
 * serials that exhibit the same failure. Matches (matchesGolden === true)
 * are dropped — they're not failures.
 */
export interface GroupedDiff {
  package: string;
  scenario: string;
  deviceFingerprint: string;
  affectedSerials: string[];
  affectedCount: number;
  /** Worst-case SSIM across the cluster (lowest similarity). */
  worstSSIM: number;
  /** Worst-case pHash distance (highest Hamming). */
  worstPHashDistance: number;
  observedAt: number;
}

export function groupDiffs(diffs: DiffResult[]): GroupedDiff[] {
  const groups = new Map<string, GroupedDiff>();
  for (const d of diffs) {
    if (d.matchesGolden) continue;
    const key = clusterKey(d);
    const existing = groups.get(key);
    if (existing) {
      if (!existing.affectedSerials.includes(d.deviceSerial)) {
        existing.affectedSerials.push(d.deviceSerial);
      }
      existing.affectedCount = existing.affectedSerials.length;
      if (d.ssim < existing.worstSSIM) existing.worstSSIM = d.ssim;
      if (d.pHashDistance > existing.worstPHashDistance) existing.worstPHashDistance = d.pHashDistance;
      if (d.observedAt > existing.observedAt) existing.observedAt = d.observedAt;
    } else {
      groups.set(key, {
        package: d.package,
        scenario: d.scenario,
        deviceFingerprint: d.deviceFingerprint,
        affectedSerials: [d.deviceSerial],
        affectedCount: 1,
        worstSSIM: d.ssim,
        worstPHashDistance: d.pHashDistance,
        observedAt: d.observedAt,
      });
    }
  }
  return Array.from(groups.values()).sort((a, b) => b.affectedCount - a.affectedCount);
}

// ----------------- Frame normalization (Electron-only) -----------------

/**
 * Convert a PNG/JPEG buffer to an 8x8 grayscale via Electron's nativeImage.
 * Returns Uint8Array(64) in row-major order. Throws if nativeImage is not
 * available (e.g. when running tests outside the Electron main process).
 *
 * For tests, callers should use a synthetic 8x8 grayscale buffer and skip
 * this normalization.
 */
export function imageToPHashBuffer(pngBuffer: Buffer): { grayscale8x8: Uint8Array; fullGrayscale: Uint8Array; width: number; height: number } {
  // Lazy import so this module stays importable from non-Electron contexts.
  let nativeImage: any;
  try {
    nativeImage = require('electron').nativeImage;
  } catch {
    throw new Error('imageToPHashBuffer requires Electron; in tests pass a synthetic grayscale buffer');
  }
  const img = nativeImage.createFromBuffer(pngBuffer);
  const size = img.getSize();
  if (!size.width || !size.height) {
    throw new Error('imageToPHashBuffer: invalid image dimensions');
  }
  // Resize to 8x8 (pHash) and to a 64x64 (SSIM; small enough to keep compute
  // cheap while still catching real pixel-level drift).
  const phash = img.resize({ width: 8, height: 8, quality: 'good' }).toBitmap();
  const fullImg = img.resize({ width: 64, height: 64, quality: 'good' }).toBitmap();
  return {
    grayscale8x8: rgbaToGray(phash, 8, 8, DEFAULT_DIFF_CONFIG),
    fullGrayscale: rgbaToGray(fullImg, 64, 64, DEFAULT_DIFF_CONFIG),
    width: 64,
    height: 64,
  };
}

/**
 * Convert an RGBA bitmap (Electron nativeImage output) to single-channel
 * grayscale, optionally masking the top status-bar rows and bottom nav-bar
 * rows by zeroing them out.
 */
function rgbaToGray(rgba: Buffer, w: number, h: number, cfg: DiffConfig): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      // Rec. 601 luma.
      const g = Math.round(0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]);
      out[y * w + x] = (y < cfg.statusBarRows || y >= h - cfg.navBarRows) ? 0 : g;
    }
  }
  return out;
}