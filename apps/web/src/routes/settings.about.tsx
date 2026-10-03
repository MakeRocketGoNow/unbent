import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { configQuery } from '../queries.js';
import { About } from '../components/About.js';

export const Route = createFileRoute('/settings/about')({
  component: AboutPage,
});

function AboutPage() {
  const config = useQuery(configQuery());
  return <About config={config.data} host={window.location.host} />;
}
