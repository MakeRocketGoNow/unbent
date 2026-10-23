import { createFileRoute } from '@tanstack/react-router';
import { requireFrontPage } from '../front-gate.js';
import { JoplinComparison } from '../components/ComparePage.js';

/** Unbent beside Joplin; see `ComparePage`. Public through `shellFor` (`COMPARE_PATHS`). */
export const Route = createFileRoute('/compare/joplin')({
  beforeLoad: requireFrontPage,
  component: JoplinComparison,
});
