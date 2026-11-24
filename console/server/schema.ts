// A small JSON Schema subset validator, enough for /contracts: type (incl. unions), const, enum,
// minimum/maximum, minLength/maxLength, items, minItems/maxItems, properties, required,
// additionalProperties:false, and the formats uuid and date-time. Unknown keywords are ignored.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(want: string, v: unknown): boolean {
  const t = typeOf(v);
  return t === want || (want === 'number' && t === 'integer');
}

export function validate(schema: any, value: unknown, path = '$'): string[] {
  const errors: string[] = [];
  const fail = (msg: string) => errors.push(`${path}: ${msg}`);

  if (schema.const !== undefined && value !== schema.const) {
    fail(`must be ${JSON.stringify(schema.const)}`);
    return errors;
  }
  if (schema.type !== undefined) {
    const types: string[] = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(t, value))) {
      fail(`must be ${types.join(' or ')}`);
      return errors;
    }
  }
  if (schema.enum && !schema.enum.includes(value)) fail(`must be one of ${schema.enum.join(', ')}`);

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) fail(`must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) fail(`must be at most ${schema.maximum}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) fail(`must be at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) fail(`must be at most ${schema.maxLength} characters`);
    if (schema.format === 'uuid' && !UUID.test(value)) fail('must be a UUID');
    if (schema.format === 'date-time' && (!DATE_TIME.test(value) || Number.isNaN(Date.parse(value)))) fail('must be an RFC 3339 date-time');
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) fail(`must have at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail(`must have at most ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => errors.push(...validate(schema.items, v, `${path}[${i}]`)));
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const props = schema.properties ?? {};
    for (const key of schema.required ?? []) if (!(key in obj)) errors.push(`${path}.${key}: is required`);
    for (const [key, v] of Object.entries(obj)) {
      if (key in props) errors.push(...validate(props[key], v, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: is not allowed`);
    }
  }
  return errors;
}
