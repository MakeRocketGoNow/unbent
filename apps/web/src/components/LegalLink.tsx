import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';

/**
 * A link to a legal document, wherever this instance keeps it.
 *
 * The destination comes from `/api/config` and can be either kind: `/privacy` for the
 * built-in documents, or an absolute URL for an operator hosting their own. Those need
 * different elements — a router `<Link>` for a route, a plain `<a>` for another site — and
 * the call sites should not each have to remember which they are holding.
 *
 * The distinction matters more than it looks. `<Link to>` pushes onto the router's history,
 * so an absolute URL handed to it becomes a route this app does not have rather than a
 * navigation off the site.
 *
 * No `target="_blank"`: these are documents to read, not a tool to keep open beside the
 * app, and a new tab is the reader's decision to make rather than ours.
 */
export function LegalLink({ href, children }: { href: string; children: ReactNode }) {
  if (href.startsWith('/')) return <Link to={href}>{children}</Link>;
  return (
    <a href={href} rel="noopener noreferrer">
      {children}
    </a>
  );
}
