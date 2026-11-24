// Pure zero-dependency JSON Schema Draft 2020-12 subset validator for WuwaTerm contracts.
// Uses an explicit closed allowlist of supported keywords and fails closed if any schema
// introduces an unknown keyword, unknown type, or broken internal $ref.

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export const SUPPORTED_KEYWORDS = Object.freeze(new Set([
  '$schema',
  '$id',
  'title',
  'description',
  '$defs',
  '$ref',
  'const',
  'enum',
  'type',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
  'uniqueItems',
  'prefixItems',
  'items',
  'required',
  'properties',
  'additionalProperties',
  'allOf',
  'anyOf',
  'oneOf',
  'not',
]));

export const SUPPORTED_TYPES = Object.freeze(new Set([
  'null',
  'boolean',
  'string',
  'number',
  'integer',
  'array',
  'object',
]));

const VERIFIED_SCHEMAS = new WeakSet();

function resolveRef(root, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/$defs/')) {
    throw new Error(`Unsupported $ref: ${String(ref)}`);
  }
  const key = ref.slice('#/$defs/'.length);
  if (!root.$defs || !Object.hasOwn(root.$defs, key)) {
    throw new Error(`Missing $def: ${key}`);
  }
  return root.$defs[key];
}

function assertNodeSupported(root, node, path) {
  if (typeof node === 'boolean') return;
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    throw new Error(`Invalid schema node at ${path}`);
  }
  for (const key of Object.keys(node)) {
    if (!SUPPORTED_KEYWORDS.has(key)) {
      throw new Error(`Unsupported JSON Schema keyword "${key}" at ${path}`);
    }
  }
  if (Object.hasOwn(node, '$ref')) resolveRef(root, node.$ref);
  if (Object.hasOwn(node, 'type')) {
    const allowed = Array.isArray(node.type) ? node.type : [node.type];
    if (!allowed.length) throw new Error(`Empty type list at ${path}`);
    for (const t of allowed) {
      if (!SUPPORTED_TYPES.has(t)) throw new Error(`Unsupported schema type "${String(t)}" at ${path}`);
    }
  }
  if (Object.hasOwn(node, '$defs')) {
    if (!node.$defs || typeof node.$defs !== 'object' || Array.isArray(node.$defs)) {
      throw new Error(`Invalid $defs at ${path}`);
    }
    for (const [k, def] of Object.entries(node.$defs)) {
      assertNodeSupported(root, def, `${path}.$defs.${k}`);
    }
  }
  if (Object.hasOwn(node, 'properties')) {
    if (!node.properties || typeof node.properties !== 'object' || Array.isArray(node.properties)) {
      throw new Error(`Invalid properties at ${path}`);
    }
    for (const [k, sub] of Object.entries(node.properties)) {
      assertNodeSupported(root, sub, `${path}.properties.${k}`);
    }
  }
  if (Object.hasOwn(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') {
    assertNodeSupported(root, node.additionalProperties, `${path}.additionalProperties`);
  }
  if (Object.hasOwn(node, 'items')) {
    assertNodeSupported(root, node.items, `${path}.items`);
  }
  if (Object.hasOwn(node, 'prefixItems')) {
    if (!Array.isArray(node.prefixItems)) throw new Error(`Invalid prefixItems at ${path}`);
    node.prefixItems.forEach((sub, i) => assertNodeSupported(root, sub, `${path}.prefixItems[${i}]`));
  }
  for (const combiner of ['allOf', 'anyOf', 'oneOf']) {
    if (Object.hasOwn(node, combiner)) {
      if (!Array.isArray(node[combiner])) throw new Error(`Invalid ${combiner} at ${path}`);
      node[combiner].forEach((sub, i) => assertNodeSupported(root, sub, `${path}.${combiner}[${i}]`));
    }
  }
  if (Object.hasOwn(node, 'not')) {
    assertNodeSupported(root, node.not, `${path}.not`);
  }
}

export function assertSupportedSchema(rootSchema) {
  assertNodeSupported(rootSchema, rootSchema, '$');
}

function matchesType(value, typeName) {
  if (typeName === 'null') return value === null;
  if (typeName === 'boolean') return typeof value === 'boolean';
  if (typeName === 'string') return typeof value === 'string';
  if (typeName === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (typeName === 'integer') return typeof value === 'number' && Number.isSafeInteger(value);
  if (typeName === 'array') return Array.isArray(value);
  if (typeName === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  throw new Error(`Unsupported schema type: ${typeName}`);
}

function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (typeof a === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every(k => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

function validateNode(root, schema, value, path, errors) {
  if (typeof schema === 'boolean') {
    if (!schema) errors.push({ path, message: 'disallowed by false schema' });
    return;
  }
  if (Object.hasOwn(schema, '$ref')) {
    validateNode(root, resolveRef(root, schema.$ref), value, path, errors);
  }
  if (Object.hasOwn(schema, 'const') && !deepEqual(value, schema.const)) {
    errors.push({ path, message: `expected const ${JSON.stringify(schema.const)}` });
    return;
  }
  if (Object.hasOwn(schema, 'enum') && !schema.enum.some(item => deepEqual(value, item))) {
    errors.push({ path, message: 'value not in enum' });
    return;
  }
  if (Object.hasOwn(schema, 'type')) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!allowed.some(t => matchesType(value, t))) {
      errors.push({ path, message: `expected type ${allowed.join(' | ')}` });
      return;
    }
  }
  if (typeof value === 'string') {
    if (Object.hasOwn(schema, 'minLength') || Object.hasOwn(schema, 'maxLength')) {
      const codePoints = Array.from(value).length;
      if (Object.hasOwn(schema, 'minLength') && codePoints < schema.minLength) {
        errors.push({ path, message: `string shorter than ${schema.minLength}` });
      }
      if (Object.hasOwn(schema, 'maxLength') && codePoints > schema.maxLength) {
        errors.push({ path, message: `string longer than ${schema.maxLength}` });
      }
    }
    if (Object.hasOwn(schema, 'pattern') && !(new RegExp(schema.pattern, 'u').test(value))) {
      errors.push({ path, message: `string does not match ${schema.pattern}` });
    }
  }
  if (typeof value === 'number') {
    if (Object.hasOwn(schema, 'minimum') && value < schema.minimum) {
      errors.push({ path, message: `number < ${schema.minimum}` });
    }
    if (Object.hasOwn(schema, 'maximum') && value > schema.maximum) {
      errors.push({ path, message: `number > ${schema.maximum}` });
    }
  }
  if (Array.isArray(value)) {
    if (Object.hasOwn(schema, 'minItems') && value.length < schema.minItems) {
      errors.push({ path, message: `array length < ${schema.minItems}` });
    }
    if (Object.hasOwn(schema, 'maxItems') && value.length > schema.maxItems) {
      errors.push({ path, message: `array length > ${schema.maxItems}` });
    }
    if (Object.hasOwn(schema, 'uniqueItems') && schema.uniqueItems) {
      let duplicate = false;
      for (let i = 0; i < value.length && !duplicate; i++) {
        for (let j = i + 1; j < value.length; j++) {
          if (deepEqual(value[i], value[j])) { duplicate = true; break; }
        }
      }
      if (duplicate) errors.push({ path, message: 'array items are not unique' });
    }
    const prefixCount = Array.isArray(schema.prefixItems) ? schema.prefixItems.length : 0;
    for (let i = 0; i < prefixCount && i < value.length; i++) {
      validateNode(root, schema.prefixItems[i], value[i], `${path}[${i}]`, errors);
    }
    if (Object.hasOwn(schema, 'items')) {
      for (let i = prefixCount; i < value.length; i++) {
        if (schema.items === false) {
          errors.push({ path: `${path}[${i}]`, message: 'unexpected extra tuple item' });
        } else if (schema.items !== true) {
          validateNode(root, schema.items, value[i], `${path}[${i}]`, errors);
        }
      }
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const k of Object.keys(value)) {
      if (FORBIDDEN_KEYS.has(k)) {
        errors.push({ path: `${path}.${k}`, message: 'forbidden property key' });
        return;
      }
    }
    if (Array.isArray(schema.required)) {
      for (const req of schema.required) {
        if (!Object.hasOwn(value, req)) errors.push({ path: `${path}.${req}`, message: 'missing required property' });
      }
    }
    const props = Object.hasOwn(schema, 'properties') ? schema.properties : {};
    for (const [key, propValue] of Object.entries(value)) {
      if (Object.hasOwn(props, key)) {
        validateNode(root, props[key], propValue, `${path}.${key}`, errors);
      } else if (Object.hasOwn(schema, 'additionalProperties')) {
        if (schema.additionalProperties === false) {
          errors.push({ path: `${path}.${key}`, message: 'unexpected property' });
        } else if (typeof schema.additionalProperties === 'object') {
          validateNode(root, schema.additionalProperties, propValue, `${path}.${key}`, errors);
        }
      }
    }
  }
  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) validateNode(root, sub, value, path, errors);
  }
  if (Array.isArray(schema.anyOf)) {
    const matched = schema.anyOf.some(sub => {
      const subErrors = [];
      validateNode(root, sub, value, path, subErrors);
      return subErrors.length === 0;
    });
    if (!matched) errors.push({ path, message: 'matched none of anyOf' });
  }
  if (Array.isArray(schema.oneOf)) {
    let matches = 0;
    for (const sub of schema.oneOf) {
      const subErrors = [];
      validateNode(root, sub, value, path, subErrors);
      if (subErrors.length === 0) matches += 1;
    }
    if (matches !== 1) errors.push({ path, message: `expected exactly 1 oneOf match, got ${matches}` });
  }
  if (Object.hasOwn(schema, 'not')) {
    const subErrors = [];
    validateNode(root, schema.not, value, path, subErrors);
    if (subErrors.length === 0) errors.push({ path, message: 'matched forbidden not schema' });
  }
}

export function validateJsonSchema(schema, value) {
  if (!VERIFIED_SCHEMAS.has(schema)) {
    assertSupportedSchema(schema);
    if (schema && typeof schema === 'object') VERIFIED_SCHEMAS.add(schema);
  }
  const errors = [];
  validateNode(schema, schema, value, '$', errors);
  return { valid: errors.length === 0, errors };
}
