/**
 * Purges every note in a test actor's account, so the account holds nothing at all.
 *
 * Every account is created holding one note, the welcome note (`src/lib/welcome-note.ts`).
 * The suites that count — totals, pages, export entries, store stats — were written for an
 * account that starts at zero, and that is still what they are about: a paging test is
 * about the cursor, not about what a new account is given. So their actors are emptied
 * here first, rather than every count in them gaining a "+ 1" that says nothing about what
 * they test and breaks the day the welcome note changes.
 *
 * Purged rather than trashed, because the trash is counted too. What a new account holds
 * is pinned once, in `isolation.test.ts`, with the check that nobody else can read it.
 *
 * Not a `.test.ts`, so vitest collects it only as an import.
 */
export async function emptyAccount(base: string, origin: string, cookie: string): Promise<void> {
  const headers = { 'Content-Type': 'application/json', Cookie: cookie, Origin: origin };
  const listed = await fetch(`${base}/api/notes`, { headers });
  if (!listed.ok) throw new Error(`listing notes to empty the account failed: ${listed.status}`);
  const ids = ((await listed.json()) as { items: Array<{ id: string }> }).items.map((n) => n.id);
  if (ids.length === 0) return;
  for (const step of ['trash', 'purge']) {
    const res = await fetch(`${base}/api/notes/${step}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) throw new Error(`${step} while emptying the account failed: ${res.status}`);
  }
}
