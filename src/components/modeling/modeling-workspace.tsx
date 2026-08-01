"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState
} from "react";
import { CommandPanel } from "@/components/modeling/command-panel";
import { InspectorPanel } from "@/components/modeling/inspector-panel";
import { ModelingHeader } from "@/components/modeling/modeling-header";
import { ModelingToolbar } from "@/components/modeling/modeling-toolbar";
import { NewProjectDialog } from "@/components/modeling/new-project-dialog";
import { ProjectPanel } from "@/components/modeling/project-panel";
import { ToolSettingsPanel } from "@/components/modeling/tool-settings-panel";
import { ViewportStage } from "@/components/modeling/viewport-stage";
import {
  cancelModelingJob,
  clientId,
  confirmAiPlan,
  createAiPlan,
  createModelingJob,
  createModelingProject,
  getAiPlan,
  getModelingJob,
  getModelingProject,
  importPrivateStep,
  listModelingProjects,
  listModelingRevisions,
  modelingArtifactDownloadUrl,
  ModelingClientError,
  postOperationBatch,
  rejectAiPlan,
  type ModelingJobSummary,
  type ModelingKernelDiagnostic,
  type ModelingRevisionSummary,
  type StepImportProgress,
  withAiPlanOperationDiffs
} from "@/lib/modeling/client/api";
import {
  cloneModelDocumentWithFreshIds,
  createBlankPartDocument,
  createOperationBatchFromManualState,
  getManualToolContext,
  isModelDocument,
  mergePumpStateIntoModelDocument,
  modelingDocumentKind,
  pumpDocumentFromModelDocument,
  selectedModelSemanticRefs
} from "@/lib/modeling/client/protocol-adapter";
import {
  createInitialWorkspaceState,
  modelingWorkspaceReducer,
  type ModelingDocumentKind,
  type ModelingSelection,
  type ModelingTool,
  type ModelingWorkspaceAction
} from "@/lib/modeling/client/workspace-state";
import type { ModelDocument, ModelParameter } from "@/types/modeling";
import styles from "./modeling-workspace.module.css";

export function ModelingWorkspace({
  userName,
  userId,
  initialProjectId,
  initialTemplate
}: {
  userName: string;
  userId: string;
  initialProjectId?: string;
  initialTemplate: ModelDocument;
}) {
  const [state, dispatch] = useReducer(
    modelingWorkspaceReducer,
    initialTemplate,
    (template) => ({
      ...createInitialWorkspaceState(modelingDocumentKind(template)),
      projectName: template.name,
      document: pumpDocumentFromModelDocument(template),
      ...initialGeneralSelection(template)
    })
  );
  const stateRef = useRef(state);
  const modelDocumentRef = useRef(initialTemplate);
  const previewRequestRef = useRef(0);
  const activePreviewRef = useRef<
    | {
        requestNumber: number;
        controller: AbortController;
        jobId?: string;
      }
    | undefined
  >(undefined);
  const revisionRequestRef = useRef(0);
  const [modelDocument, setModelDocument] = useState(initialTemplate);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [canonicalRevision, setCanonicalRevision] =
    useState<ModelingRevisionSummary>();
  const [revisions, setRevisions] = useState<ModelingRevisionSummary[]>([]);
  const [revisionsLoading, setRevisionsLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string>();
  const [importStatus, setImportStatus] = useState<{
    busy: boolean;
    message: string;
    error?: boolean;
  }>();
  const [kernelPreview, setKernelPreview] = useState<{
    status: "procedural" | "queued" | "ready" | "failed";
    url?: string;
    message?: string;
    diagnostics?: ModelingKernelDiagnostic[];
  }>({ status: "procedural" });
  const kernelPreviewRef = useRef(kernelPreview);
  const aiPreviewRestoreRef = useRef<typeof kernelPreview | undefined>(
    undefined
  );
  const [hiddenSemanticIds, setHiddenSemanticIds] = useState<Set<string>>(
    () => new Set()
  );
  const [isolatedSemanticId, setIsolatedSemanticId] = useState<string>();

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    kernelPreviewRef.current = kernelPreview;
  }, [kernelPreview]);

  useEffect(() => {
    setHiddenSemanticIds(new Set());
    setIsolatedSemanticId(undefined);
  }, [modelDocument.revisionId]);

  const refreshRevisions = useCallback(async (projectId?: string) => {
    const requestNumber = revisionRequestRef.current + 1;
    revisionRequestRef.current = requestNumber;
    const id = projectId ?? stateRef.current.projectId;
    if (!id) {
      setRevisions([]);
      setRevisionsLoading(false);
      setHistoryError(undefined);
      return;
    }
    setRevisionsLoading(true);
    setHistoryError(undefined);
    try {
      const page = await listModelingRevisions(id, { pageSize: 50 });
      if (revisionRequestRef.current !== requestNumber) return;
      setRevisions(page.items);
    } catch (error) {
      if (revisionRequestRef.current !== requestNumber) return;
      setHistoryError(clientErrorMessage(error));
    } finally {
      if (revisionRequestRef.current === requestNumber) {
        setRevisionsLoading(false);
      }
    }
  }, []);

  const stopActivePreview = useCallback(() => {
    previewRequestRef.current += 1;
    const active = activePreviewRef.current;
    activePreviewRef.current = undefined;
    if (!active) return;
    active.controller.abort();
    if (active.jobId) {
      void cancelModelingJob(active.jobId).catch(() => undefined);
    }
  }, []);

  const changeModelParameter = useCallback(
    (parameter: ModelParameter, requestedValue: number) => {
      if (!parameter.editable || !Number.isFinite(requestedValue)) return;
      const currentDocument = modelDocumentRef.current;
      const currentParameter = currentDocument.parameters.find(
        (candidate) =>
          candidate.id === parameter.id &&
          candidate.semanticRef === parameter.semanticRef
      );
      if (!currentParameter?.editable) return;
      const boundedValue = Math.min(
        currentParameter.maximum ?? Number.POSITIVE_INFINITY,
        Math.max(
          currentParameter.minimum ?? Number.NEGATIVE_INFINITY,
          requestedValue
        )
      );
      const value =
        currentParameter.parameterType === "integer"
          ? Math.round(boundedValue)
          : boundedValue;
      if (value === currentParameter.value) return;
      const nextDocument = replaceModelParameterValue(
        currentDocument,
        currentParameter.id,
        currentParameter.semanticRef,
        value
      );
      modelDocumentRef.current = nextDocument;
      setModelDocument(nextDocument);
      dispatch({
        type: "model-parameter/change",
        parameterId: currentParameter.id,
        semanticRef: currentParameter.semanticRef,
        parameterLabel: currentParameter.label,
        value,
        previousValue: currentParameter.value
      });
    },
    []
  );

  const undoManualChange = useCallback(() => {
    const operation = stateRef.current.pendingOperations.at(-1);
    if (operation?.type === "set_model_parameter") {
      const nextDocument = replaceModelParameterValue(
        modelDocumentRef.current,
        operation.parameterId,
        operation.semanticRef,
        operation.previousValue
      );
      modelDocumentRef.current = nextDocument;
      setModelDocument(nextDocument);
    }
    dispatch({ type: "history/undo" });
  }, []);

  const redoManualChange = useCallback(() => {
    const operation = stateRef.current.undoneManualOperations.at(-1);
    if (operation?.type === "set_model_parameter") {
      const nextDocument = replaceModelParameterValue(
        modelDocumentRef.current,
        operation.parameterId,
        operation.semanticRef,
        operation.value
      );
      modelDocumentRef.current = nextDocument;
      setModelDocument(nextDocument);
    }
    dispatch({ type: "history/redo" });
  }, []);

  const toggleSemanticVisibility = useCallback((semanticId: string) => {
    setHiddenSemanticIds((current) => {
      const next = new Set(current);
      if (next.has(semanticId)) next.delete(semanticId);
      else next.add(semanticId);
      return next;
    });
    setIsolatedSemanticId((current) =>
      current === semanticId ? undefined : current
    );
  }, []);

  const isolateSemanticObject = useCallback((semanticId: string) => {
    setHiddenSemanticIds((current) => {
      if (!current.has(semanticId)) return current;
      const next = new Set(current);
      next.delete(semanticId);
      return next;
    });
    setIsolatedSemanticId((current) =>
      current === semanticId ? undefined : semanticId
    );
  }, []);

  useEffect(
    () => () => {
      stopActivePreview();
    },
    [stopActivePreview]
  );

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const projects = await listModelingProjects();
        if (cancelled) return;
        let project = initialProjectId
          ? projects.find((candidate) => candidate.id === initialProjectId)
          : projects[0];
        if (initialProjectId && !project) {
          try {
            project = await getModelingProject(initialProjectId);
          } catch {
            if (cancelled) return;
            setHistoryError(
              "项目链接不存在或当前账号无权访问，已打开最近使用的项目。"
            );
            project = projects[0];
          }
        }
        if (!project) {
          if (initialProjectId) {
            setHistoryError("项目链接不存在或当前账号无权访问。");
          }
          return;
        }
        const revision = project.currentRevision;
        if (!revision?.id) return;
        const current = stateRef.current;
        if (current.sync !== "local-draft" || current.past.length) return;
        setCanonicalRevision(revision);
        void refreshRevisions(project.id);
        const serverDocument = isModelDocument(revision.document)
          ? revision.document
          : undefined;
        if (serverDocument) {
          modelDocumentRef.current = serverDocument;
          setModelDocument(serverDocument);
        }
        const documentKind = serverDocument
          ? modelingDocumentKind(serverDocument)
          : current.documentKind;
        dispatch({
          type: "project/hydrate",
          projectId: project.id,
          revisionId: revision.id,
          name: project.name,
          documentKind,
          selectedPartId:
            documentKind === "general-part" && serverDocument?.features[0]
              ? `feature:${serverDocument.features[0].semanticRef}`
              : undefined,
          semanticSelections:
            documentKind === "general-part" && serverDocument?.features[0]
              ? [featureSelection(serverDocument.features[0])]
              : [],
          document: serverDocument
            ? pumpDocumentFromModelDocument(serverDocument)
            : undefined
        });
      } catch (error) {
        if (cancelled) return;
        dispatch({
          type: "sync/offline",
          message: clientErrorMessage(error)
        });
      }
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [initialProjectId, refreshRevisions]);

  const queueKernelPreview = useCallback(
    async (projectId: string, revisionId: string) => {
      stopActivePreview();
      const requestNumber = previewRequestRef.current + 1;
      previewRequestRef.current = requestNumber;
      const controller = new AbortController();
      activePreviewRef.current = { requestNumber, controller };
      setKernelPreview({ status: "queued", message: "确定性内核正在重建…" });
      try {
        const job = await createModelingJob(projectId, {
          revisionId,
          kind: "preview",
          formats: ["glb"],
          validatePump:
            modelingDocumentKind(modelDocumentRef.current) === "pump-template",
          idempotencyKey: clientId(`preview-${revisionId}`)
        });
        if (
          previewRequestRef.current !== requestNumber ||
          controller.signal.aborted
        ) {
          void cancelModelingJob(job.id).catch(() => undefined);
          return;
        }
        activePreviewRef.current = { requestNumber, controller, jobId: job.id };
        const completed = await pollForArtifact(job.id, job, controller.signal);
        if (
          previewRequestRef.current !== requestNumber ||
          controller.signal.aborted
        ) {
          return;
        }
        const artifactId = firstArtifactId(completed);
        if (!artifactId) {
          throw new ModelingClientError("任务完成但没有返回可下载制品。", 502);
        }
        setKernelPreview({
          status: "ready",
          // Artifact ids are immutable and unique. Extra cache-busting query
          // keys would be rejected by the strict signed-download endpoint.
          url: modelingArtifactDownloadUrl(artifactId),
          message: "OCCT / GLB 权威预览",
          diagnostics: completed.output?.diagnostics
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        if (previewRequestRef.current !== requestNumber) return;
        setKernelPreview({
          status: "failed",
          message: clientErrorMessage(error),
          diagnostics: diagnosticsFromError(error)
        });
      } finally {
        if (activePreviewRef.current?.requestNumber === requestNumber) {
          activePreviewRef.current = undefined;
        }
      }
    },
    [stopActivePreview]
  );

  const hydrateRevision = useCallback(
    (
      projectId: string,
      projectName: string,
      revision: ModelingRevisionSummary
    ) => {
      if (!isModelDocument(revision.document)) {
        throw new ModelingClientError(
          "该历史版本缺少可识别的 openvac.modeling.v1 文档。",
          422
        );
      }
      const document = revision.document;
      const documentKind = modelingDocumentKind(document);
      modelDocumentRef.current = document;
      setModelDocument(document);
      dispatch({
        type: "project/hydrate",
        projectId,
        revisionId: revision.id,
        name: projectName,
        documentKind,
        selectedPartId:
          documentKind === "general-part" && document.features[0]
            ? `feature:${document.features[0].semanticRef}`
            : undefined,
        semanticSelections:
          documentKind === "general-part" && document.features[0]
            ? [featureSelection(document.features[0])]
            : [],
        document: pumpDocumentFromModelDocument(document)
      });
      if (hasBuildableFeature(document)) {
        void queueKernelPreview(projectId, revision.id);
      } else {
        stopActivePreview();
        setKernelPreview({
          status: "procedural",
          message:
            revision.id === canonicalRevision?.id
              ? "当前版本尚无可构建实体"
              : "该历史版本尚无可构建实体"
        });
      }
    },
    [canonicalRevision?.id, queueKernelPreview, stopActivePreview]
  );

  const openRevision = useCallback(
    (revision: ModelingRevisionSummary) => {
      const current = stateRef.current;
      if (!current.projectId) return;
      if (current.pendingOperations.length) {
        setHistoryError("请先保存或撤销当前待保存操作，再打开历史版本。");
        return;
      }
      try {
        hydrateRevision(current.projectId, current.projectName, revision);
        setHistoryError(undefined);
      } catch (error) {
        setHistoryError(clientErrorMessage(error));
      }
    },
    [hydrateRevision]
  );

  const returnToCurrentRevision = useCallback(async () => {
    const current = stateRef.current;
    if (!current.projectId) return;
    try {
      const project = await getModelingProject(current.projectId);
      const revision = project.currentRevision;
      if (!revision?.id || !isModelDocument(revision.document)) {
        throw new ModelingClientError("服务器未返回当前项目版本。", 502);
      }
      setCanonicalRevision(revision);
      hydrateRevision(project.id, project.name, revision);
      void refreshRevisions(project.id);
      setHistoryError(undefined);
    } catch (error) {
      setHistoryError(clientErrorMessage(error));
    }
  }, [hydrateRevision, refreshRevisions]);

  const importStep = useCallback(
    async (file: File) => {
      const current = stateRef.current;
      if (
        !current.projectId ||
        !current.revisionId ||
        current.pendingOperations.length ||
        current.revisionId !== canonicalRevision?.id
      ) {
        setImportStatus({
          busy: false,
          error: true,
          message:
            current.revisionId !== canonicalRevision?.id
              ? "历史版本为只读；请先返回当前版本再导入 STEP。"
              : "请先保存当前项目与待保存操作，再导入 STEP。"
        });
        return;
      }
      const projectId = current.projectId;
      setImportStatus({
        busy: true,
        message: "正在读取 STEP 并计算 SHA-256…"
      });
      setKernelPreview({
        status: "queued",
        url: kernelPreview.url,
        message: "STEP 私有导入准备中…"
      });
      try {
        const imported = await importPrivateStep(projectId, file, {
          onProgress: (progress) =>
            setImportStatus({
              busy: true,
              message: importProgressLabel(progress)
            })
        });
        setImportStatus({
          busy: true,
          message: "上传已由服务端核验，确定性内核正在导入…"
        });
        const completed = await pollForCompletedJob(
          imported.job.id,
          imported.job
        );
        if (!completed.output?.revisionId) {
          throw new ModelingClientError(
            "STEP 导入任务完成，但未返回不可变版本标识。",
            502
          );
        }
        const project = await getModelingProject(projectId);
        const revision = project.currentRevision;
        if (
          !revision?.id ||
          revision.id !== completed.output.revisionId ||
          !isModelDocument(revision.document)
        ) {
          throw new ModelingClientError(
            "STEP 已处理，但项目当前版本与导入结果不一致；请刷新版本历史确认。",
            409
          );
        }
        setCanonicalRevision(revision);
        hydrateRevision(project.id, project.name, revision);
        await refreshRevisions(project.id);
        setImportStatus({
          busy: false,
          message: `${file.name} 已导入为新的 STEP 基础实体版本；原历史版本仍保留。`
        });
      } catch (error) {
        const message = clientErrorMessage(error);
        setImportStatus({ busy: false, error: true, message });
        setKernelPreview({
          status: "failed",
          url: kernelPreview.url,
          message,
          diagnostics: diagnosticsFromError(error)
        });
      }
    },
    [
      canonicalRevision?.id,
      hydrateRevision,
      kernelPreview.url,
      refreshRevisions
    ]
  );

  const save = useCallback(async () => {
    const current = stateRef.current;
    if (current.sync === "saving") return;
    dispatch({ type: "sync/saving" });

    try {
      if (!current.projectId || !current.revisionId) {
        const document =
          current.documentKind === "pump-template"
            ? mergePumpStateIntoModelDocument(
                modelDocumentRef.current,
                current.document
              )
            : modelDocumentRef.current;
        const project = await createModelingProject({
          name: current.projectName,
          document,
          idempotencyKey: clientId(`create-${userId}`)
        });
        const revisionId = project.currentRevision?.id;
        if (!revisionId) {
          throw new ModelingClientError(
            "服务器未返回项目修订，草稿尚未持久化。"
          );
        }
        if (isModelDocument(project.currentRevision?.document)) {
          modelDocumentRef.current = project.currentRevision.document;
          setModelDocument(project.currentRevision.document);
        }
        setCanonicalRevision(project.currentRevision ?? { id: revisionId });
        dispatch({
          type: "sync/saved",
          projectId: project.id,
          revisionId,
          message: "项目已创建并保存"
        });
        if (hasBuildableFeature(document)) {
          void queueKernelPreview(project.id, revisionId);
        }
        void refreshRevisions(project.id);
        return;
      }

      if (!current.pendingOperations.length) {
        dispatch({
          type: "sync/saved",
          projectId: current.projectId,
          revisionId: current.revisionId,
          message: "当前修订没有待保存操作"
        });
        return;
      }

      const batch = createOperationBatchFromManualState(
        modelDocumentRef.current,
        current.pendingOperations,
        clientId(`operations-${userId}`)
      );
      if (!batch) {
        throw new ModelingClientError(
          "当前只有本地视图更改，没有可提交的建模协议操作。"
        );
      }
      const revision = await postOperationBatch(current.projectId, batch);
      if (!isModelDocument(revision.document)) {
        throw new ModelingClientError(
          "服务器未返回新修订文档，当前修改仍保留在本地。"
        );
      }
      modelDocumentRef.current = revision.document;
      setModelDocument(revision.document);
      setCanonicalRevision(revision);
      dispatch({
        type: "sync/saved",
        projectId: current.projectId,
        revisionId: revision.id,
        message: `已保存 ${current.pendingOperations.length} 个操作`
      });
      if (hasBuildableFeature(revision.document)) {
        void queueKernelPreview(current.projectId, revision.id);
      }
      void refreshRevisions(current.projectId);
    } catch (error) {
      const diagnostics = diagnosticsFromError(error);
      if (diagnostics.length) {
        setKernelPreview((preview) => ({
          ...preview,
          status: "failed",
          message: clientErrorMessage(error),
          diagnostics
        }));
      }
      dispatch(saveFailureAction(error, current.revisionId));
    }
  }, [queueKernelPreview, refreshRevisions, userId]);

  const createProject = useCallback(
    async (
      name: string,
      documentKind: ModelingDocumentKind,
      material?: { name?: string; densityKgM3: number }
    ) => {
      setNewProjectOpen(false);
      const baseDocument =
        documentKind === "pump-template"
          ? cloneModelDocumentWithFreshIds(initialTemplate, name)
          : createBlankPartDocument(name);
      const document: ModelDocument = material
        ? {
            ...baseDocument,
            metadata: {
              ...baseDocument.metadata,
              material: {
                ...material,
                densitySource: "user"
              }
            }
          }
        : baseDocument;
      modelDocumentRef.current = document;
      setModelDocument(document);
      revisionRequestRef.current += 1;
      setCanonicalRevision(undefined);
      setRevisions([]);
      setRevisionsLoading(false);
      setHistoryError(undefined);
      setImportStatus(undefined);
      setKernelPreview({
        status: "procedural",
        message:
          documentKind === "pump-template"
            ? "参数化客户端预览"
            : "等待首个可构建修订"
      });
      dispatch({ type: "project/new", name, documentKind });
      dispatch({ type: "sync/saving" });
      try {
        const project = await createModelingProject({
          name,
          document,
          idempotencyKey: clientId(`new-${userId}`)
        });
        const revisionId = project.currentRevision?.id;
        if (!revisionId) {
          throw new ModelingClientError(
            "服务器未返回项目修订，草稿尚未持久化。"
          );
        }
        if (isModelDocument(project.currentRevision?.document)) {
          modelDocumentRef.current = project.currentRevision.document;
          setModelDocument(project.currentRevision.document);
        }
        setCanonicalRevision(project.currentRevision ?? { id: revisionId });
        dispatch({
          type: "sync/saved",
          projectId: project.id,
          revisionId,
          message:
            documentKind === "pump-template"
              ? "旋片泵模板项目已创建"
              : "空白通用零件已创建"
        });
        if (hasBuildableFeature(document)) {
          void queueKernelPreview(project.id, revisionId);
        }
        void refreshRevisions(project.id);
      } catch (error) {
        dispatch({ type: "sync/offline", message: clientErrorMessage(error) });
      }
    },
    [initialTemplate, queueKernelPreview, refreshRevisions, userId]
  );

  const showAiPreviewArtifact = useCallback((artifactId: string) => {
    aiPreviewRestoreRef.current ??= kernelPreviewRef.current;
    setKernelPreview({
      status: "ready",
      url: modelingArtifactDownloadUrl(artifactId),
      message: "AI 计划 dry-run · 尚未确认"
    });
  }, []);

  const sendAiPrompt = useCallback(
    async (prompt: string) => {
      const current = stateRef.current;
      if (!current.projectId || !current.revisionId) {
        dispatch({
          type: "ai/error",
          message: "请先把当前草稿保存为服务器项目，再生成 AI 计划。"
        });
        return;
      }
      const baseDocument = modelDocumentRef.current;
      dispatch({ type: "ai/pending", prompt });
      try {
        const result = await createAiPlan(current.projectId, {
          baseRevisionId: current.revisionId,
          prompt,
          selectedSemanticRefs: selectedModelSemanticRefs(
            modelDocumentRef.current,
            current.selectedPartId,
            current.semanticSelections
          ),
          idempotencyKey: clientId("ai-plan")
        });
        if (result.status === "needs_input") {
          dispatch({
            type: "ai/needs-input",
            prompt,
            planId: result.planId,
            question: result.question
          });
        }
        if (result.status === "preview") {
          if (result.previewArtifactId) {
            showAiPreviewArtifact(result.previewArtifactId);
          }
          dispatch({
            type: "ai/preview",
            prompt,
            planId: result.planId,
            planHash: result.planHash,
            operations: withAiPlanOperationDiffs(
              result.operations,
              baseDocument
            ),
            summary: result.summary,
            assumptions: result.assumptions,
            warnings: result.warnings,
            expectedChecks: result.expectedChecks,
            diagnostics: result.diagnostics,
            metrics: result.metrics
          });
        }
        if (result.status === "pending" && result.jobId) {
          dispatch({ type: "ai/pending", prompt, jobId: result.jobId });
          void pollForAiPlan(
            result.jobId,
            prompt,
            dispatch,
            showAiPreviewArtifact,
            baseDocument
          );
        }
        // A queued job deliberately remains pending. The client never invents
        // a plan or applies operations before server preview and confirmation.
      } catch (error) {
        dispatch({ type: "ai/error", message: clientErrorMessage(error) });
      }
    },
    [showAiPreviewArtifact]
  );

  const confirmPlan = useCallback(async () => {
    const plan = stateRef.current.aiPlan;
    if (plan.status !== "preview") return;
    const currentRevisionId = stateRef.current.revisionId;
    if (!plan.planHash || !currentRevisionId) {
      dispatch({
        type: "ai/error",
        message: "计划缺少哈希或基础修订，不能确认执行。"
      });
      return;
    }
    dispatch({
      type: "ai/confirming",
      prompt: plan.prompt,
      planId: plan.planId
    });
    try {
      const result = await confirmAiPlan(plan.planId, {
        baseRevisionId: currentRevisionId,
        planHash: plan.planHash
      });
      const revision = extractConfirmedRevision(result);
      if (revision && isModelDocument(revision.document)) {
        modelDocumentRef.current = revision.document;
        setModelDocument(revision.document);
        setCanonicalRevision(revision);
        const documentKind = modelingDocumentKind(revision.document);
        dispatch({
          type: "project/hydrate",
          projectId: stateRef.current.projectId ?? "",
          revisionId: revision.id,
          name: stateRef.current.projectName,
          documentKind,
          selectedPartId:
            documentKind === "general-part" && revision.document.features[0]
              ? `feature:${revision.document.features[0].semanticRef}`
              : undefined,
          semanticSelections:
            documentKind === "general-part" && revision.document.features[0]
              ? [featureSelection(revision.document.features[0])]
              : [],
          document: pumpDocumentFromModelDocument(revision.document)
        });
        const projectId = stateRef.current.projectId;
        if (projectId) {
          aiPreviewRestoreRef.current = undefined;
          void queueKernelPreview(projectId, revision.id);
          void refreshRevisions(projectId);
        }
      }
      dispatch({
        type: "ai/confirmed",
        message: "计划已由服务器确认；刷新项目修订后可查看执行结果。"
      });
    } catch (error) {
      dispatch({ type: "ai/error", message: clientErrorMessage(error) });
    }
  }, [queueKernelPreview, refreshRevisions]);

  const rejectPlan = useCallback(async () => {
    const current = stateRef.current;
    const plan = current.aiPlan;
    if (plan.status !== "preview" || plan.rejecting) return;

    dispatch({ type: "ai/rejecting" });
    try {
      await rejectAiPlan(plan.planId);
      const restorePreview = aiPreviewRestoreRef.current;
      aiPreviewRestoreRef.current = undefined;
      if (restorePreview) setKernelPreview(restorePreview);
      dispatch({
        type: "ai/rejected",
        message: "AI 计划已拒绝，当前修订未发生变化。"
      });
    } catch (error) {
      dispatch({
        type: "ai/reject-failed",
        message: clientErrorMessage(error)
      });
    }
  }, []);

  const manualToolContext = useMemo(
    () =>
      getManualToolContext(
        modelDocument,
        state.selectedPartId,
        state.pendingOperations,
        state.semanticSelections
      ),
    [
      modelDocument,
      state.pendingOperations,
      state.selectedPartId,
      state.semanticSelections
    ]
  );

  const activateTool = useCallback(
    (tool: ModelingTool) => {
      const current = stateRef.current;
      if (
        GENERAL_MANUAL_TOOLS.has(tool) &&
        current.documentKind !== "general-part"
      ) {
        return;
      }
      dispatch({ type: "tool/activate", tool });
      if (tool !== "interference") return;
      if (
        current.projectId &&
        current.revisionId &&
        !current.pendingOperations.length &&
        hasBuildableFeature(modelDocumentRef.current)
      ) {
        void queueKernelPreview(current.projectId, current.revisionId);
      } else {
        setKernelPreview((preview) => ({
          ...preview,
          message: "请先保存当前实体修订，再运行权威 OCCT 干涉检查。"
        }));
      }
    },
    [queueKernelPreview]
  );

  const exportModel = useCallback(
    async (format: "step" | "stl" | "glb") => {
      const current = stateRef.current;
      if (
        !current.projectId ||
        !current.revisionId ||
        current.pendingOperations.length ||
        !hasBuildableFeature(modelDocumentRef.current)
      ) {
        setKernelPreview({
          status: "failed",
          message: "请先保存一个含实体的当前修订，再生成导出制品。"
        });
        return;
      }
      setKernelPreview({
        status: "queued",
        url: kernelPreview.url,
        message: `正在生成 ${format.toUpperCase()}…`
      });
      try {
        const job = await createModelingJob(current.projectId, {
          revisionId: current.revisionId,
          kind: "export",
          formats: [format],
          validatePump: current.documentKind === "pump-template",
          idempotencyKey: clientId(`export-${format}-${current.revisionId}`)
        });
        const completed = await pollForArtifact(job.id, job);
        const artifactId = firstArtifactId(completed);
        if (!artifactId) {
          throw new ModelingClientError("任务完成但没有返回可下载制品。", 502);
        }
        window.location.assign(modelingArtifactDownloadUrl(artifactId));
        setKernelPreview({
          status: "ready",
          url: kernelPreview.url,
          message: `${format.toUpperCase()} 已由 OCCT 生成并通过制品校验`,
          diagnostics: completed.output?.diagnostics
        });
      } catch (error) {
        setKernelPreview({
          status: "failed",
          url: kernelPreview.url,
          message: clientErrorMessage(error),
          diagnostics: diagnosticsFromError(error)
        });
      }
    },
    [kernelPreview.url]
  );

  const runCommand = useCallback(
    (rawCommand: string) => {
      const command = rawCommand.toLowerCase();
      if (command.includes("interference") || command.includes("干涉")) {
        activateTool("interference");
        return;
      }
      if (command.includes("section") || command.includes("剖切")) {
        activateTool("section");
        return;
      }
      if (command.includes("measure") || command.includes("测量")) {
        activateTool("measure");
        return;
      }
      const manualTool: ModelingTool = command.includes("hole")
        ? "hole"
        : command.includes("fillet")
          ? "fillet"
          : "sketch";
      activateTool(manualTool);
    },
    [activateTool]
  );

  const anyDrawerOpen = state.projectPanelOpen || state.inspectorOpen;
  const readOnlyHistory = Boolean(
    state.revisionId &&
    canonicalRevision?.id &&
    state.revisionId !== canonicalRevision.id
  );
  const importBusy = Boolean(importStatus?.busy);
  const editingLocked = readOnlyHistory || importBusy;
  const activeRevision = revisions.find(
    (revision) => revision.id === state.revisionId
  );

  return (
    <main className={styles.workspace}>
      <ModelingHeader
        projectName={state.projectName}
        userName={userName}
        sync={state.sync}
        canUndo={
          !editingLocked &&
          (state.past.length > 0 ||
            state.pendingOperations.at(-1)?.type === "set_model_parameter")
        }
        canRedo={
          !editingLocked &&
          (state.future.length > 0 || state.undoneManualOperations.length > 0)
        }
        canSave={
          !editingLocked && state.sync !== "saving" && state.sync !== "saved"
        }
        canExport={
          Boolean(state.projectId && state.revisionId) &&
          !importBusy &&
          !state.pendingOperations.length &&
          hasBuildableFeature(modelDocument) &&
          kernelPreview.status !== "queued"
        }
        onUndo={undoManualChange}
        onRedo={redoManualChange}
        onSave={() => void save()}
        onExport={(format) => void exportModel(format)}
        onOpenProject={() => dispatch({ type: "panel/project", open: true })}
        onOpenInspector={() =>
          dispatch({ type: "panel/inspector", open: true })
        }
      />

      {(state.sync === "offline" || state.sync === "error") &&
      state.syncMessage ? (
        <div className={styles.offlineBanner} role="alert">
          {state.syncMessage}
        </div>
      ) : null}

      {readOnlyHistory ? (
        <div className={styles.historyBanner} role="status">
          <span>
            正在只读查看 V{activeRevision?.revisionNumber ?? "?"}
            ；保存、手工编辑与 AI 计划已锁定。
          </span>
          <button type="button" onClick={() => void returnToCurrentRevision()}>
            返回当前版本
          </button>
        </div>
      ) : null}

      <div className={styles.workspaceBody}>
        <ProjectPanel
          projectName={state.projectName}
          document={state.document}
          modelDocument={modelDocument}
          documentKind={state.documentKind}
          pendingOperations={state.pendingOperations}
          selectedPartId={state.selectedPartId}
          semanticSelections={state.semanticSelections}
          hiddenSemanticIds={[...hiddenSemanticIds]}
          isolatedSemanticId={isolatedSemanticId}
          mobileOpen={state.projectPanelOpen}
          readOnlyHistory={readOnlyHistory}
          revisions={revisions}
          revisionsLoading={revisionsLoading}
          activeRevisionId={state.revisionId}
          currentRevisionId={canonicalRevision?.id}
          canImportStep={Boolean(
            canonicalRevision?.id &&
            !readOnlyHistory &&
            !state.pendingOperations.length
          )}
          historyError={historyError}
          importStatus={importStatus}
          onClose={() => dispatch({ type: "panel/project", open: false })}
          onNew={() => setNewProjectOpen(true)}
          onImportStep={(file) => void importStep(file)}
          onRefreshRevisions={() => void refreshRevisions()}
          onOpenRevision={openRevision}
          onReturnToCurrent={() => void returnToCurrentRevision()}
          onSelectPart={(id) => dispatch({ type: "part/select", id })}
          onSelectSemantic={(selection, additive) =>
            dispatch({ type: "semantic/select", selection, additive })
          }
          onToggleVisibility={(id) => dispatch({ type: "part/visibility", id })}
          onToggleFeatureSuppressed={(feature, suppressed) =>
            dispatch({
              type: "feature/suppressed",
              featureId: feature.id,
              semanticRef: feature.semanticRef,
              featureName: feature.name,
              suppressed
            })
          }
          onToggleSemanticVisibility={toggleSemanticVisibility}
          onIsolateSemantic={isolateSemanticObject}
        />

        <div
          className={styles.inertContents}
          inert={editingLocked ? true : undefined}
        >
          <section className={styles.centerWorkspace} aria-label="建模画布">
            <div className={styles.canvasArea}>
              <ModelingToolbar
                activeTool={state.activeTool}
                manualFeaturesEnabled={manualToolContext.manualFeaturesEnabled}
                onActivate={activateTool}
              />
              <ViewportStage
                document={state.document}
                documentKind={state.documentKind}
                selectedPartId={state.selectedPartId}
                activeTool={state.activeTool}
                kernelPreview={kernelPreview}
                modelDocument={modelDocument}
                semanticSelections={state.semanticSelections}
                hiddenSemanticIds={[...hiddenSemanticIds]}
                isolatedSemanticId={isolatedSemanticId}
                onSelectPart={(id) => {
                  const selection = selectionFromViewportId(modelDocument, id);
                  dispatch(
                    selection
                      ? {
                          type: "semantic/select",
                          selection,
                          additive: false
                        }
                      : { type: "part/select", id }
                  );
                }}
              />
              <ToolSettingsPanel
                key={`${state.activeTool}:${state.semanticSelections.map((item) => item.semanticRef).join("|")}`}
                tool={state.activeTool}
                open={state.toolPanelOpen}
                context={manualToolContext}
                onClose={() => dispatch({ type: "panel/tool", open: false })}
                onCommit={(settings) =>
                  dispatch({
                    type: "tool/commit",
                    tool: state.activeTool,
                    settings
                  })
                }
              />
            </div>
            <CommandPanel
              open={state.commandPanelOpen}
              aiPlan={state.aiPlan}
              tasks={state.tasks}
              onOpenChange={(open) => dispatch({ type: "panel/command", open })}
              onPrompt={(prompt) => void sendAiPrompt(prompt)}
              onConfirmPlan={() => void confirmPlan()}
              onRejectPlan={() => void rejectPlan()}
              onCommand={runCommand}
            />
          </section>

          <InspectorPanel
            document={state.document}
            modelDocument={modelDocument}
            documentKind={state.documentKind}
            selectedPartId={state.selectedPartId}
            semanticSelections={state.semanticSelections}
            activeTab={state.inspectorTab}
            mobileOpen={state.inspectorOpen}
            onClose={() => dispatch({ type: "panel/inspector", open: false })}
            onTab={(tab) => dispatch({ type: "inspector/tab", tab })}
            onParameterChange={(id, value) =>
              dispatch({ type: "parameter/change", id, value })
            }
            onModelParameterChange={changeModelParameter}
            onToggleVisibility={(id) =>
              dispatch({ type: "part/visibility", id })
            }
            onToggleFeatureSuppressed={(feature, suppressed) =>
              dispatch({
                type: "feature/suppressed",
                featureId: feature.id,
                semanticRef: feature.semanticRef,
                featureName: feature.name,
                suppressed
              })
            }
            hiddenSemanticIds={[...hiddenSemanticIds]}
            isolatedSemanticId={isolatedSemanticId}
            onToggleSemanticVisibility={toggleSemanticVisibility}
            onIsolateSemantic={isolateSemanticObject}
            onActivateInterference={() => activateTool("interference")}
          />
        </div>
      </div>

      <div className={styles.mobileRail} aria-label="移动端面板导航">
        <button
          type="button"
          onClick={() => dispatch({ type: "panel/project", open: true })}
        >
          项目
        </button>
        <button
          type="button"
          onClick={() => dispatch({ type: "panel/command", open: true })}
        >
          AI 计划
        </button>
        <button
          type="button"
          onClick={() => dispatch({ type: "panel/inspector", open: true })}
        >
          参数
        </button>
      </div>

      {anyDrawerOpen ? (
        <button
          type="button"
          className={styles.drawerBackdrop}
          onClick={() => {
            dispatch({ type: "panel/project", open: false });
            dispatch({ type: "panel/inspector", open: false });
          }}
          aria-label="关闭侧边面板"
        />
      ) : null}

      <NewProjectDialog
        open={newProjectOpen}
        onClose={() => setNewProjectOpen(false)}
        onCreate={(name, documentKind, material) =>
          void createProject(name, documentKind, material)
        }
      />
    </main>
  );
}

function clientErrorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "建模服务暂时不可用，当前修改保留为离线草稿。";
}

async function pollForAiPlan(
  jobId: string,
  prompt: string,
  dispatch: (action: ModelingWorkspaceAction) => void,
  onPreviewArtifact: (artifactId: string, previewKey: string) => void,
  baseDocument: ModelDocument
) {
  let previewArtifactShown = false;
  for (let attempt = 0; attempt < 18; attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 1800));
    try {
      const job = await getModelingJob(jobId);
      const jobArtifactId = firstArtifactId(job);
      if (jobArtifactId && !previewArtifactShown) {
        onPreviewArtifact(jobArtifactId, jobId);
        previewArtifactShown = true;
      }
      if (job.planId) {
        const plan = await getAiPlan(job.planId);
        if (plan.status === "needs_input") {
          dispatch({
            type: "ai/needs-input",
            prompt,
            planId: plan.planId,
            question: plan.question
          });
          return;
        }
        if (plan.status === "preview") {
          if (plan.previewArtifactId && !previewArtifactShown) {
            onPreviewArtifact(plan.previewArtifactId, plan.planId);
            previewArtifactShown = true;
          }
          dispatch({
            type: "ai/preview",
            prompt,
            planId: plan.planId,
            planHash: plan.planHash,
            operations: withAiPlanOperationDiffs(plan.operations, baseDocument),
            summary: plan.summary,
            assumptions: plan.assumptions,
            warnings: plan.warnings,
            expectedChecks: plan.expectedChecks,
            diagnostics: job.output?.dryRun?.diagnostics ?? plan.diagnostics,
            metrics: job.output?.dryRun?.metrics ?? plan.metrics
          });
          return;
        }
      }
      if (["failed", "cancelled"].includes(job.status)) {
        dispatch({
          type: "ai/error",
          message: job.errorMessage || "AI 建模计划未能生成。"
        });
        return;
      }
    } catch (error) {
      dispatch({ type: "ai/error", message: clientErrorMessage(error) });
      return;
    }
  }
  dispatch({
    type: "ai/error",
    message: "AI 计划仍在后台运行，请稍后重新打开项目查看。"
  });
}

async function pollForArtifact(
  jobId: string,
  initial?: ModelingJobSummary,
  signal?: AbortSignal
): Promise<ModelingJobSummary> {
  let job = initial;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (signal?.aborted) throw signal.reason ?? new Error("Preview cancelled");
    if (!job || attempt > 0) {
      await abortableClientDelay(1500, signal);
      job = await getModelingJob(jobId);
    }
    if (job.status === "succeeded") {
      return job;
    }
    if (job.status === "failed" || job.status === "cancelled") {
      throw new ModelingClientError(
        job.errorMessage || "建模任务未能完成。",
        422
      );
    }
  }
  throw new ModelingClientError("建模任务仍在运行，请稍后重试。", 504);
}

function abortableClientDelay(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Preview cancelled"));
      return;
    }
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(signal?.reason ?? new Error("Preview cancelled"));
    };
    const timer = window.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function replaceModelParameterValue(
  document: ModelDocument,
  parameterId: string,
  semanticRef: string,
  value: number
): ModelDocument {
  return {
    ...document,
    parameters: document.parameters.map((parameter) =>
      parameter.id === parameterId && parameter.semanticRef === semanticRef
        ? { ...parameter, value, source: "user" as const }
        : parameter
    )
  };
}

async function pollForCompletedJob(
  jobId: string,
  initial?: ModelingJobSummary
): Promise<ModelingJobSummary> {
  let job = initial;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (!job || attempt > 0) {
      await new Promise((resolve) => window.setTimeout(resolve, 1500));
      job = await getModelingJob(jobId);
    }
    if (job.status === "succeeded") return job;
    if (job.status === "failed" || job.status === "cancelled") {
      throw new ModelingClientError(
        job.errorMessage || "STEP 导入任务未能完成，项目仍保留原版本。",
        422
      );
    }
  }
  throw new ModelingClientError(
    "STEP 导入任务仍在后台运行，请稍后刷新版本历史。",
    504
  );
}

function importProgressLabel(progress: StepImportProgress) {
  switch (progress) {
    case "hashing":
      return "正在读取 STEP 并计算 SHA-256…";
    case "presigning":
      return "正在申请 15 分钟有效的私有上传签名…";
    case "uploading":
      return "正在直传私有 OSS（上限 50 MB）…";
    case "verifying":
      return "上传完成，服务端正在核验大小、类型与 SHA-256…";
  }
}

function extractConfirmedRevision(
  value: unknown
): ModelingRevisionSummary | undefined {
  if (!value || typeof value !== "object") return undefined;
  const root = value as Record<string, unknown>;
  const revision =
    root.revision && typeof root.revision === "object"
      ? (root.revision as Record<string, unknown>)
      : undefined;
  if (!revision || typeof revision.id !== "string") return undefined;
  return {
    id: revision.id,
    document: isModelDocument(revision.document) ? revision.document : undefined
  };
}

function firstArtifactId(job: ModelingJobSummary) {
  return job.output?.artifactIds?.find(
    (value): value is string => typeof value === "string" && Boolean(value)
  );
}

function diagnosticsFromError(error: unknown): ModelingKernelDiagnostic[] {
  if (!(error instanceof ModelingClientError)) return [];
  const details = error.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return [];
  }
  const diagnostics = (details as { diagnostics?: unknown }).diagnostics;
  if (!Array.isArray(diagnostics)) return [];
  return diagnostics.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const item = value as Record<string, unknown>;
    if (
      typeof item.code !== "string" ||
      !["info", "warning", "error"].includes(String(item.severity)) ||
      typeof item.message !== "string"
    ) {
      return [];
    }
    return [
      {
        code: item.code,
        severity: item.severity as ModelingKernelDiagnostic["severity"],
        message: item.message,
        ...(typeof item.target_id === "string" || item.target_id === null
          ? { target_id: item.target_id }
          : {}),
        ...(typeof item.targetId === "string" || item.targetId === null
          ? { targetId: item.targetId }
          : {})
      }
    ];
  });
}

function hasBuildableFeature(document: ModelDocument) {
  return document.features.some((feature) => !feature.suppressed);
}

function saveFailureAction(
  error: unknown,
  revisionId?: string
): ModelingWorkspaceAction {
  const previousRevision = revisionId
    ? `服务器仍保留基础修订 ${revisionId.slice(0, 8)}；本地待保存操作未丢失。`
    : "服务器未创建新修订；本地待保存操作未丢失。";
  const message = `${clientErrorMessage(error)} ${previousRevision}`;
  return error instanceof ModelingClientError && error.status === 0
    ? { type: "sync/offline", message }
    : { type: "sync/error", message };
}

const GENERAL_MANUAL_TOOLS = new Set<ModelingTool>([
  "sketch",
  "extrude",
  "cut",
  "rotate",
  "slot",
  "hole",
  "fillet",
  "chamfer",
  "mirror",
  "linear-pattern",
  "circular-pattern",
  "reorder",
  "boolean",
  "assembly"
]);

function featureSelection(feature: ModelDocument["features"][number]) {
  return {
    collection: "features" as const,
    id: feature.id,
    semanticRef: feature.semanticRef,
    name: feature.name
  };
}

function initialGeneralSelection(document: ModelDocument): {
  selectedPartId?: string;
  semanticSelections?: ModelingSelection[];
} {
  if (
    modelingDocumentKind(document) !== "general-part" ||
    !document.features[0]
  ) {
    return {};
  }
  const selection = featureSelection(document.features[0]);
  return {
    selectedPartId: `feature:${selection.semanticRef}`,
    semanticSelections: [selection]
  };
}

function selectionFromViewportId(
  document: ModelDocument,
  selectionId: string
): ModelingSelection | undefined {
  if (selectionId.startsWith("feature:")) {
    const semanticRef = selectionId.slice("feature:".length);
    const feature = document.features.find(
      (candidate) => candidate.semanticRef === semanticRef
    );
    return feature ? featureSelection(feature) : undefined;
  }
  if (selectionId.startsWith("component:")) {
    const semanticRef = selectionId.slice("component:".length);
    const component = document.components.find(
      (candidate) => candidate.semanticRef === semanticRef
    );
    return component
      ? {
          collection: "components",
          id: component.id,
          semanticRef: component.semanticRef,
          name: component.name
        }
      : undefined;
  }
}
