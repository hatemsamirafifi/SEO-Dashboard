import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { traceServerCall } from "@/client/features/tracing/traceServerCall";
import {
  archiveGa4Goal,
  createGa4Goal,
  listGa4Goals,
  updateGa4Goal,
} from "@/serverFunctions/ga4";

export type GoalRow = Awaited<ReturnType<typeof listGa4Goals>>["goals"][number];

/** Project goal management (spec 010, contracts/goals-api.md): create, list,
 *  rename, and archive conversion goals. Mutations are traced as
 *  `analytics.goal_change` (P41); archived goals are read-only and historical
 *  evidence referencing them stays frozen. */
export function GoalsManager({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [eventName, setEventName] = useState("");
  const [keyOnly, setKeyOnly] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");

  const goalsQuery = useQuery({
    queryKey: ["ga4Goals", projectId],
    queryFn: () => listGa4Goals({ data: { projectId } }),
  });
  const goals: GoalRow[] = goalsQuery.data?.goals ?? [];

  async function invalidate() {
    await queryClient.invalidateQueries({ queryKey: ["ga4Goals", projectId] });
    await queryClient.invalidateQueries({
      queryKey: ["analyticsConversions", projectId],
    });
  }

  const createMutation = useMutation({
    mutationFn: (input: {
      name: string;
      eventName: string;
      keyOnly: boolean;
    }) =>
      traceServerCall({
        feature: "analytics",
        operation: "analytics.goal_change",
        source: "Analytics goals",
        projectId,
        call: () =>
          createGa4Goal({
            data: {
              projectId,
              name: input.name,
              eventName: input.eventName,
              matchKeyEventOnly: input.keyOnly,
            },
          }),
      }),
    onSuccess: async () => {
      setName("");
      setEventName("");
      setKeyOnly(false);
      await invalidate();
    },
  });

  const updateMutation = useMutation({
    mutationFn: (input: { id: string; name: string }) =>
      traceServerCall({
        feature: "analytics",
        operation: "analytics.goal_change",
        source: "Analytics goals",
        projectId,
        call: () =>
          updateGa4Goal({
            data: { projectId, id: input.id, name: input.name },
          }),
      }),
    onSuccess: async () => {
      setEditingId(null);
      setEditingName("");
      await invalidate();
    },
  });

  const archiveMutation = useMutation({
    mutationFn: (id: string) =>
      traceServerCall({
        feature: "analytics",
        operation: "analytics.goal_change",
        source: "Analytics goals",
        projectId,
        call: () => archiveGa4Goal({ data: { projectId, id } }),
      }),
    onSuccess: async () => {
      await invalidate();
    },
  });

  const mutationError =
    createMutation.error ?? updateMutation.error ?? archiveMutation.error;

  return (
    <section aria-label="Conversion goals" className="card bg-base-100 shadow">
      <div className="card-body gap-3">
        <h2 className="card-title text-base">Conversion goals</h2>
        <p className="text-sm text-base-content/60">
          Goals name the GA4 events this project converts on. Analytics and
          opportunities filter by goal; archived goals stay readable in history
          but can no longer change.
        </p>
        <form
          className="flex flex-col gap-2 lg:flex-row lg:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim() && eventName.trim()) {
              createMutation.mutate({
                name: name.trim(),
                eventName: eventName.trim(),
                keyOnly,
              });
            }
          }}
        >
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-base-content/60">Goal name</span>
            <input
              className="input input-bordered input-sm w-56"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Newsletter signup"
              aria-label="Goal name"
              maxLength={100}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-base-content/60">GA4 event name</span>
            <input
              className="input input-bordered input-sm w-56"
              value={eventName}
              onChange={(event) => setEventName(event.target.value)}
              placeholder="signup_completed"
              aria-label="GA4 event name"
              maxLength={100}
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="checkbox checkbox-sm"
              checked={keyOnly}
              onChange={(event) => setKeyOnly(event.target.checked)}
            />
            <span className="text-base-content/60">Key events only</span>
          </label>
          <button
            type="submit"
            className="btn btn-primary btn-sm"
            disabled={
              createMutation.isPending || !name.trim() || !eventName.trim()
            }
          >
            {createMutation.isPending ? "Adding…" : "Add goal"}
          </button>
        </form>
        {mutationError ? (
          <div className="alert alert-error" role="alert">
            <span className="text-sm">
              {getStandardErrorMessage(mutationError)}
            </span>
          </div>
        ) : null}
        {goalsQuery.isPending ? (
          <p className="text-sm text-base-content/60">Loading goals…</p>
        ) : goalsQuery.isError ? (
          <div className="alert alert-error" role="alert">
            <span className="text-sm">
              {getStandardErrorMessage(goalsQuery.error)}
            </span>
          </div>
        ) : goals.length === 0 ? (
          <p className="text-sm text-base-content/60">
            No goals yet. Add one above — conversions and opportunities can
            filter by goal once it exists.
          </p>
        ) : (
          <ul className="divide-y divide-base-200">
            {goals.map((goal) => (
              <li
                key={goal.id}
                className="flex flex-col gap-1 py-2 lg:flex-row lg:items-center lg:gap-3"
              >
                {editingId === goal.id ? (
                  <>
                    <input
                      className="input input-bordered input-sm w-56"
                      value={editingName}
                      onChange={(event) => setEditingName(event.target.value)}
                      aria-label="Goal name"
                      maxLength={100}
                    />
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={updateMutation.isPending || !editingName.trim()}
                      onClick={() =>
                        updateMutation.mutate({
                          id: goal.id,
                          name: editingName.trim(),
                        })
                      }
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => {
                        setEditingId(null);
                        setEditingName("");
                      }}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <span className="text-sm font-medium">{goal.name}</span>
                    <span className="text-xs text-base-content/60">
                      {goal.eventName}
                      {goal.matchKeyEventOnly ? " · key events only" : ""}
                    </span>
                    <span className="lg:ml-auto" />
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => {
                        setEditingId(goal.id);
                        setEditingName(goal.name);
                      }}
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={archiveMutation.isPending}
                      onClick={() => archiveMutation.mutate(goal.id)}
                    >
                      Archive
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
