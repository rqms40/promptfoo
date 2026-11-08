import fs from 'fs';
import path from 'path';

import Ajv from 'ajv';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getFinalTest } from '../../src/assertions/utils';
import cliState from '../../src/cliState';
import { getGradingProvider } from '../../src/matchers/providers';
import { loadApiProvider } from '../../src/providers/index';
import { GRADER_PROVIDER_CONFLICT_MESSAGE } from '../../src/types/graderProvider';
import {
  AssertionSchema,
  GradingConfigSchema,
  TestCaseSchema,
  UnifiedConfigSchema,
} from '../../src/types/index';
import { createMockProvider } from '../factories/provider';

import type { Assertion, TestCase } from '../../src/types/index';

vi.mock('../../src/providers', () => ({
  loadApiProvider: vi.fn(),
}));

describe('graderProvider alias', () => {
  const mockProvider = createMockProvider({ id: 'grader' });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetAllMocks();
    (cliState as { config?: unknown }).config = {};
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('schema validation', () => {
    it('accepts graderProvider on grading config, test options, and assertions', () => {
      expect(GradingConfigSchema.parse({ graderProvider: 'openai:gpt-4o-mini' })).toMatchObject({
        graderProvider: 'openai:gpt-4o-mini',
      });

      const testCase = TestCaseSchema.parse({
        options: { graderProvider: 'openai:gpt-4o-mini' },
        assert: [{ type: 'llm-rubric', value: 'accurate', graderProvider: 'openai:gpt-4.1' }],
      });
      expect(testCase.options?.graderProvider).toBe('openai:gpt-4o-mini');
      expect(testCase.assert?.[0]).toMatchObject({ graderProvider: 'openai:gpt-4.1' });
    });

    it('keeps provider working when graderProvider is absent', () => {
      const parsed = TestCaseSchema.parse({
        options: { provider: 'openai:gpt-4o-mini', rubricPrompt: 'Grade it' },
        assert: [{ type: 'llm-rubric', value: 'accurate', provider: 'openai:gpt-4.1' }],
      });
      expect(parsed.options?.provider).toBe('openai:gpt-4o-mini');
      expect(parsed.assert?.[0]).toMatchObject({ provider: 'openai:gpt-4.1' });
      expect(parsed.options?.graderProvider).toBeUndefined();
    });

    it('reports a validation error when both are set at the same level', () => {
      for (const config of [
        GradingConfigSchema.safeParse({ provider: 'openai:a', graderProvider: 'openai:b' }),
        TestCaseSchema.safeParse({
          options: { provider: 'openai:a', graderProvider: 'openai:b' },
        }),
        AssertionSchema.safeParse({
          type: 'llm-rubric',
          value: 'accurate',
          provider: 'openai:a',
          graderProvider: 'openai:b',
        }),
        UnifiedConfigSchema.safeParse({
          prompts: ['Say hi'],
          providers: ['echo'],
          defaultTest: { options: { provider: 'openai:a', graderProvider: 'openai:b' } },
        }),
      ]) {
        expect(config.success).toBe(false);
        if (!config.success) {
          expect(
            config.error.issues.some((issue) =>
              issue.message.includes(GRADER_PROVIDER_CONFLICT_MESSAGE),
            ),
          ).toBe(true);
        }
      }
    });

    it('allows provider and graderProvider at different configuration levels', () => {
      const parsed = TestCaseSchema.parse({
        options: { provider: 'openai:default-judge' },
        assert: [
          { type: 'llm-rubric', value: 'accurate', graderProvider: 'openai:assertion-judge' },
        ],
      });
      expect(parsed.options?.provider).toBe('openai:default-judge');
      expect(parsed.assert?.[0]).toMatchObject({ graderProvider: 'openai:assertion-judge' });
    });
  });

  describe('getFinalTest equivalence and precedence', () => {
    it('uses assertion graderProvider the same way as assertion provider', () => {
      const grader = createMockProvider({ id: 'assertion-grader' });
      const viaAlias = getFinalTest({ vars: { question: 'hi' } }, {
        type: 'llm-rubric',
        value: 'accurate',
        graderProvider: grader,
      } as Assertion);
      const viaProvider = getFinalTest(
        { vars: { question: 'hi' } },
        { type: 'llm-rubric', value: 'accurate', provider: grader },
      );

      expect(viaAlias.options?.provider).toBe(grader);
      expect(viaAlias.options?.graderProvider).toBeUndefined();
      expect(viaAlias.options?.provider).toBe(viaProvider.options?.provider);
    });

    it('uses test options graderProvider when the assertion does not set a judge', () => {
      const grader = createMockProvider({ id: 'test-grader' });
      const result = getFinalTest({ options: { graderProvider: grader } } as TestCase, {
        type: 'llm-rubric',
        value: 'accurate',
      });

      expect(result.options?.provider).toBe(grader);
      expect(result.options?.graderProvider).toBeUndefined();
    });

    it('prefers an assertion judge over a test options judge for either field name', () => {
      const assertionJudge = createMockProvider({ id: 'assertion-judge' });
      const testJudge = createMockProvider({ id: 'test-judge' });

      expect(
        getFinalTest({ options: { provider: testJudge } }, {
          type: 'llm-rubric',
          value: 'accurate',
          graderProvider: assertionJudge,
        } as Assertion).options?.provider,
      ).toBe(assertionJudge);
      expect(
        getFinalTest({ options: { graderProvider: testJudge } } as TestCase, {
          type: 'llm-rubric',
          value: 'accurate',
          provider: assertionJudge,
        }).options?.provider,
      ).toBe(assertionJudge);
    });

    it('throws when both fields are set on the assertion or on test options', () => {
      expect(() =>
        getFinalTest({}, {
          type: 'llm-rubric',
          value: 'accurate',
          provider: 'openai:a',
          graderProvider: 'openai:b',
        } as Assertion),
      ).toThrow(GRADER_PROVIDER_CONFLICT_MESSAGE);
      expect(() =>
        getFinalTest(
          { options: { provider: 'openai:a', graderProvider: 'openai:b' } } as TestCase,
          { type: 'llm-rubric', value: 'accurate' },
        ),
      ).toThrow(GRADER_PROVIDER_CONFLICT_MESSAGE);
    });
  });

  describe('getGradingProvider lookup', () => {
    it('loads defaultTest.options.graderProvider the same way as provider', async () => {
      vi.mocked(loadApiProvider).mockResolvedValue(mockProvider);

      (cliState as { config?: unknown }).config = {
        defaultTest: { options: { graderProvider: 'openai:gpt-4o-mini' } },
      };
      const aliasResult = await getGradingProvider('text', undefined, null);

      vi.mocked(loadApiProvider).mockClear();
      (cliState as { config?: unknown }).config = {
        defaultTest: { options: { provider: 'openai:gpt-4o-mini' } },
      };
      const providerResult = await getGradingProvider('text', undefined, null);

      expect(aliasResult).toBe(mockProvider);
      expect(providerResult).toBe(mockProvider);
      expect(loadApiProvider).toHaveBeenCalledTimes(1);
      expect(loadApiProvider).toHaveBeenCalledWith('openai:gpt-4o-mini', { basePath: undefined });
    });

    it('uses a typed graderProvider map the same way as provider', async () => {
      vi.mocked(loadApiProvider).mockResolvedValue(mockProvider);
      (cliState as { config?: unknown }).config = {
        defaultTest: { options: { graderProvider: { text: 'azureopenai:chat:gpt-4' } } },
      };

      const result = await getGradingProvider('text', undefined, null);

      expect(result).toBe(mockProvider);
      expect(loadApiProvider).toHaveBeenCalledWith('azureopenai:chat:gpt-4', {
        basePath: undefined,
      });
    });

    it('keeps explicit and defaultTest.provider precedence over options.graderProvider', async () => {
      const explicit = createMockProvider({ id: 'explicit' });
      vi.mocked(loadApiProvider).mockResolvedValue(explicit);
      (cliState as { config?: unknown }).config = {
        defaultTest: {
          provider: 'openai:target-fallback',
          options: { graderProvider: 'openai:should-not-win' },
        },
      };

      await getGradingProvider('text', 'openai:explicit', null);
      expect(loadApiProvider).toHaveBeenCalledWith('openai:explicit', { basePath: undefined });

      vi.mocked(loadApiProvider).mockClear();
      await getGradingProvider('text', undefined, null);
      expect(loadApiProvider).toHaveBeenCalledWith('openai:target-fallback', {
        basePath: undefined,
      });
    });

    it('throws when defaultTest.options sets both provider and graderProvider', async () => {
      (cliState as { config?: unknown }).config = {
        defaultTest: { options: { provider: 'openai:a', graderProvider: 'openai:b' } },
      };

      await expect(getGradingProvider('text', undefined, null)).rejects.toThrow(
        GRADER_PROVIDER_CONFLICT_MESSAGE,
      );
      expect(loadApiProvider).not.toHaveBeenCalled();
    });
  });

  describe('generated config schema', () => {
    it('accepts graderProvider and rejects setting both fields', () => {
      const schema = JSON.parse(
        fs.readFileSync(path.join(__dirname, '../../site/static/config-schema.json'), 'utf8'),
      );
      const validate = new Ajv({ strict: false, allErrors: true }).compile(schema);
      const base = { prompts: ['Say hi'], providers: ['echo'] };

      expect(
        validate({
          ...base,
          defaultTest: { options: { graderProvider: 'openai:gpt-4o-mini' } },
          tests: [
            {
              assert: [{ type: 'llm-rubric', value: 'accurate', graderProvider: 'openai:gpt-4.1' }],
            },
          ],
        }),
      ).toBe(true);
      expect(
        validate({
          ...base,
          defaultTest: { options: { provider: 'openai:a', graderProvider: 'openai:b' } },
        }),
      ).toBe(false);
    });
  });
});
