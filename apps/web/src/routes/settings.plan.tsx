import { createFileRoute } from '@tanstack/react-router';
import { Plan } from '../components/Plan.js';

export const Route = createFileRoute('/settings/plan')({
  component: Plan,
});
