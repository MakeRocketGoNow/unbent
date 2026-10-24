import { createFileRoute } from '@tanstack/react-router';
import { requireFrontPage } from '../front-gate.js';
import { EvernoteComparison } from '../components/ComparePage.js';

/** Unbent beside Evernote; see `ComparePage`. Public through `shellFor` (`COMPARE_PATHS`). */
export const Route = createFileRoute('/compare/evernote')({
  beforeLoad: requireFrontPage,
  component: EvernoteComparison,
});
