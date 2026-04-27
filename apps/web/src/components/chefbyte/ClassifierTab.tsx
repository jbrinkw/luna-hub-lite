import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Toggle } from '@/components/ui/Toggle';
import { useAuth } from '@/shared/auth/AuthProvider';
import { supabase } from '@/shared/supabase';
import { queryKeys } from '@/shared/queryKeys';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface ClassifierProfile {
  chefbyte_classifier_fallback_enabled: boolean;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Predicate the SettingsPage unit test pins. Exported so the test can
 * import the same arithmetic the toggle uses for "is the toggle on
 * right now?" — keeps the test from coupling to the rendered DOM
 * shape and acts as a tiny mutation boundary on the toggle's logic.
 */
export function isFallbackEnabled(profile: ClassifierProfile | null | undefined): boolean {
  return Boolean(profile?.chefbyte_classifier_fallback_enabled);
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

const cardCls = 'border border-border rounded-lg p-5 mb-4 bg-surface';

export function ClassifierTab() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const { data: profile, isLoading } = useQuery({
    queryKey: queryKeys.profile(user!.id),
    queryFn: async () => {
      const { data, error } = await supabase
        .schema('hub')
        .from('profiles')
        .select('chefbyte_classifier_fallback_enabled')
        .eq('user_id', user!.id)
        .single();
      if (error) throw error;
      return data as ClassifierProfile;
    },
    enabled: !!user,
  });

  const fallbackEnabled = isFallbackEnabled(profile);

  // Optimistic toggle: flip the cache eagerly, then write through. On
  // error roll back. Mirrors the AccountPage profile-update pattern but
  // adds optimism since the toggle is a one-tap action where the
  // network round-trip would otherwise feel laggy.
  const toggleMutation = useMutation({
    mutationFn: async (next: boolean) => {
      const { error } = await supabase
        .schema('hub')
        .from('profiles')
        .update({ chefbyte_classifier_fallback_enabled: next })
        .eq('user_id', user!.id);
      if (error) throw error;
    },
    onMutate: async (next: boolean) => {
      const key = queryKeys.profile(user!.id);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<ClassifierProfile>(key);
      queryClient.setQueryData<ClassifierProfile>(key, (old) => ({
        ...(old ?? { chefbyte_classifier_fallback_enabled: false }),
        chefbyte_classifier_fallback_enabled: next,
      }));
      return { previous };
    },
    onError: (_err, _next, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(queryKeys.profile(user!.id), context.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.profile(user!.id) });
    },
  });

  return (
    <div data-testid="classifier-tab" className="p-5">
      <div className="mb-4 pb-3 border-b border-border">
        <h2 className="m-0 text-lg font-bold text-text">Classifier Settings</h2>
        <p className="m-0 mt-1 text-sm text-text-secondary">
          Tune how the live-shelf identifies items it sees on the camera
        </p>
      </div>

      <div data-testid="classifier-fallback-section" className={cardCls}>
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <h3 className="m-0 mb-1 text-base font-bold text-text">Classifier fallback mode</h3>
            <p className="m-0 text-sm text-text-secondary">
              If the classifier can&apos;t match a placed item to your current inventory, try matching against all
              certified LiveTrack items as a fallback. Adds latency + AI cost when triggered. Off by default.
            </p>
          </div>
          <div className="shrink-0">
            <Toggle
              checked={fallbackEnabled}
              onChange={(next) => toggleMutation.mutate(next)}
              disabled={isLoading || toggleMutation.isPending}
              data-testid="classifier-fallback-toggle"
              aria-label="Classifier fallback mode"
            />
          </div>
        </div>
        {toggleMutation.isError && (
          <p
            data-testid="classifier-fallback-error"
            className="mt-3 text-sm text-danger-text bg-danger-subtle px-3 py-2 rounded-md border border-danger"
          >
            Failed to update setting: {(toggleMutation.error as Error).message}
          </p>
        )}
      </div>
    </div>
  );
}
