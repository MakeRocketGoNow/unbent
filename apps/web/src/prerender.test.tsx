import { describe, expect, it } from 'vitest';
import { OPERATOR_PLACEHOLDER } from '@unbent/shared';
import { render } from './prerender.js';

describe('render', () => {
  /*
   * The Worker's `fillOperator` hands back a copy with no placeholder in it unchanged, and
   * its tests feed it hand-written HTML, so they prove only its half. If `SupportPage`
   * stopped drawing the operator from the config (the address obfuscated, moved, or put
   * behind another flag), the copy would lose its lead sentence, the app would write it
   * back in on load, and nothing would fail. This is the build's half.
   */
  it('writes the operator placeholders into support’s copy', async () => {
    const html = await render('/support');
    expect(html).toContain(`mailto:${OPERATOR_PLACEHOLDER.email}`);
    expect(html).toContain(OPERATOR_PLACEHOLDER.name);
  });
});
