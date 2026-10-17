import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_META, markInstance, setPageMeta, titleFor } from './page-meta.js';

const meta = (property: string) =>
  document.head.querySelector<HTMLMetaElement>(`meta[property="${property}"], meta[name="${property}"]`)?.content;

/**
 * The head as `index.html` ships it: the defaults are tags already, so a page's values
 * are written over them rather than added beside them.
 */
beforeEach(() => {
  document.head.innerHTML = `
    <title>Unbent</title>
    <meta name="description" content="${DEFAULT_META.description}" />
    <meta property="og:title" content="Unbent" />
    <meta property="og:description" content="${DEFAULT_META.description}" />
    <meta property="og:image" content="${DEFAULT_META.image}" />
  `;
});

afterEach(() => {
  setPageMeta(null);
  document.head.innerHTML = '';
});

describe('page meta', () => {
  it('writes a page’s title, description and picture into the head, and takes them back', () => {
    setPageMeta({ title: 'Pricing · Unbent', description: 'One plan.', image: '/front/phone-light.webp' });
    expect(document.title).toBe('Pricing · Unbent');
    expect(meta('description')).toBe('One plan.');
    expect(meta('og:title')).toBe('Pricing · Unbent');
    expect(meta('og:description')).toBe('One plan.');
    expect(meta('og:image')).toBe(`${window.location.origin}/front/phone-light.webp`);
    expect(document.head.querySelectorAll('meta[property="og:title"]')).toHaveLength(1);

    setPageMeta(null);
    expect(document.title).toBe('Unbent');
    expect(meta('description')).toBe(DEFAULT_META.description);
    expect(meta('og:image')).toBe(`${window.location.origin}${DEFAULT_META.image}`);
  });

  /**
   * The two halves of the title arrive in either order: the page's effect may run before
   * `/api/config` has answered with the label, or after. Both orders end the same.
   */
  it('keeps the instance label in front of whichever page is showing', () => {
    setPageMeta({ title: 'Pricing · Unbent', description: 'One plan.', image: '/x.webp' });
    markInstance('PR 222');
    expect(document.title).toBe('PR 222 · Pricing · Unbent');

    setPageMeta({ title: 'Why Unbent exists', description: 'The story.', image: '/x.webp' });
    expect(document.title).toBe('PR 222 · Why Unbent exists');

    setPageMeta(null);
    expect(document.title).toBe('PR 222 · Unbent');
  });

  it('composes the title the same way for a page the build writes out', () => {
    expect(titleFor(null, null)).toBe('Unbent');
    expect(titleFor({ title: 'Why Unbent exists', description: '', image: '' }, null)).toBe('Why Unbent exists');
    expect(titleFor({ title: 'Why Unbent exists', description: '', image: '' }, 'Dev')).toBe('Dev · Why Unbent exists');
  });
});
