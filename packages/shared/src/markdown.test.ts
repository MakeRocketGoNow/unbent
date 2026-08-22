import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown.js';

const NOTE = 'note-123';
const render = (md: string) => renderMarkdown(md, { noteId: NOTE });

describe('attachment resolution', () => {
  it('rewrites relative image paths to the API', () => {
    expect(render('![alt](files/diagram.png)')).toContain(
      `src="/api/notes/${NOTE}/files/diagram.png"`,
    );
  });

  it('rewrites relative link paths', () => {
    expect(render('[report](files/report.pdf)')).toContain(
      `href="/api/notes/${NOTE}/files/report.pdf"`,
    );
  });

  // CommonMark requires angle brackets when a URL contains spaces.
  it('encodes filenames with spaces', () => {
    expect(render('![x](<files/my photo.png>)')).toContain('my%20photo.png');
  });

  it('encodes unicode filenames', () => {
    expect(render('![x](files/café.png)')).toContain('caf%C3%A9.png');
  });

  // Editors commonly percent-encode on insert; that must not be double-encoded.
  it('does not double-encode an already-encoded filename', () => {
    const out = render('![x](files/my%20photo.png)');
    expect(out).toContain('my%20photo.png');
    expect(out).not.toContain('my%2520photo.png');
  });

  // A lone `%` is not valid percent-encoding; decodeURIComponent would throw.
  it('survives a filename with a bare percent sign', () => {
    const out = render('![x](files/100%.png)');
    expect(out).toContain('/api/notes/');
    expect(out).toContain('.png');
  });

  it('leaves absolute URLs alone', () => {
    expect(render('![x](https://example.com/a.png)')).toContain('src="https://example.com/a.png"');
  });

  it('leaves anchors and other relative paths alone', () => {
    expect(render('[jump](#section)')).toContain('href="#section"');
    expect(render('[up](../other/file.md)')).toContain('href="../other/file.md"');
  });
});

/** Notes can contain arbitrary HTML, and imported ENML is untrusted by construction. */
describe('sanitization', () => {
  it('strips script tags', () => {
    const out = render('<script>alert(1)</script>\n\ntext');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('alert(1)');
  });

  it('strips inline event handlers', () => {
    expect(render('<img src="x" onerror="alert(1)">')).not.toContain('onerror');
  });

  it('strips javascript: URLs', () => {
    expect(render('[click](javascript:alert(1))')).not.toContain('javascript:');
  });

  it('strips iframes', () => {
    expect(render('<iframe src="https://evil.test"></iframe>')).not.toContain('<iframe');
  });

  it('strips data: URLs in links', () => {
    expect(render('[x](data:text/html,<script>alert(1)</script>)')).not.toContain('data:text/html');
  });

  it('keeps benign formatting', () => {
    const out = render('**bold** and `code` and [link](https://example.com)');
    expect(out).toContain('<strong>bold</strong>');
    expect(out).toContain('<code>code</code>');
    expect(out).toContain('href="https://example.com"');
  });
});

describe('gfm', () => {
  it('renders tables', () => {
    const out = render('| a | b |\n| - | - |\n| 1 | 2 |');
    expect(out).toContain('<table>');
    expect(out).toContain('<td>1</td>');
  });

  it('renders task lists', () => {
    const out = render('- [x] done\n- [ ] todo');
    expect(out).toContain('type="checkbox"');
    expect(out).toContain('checked');
  });

  it('renders strikethrough and autolinks', () => {
    expect(render('~~gone~~')).toContain('<del>gone</del>');
    expect(render('https://example.com')).toContain('<a href="https://example.com"');
  });
});

describe('structure', () => {
  it('renders headings and code blocks', () => {
    expect(render('# Title')).toContain('<h1>Title</h1>');
    expect(render('```js\nconst x = 1;\n```')).toContain('<code class="language-js">');
  });

  it('handles an empty document', () => {
    expect(render('').trim()).toBe('');
  });
});
