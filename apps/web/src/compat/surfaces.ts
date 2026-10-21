/**
 * Reading source for the contract test's fingerprints (`contract.test.ts`): what two
 * builds share that no schema describes, and that a person has to judge when it changes.
 *
 * A fingerprint is of the code with its comments and its spacing taken out, so that the
 * house style's long comments can be rewritten without asking anyone whether a page from
 * the previous build still works. Text, not a syntax tree: the TypeScript in this repo is
 * the native compiler, which has no API to parse with, and the cost of a crude reading is
 * only ever a question asked that need not have been (a comment-like run inside a string
 * is read as code, and a `//` after code on a line is taken as a comment). A difference
 * this misses would need one inside a string, after a ` // `, which nothing here has.
 */

/** The source without comments, blank lines or the spacing at either end of a line. */
export function normalize(source: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of source.split('\n')) {
    let line = raw.trim();
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end < 0) continue;
      inBlock = false;
      line = line.slice(end + 2).trim();
    }
    if (line.startsWith('/*')) {
      const end = line.indexOf('*/', 2);
      if (end < 0) {
        inBlock = true;
        continue;
      }
      line = line.slice(end + 2).trim();
    }
    if (line.startsWith('//')) continue;
    line = line.replace(/\s+\/\/\s.*$/, '').replace(/\s+/g, ' ');
    if (line) out.push(line);
  }
  return out.join('\n');
}

/**
 * Each `interface` and `type` declared in the source, by name, as normalized text: the
 * shapes the API answers with, which the page trusts rather than parses. Kept per name so
 * the test can say which shape changed rather than which file.
 */
export function declarations(source: string): Map<string, string> {
  const text = normalize(source);
  const found = new Map<string, string>();
  const start = /^(?:export\s+)?(?:declare\s+)?(interface|type)\s+([A-Za-z_$][\w$]*)/gm;
  for (let match = start.exec(text); match; match = start.exec(text)) {
    const end = declarationEnd(text, match.index, match[1] === 'interface');
    const name = found.has(match[2]!) ? `${match[2]} (again)` : match[2]!;
    found.set(name, text.slice(match.index, end));
  }
  return found;
}

/**
 * An interface's heading (its name and what it extends) and its members, one string
 * each, so that one which only gained members can be told from one that changed: a page
 * reading an answer ignores a field it does not know, so a new one fits. Null for a
 * declaration that is not an interface, or not one this reads.
 */
export function interfaceParts(declaration: string): { head: string; members: string[] } | null {
  if (!/^(?:export\s+)?(?:declare\s+)?interface\s/.test(declaration)) return null;
  const open = declaration.indexOf('{');
  if (open < 0 || !declaration.endsWith('}')) return null;
  const members: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  const end = () => {
    const member = current.trim();
    if (member) members.push(member);
    current = '';
  };
  for (let i = open + 1; i < declaration.length - 1; i++) {
    const c = declaration[i]!;
    if (quote) {
      if (c === '\\') current += c + (declaration[++i] ?? '');
      else {
        if (c === quote) quote = null;
        current += c;
      }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') depth--;
    if (depth === 0 && (c === ';' || c === '\n')) end();
    else current += c;
  }
  end();
  return { head: declaration.slice(0, open).trim(), members };
}

/** Where a declaration ends: an interface at its closing brace, a type at its `;`. */
function declarationEnd(text: string, from: number, isInterface: boolean): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') {
      depth--;
      if (isInterface && depth === 0 && c === '}') return i + 1;
    } else if (!isInterface && depth === 0 && c === ';') return i + 1;
  }
  return text.length;
}

/** The relative modules a source file imports, as written (`./routes.js`). */
export function relativeImports(source: string): string[] {
  const specifiers = new Set<string>();
  const patterns = [/\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]/g, /\bimport\s+['"](\.{1,2}\/[^'"]+)['"]/g, /\bimport\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1]!);
  }
  return [...specifiers];
}
