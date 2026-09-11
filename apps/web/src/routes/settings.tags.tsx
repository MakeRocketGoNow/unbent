import { createFileRoute } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Tags } from '../components/Tags.js';
import { keys } from '../queries.js';

export const Route = createFileRoute('/settings/tags')({
  component: TagsRoute,
});

function TagsRoute() {
  const queryClient = useQueryClient();

  return (
    <Tags
      onChanged={() => {
        // Renaming, merging or deleting a tag changes every note that carried it: the tag
        // list, every note list's rows, and any open note's chips are all stale.
        void queryClient.invalidateQueries({ queryKey: keys.tags() });
        void queryClient.invalidateQueries({ queryKey: ['notes'] });
        void queryClient.invalidateQueries({ queryKey: ['note'] });
      }}
    />
  );
}
