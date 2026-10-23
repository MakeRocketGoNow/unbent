import { createFileRoute } from '@tanstack/react-router';
import { requireFrontPage } from '../front-gate.js';
import { CompareIndexPage } from '../components/ComparePage.js';

/**
 * How Unbent compares, `/compare`: one line on each comparison and a link to it. Not
 * linked from the front page; it is for search, for the story to point at, and for
 * sending to someone who asked. Public through `shellFor` (`COMPARE_PATHS`).
 */
export const Route = createFileRoute('/compare/')({
  beforeLoad: requireFrontPage,
  component: CompareIndexPage,
});
