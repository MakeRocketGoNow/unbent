import { createFileRoute } from '@tanstack/react-router';
import { Export } from '../components/Export.js';

export const Route = createFileRoute('/settings/export')({
  component: Export,
});
