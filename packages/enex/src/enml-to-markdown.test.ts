import { describe, expect, it } from 'vitest';
import { enmlToMarkdown } from './enml-to-markdown.js';
import type { EnexResource } from './types.js';

const wrap = (inner: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd">
<en-note>${inner}</en-note>`;

const md = (inner: string, resources: EnexResource[] = []) =>
  enmlToMarkdown(wrap(inner), resources).markdown;

function resource(over: Partial<EnexResource> = {}): EnexResource {
  return {
    md5: 'a'.repeat(32),
    filename: 'doc.pdf',
    mime: 'application/pdf',
    bytes: new Uint8Array([1, 2, 3]),
    ...over,
  };
}

describe('structure', () => {
  it('converts headings, emphasis, and links', () => {
    expect(md('<h1>Title</h1>')).toBe('# Title');
    expect(md('<b>bold</b>')).toContain('*bold*');
    expect(md('<i>it</i>')).toContain('_it_');
    expect(md('<a href="https://x.test">link</a>')).toBe('[link](https://x.test)');
  });

  it('converts lists', () => {
    expect(md('<ul><li>one</li><li>two</li></ul>')).toBe('- one\n- two');
    expect(md('<ol><li>one</li><li>two</li></ol>')).toBe('1. one\n2. two');
  });

  it('converts nested lists', () => {
    const out = md('<ul><li>outer<ul><li>inner</li></ul></li></ul>');
    expect(out).toContain('- outer');
    expect(out).toContain('  - inner');
  });

  it('converts tables', () => {
    const out = md('<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>');
    expect(out).toContain('| a | b |');
    expect(out).toContain('| 1 | 2 |');
  });

  it('converts blockquotes and code', () => {
    expect(md('<blockquote>quoted</blockquote>')).toBe('> quoted');
    expect(md('<pre><code>x = 1</code></pre>')).toContain('x = 1');
  });

  it('treats divs as separate lines', () => {
    expect(md('<div>one</div><div>two</div>')).toBe('one\n\ntwo');
  });

  it('decodes entities', () => {
    // `<` is escaped on the way out, which is correct: an unescaped one would be read as
    // the start of an HTML tag.
    const out = md('<div>&quot;quoted&quot; &amp; &lt;escaped&gt;</div>');
    expect(out).toContain('"quoted" &');
    expect(out).toContain('escaped>');
  });
});

/** Stripping Evernote's clipper styling is the point of converting to markdown. */
describe('presentation stripping', () => {
  it('drops inline styles and unwraps spans', () => {
    const out = md(
      '<div><span style="color: rgb(0,0,0); font-family: Helvetica; font-size: 12px;">text</span></div>',
    );
    expect(out).toBe('text');
    expect(out).not.toContain('style');
  });

  it('unwraps font tags', () => {
    expect(md('<font face="Arial" color="#ff0000">plain</font>')).toBe('plain');
  });

  it('drops style and script elements entirely', () => {
    expect(md('<div>keep</div><style>.x{}</style><script>bad()</script>')).toBe('keep');
  });

  it('keeps structure while dropping classes', () => {
    const out = md('<h2 class="heading" id="x">Kept</h2>');
    expect(out).toBe('## Kept');
  });
});

describe('en-media resolution', () => {
  it('renders an image resource as an image', () => {
    const r = resource({ md5: 'b'.repeat(32), filename: 'pic.png', mime: 'image/png' });
    const out = md(`<en-media hash="${r.md5}" type="image/png"/>`, [r]);
    expect(out).toBe('![pic.png](files/pic.png)');
  });

  it('renders a non-image resource as a link', () => {
    const r = resource({ md5: 'c'.repeat(32), filename: 'report.pdf' });
    const out = md(`<en-media hash="${r.md5}" type="application/pdf"/>`, [r]);
    expect(out).toBe('[report.pdf](files/report.pdf)');
  });

  /**
   * Resources are not in the same order as their references — verified against the real
   * export — so resolution must be by hash lookup and never by position.
   */
  it('resolves by hash, not document order', () => {
    const first = resource({ md5: '1'.repeat(32), filename: 'first.pdf' });
    const second = resource({ md5: '2'.repeat(32), filename: 'second.pdf' });
    // Reference the second resource first.
    const out = md(
      `<en-media hash="${second.md5}"/><en-media hash="${first.md5}"/>`,
      [first, second],
    );
    expect(out.indexOf('second.pdf')).toBeLessThan(out.indexOf('first.pdf'));
  });

  it('reports which resources were referenced', () => {
    const used = resource({ md5: 'd'.repeat(32), filename: 'used.pdf' });
    const unused = resource({ md5: 'e'.repeat(32), filename: 'unused.pdf' });
    const { usedMd5 } = enmlToMarkdown(wrap(`<en-media hash="${used.md5}"/>`), [used, unused]);
    expect([...usedMd5]).toEqual([used.md5]);
  });

  it('leaves a marker for a reference with no matching resource', () => {
    const out = md('<en-media hash="ffffffffffffffffffffffffffffffff"/>', []);
    expect(out).toContain('missing attachment');
  });

  it('does not escape underscores in filenames', () => {
    const r = resource({ md5: 'f'.repeat(32), filename: '2020_02_29_10_30.pdf' });
    const out = md(`<en-media hash="${r.md5}"/>`, [r]);
    expect(out).toContain('[2020_02_29_10_30.pdf]');
    expect(out).not.toContain('\\_');
  });
});

describe('en-todo', () => {
  it('converts checked and unchecked boxes to task list items', () => {
    const out = md(
      '<ul><li><en-todo checked="true"/>done</li><li><en-todo checked="false"/>todo</li></ul>',
    );
    expect(out).toContain('[x] done');
    expect(out).toContain('[ ] todo');
  });
});

describe('cleanup', () => {
  it('collapses runs of blank lines', () => {
    expect(md('<div>a</div><br/><br/><br/><div>b</div>')).toBe('a\n\nb');
  });

  it('removes hard-break backslashes left by stray br tags', () => {
    expect(md('<div>line<br/></div>')).not.toContain('\\');
  });

  it('normalizes non-breaking spaces', () => {
    expect(md('<div>a&nbsp;b</div>')).toBe('a b');
  });

  it('handles empty content', () => {
    expect(md('')).toBe('');
    expect(md('<div></div>')).toBe('');
  });
});
