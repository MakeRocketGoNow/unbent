import { createFileRoute } from '@tanstack/react-router';
import { requireFrontPage } from '../front-gate.js';
import { PaperlessNgxComparison } from '../components/ComparePage.js';

/** Unbent beside Paperless-ngx; see `ComparePage`. Public through `shellFor` (`COMPARE_PATHS`). */
export const Route = createFileRoute('/compare/paperless-ngx')({
  beforeLoad: requireFrontPage,
  component: PaperlessNgxComparison,
});
