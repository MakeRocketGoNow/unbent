import { describe, expect, it } from 'vitest';
import { fromHtml } from 'hast-util-from-html';
import { htmlToMarkdown, type Node } from './html-to-markdown.js';

// The output itself is pinned by the ENML converter's tests in `@unbent/enex`, which run
// through this module; these cover what is particular to it as an entry point.
describe('htmlToMarkdown', () => {
  it('converts a fragment given as a string', () => {
    expect(htmlToMarkdown('<h2>Notes</h2><p>Some <b>bold</b> text</p>')).toBe('## Notes\n\nSome **bold** text');
  });

  it('converts a tree the caller already parsed', () => {
    const tree = fromHtml('<p>From a tree</p>', { fragment: true });
    expect(htmlToMarkdown(tree)).toBe('From a tree');
  });

  it('strips styling and makes line divs paragraphs', () => {
    expect(
      htmlToMarkdown('<div style="color:red" class="x"><span>one</span></div><div><font>two</font></div>'),
    ).toBe('one\n\ntwo');
  });

  it('keeps a div holding a block element a container', () => {
    expect(htmlToMarkdown('<div><article><p>one</p><p>two</p></article></div>')).toBe('one\n\ntwo');
    expect(htmlToMarkdown('<div><pre><code>x = 1</code></pre></div><div>after</div>')).toBe(
      '```\nx = 1\n```\n\nafter',
    );
  });

  it('leaves a code block exactly as it came, whatever tidies the text around it', () => {
    const code = 'docker run \\\n  --rm foo   \n\n\n\necho a\\_b\u00a0c';
    expect(htmlToMarkdown(`<p>Run a_b:</p><pre><code>${code}</code></pre><p>then\u00a0go</p>`)).toBe(
      `Run a_b:\n\n\`\`\`\n${code}\n\`\`\`\n\nthen go`,
    );
  });

  it('knows a code block inside a list or a quote, and tidies again after it', () => {
    const inList = htmlToMarkdown('<ul><li><pre><code>a \\\nb</code></pre></li></ul><p>one<br>two</p>');
    expect(inList).toContain('a \\\n');
    expect(htmlToMarkdown('<blockquote><pre><code>a \\\nb</code></pre></blockquote>')).toContain('a \\\n');
    expect(htmlToMarkdown('<pre><code>x</code></pre><p>1</p>\n\n<p></p><p>2</p>')).toBe('```\nx\n```\n\n1\n\n2');
  });

  it('reads a div a line inside a code block as lines, not paragraphs', () => {
    expect(htmlToMarkdown('<pre><code><div>a = 1</div><div>b = 2</div></code></pre>')).toBe('```\na = 1\nb = 2\n```');
    // The ENEX import's output is pinned.
    expect(htmlToMarkdown('<pre><code><div>a = 1</div><div>b = 2</div></code></pre>', { tidyInsideCode: true })).toBe(
      '```\na = 1\n\nb = 2\n```',
    );
  });

  it('takes a fence longer than the code holds for the one that closes it', () => {
    expect(htmlToMarkdown('<pre><code>```\na  \n```</code></pre><p>after\u00a0it</p>')).toBe(
      '````\n```\na  \n```\n````\n\nafter it',
    );
  });

  it('keeps a rule inside a div apart from the text either side of it', () => {
    // Made a paragraph, the div would run the three together as `a---b`.
    expect(htmlToMarkdown('<div>a<hr>b</div>')).toBe('a\n\n---\n\nb');
  });

  it('runs the caller’s transforms before the cleaning ones', () => {
    const seen: string[] = [];
    const out = htmlToMarkdown('<a class="keep" href="https://example.com/">Acme</a>', {
      transforms: [
        (tree: Node) => {
          const a = tree.children![0]!;
          // The class is still there: stripPresentation has not run yet.
          seen.push(String((a.properties!['className'] as string[]).join(' ')));
        },
      ],
    });
    expect(seen).toEqual(['keep']);
    expect(out).toBe('[Acme](https://example.com/)');
  });
});
