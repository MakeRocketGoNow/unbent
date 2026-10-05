import { describe, expect, it } from 'vitest';
import { appLinks } from './app-links.js';

const id = 'da0bc713-7664-464b-b76e-af5fb3b66297';

describe('appLinks', () => {
  it('builds an absolute link to the note on the instance it is given', () => {
    expect(appLinks('https://unbent.app').note(id)).toBe(`https://unbent.app/notes/${id}`);
    // A self-hosted domain, and a dev server on its own port, link to themselves.
    expect(appLinks('https://notes.example.com').note(id)).toBe(`https://notes.example.com/notes/${id}`);
    expect(appLinks('http://localhost:5234').note(id)).toBe(`http://localhost:5234/notes/${id}`);
  });

  it('ignores a trailing slash or a path on the setting rather than doubling a segment', () => {
    expect(appLinks('https://unbent.app/').note(id)).toBe(`https://unbent.app/notes/${id}`);
    expect(appLinks('https://unbent.app/settings').note(id)).toBe(`https://unbent.app/notes/${id}`);
  });

  it('links a trashed note to the trash, where it opens', () => {
    expect(appLinks('https://unbent.app').note(id, { trashed: true })).toBe(`https://unbent.app/trash/${id}`);
  });

  it('links a notebook to the note list filtered to it, escaped', () => {
    const links = appLinks('https://unbent.app');
    expect(links.notebook('Coupons')).toBe('https://unbent.app/notes?notebook=Coupons');
    expect(links.notebook('Watch Later')).toBe('https://unbent.app/notes?notebook=Watch+Later');
    expect(links.notebook('Bills & Receipts')).toBe('https://unbent.app/notes?notebook=Bills+%26+Receipts');
  });

  it('quotes a notebook name the router would read back as a number or a boolean', () => {
    // The web app's router JSON-parses each search value; unquoted, `2024` would arrive as
    // a number, fail the filter's schema, and open every note instead of the notebook.
    const links = appLinks('https://unbent.app');
    expect(links.notebook('2024')).toBe('https://unbent.app/notes?notebook=%222024%22');
    expect(links.notebook('true')).toBe('https://unbent.app/notes?notebook=%22true%22');
    const read = new URL(links.notebook('2024')).searchParams.get('notebook')!;
    expect(JSON.parse(read)).toBe('2024');
  });

  it('refuses an APP_URL that is not an absolute URL, by name', () => {
    expect(() => appLinks('unbent.app')).toThrow(/APP_URL/);
    expect(() => appLinks('')).toThrow(/APP_URL/);
  });
});
