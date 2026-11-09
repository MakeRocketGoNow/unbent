import { describe, expect, it } from 'vitest';
import { clipPage, withoutScriptsAndStyles } from './clip.js';
import { streamedInstructions } from './streamed.js';
import { PARAGRAPHS } from './test-pages.js';

const PAGE_URL = 'https://www.example.com/guides/anvil-care';

const BODY = PARAGRAPHS.map((p) => `<p>${p}</p>`).join('');

/**
 * A page as React's streaming sends it: the byline first, a skeleton where the article
 * will go, and the article near the end in a hidden element with a script that moves it
 * into place. The ids are not the same number, as they need not be in a real page.
 */
function streamedPage(opts: { instruction?: string; extraHidden?: string } = {}): string {
  const instruction = opts.instruction ?? '<script>$RC=function(b,c){/* runtime */};$RC("B:0","S:3")</script>';
  return `<!doctype html><html lang="en"><head><title>Caring for an anvil</title></head><body>
    <article>
      <h1>Caring for an anvil</h1>
      <p class="byline"><span>Sam Example</span> · <span>2 min read</span></p>
      <div class="story"><!--$?--><template id="B:0"></template><div class="skeleton">Loading the story</div><!--/$--></div>
    </article>
    ${opts.extraHidden ?? ''}
    <div hidden id="S:3"><div class="content-body">${BODY}</div></div>
    ${instruction}
  </body></html>`;
}

const clip = (html: string) => clipPage(withoutScriptsAndStyles(html), PAGE_URL).markdown;

describe('a page React streamed', () => {
  it('clips the article the page moves into place, not only what was sent first', () => {
    const markdown = clip(streamedPage());

    for (const paragraph of PARAGRAPHS) expect(markdown).toContain(paragraph.slice(0, 60));
    expect(markdown).not.toContain('Loading the story');
  });

  it('reads the template React writes on a page with no inline scripts the same way', () => {
    const markdown = clip(streamedPage({ instruction: '<template data-rci="" data-bid="B:0" data-sid="S:3"></template>' }));

    expect(markdown).toContain(PARAGRAPHS[0]!.slice(0, 60));
  });

  it('fills a segment placeholder before the boundary that holds it is completed', () => {
    const html = `<!doctype html><html><head><title>Caring for an anvil</title></head><body>
      <article><h1>Caring for an anvil</h1><!--$?--><template id="B:0"></template><p>Loading the story</p><!--/$--></article>
      <div hidden id="S:1"><p>${PARAGRAPHS[0]}</p><template id="P:2"></template></div>
      <div hidden id="S:2"><p>${PARAGRAPHS[1]}</p><p>${PARAGRAPHS[2]}</p></div>
      <script>$RS("S:2","P:2");$RC("B:0","S:1")</script>
    </body></html>`;

    const markdown = clip(html);

    for (const paragraph of PARAGRAPHS) expect(markdown).toContain(paragraph.slice(0, 60));
    expect(markdown.indexOf(PARAGRAPHS[0]!.slice(0, 60))).toBeLessThan(markdown.indexOf(PARAGRAPHS[1]!.slice(0, 60)));
    expect(markdown).not.toContain('Loading the story');
  });

  it('leaves hidden what no instruction names', () => {
    const markdown = clip(streamedPage({ extraHidden: '<div hidden id="S:9"><p>Members-only edition text.</p></div>' }));

    expect(markdown).toContain(PARAGRAPHS[0]!.slice(0, 60));
    expect(markdown).not.toContain('Members-only');
  });

  it('does nothing for an instruction whose ids are not in the page, as in a tab that ran it', () => {
    const page = `<!doctype html><html><head><title>Caring for an anvil</title></head><body>
      <article><h1>Caring for an anvil</h1>${BODY}</article><script>$RC("B:0","S:3")</script></body></html>`;

    expect(clip(page)).toContain(PARAGRAPHS[2]!.slice(0, 60));
  });
});

describe('streamedInstructions', () => {
  it('writes each call as the template React uses for it', () => {
    expect(streamedInstructions('$RC("B:0","S:1");$RR("B:2","S:3",[]);$RS("S:4","P:4")')).toBe(
      '<template data-rci="" data-bid="B:0" data-sid="S:1"></template>' +
        '<template data-rri="" data-bid="B:2" data-sid="S:3"></template>' +
        '<template data-rsi="" data-sid="S:4" data-pid="P:4"></template>',
    );
  });

  it('writes nothing for a script without them', () => {
    expect(streamedInstructions('window.dataLayer = []')).toBe('');
  });

  it('never writes an id that is not shaped like React\'s into the page', () => {
    expect(streamedInstructions('$RC("B:0\\"><img src=x>","S:1");$RC("<b>","S:1")')).toBe('');
  });
});
