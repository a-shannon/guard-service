const MAX_UINT256 = (1n << 256n) - 1n;

export interface AvalancheHealthConfig {
  readonly nativeWarnWei: bigint;
  readonly nativeCriticalWei: bigint;
  readonly scannerWarnAgeSeconds: number;
  readonly scannerCriticalAgeSeconds: number;
  readonly tokens?: readonly Readonly<{
    tokenId: string;
    warnRaw: bigint;
    criticalRaw: bigint;
  }>[];
}

/** Reads only the explicit operational health policy, independently of blockTime. */
export const readAvalancheHealthConfig = (
  raw: unknown,
): AvalancheHealthConfig => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Invalid Avalanche health configuration');
  const values = raw as Record<string, unknown>;
  /** Parses a canonical decimal wei threshold bounded by uint256. */
  const wei = (value: unknown, field: string) => {
    if (
      typeof value !== 'string' ||
      value.length > 78 ||
      !/^(0|[1-9][0-9]*)$/.test(value)
    )
      throw new Error(`Invalid Avalanche health ${field}`);
    const parsed = BigInt(value);
    if (parsed > MAX_UINT256)
      throw new Error(`Invalid Avalanche health ${field}`);
    return parsed;
  };
  /** Requires a positive safe integer for an observation-age threshold in seconds. */
  const seconds = (value: unknown, field: string) => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
      throw new Error(`Invalid Avalanche health ${field}`);
    return value;
  };
  const nativeWarnWei = wei(values.nativeWarnWei, 'nativeWarnWei');
  const nativeCriticalWei = wei(values.nativeCriticalWei, 'nativeCriticalWei');
  const scannerWarnAgeSeconds = seconds(
    values.scannerWarnAgeSeconds,
    'scannerWarnAgeSeconds',
  );
  const scannerCriticalAgeSeconds = seconds(
    values.scannerCriticalAgeSeconds,
    'scannerCriticalAgeSeconds',
  );
  if (
    nativeCriticalWei > nativeWarnWei ||
    scannerWarnAgeSeconds > scannerCriticalAgeSeconds
  )
    throw new Error('Invalid Avalanche health threshold ordering');
  const selected = values.tokens === undefined ? [] : values.tokens;
  if (!Array.isArray(selected))
    throw new Error('Invalid Avalanche token health thresholds');
  const seen = new Set<string>();
  const tokens = selected.map((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid Avalanche token health thresholds');
    const token = value as Record<string, unknown>;
    const id = token.tokenId;
    if (
      typeof id !== 'string' ||
      !/^0x[0-9a-f]{40}$/.test(id) ||
      /^0x0{40}$/.test(id) ||
      seen.has(id)
    )
      throw new Error('Invalid Avalanche token health identity');
    seen.add(id);
    const warnRaw = wei(token.warnRaw, 'token warnRaw');
    const criticalRaw = wei(token.criticalRaw, 'token criticalRaw');
    if (criticalRaw > warnRaw)
      throw new Error('Invalid Avalanche token health threshold ordering');
    return Object.freeze({ tokenId: id, warnRaw, criticalRaw });
  });
  return Object.freeze({
    nativeWarnWei,
    nativeCriticalWei,
    scannerWarnAgeSeconds,
    scannerCriticalAgeSeconds,
    tokens: Object.freeze(tokens),
  });
};

/** Runtime constructors accept parsed policy only and retain their own snapshot. */
export const captureAvalancheHealthConfig = (
  config: AvalancheHealthConfig,
): AvalancheHealthConfig => {
  if (!config || typeof config !== 'object')
    throw new Error('Invalid Avalanche health configuration');
  const warn = config.nativeWarnWei,
    critical = config.nativeCriticalWei;
  return readAvalancheHealthConfig({
    nativeWarnWei: typeof warn === 'bigint' ? warn.toString() : undefined,
    nativeCriticalWei:
      typeof critical === 'bigint' ? critical.toString() : undefined,
    scannerWarnAgeSeconds: config.scannerWarnAgeSeconds,
    scannerCriticalAgeSeconds: config.scannerCriticalAgeSeconds,
    tokens: config.tokens?.map((token) => ({
      tokenId: token.tokenId,
      warnRaw:
        typeof token.warnRaw === 'bigint'
          ? token.warnRaw.toString()
          : undefined,
      criticalRaw:
        typeof token.criticalRaw === 'bigint'
          ? token.criticalRaw.toString()
          : undefined,
    })),
  });
};
