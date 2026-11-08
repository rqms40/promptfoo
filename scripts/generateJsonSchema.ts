import { z } from 'zod';
import { UnifiedConfigSchema } from '../src/types';
import { CONFIG_PROVIDER_INPUT_KEYS } from '../src/types/configAliases';
import { TRANSFORM_KEYS } from '../src/util/transform';
import { StringOrFunctionSchema } from '../src/validators/shared';

const transformSchemaKeys: Set<string> = new Set(TRANSFORM_KEYS);

/**
 * Strips every key from `target` and reassigns it to `{ type: 'string', description? }`,
 * preserving an optional description so generated docs stay useful. Used by both the
 * `override` hook (for inline `StringOrFunctionSchema` nodes) and the post-pass walker
 * (for nodes Zod rewrites after `override` runs).
 */
function rewriteNodeToStringSchema(target: Record<string, unknown>): void {
  const description = target.description;
  for (const key of Object.keys(target)) {
    delete target[key];
  }
  if (typeof description === 'string') {
    target.description = description;
  }
  target.type = 'string';
}

function forceStringTransformSchemas(node: unknown): void {
  if (!node || typeof node !== 'object') {
    return;
  }

  for (const [key, value] of Object.entries(node)) {
    if (
      transformSchemaKeys.has(key) &&
      value &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      rewriteNodeToStringSchema(value as Record<string, unknown>);
      // Recursing into the just-rewritten `{type, description}` stub is pointless
      // and could accidentally re-match if a future rewrite leaves nested junk.
      continue;
    }

    forceStringTransformSchemas(value);
  }
}

// Convert the entire input in one pass so defaults stay optional and recursive references
// share a single root. Draft 7 remains compatible with YAML editors and Ajv.
const schemaContent = z.toJSONSchema(UnifiedConfigSchema, {
  target: 'draft-07',
  io: 'input',
  unrepresentable: 'any',
  reused: 'ref',
  override: ({ zodSchema, jsonSchema }) => {
    // Config files can only represent string transforms. Preserve runtime support for function
    // transforms in the Zod schema, but keep generated JSON Schema string-only for editor/Ajv use.
    if (zodSchema === StringOrFunctionSchema) {
      rewriteNodeToStringSchema(jsonSchema as Record<string, unknown>);
    }
  },
});

// Extract the main schema parts
const {
  $schema: _,
  definitions: zodDefinitions,
  ...mainSchema
} = schemaContent as Record<string, unknown>;

// Build final schema with proper structure and metadata
const jsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://promptfoo.dev/config-schema.json',
  title: 'Promptfoo Configuration Schema',
  $ref: '#/definitions/PromptfooConfigSchema',
  definitions: {
    PromptfooConfigSchema: {
      ...mainSchema,
      // Zod refinements are not converted; authoring also serves non-evaluation configurations.
      not: { required: [...CONFIG_PROVIDER_INPUT_KEYS] },
    },
    ...(zodDefinitions as Record<string, unknown>),
  },
};

// Zod may rewrite reused StringOrFunctionSchema nodes after `override` runs. Do a final pass to keep
// transform-like fields string-only in JSON Schema while runtime Zod still accepts functions.
forceStringTransformSchemas(jsonSchema);

// Zod refinements are not represented in JSON Schema. Reject configs that set both judge aliases.
function disallowBothGraderProviderFields(node: unknown, seen = new WeakSet<object>()): void {
  if (!node || typeof node !== 'object') {
    return;
  }
  if (seen.has(node)) {
    return;
  }
  seen.add(node);

  if (Array.isArray(node)) {
    for (const item of node) {
      disallowBothGraderProviderFields(item, seen);
    }
    return;
  }

  const record = node as Record<string, unknown>;
  const properties = record.properties;
  if (
    record.type === 'object' &&
    properties &&
    typeof properties === 'object' &&
    !Array.isArray(properties) &&
    'provider' in properties &&
    'graderProvider' in properties &&
    record.not === undefined
  ) {
    record.not = { required: ['provider', 'graderProvider'] };
  }

  for (const value of Object.values(record)) {
    disallowBothGraderProviderFields(value, seen);
  }
}

disallowBothGraderProviderFields(jsonSchema);

console.log(JSON.stringify(jsonSchema, null, 2));
