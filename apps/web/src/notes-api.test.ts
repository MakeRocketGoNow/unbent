import { describe, expect, it } from 'vitest';
import { ApiError, errorText, httpErrorMessage } from './notes-api.js';

const response = (status: number, body: string, contentType?: string) =>
  new Response(body, {
    status,
    headers: contentType ? { 'Content-Type': contentType } : {},
  });

/**
 * The shapes an error body actually arrives in. The HTML case is the one that mattered:
 * a preview Worker deleted mid-import answered every remaining request with the edge's
 * error page, and the import's failure list repeated 200 characters of it 36 times.
 */
describe('httpErrorMessage', () => {
  it("uses the API's own error text", async () => {
    const message = await httpErrorMessage(
      response(404, JSON.stringify({ error: 'Not found' }), 'application/json'),
    );
    expect(message).toBe('404: Not found');
  });

  it('names an HTML body rather than quoting it', async () => {
    const page = '<!DOCTYPE html> <!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US">';
    const message = await httpErrorMessage(response(404, page, 'text/html'));
    expect(message).toBe('404: the request did not reach the API; an error page came back instead');
    expect(message).not.toContain('<');
  });

  it('names an HTML body that arrived mislabelled', async () => {
    const message = await httpErrorMessage(response(502, '<html>oh no</html>', 'text/plain'));
    expect(message).not.toContain('<');
  });

  it('quotes a plain-text body, capped', async () => {
    const message = await httpErrorMessage(response(500, 'x'.repeat(500), 'text/plain'));
    expect(message).toBe(`500: ${'x'.repeat(200)}`);
  });

  it('quotes a JSON body that is not shaped like ours', async () => {
    const message = await httpErrorMessage(response(400, '{"detail":"nope"}', 'application/json'));
    expect(message).toBe('400: {"detail":"nope"}');
  });

  it('is the status alone when there is no body', async () => {
    expect(await httpErrorMessage(response(401, ''))).toBe('401');
  });
});

describe('errorText', () => {
  it('drops the status httpErrorMessage leads with, and keeps the route’s sentence', async () => {
    const res = new Response(JSON.stringify({ error: 'The server is busy' }), {
      status: 503,
      statusText: 'Service Unavailable',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(errorText(new ApiError(503, await httpErrorMessage(res)))).toBe('The server is busy');
    // HTTP/2: no reason phrase.
    expect(errorText(new Error('404: Not found'))).toBe('Not found');
  });

  it('leaves a message that is not one of ours as it is', () => {
    expect(errorText(new Error('This note has changes that have not synced yet. Try again in a moment.'))).toBe(
      'This note has changes that have not synced yet. Try again in a moment.',
    );
    expect(errorText('plain')).toBe('plain');
  });
});
