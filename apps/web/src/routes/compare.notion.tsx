import { createFileRoute } from '@tanstack/react-router';
import { requireFrontPage } from '../front-gate.js';
import { NotionComparison } from '../components/ComparePage.js';

/** Unbent beside Notion; see `ComparePage`. Public through `shellFor` (`COMPARE_PATHS`). */
export const Route = createFileRoute('/compare/notion')({
  beforeLoad: requireFrontPage,
  component: NotionComparison,
});
