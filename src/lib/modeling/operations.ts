import {
  assemblyConstraintSchema,
  componentSchema,
  featureSchema,
  modelDocumentSchema,
  modelOperationBatchSchema,
  modelParameterSchema,
  sketchSchema,
  type ModelCollection,
  type ModelDocument,
  type ModelOperationBatch,
  type ModelReference
} from "@/types/modeling";

export class ModelingSemanticError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelingSemanticError";
  }
}

type StableIdentity = {
  id: string;
  semanticRef: string;
};

function targetIndex(
  values: readonly StableIdentity[],
  target: ModelReference,
  collection: ModelCollection
): number {
  const index = values.findIndex(
    (value) =>
      value.id === target.id && value.semanticRef === target.semanticRef
  );
  if (index < 0) {
    throw new ModelingSemanticError(
      `Target ${target.semanticRef} does not exist in ${collection}.`
    );
  }
  return index;
}

function ensureNewIdentity(
  document: ModelDocument,
  item: StableIdentity
): void {
  const identities: StableIdentity[] = [
    ...document.parameters,
    ...document.sketches,
    ...document.sketches.flatMap((sketch) => [
      ...sketch.entities,
      ...sketch.constraints
    ]),
    ...document.features,
    ...document.components,
    ...document.assemblyConstraints
  ];
  if (identities.some((identity) => identity.id === item.id)) {
    throw new ModelingSemanticError(`UUID ${item.id} is already in use.`);
  }
  if (
    identities.some((identity) => identity.semanticRef === item.semanticRef)
  ) {
    throw new ModelingSemanticError(
      `Semantic reference ${item.semanticRef} is already in use.`
    );
  }
}

function addItem(
  document: ModelDocument,
  operation: Extract<ModelOperationBatch["operations"][number], { kind: "add" }>
): ModelDocument {
  switch (operation.collection) {
    case "parameters": {
      const item = modelParameterSchema.parse(operation.item);
      ensureNewIdentity(document, item);
      return { ...document, parameters: [...document.parameters, item] };
    }
    case "sketches": {
      const item = sketchSchema.parse(operation.item);
      ensureNewIdentity(document, item);
      return { ...document, sketches: [...document.sketches, item] };
    }
    case "features": {
      const item = featureSchema.parse(operation.item);
      ensureNewIdentity(document, item);
      return { ...document, features: [...document.features, item] };
    }
    case "components": {
      const item = componentSchema.parse(operation.item);
      ensureNewIdentity(document, item);
      return { ...document, components: [...document.components, item] };
    }
    case "assemblyConstraints": {
      const item = assemblyConstraintSchema.parse(operation.item);
      ensureNewIdentity(document, item);
      return {
        ...document,
        assemblyConstraints: [...document.assemblyConstraints, item]
      };
    }
  }
}

function updateItem(
  document: ModelDocument,
  operation: Extract<
    ModelOperationBatch["operations"][number],
    { kind: "update" }
  >
): ModelDocument {
  switch (operation.collection) {
    case "parameters": {
      const index = targetIndex(
        document.parameters,
        operation.target,
        operation.collection
      );
      const current = document.parameters[index];
      const next = modelParameterSchema.parse({
        ...current,
        ...operation.changes
      });
      const parameters = [...document.parameters];
      parameters[index] = next;
      return { ...document, parameters };
    }
    case "sketches": {
      const index = targetIndex(
        document.sketches,
        operation.target,
        operation.collection
      );
      const current = document.sketches[index];
      const next = sketchSchema.parse({ ...current, ...operation.changes });
      const sketches = [...document.sketches];
      sketches[index] = next;
      return { ...document, sketches };
    }
    case "features": {
      const index = targetIndex(
        document.features,
        operation.target,
        operation.collection
      );
      const current = document.features[index];
      const next = featureSchema.parse({ ...current, ...operation.changes });
      const features = [...document.features];
      features[index] = next;
      return { ...document, features };
    }
    case "components": {
      const index = targetIndex(
        document.components,
        operation.target,
        operation.collection
      );
      const current = document.components[index];
      const next = componentSchema.parse({ ...current, ...operation.changes });
      const components = [...document.components];
      components[index] = next;
      return { ...document, components };
    }
    case "assemblyConstraints": {
      const index = targetIndex(
        document.assemblyConstraints,
        operation.target,
        operation.collection
      );
      const current = document.assemblyConstraints[index];
      const next = assemblyConstraintSchema.parse({
        ...current,
        ...operation.changes
      });
      const assemblyConstraints = [...document.assemblyConstraints];
      assemblyConstraints[index] = next;
      return { ...document, assemblyConstraints };
    }
  }
}

function deleteItem(
  document: ModelDocument,
  operation: Extract<
    ModelOperationBatch["operations"][number],
    { kind: "delete" }
  >
): ModelDocument {
  switch (operation.collection) {
    case "parameters": {
      const index = targetIndex(
        document.parameters,
        operation.target,
        operation.collection
      );
      return {
        ...document,
        parameters: document.parameters.filter(
          (_parameter, itemIndex) => itemIndex !== index
        )
      };
    }
    case "sketches": {
      const index = targetIndex(
        document.sketches,
        operation.target,
        operation.collection
      );
      return {
        ...document,
        sketches: document.sketches.filter(
          (_sketch, itemIndex) => itemIndex !== index
        )
      };
    }
    case "features": {
      const index = targetIndex(
        document.features,
        operation.target,
        operation.collection
      );
      return {
        ...document,
        features: document.features.filter(
          (_feature, itemIndex) => itemIndex !== index
        )
      };
    }
    case "components": {
      const index = targetIndex(
        document.components,
        operation.target,
        operation.collection
      );
      return {
        ...document,
        components: document.components.filter(
          (_component, itemIndex) => itemIndex !== index
        )
      };
    }
    case "assemblyConstraints": {
      const index = targetIndex(
        document.assemblyConstraints,
        operation.target,
        operation.collection
      );
      return {
        ...document,
        assemblyConstraints: document.assemblyConstraints.filter(
          (_constraint, itemIndex) => itemIndex !== index
        )
      };
    }
  }
}

function reorderItems<T extends StableIdentity>(
  values: readonly T[],
  orderedRefs: readonly ModelReference[],
  collection: ModelCollection
): T[] {
  if (values.length !== orderedRefs.length) {
    throw new ModelingSemanticError(
      `Reorder for ${collection} must include every item exactly once.`
    );
  }
  const byReference = new Map<string, T>(
    values.map(
      (value) => [`${value.id}\u0000${value.semanticRef}`, value] as const
    )
  );
  const seen = new Set<string>();
  return orderedRefs.map((reference) => {
    const key = `${reference.id}\u0000${reference.semanticRef}`;
    const value = byReference.get(key);
    if (!value || seen.has(key)) {
      throw new ModelingSemanticError(
        `Reorder for ${collection} contains an unknown or duplicate reference.`
      );
    }
    seen.add(key);
    return value;
  });
}

function reorderCollection(
  document: ModelDocument,
  operation: Extract<
    ModelOperationBatch["operations"][number],
    { kind: "reorder" }
  >
): ModelDocument {
  switch (operation.collection) {
    case "parameters":
      return {
        ...document,
        parameters: reorderItems(
          document.parameters,
          operation.orderedRefs,
          operation.collection
        )
      };
    case "sketches":
      return {
        ...document,
        sketches: reorderItems(
          document.sketches,
          operation.orderedRefs,
          operation.collection
        )
      };
    case "features":
      return {
        ...document,
        features: reorderItems(
          document.features,
          operation.orderedRefs,
          operation.collection
        )
      };
    case "components":
      return {
        ...document,
        components: reorderItems(
          document.components,
          operation.orderedRefs,
          operation.collection
        )
      };
    case "assemblyConstraints":
      return {
        ...document,
        assemblyConstraints: reorderItems(
          document.assemblyConstraints,
          operation.orderedRefs,
          operation.collection
        )
      };
  }
}

function suppressItem(
  document: ModelDocument,
  operation: Extract<
    ModelOperationBatch["operations"][number],
    { kind: "suppress" }
  >
): ModelDocument {
  if (operation.collection === "features") {
    const index = targetIndex(
      document.features,
      operation.target,
      operation.collection
    );
    const features = [...document.features];
    features[index] = featureSchema.parse({
      ...features[index],
      suppressed: operation.suppressed
    });
    return { ...document, features };
  }

  const index = targetIndex(
    document.components,
    operation.target,
    operation.collection
  );
  const components = [...document.components];
  components[index] = componentSchema.parse({
    ...components[index],
    suppressed: operation.suppressed
  });
  return { ...document, components };
}

/**
 * Applies a validated operation batch without mutating either input.
 *
 * The caller owns optimistic-concurrency comparison of `baseRevisionId`.
 * This function deliberately does not reject a stale base revision; it does
 * enforce the document identity and every schema/reference invariant.
 */
export function applyOperationBatch(
  documentInput: ModelDocument,
  batchInput: ModelOperationBatch
): ModelDocument {
  const original = modelDocumentSchema.parse(documentInput);
  const batch = modelOperationBatchSchema.parse(batchInput);

  if (batch.documentId !== original.id) {
    throw new ModelingSemanticError(
      "Operation batch targets a different model document."
    );
  }

  let working = original;
  for (const operation of batch.operations) {
    switch (operation.kind) {
      case "add":
        working = addItem(working, operation);
        break;
      case "update":
        working = updateItem(working, operation);
        break;
      case "delete":
        working = deleteItem(working, operation);
        break;
      case "reorder":
        working = reorderCollection(working, operation);
        break;
      case "suppress":
        working = suppressItem(working, operation);
        break;
    }
  }

  return modelDocumentSchema.parse({
    ...working,
    revision: working.revision + 1,
    revisionId: batch.id
  });
}
