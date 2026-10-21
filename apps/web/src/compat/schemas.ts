/**
 * Whether a request schema still accepts everything it used to, read from two JSON
 * Schemas: the one recorded when the compatibility level was last decided, and the one
 * zod gives for the code now.
 *
 * A page left open runs the build it loaded, and the server it talks to is always the
 * newest. So every body an old page sends, and every write its outbox replays days later,
 * meets a schema that may have moved since the page was built. A schema that accepts more
 * than it did (a new optional field, a new value, a longer limit) is safe; one that
 * accepts less refuses that page with a 400, and the outbox ends the entry, which loses
 * the write. This tells the two apart, so the contract test (`contract.test.ts`) can let
 * the first through and stop the second.
 *
 * Deliberately conservative, and deliberately small. It reads the keywords zod writes
 * and nothing else; any other difference is `unsure`, which asks a person rather than
 * guessing. A property a schema no longer names is `unsure` too, not safe: zod strips an
 * unknown key without a word, so an old page that still sends it is not refused, but
 * what it sent is dropped, and whether that matters is a judgment. What it cannot see at
 * all is a refinement (`refine`, `superRefine`): zod writes none of them into JSON
 * Schema, so tightening one is invisible here, and AGENTS.md says so.
 *
 * Written for this rather than taken from a library: the JSON Schema "is this a subset"
 * question has no general answer, the libraries that try are large and answer it for
 * every draft, and the shapes zod emits are a few dozen keywords.
 */

export type Severity = 'breaks' | 'unsure';

export interface Narrowing {
  /** Where in the schema, from its root: `.tags[]`, `.fields{key}`. Empty for the root. */
  path: string;
  severity: Severity;
  what: string;
}

type Obj = Record<string, unknown>;
type Schema = Obj | boolean;

/** Keywords that say nothing about what is accepted. */
const ANNOTATIONS = new Set(['$schema', '$id', '$comment', 'title', 'description', 'examples', 'default', 'deprecated', 'readOnly', 'writeOnly']);

/** Keywords this file reads. Any other one that differs is `unsure`. */
const UNDERSTOOD = new Set([
  'type', 'enum', 'const', 'anyOf', 'oneOf', 'allOf', 'not', '$ref', '$defs', 'definitions',
  'properties', 'required', 'additionalProperties', 'propertyNames', 'minProperties', 'maxProperties',
  'items', 'prefixItems', 'minItems', 'maxItems', 'uniqueItems',
  'minLength', 'maxLength', 'pattern', 'format',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
]);

/** Every way `next` accepts less than `prev` did; empty when it accepts at least as much. */
export function narrowings(next: Schema, prev: Schema): Narrowing[] {
  return compare(next, prev, '', { next, prev, seen: new Set() });
}

interface Roots {
  next: Schema;
  prev: Schema;
  /** Pairs of (resolved) schemas already being compared, so a recursive `$ref` ends. */
  seen: Set<string>;
}

function compare(nextIn: Schema, prevIn: Schema, path: string, roots: Roots): Narrowing[] {
  const next = resolve(nextIn, roots.next);
  const prev = resolve(prevIn, roots.prev);
  if (equal(strip(next), strip(prev))) return [];
  if (prev === false || acceptsAnything(next)) return [];
  if (next === false) return [{ path, severity: 'breaks', what: 'accepts nothing now' }];
  if (acceptsAnything(prev)) return [{ path, severity: 'breaks', what: 'accepted anything, and is limited now' }];
  const n = next as Obj;
  const p = prev as Obj;

  const pair = `${identity(n)}|${identity(p)}`;
  if (roots.seen.has(pair)) return [];
  if (path.length > 2000) return [{ path, severity: 'unsure', what: 'is nested deeper than this check reads' }];
  roots.seen.add(pair);

  // Every shape the old schema accepted must still be accepted, so a union in the old one
  // is checked branch by branch, and a union in the new one needs one branch that takes
  // the old shape whole.
  const prevUnion = union(p);
  if (prevUnion) return prevUnion.flatMap((branch) => compare(n, branch, path, roots));
  const nextUnion = union(n);
  if (nextUnion) {
    let best: Narrowing[] | undefined;
    for (const branch of nextUnion) {
      const found = compare(branch, p, path, roots);
      if (found.length === 0) return [];
      if (!best || found.length < best.length) best = found;
    }
    return best ?? [];
  }

  const out: Narrowing[] = [];
  const say = (severity: Severity, what: string, at = path) => out.push({ path: at, severity, what });

  for (const key of new Set([...Object.keys(n), ...Object.keys(p)])) {
    if (ANNOTATIONS.has(key) || UNDERSTOOD.has(key)) continue;
    if (!equal(n[key], p[key])) say('unsure', `\`${key}\` changed, which this check does not read`);
  }
  for (const key of ['allOf', 'not', 'prefixItems'] as const) {
    if (!equal(n[key], p[key])) say('unsure', `\`${key}\` changed, which this check does not read`);
  }

  const prevValues = valuesOf(p);
  const nextValues = valuesOf(n);
  if (nextValues) {
    if (!prevValues) say('breaks', `only ${list(nextValues)} now`);
    else {
      const lost = prevValues.filter((value) => !nextValues.some((v) => equal(v, value)));
      if (lost.length > 0) say('breaks', `no longer accepts ${list(lost)}`);
    }
  }

  const prevTypes = typesOf(p, prevValues);
  const nextTypes = typesOf(n, nextValues);
  if (nextTypes) {
    if (!prevTypes) say('breaks', `has to be ${nextTypes.join(' or ')} now`);
    else {
      const lost = prevTypes.filter((t) => !nextTypes.includes(t) && !(t === 'integer' && nextTypes.includes('number')));
      if (lost.length > 0) say('breaks', `no longer accepts ${lost.join(' or ')}`);
    }
  }

  for (const key of ['minLength', 'minItems', 'minProperties'] as const) {
    const [was, now] = [num(p[key]), num(n[key])];
    if (now !== undefined && (was === undefined || now > was)) say('breaks', `${key} ${was ?? 'none'} → ${now}`);
  }
  for (const key of ['maxLength', 'maxItems', 'maxProperties'] as const) {
    const [was, now] = [num(p[key]), num(n[key])];
    if (now !== undefined && (was === undefined || now < was)) say('breaks', `${key} ${was ?? 'none'} → ${now}`);
  }
  const [lowWas, lowNow] = [bound(p, 'minimum', 'exclusiveMinimum'), bound(n, 'minimum', 'exclusiveMinimum')];
  if (lowNow && (!lowWas || lowNow.v > lowWas.v || (lowNow.v === lowWas.v && lowNow.ex && !lowWas.ex))) {
    say('breaks', `lowest value ${lowWas ? show(lowWas) : 'none'} → ${show(lowNow)}`);
  }
  const [highWas, highNow] = [bound(p, 'maximum', 'exclusiveMaximum'), bound(n, 'maximum', 'exclusiveMaximum')];
  if (highNow && (!highWas || highNow.v < highWas.v || (highNow.v === highWas.v && highNow.ex && !highWas.ex))) {
    say('breaks', `highest value ${highWas ? show(highWas) : 'none'} → ${show(highNow)}`);
  }
  if (n.format !== undefined && n.format !== p.format) say('breaks', `has to be a ${String(n.format)} now`);
  if (n.pattern !== undefined && n.pattern !== p.pattern) say('unsure', 'its pattern changed, and whether the new one accepts every old value is not read here');
  if (n.multipleOf !== undefined && n.multipleOf !== p.multipleOf) say('unsure', `multipleOf ${String(p.multipleOf ?? 'none')} → ${String(n.multipleOf)}`);
  if (n.uniqueItems === true && p.uniqueItems !== true) say('breaks', 'refuses repeated items now');

  if (n.items !== undefined || p.items !== undefined) {
    out.push(...compare(schemaOr(n.items), schemaOr(p.items), `${path}[]`, roots));
  }

  const nextProps = (isObj(n.properties) ? n.properties : {}) as Record<string, Schema>;
  const prevProps = (isObj(p.properties) ? p.properties : {}) as Record<string, Schema>;
  const prevRequired = new Set(Array.isArray(p.required) ? (p.required as string[]) : []);
  for (const key of Array.isArray(n.required) ? (n.required as string[]) : []) {
    if (!prevRequired.has(key)) say('breaks', 'is required now', `${path}.${key}`);
  }
  const extra = n.additionalProperties;
  for (const [key, was] of Object.entries(prevProps)) {
    const at = `${path}.${key}`;
    if (key in nextProps) out.push(...compare(nextProps[key]!, was, at, roots));
    else if (extra === false) say('breaks', 'is refused now', at);
    else if (isObj(extra) || typeof extra === 'boolean') out.push(...compare(extra, was, at, roots));
    else say('unsure', 'is no longer read: a page from before still sends it, and what it sends is dropped', at);
  }
  // A record: the old schema took any key, so the new one must take every value it did.
  if (isObj(p.additionalProperties)) {
    out.push(...compare(extra === undefined ? true : (extra as Schema), p.additionalProperties, `${path}{key}`, roots));
  }
  if (n.propertyNames !== undefined || p.propertyNames !== undefined) {
    out.push(...compare(schemaOr(n.propertyNames), schemaOr(p.propertyNames), `${path}{name}`, roots));
  }
  return out;
}

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function schemaOr(value: unknown): Schema {
  return isObj(value) || typeof value === 'boolean' ? value : true;
}

function strip(schema: Schema): Schema {
  if (!isObj(schema)) return schema;
  return Object.fromEntries(Object.entries(schema).filter(([key]) => !ANNOTATIONS.has(key)));
}

function acceptsAnything(schema: Schema): boolean {
  return schema === true || (isObj(schema) && Object.keys(strip(schema)).length === 0);
}

/** Follows `$ref`s within the schema's own root (`#`, `#/$defs/…`), keeping any siblings. */
function resolve(schema: Schema, root: Schema): Schema {
  let current = schema;
  for (let hops = 0; hops < 32 && isObj(current) && typeof current.$ref === 'string'; hops++) {
    const { $ref, ...siblings } = current;
    let target: unknown = root;
    if ($ref !== '#') {
      if (!($ref as string).startsWith('#/')) break;
      for (const part of ($ref as string).slice(2).split('/')) {
        target = isObj(target) ? target[part.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined;
      }
    }
    if (!isObj(target) && typeof target !== 'boolean') break;
    // The target itself when nothing sits beside the `$ref`, so a recursive schema meets
    // the same object again and the pair check below ends it.
    current = isObj(target) && Object.keys(siblings).length > 0 ? { ...target, ...siblings } : target;
  }
  return current;
}

const ids = new WeakMap<object, number>();
let nextId = 0;
function identity(value: object): number {
  let id = ids.get(value);
  if (id === undefined) ids.set(value, (id = ++nextId));
  return id;
}

/** A union's branches, each carrying the keywords written beside the union. */
function union(schema: Obj): Schema[] | undefined {
  const branches = (schema.anyOf ?? schema.oneOf) as unknown;
  if (!Array.isArray(branches)) return undefined;
  const { anyOf: _a, oneOf: _o, ...rest } = schema;
  return branches.map((branch: Schema) => (isObj(branch) ? { ...rest, ...branch } : branch));
}

function valuesOf(schema: Obj): unknown[] | undefined {
  if ('const' in schema) return [schema.const];
  return Array.isArray(schema.enum) ? schema.enum : undefined;
}

function typesOf(schema: Obj, values: unknown[] | undefined): string[] | undefined {
  if (typeof schema.type === 'string') return [schema.type];
  if (Array.isArray(schema.type)) return schema.type as string[];
  if (!values) return undefined;
  return [...new Set(values.map((v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'object' ? 'object' : typeof v)))];
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function bound(schema: Obj, inclusive: string, exclusive: string): { v: number; ex: boolean } | undefined {
  const at = num(schema[inclusive]);
  const past = num(schema[exclusive]);
  if (at === undefined && past === undefined) return undefined;
  if (at === undefined) return { v: past!, ex: true };
  if (past === undefined) return { v: at, ex: false };
  return past >= at ? { v: past, ex: true } : { v: at, ex: false };
}

function show(b: { v: number; ex: boolean }): string {
  return b.ex ? `over ${b.v}` : String(b.v);
}

function list(values: unknown[]): string {
  return values.map((v) => JSON.stringify(v)).join(', ');
}

/** Structural equality for JSON values; key order does not matter. */
export function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => equal(v, b[i]));
  }
  if (!isObj(a) || !isObj(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => key in b && equal(a[key], b[key]));
}
