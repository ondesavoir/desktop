import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import {
  RemoteContractError,
  type WorkflowDebugPreview,
  type WorkflowDebugOperation,
  type GetWorkflowDebugAttemptResponse,
} from "@ora/contracts";
import { createChatStore } from "@ora/chat";
import { createMockWorkflowCapabilities } from "@ora/workflow-mock";
import { appI18n } from "../../i18n/i18n-instance";
import {
  createHookWrapper,
  createTestQueryClient,
  renderHookWithClient,
} from "../../test/hook-harness";
import { createTestClient } from "../../test/contracts-transport";
import {
  invalidateWorkflowRun,
  useWorkflowDebugHistory,
} from "../../state/data/workflow-runs";
import {
  RunDebugDisclosure,
  RunDebugPanel,
  type RunDebugSession,
} from "./run-debug-panel";

beforeEach(async () => {
  await appI18n.changeLanguage("en-US");
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const preview: WorkflowDebugPreview = {
  previewId: "p1",
  baseRevision: 0,
  target: {
    nodeRunId: "it1",
    nodeId: "loop",
    scopeId: "root",
    round: null,
    index: null,
    containerNodeRunId: null,
  },
  keep: ["start.input"],
  invalidate: ["loop.export"],
  stop: ["attempt-3"],
  schedule: ["loop.entry"],
  workspace: "keep",
  externalActionsMayRepeat: true,
  predictedBranch: null,
  memberConfigurations: { worker: { prompt: "original" } },
};
function example() {
  const input: RunDebugSession["positions"][number]["input"] = {
    target: { runId: "F", nodeRunId: "it1" },
    baseRevision: 0,
    effective: {
      kind: "loop",
      config: { until: { logic: "and", conditions: [] }, maxIterations: 5 },
    },
    variables: [],
    capabilities: createMockWorkflowCapabilities("en-US", []),
  };
  return {
    runId: "F",
    positions: [
      { label: "Container", input },
      {
        label: "Ready",
        input: {
          ...input,
          target: {
            runId: "F",
            pendingTarget: {
              scopeId: "root",
              rootScopeId: "root",
              nodeId: "next",
            },
          },
        },
      },
    ],
    history: [],
    preview: vi.fn<RunDebugSession["preview"]>().mockResolvedValue(preview),
    commit: vi.fn<RunDebugSession["commit"]>(),
    refresh: vi.fn(async () => {}),
  } satisfies RunDebugSession;
}
async function edit(
  user: ReturnType<typeof userEvent.setup>,
  position: string,
) {
  await user.selectOptions(
    screen.getByRole("combobox", { name: /Select an execution/ }),
    screen.getByRole("option", { name: new RegExp(position) }),
  );
  fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "2" } });
  await user.click(screen.getByRole("button", { name: "Preview changes" }));
}
const confirm = () =>
  screen.getByRole("button", { name: /Confirm and continue/ });
it("re-reads durable history after a run invalidation through the generated client", async () => {
  const entry = {
    preview,
    patch: [],
    firstNodeRunId: null,
    priorRunStatus: "running" as const,
    priorError: null,
    operation: {
      state: "applied" as const,
      revision: 1,
      operationId: "op1",
      requestId: "k1",
      baseRevision: 0,
    },
  };
  const history = vi
    .fn()
    .mockResolvedValueOnce({ entries: [] })
    .mockResolvedValueOnce({ entries: [entry] });
  const view = renderHookWithClient(
    () => useWorkflowDebugHistory("F"),
    createTestClient({ getWorkflowDebugHistory: history }),
  );
  await waitFor(() => expect(view.result.current.data).toEqual([]));
  act(() => invalidateWorkflowRun(view.queryClient, "F"));
  await waitFor(() => expect(view.result.current.data).toEqual([entry]));
  expect(history.mock.calls.map((call) => call[0])).toEqual([
    { runId: "F" },
    { runId: "F" },
  ]);
  view.unmount();
});
it("previews the form patch and retries an uncertain confirmation with the original key", async () => {
  const user = userEvent.setup(),
    session = example();
  const response = deferred<WorkflowDebugOperation>();
  session.commit
    .mockReturnValueOnce(response.promise)
    .mockImplementationOnce(async (req) => ({
      operationId: "op",
      requestId: req.requestId,
      baseRevision: 0,
      state: "stopping",
    }));
  render(<RunDebugPanel session={session} />);
  await edit(user, "Container");
  expect(session.preview).toHaveBeenCalledWith({
    runId: "F",
    nodeRunId: "it1",
    baseRevision: 0,
    patch: [{ op: "replace", path: "/loopConfig/maxIterations", value: 2 }],
  });
  for (const fact of [
    "start.input",
    "loop.export",
    "attempt-3",
    "loop.entry",
    /External actions/,
  ])
    expect(screen.getByText(fact)).toBeInTheDocument();
  await user.dblClick(confirm());
  expect(session.commit).toHaveBeenCalledTimes(1);
  await act(async () => response.reject(new Error("lost response")));
  expect(screen.getByRole("alert")).toHaveTextContent("retry the same request");
  await user.click(confirm());
  expect(session.commit.mock.calls[1]).toEqual(session.commit.mock.calls[0]);
  expect(
    await screen.findByText("Waiting for earlier attempts to stop."),
  ).toBeVisible();
});
it("drops late previews on reselection, forwards a pending target and requires a new preview after staleness", async () => {
  const user = userEvent.setup(),
    session = example(),
    first = deferred<WorkflowDebugPreview>();
  session.preview.mockReturnValueOnce(first.promise).mockResolvedValueOnce({
    ...preview,
    previewId: "p2",
    target: { ...preview.target, nodeId: "next", nodeRunId: undefined },
  });
  session.commit.mockRejectedValueOnce(
    new RemoteContractError(
      { code: "workflow_debug_stale_preview", params: {}, requestId: "e1" },
      null,
    ),
  );
  render(<RunDebugPanel session={session} />);
  await edit(user, "Container");
  await edit(user, "Ready");
  await act(async () => first.resolve(preview));
  expect(session.preview.mock.calls[1]?.[0]).toMatchObject({
    pendingTarget: { rootScopeId: "root", scopeId: "root", nodeId: "next" },
  });
  await user.click(confirm());
  expect(session.commit.mock.calls[0]?.[0].previewId).toBe("p2");
  expect(await screen.findByRole("alert")).toHaveTextContent(/stale/i);
  expect(
    screen.queryByRole("button", { name: /Confirm and continue/ }),
  ).toBeNull();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(session.commit).toHaveBeenCalledTimes(1);
});
it("reopens a persisted stop failure without submitting again", async () => {
  const user = userEvent.setup(),
    session = example();
  render(
    <RunDebugPanel
      session={{
        ...session,
        history: [
          {
            firstNodeRunId: null,
            priorError: null,
            priorRunStatus: "running",
            patch: [],
            preview,
            operation: {
              state: "stop_failed",
              operationId: "op-3",
              requestId: "req",
              baseRevision: 0,
              reason: "session still writing",
              unsettledNodeRunIds: ["nr-3"],
            },
          },
        ],
      }}
    />,
  );
  await user.click(screen.getByText(/op-3/));
  expect(screen.getByRole("status")).toHaveTextContent(
    /session still writing.*nr-3/,
  );
  expect(session.commit).not.toHaveBeenCalled();
});

it("opens the stored dispatch configuration from a reloaded run's history", async () => {
  const user = userEvent.setup();
  const entry = {
    preview,
    patch: [],
    firstNodeRunId: "first-new",
    priorError: null,
    priorRunStatus: "running" as const,
    operation: {
      state: "applied" as const,
      revision: 1,
      operationId: "op1",
      requestId: "k1",
      baseRevision: 0,
    },
  };
  const attempt = vi.fn(
    async ({
      nodeRunId,
    }: {
      nodeRunId: string;
    }): Promise<GetWorkflowDebugAttemptResponse> => ({
      target: { ...preview.target, nodeRunId },
      status: "succeeded",
      revision: nodeRunId === "it1" ? 0 : null,
      configuration: nodeRunId === "it1" ? { maxIterations: 5 } : null,
      snapshotId: null,
      selectedBranch: null,
      superseded: nodeRunId === "it1",
      retiredByOperationId: nodeRunId === "it1" ? "op1" : null,
      inputRecorded: true,
      output: null,
      error: null,
    }),
  );
  const client = createTestClient({
    getWorkflowDebugHistory: async () => ({ entries: [entry] }),
    getWorkflowDebugAttempt: attempt,
  });
  const wrapper = createHookWrapper(
    client,
    createTestQueryClient(),
    createChatStore(client.session),
  );
  render(<RunDebugDisclosure runId="F" />, { wrapper });
  await user.click(screen.getByText("Debug history for this run"));
  await user.click(await screen.findByText(/loop · op1/));
  expect(attempt).not.toHaveBeenCalled();
  await user.click(screen.getByText("Inspect execution it1"));
  expect(await screen.findByText(/"maxIterations": 5/)).toBeVisible();
  expect(screen.getByText(/This attempt was superseded/)).toBeVisible();
  const first = screen.getByText("Inspect execution first-new");
  await user.click(first);
  const newAttempt = within(first.closest("details")!);
  expect(
    await newAttempt.findByText(
      "This execution has no recorded configuration.",
    ),
  ).toBeVisible();
  expect(newAttempt.queryByText(/maxIterations/)).toBeNull();
  expect(attempt.mock.calls.map(([request]) => request)).toEqual([
    { runId: "F", nodeRunId: "it1" },
    { runId: "F", nodeRunId: "first-new" },
  ]);
});

it("requires a fresh container preview after a historical member is rejected", async () => {
  const user = userEvent.setup();
  const session = example();
  const member = {
    ...session.positions[0].input,
    target: { runId: "F", nodeRunId: "member-3" },
  };
  session.positions.push({ label: "Member in round 3", input: member });
  session.preview.mockRejectedValueOnce(
    new RemoteContractError(
      {
        code: "workflow_debug_target_rejected",
        requestId: "refused",
        params: { reason: "Missing round entry state" },
      },
      null,
    ),
  );
  render(<RunDebugPanel session={session} />);
  await edit(user, "Member in round 3");
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Missing round entry state",
  );
  expect(
    screen.queryByRole("button", { name: /Confirm and continue/ }),
  ).toBeNull();
  await edit(user, "Container");
  expect(
    session.preview.mock.calls.map(
      ([request]) => "nodeRunId" in request && request.nodeRunId,
    ),
  ).toEqual(["member-3", "it1"]);
  await user.click(
    screen.getByText("Member configuration for the new container"),
  );
  expect(screen.getByText(/"prompt": "original"/)).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(session.commit).not.toHaveBeenCalled();
});
