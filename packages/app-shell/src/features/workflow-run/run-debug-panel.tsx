import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@ora/ui";
import {
  RemoteContractError,
  type CommitWorkflowDebugRequest,
  type PreviewWorkflowDebugRequest,
  type WorkflowDebugHistoryEntry,
  type WorkflowDebugOperation,
  type WorkflowDebugPreview,
} from "@ora/contracts";
import { localizeContractError } from "../../i18n/contract-error";
import { RunDebugAttempt } from "./run-debug-attempt";
import { useWorkflowDebugHistory } from "../../state/data/workflow-runs";
import {
  RunNodeConfigForm,
  type RunNodeConfigFormProps,
} from "../workflow-editor/run-node-config-form";

type FormInput = Omit<RunNodeConfigFormProps, "onCancel" | "onSubmit">;

function positionKey({ target }: FormInput) {
  if ("nodeRunId" in target)
    return JSON.stringify([target.runId, target.nodeRunId]);
  const { rootScopeId, scopeId, nodeId, containerNodeRunId, index } =
    target.pendingTarget;
  return JSON.stringify([
    target.runId,
    rootScopeId,
    scopeId,
    nodeId,
    containerNodeRunId,
    index,
  ]);
}
/** Inputs are scoped to the current run by the data owner, including undispatched positions. */
export interface RunDebugSession {
  runId: string;
  positions: { label: string; input: FormInput }[];
  history: WorkflowDebugHistoryEntry[];
  preview(request: PreviewWorkflowDebugRequest): Promise<WorkflowDebugPreview>;
  commit(request: CommitWorkflowDebugRequest): Promise<WorkflowDebugOperation>;
  refresh(): Promise<void>;
}

function Operation({
  operation,
  live = false,
}: {
  operation: WorkflowDebugOperation;
  live?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <p role={live ? "status" : undefined}>
      {operation.state === "applied"
        ? t("workflowRun.debug.applied", { revision: operation.revision })
        : operation.state === "stopping"
          ? t("workflowRun.debug.stopping")
          : t("workflowRun.debug.stopFailed", {
              reason: operation.reason,
              ids: operation.unsettledNodeRunIds.join(", "),
            })}
    </p>
  );
}

function Impact({ preview: p }: { preview: WorkflowDebugPreview }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      <p>
        {p.target.nodeId} · {p.target.scopeId} {p.target.containerNodeRunId}{" "}
        {p.target.nodeRunId}
      </p>
      {p.target.round != null && (
        <p>{t("workflowRun.loopRounds.round", { round: p.target.round })}</p>
      )}
      {p.target.index != null && (
        <p>{t("workflowRun.debug.item", { item: p.target.index + 1 })}</p>
      )}
      <dl>
        {(["keep", "invalidate", "stop", "schedule"] as const).map((group) => (
          <div key={group}>
            <dt className="font-medium">{t(`workflowRun.debug.${group}`)}</dt>
            <dd>{p[group].join(", ") || "—"}</dd>
          </div>
        ))}
      </dl>
      {p.predictedBranch && (
        <p>{t("workflowRun.debug.branch", { branch: p.predictedBranch })}</p>
      )}
      {p.memberConfigurations && (
        <details>
          <summary>{t("workflowRun.debug.members")}</summary>
          <pre>{JSON.stringify(p.memberConfigurations, null, 2)}</pre>
        </details>
      )}
      <p>{t("workflowRun.debug.files")}</p>
      {p.externalActionsMayRepeat && <p>{t("workflowRun.debug.repeat")}</p>}
    </div>
  );
}

type Ticket = {
  preview: WorkflowDebugPreview;
  request: CommitWorkflowDebugRequest;
};
function Edit({
  session,
  input,
  onCancel,
}: {
  session: RunDebugSession;
  input: FormInput;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [ticket, setTicket] = useState<Ticket>();
  const [receipt, setReceipt] = useState<WorkflowDebugOperation>();
  const [error, setError] = useState<string>();
  const [refreshError, setRefreshError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const operation =
    session.history.find(
      (e) => e.operation.requestId === ticket?.request.requestId,
    )?.operation ?? receipt;
  async function submit(edit: PreviewWorkflowDebugRequest) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(undefined);
    setRefreshError(undefined);
    try {
      const preview = await session.preview(edit);
      setTicket({
        preview,
        request: {
          runId: edit.runId,
          previewId: preview.previewId,
          requestId: crypto.randomUUID(),
        },
      });
    } catch (e) {
      setError(localizeContractError(e, t));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function confirm(current: Ticket) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(undefined);
    setRefreshError(undefined);
    try {
      setReceipt(await session.commit(current.request));
    } catch (e) {
      if (
        e instanceof RemoteContractError &&
        e.code.startsWith("workflow_debug_")
      ) {
        setTicket(undefined);
        setError(localizeContractError(e, t));
      } else {
        // Delivery can fail after acceptance. A retry must replay the original request key.
        setError(t("workflowRun.debug.uncertain"));
      }
    } finally {
      try {
        await session.refresh();
      } catch (e) {
        setRefreshError(localizeContractError(e, t));
      }
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="space-y-2">
      {error && !operation && <p role="alert">{error}</p>}
      {refreshError && <p role="alert">{refreshError}</p>}
      {operation ? (
        <Operation operation={operation} live />
      ) : ticket ? (
        <>
          <Impact preview={ticket.preview} />
          <Button disabled={busy} onClick={() => void confirm(ticket)}>
            {t("workflowRun.debug.confirm")}
          </Button>
          <Button disabled={busy} variant="outline" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
        </>
      ) : (
        <fieldset disabled={busy}>
          <RunNodeConfigForm
            {...input}
            onSubmit={(edit) => void submit(edit)}
            onCancel={onCancel}
          />
        </fieldset>
      )}
    </div>
  );
}

function History({
  entries,
  runId,
}: {
  entries: WorkflowDebugHistoryEntry[];
  runId: string;
}) {
  const { t } = useTranslation();
  return (
    <>
      <h3>{t("workflowRun.debug.history")}</h3>
      {entries.length === 0 ? (
        <p>{t("workflowRun.debug.empty")}</p>
      ) : (
        <ol>
          {entries.map((e) => (
            <li key={e.operation.operationId}>
              <details>
                <summary>
                  {e.preview.target.nodeId} · {e.operation.operationId}
                </summary>
                <Operation operation={e.operation} />
                <Impact preview={e.preview} />
                <pre>{JSON.stringify(e.patch, null, 2)}</pre>
                {Array.from(
                  new Set([e.preview.target.nodeRunId, e.firstNodeRunId]),
                ).map(
                  (id) =>
                    id && (
                      <RunDebugAttempt key={id} runId={runId} nodeRunId={id} />
                    ),
                )}
              </details>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

export function RunDebugDisclosure({
  runId,
  session,
}: {
  runId: string;
  session?: RunDebugSession;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="cursor-pointer px-3 py-1">
        {t(session ? "workflowRun.debug.title" : "workflowRun.debug.history")}
      </summary>
      {open &&
        (session ? (
          <RunDebugPanel session={session} />
        ) : (
          <PersistedHistory runId={runId} />
        ))}
    </details>
  );
}

function PersistedHistory({ runId }: { runId: string }) {
  const { t } = useTranslation();
  const query = useWorkflowDebugHistory(runId);
  return (
    <div className="max-h-[60vh] space-y-3 overflow-auto border-b p-3 text-sm">
      {query.data && <History entries={query.data} runId={runId} />}
      {query.isPending && <p role="status">{t("workflowRun.loading")}</p>}
      {query.error && (
        <p role="alert">{localizeContractError(query.error, t)}</p>
      )}
      <Button
        size="sm"
        disabled={query.isFetching}
        onClick={() => void query.refetch()}
      >
        {t("workflowRun.debug.refresh")}
      </Button>
    </div>
  );
}

export function RunDebugPanel({ session }: { session: RunDebugSession }) {
  const { t } = useTranslation();
  const [selected, select] = useState("");
  const [error, setError] = useState<string>();
  const positions = session.positions.filter(
    (p) => p.input.target.runId === session.runId,
  );
  const input = positions.find((p) => positionKey(p.input) === selected)?.input;
  return (
    <section
      className="max-h-[60vh] space-y-3 overflow-auto border-b p-3 text-sm"
      aria-label={t("workflowRun.debug.title")}
    >
      <label>
        {t("workflowRun.debug.position")}{" "}
        <select
          value={input ? selected : ""}
          onChange={(e) => select(e.target.value)}
        >
          <option value="">—</option>
          {positions.map((p) => (
            <option key={positionKey(p.input)} value={positionKey(p.input)}>
              {p.label} ·{" "}
              {"nodeRunId" in p.input.target
                ? p.input.target.nodeRunId
                : [
                    p.input.target.pendingTarget.scopeId,
                    p.input.target.pendingTarget.nodeId,
                    p.input.target.pendingTarget.containerNodeRunId,
                    p.input.target.pendingTarget.index == null
                      ? null
                      : t("workflowRun.debug.item", {
                          item: p.input.target.pendingTarget.index + 1,
                        }),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
            </option>
          ))}
        </select>
      </label>
      {input && (
        <Edit
          key={JSON.stringify([selected, input.baseRevision, input.effective])}
          input={input}
          session={session}
          onCancel={() => select("")}
        />
      )}
      <History entries={session.history} runId={session.runId} />
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          setError(undefined);
          void session
            .refresh()
            .catch((e) => setError(localizeContractError(e, t)));
        }}
      >
        {t("workflowRun.debug.refresh")}
      </Button>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
