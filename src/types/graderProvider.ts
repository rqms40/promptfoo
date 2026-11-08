export const GRADER_PROVIDER_CONFLICT_MESSAGE =
  "Cannot set both 'provider' and 'graderProvider' at the same configuration level. graderProvider is an alias of provider for model-graded assertions; set only one.";

type GraderProviderFields<T> = {
  provider?: T | null;
  graderProvider?: T | null;
};

/**
 * Null and undefined mean the judge was not configured. Any other value,
 * including an empty string, is an explicit grader setting.
 */
function isGradingProviderConfigured(value: unknown): boolean {
  return value !== undefined && value !== null;
}

export function hasGraderProviderConflict(
  config: GraderProviderFields<unknown> | null | undefined,
): boolean {
  return (
    !!config &&
    isGradingProviderConfigured(config.provider) &&
    isGradingProviderConfigured(config.graderProvider)
  );
}

/**
 * Return the configured model-graded judge. `graderProvider` and `provider`
 * are aliases; setting both at this level is a validation error.
 */
export function selectGradingProvider<T>(
  config: GraderProviderFields<T> | null | undefined,
): T | undefined {
  if (!config) {
    return undefined;
  }
  if (hasGraderProviderConflict(config)) {
    throw new Error(GRADER_PROVIDER_CONFLICT_MESSAGE);
  }
  if (isGradingProviderConfigured(config.graderProvider)) {
    return config.graderProvider as T;
  }
  if (isGradingProviderConfigured(config.provider)) {
    return config.provider as T;
  }
  return undefined;
}

/**
 * The `text` entry of a typed grading-provider map, when that is what was
 * configured. Strings and id-based provider objects have no text override.
 */
export function gradingProviderText(provider: unknown): unknown {
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
    return undefined;
  }
  const text = (provider as { text?: unknown }).text;
  return text || undefined;
}

/**
 * Copy `graderProvider` onto `provider` without mutating the input.
 * Configurations that only set `provider` keep their original reference.
 */
export function normalizeGradingProviderConfig<T extends GraderProviderFields<unknown>>(
  config: T | null | undefined,
): T | undefined {
  if (!config) {
    return undefined;
  }
  if (hasGraderProviderConflict(config)) {
    throw new Error(GRADER_PROVIDER_CONFLICT_MESSAGE);
  }
  if (!isGradingProviderConfigured(config.graderProvider)) {
    return config;
  }
  const { graderProvider, ...rest } = config;
  return { ...rest, provider: graderProvider } as T;
}

/**
 * Apply the grader alias to an assertion, including children of an assert-set.
 */
export function normalizeAssertionGrader<T extends Record<string, unknown>>(assertion: T): T {
  const assertValue = assertion.assert;
  const normalizedChildren = Array.isArray(assertValue)
    ? assertValue.map((child) =>
        child && typeof child === 'object'
          ? normalizeAssertionGrader(child as Record<string, unknown>)
          : child,
      )
    : undefined;
  const childrenChanged =
    normalizedChildren !== undefined &&
    normalizedChildren.some((child, index) => child !== (assertValue as unknown[])[index]);
  const normalized = normalizeGradingProviderConfig(assertion) ?? assertion;
  if (!childrenChanged) {
    return normalized;
  }
  return { ...normalized, assert: normalizedChildren } as T;
}
