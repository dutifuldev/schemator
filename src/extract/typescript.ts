import ts from "typescript";
import { joinFieldPath } from "../field-path.js";
import type { FieldNode, ModelKind, ModelNode, SourceSpan } from "../types.js";

type Declaration =
  | ts.InterfaceDeclaration
  | ts.TypeAliasDeclaration;

type ObjectDeclarations = Map<string, Declaration[]>;

export function extractTypeScriptModels(
  code: string,
  sourcePath: string,
  startLine: number,
  knownObjectModelNames: Set<string> = new Set(),
): ModelNode[] {
  const sourceFile = ts.createSourceFile(sourcePath, code, ts.ScriptTarget.Latest, true);
  const declarations = collectDeclarations(sourceFile);
  const objectModelNames = extractObjectModelNames(declarations);
  const objectDeclarations = collectObjectDeclarations(declarations);
  for (const modelName of knownObjectModelNames) {
    objectModelNames.add(modelName);
  }
  return declarations.map((declaration) =>
    declarationToModel(declaration, sourceFile, sourcePath, startLine, objectModelNames, objectDeclarations)
  );
}

export function collectTypeScriptObjectModelNames(code: string, sourcePath: string): Set<string> {
  const sourceFile = ts.createSourceFile(sourcePath, code, ts.ScriptTarget.Latest, true);
  return extractObjectModelNames(collectDeclarations(sourceFile));
}

function collectDeclarations(sourceFile: ts.SourceFile): Declaration[] {
  const declarations: Declaration[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
      declarations.push(statement);
    }
  }
  return declarations;
}

function extractObjectModelNames(declarations: Declaration[]): Set<string> {
  const names = new Set(collectObjectDeclarations(declarations).keys());
  for (const declaration of declarations) {
    if (declarationIsArrayAlias(declaration) || declarationIsRecordAlias(declaration)) {
      names.add(declaration.name.text);
    }
  }
  return names;
}

function collectObjectDeclarations(declarations: Declaration[]): ObjectDeclarations {
  const objects: ObjectDeclarations = new Map();
  for (const declaration of declarations) {
    if (declarationHasMembers(declaration)) {
      addObjectDeclaration(objects, declaration);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      if (objects.has(declaration.name.text)) {
        continue;
      }
      if (declarationResolvesToObject(declaration, objects)) {
        objects.set(declaration.name.text, [declaration]);
        changed = true;
      }
    }
  }
  return objects;
}

function addObjectDeclaration(objects: ObjectDeclarations, declaration: Declaration): void {
  const declarations = objects.get(declaration.name.text) ?? [];
  declarations.push(declaration);
  objects.set(declaration.name.text, declarations);
}

function declarationToModel(
  declaration: Declaration,
  sourceFile: ts.SourceFile,
  sourcePath: string,
  startLine: number,
  modelNames: Set<string>,
  objectDeclarations: ObjectDeclarations,
): ModelNode {
  const id = declaration.name.text;
  const fields: FieldNode[] = [];
  const memberGroups = memberGroupsForDeclaration(declaration, objectDeclarations);
  if (memberGroups.length > 0) {
    if (ts.isInterfaceDeclaration(declaration)) {
      addInheritedInterfaceFields(
        declaration,
        id,
        sourceFile,
        sourcePath,
        startLine,
        modelNames,
        objectDeclarations,
        fields,
        new Set([id]),
      );
    }
    const rootRequired = !ts.isTypeAliasDeclaration(declaration) ||
      topLevelObjectAlwaysPresent(declaration, objectDeclarations);
    addMemberGroupsFields(memberGroups, "", id, sourceFile, sourcePath, startLine, modelNames, fields, rootRequired, true);
  } else if (ts.isTypeAliasDeclaration(declaration)) {
    addArrayAliasFields(declaration, sourceFile, sourcePath, startLine, modelNames, fields);
    addRecordAliasFields(declaration, sourceFile, sourcePath, startLine, modelNames, fields);
  }
  return {
    id,
    kind: modelKind(declaration, objectDeclarations),
    source: spanForNode(declaration, sourceFile, sourcePath, startLine),
    fields,
  };
}

function declarationResolvesToObject(
  declaration: Declaration,
  objectDeclarations: ObjectDeclarations,
): boolean {
  return ts.isTypeAliasDeclaration(declaration) &&
    (memberGroupsForDeclaration(declaration, objectDeclarations, new Set([declaration.name.text])).length > 0 ||
      declarationIsRecordAlias(declaration));
}

function addInheritedInterfaceFields(
  declaration: ts.InterfaceDeclaration,
  modelId: string,
  sourceFile: ts.SourceFile,
  sourcePath: string,
  startLine: number,
  modelNames: Set<string>,
  objectDeclarations: ObjectDeclarations,
  fields: FieldNode[],
  seenInterfaces: Set<string>,
): void {
  for (const baseName of extendedInterfaceNames(declaration, sourceFile)) {
    if (seenInterfaces.has(baseName)) {
      continue;
    }
    const baseDeclarations = objectDeclarations.get(baseName);
    if (!baseDeclarations) {
      continue;
    }
    seenInterfaces.add(baseName);
    for (const base of baseDeclarations) {
      if (!ts.isInterfaceDeclaration(base)) {
        continue;
      }
      addInheritedInterfaceFields(
        base,
        modelId,
        sourceFile,
        sourcePath,
        startLine,
        modelNames,
        objectDeclarations,
        fields,
        seenInterfaces,
      );
    }
    addMemberGroupsFields(
      memberGroupsForDeclarations(baseDeclarations, objectDeclarations, seenInterfaces),
      "",
      modelId,
      sourceFile,
      sourcePath,
      startLine,
      modelNames,
      fields,
      true,
      false,
    );
  }
}

function extendedInterfaceNames(declaration: ts.InterfaceDeclaration, sourceFile: ts.SourceFile): string[] {
  return (declaration.heritageClauses ?? [])
    .filter((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)
    .flatMap((clause) => clause.types.map((heritageType) => heritageType.expression.getText(sourceFile)));
}

function memberGroupsForDeclaration(
  declaration: Declaration,
  objectDeclarations?: ObjectDeclarations,
  seenTypes: Set<string> = new Set(),
): ReadonlyArray<ReadonlyArray<ts.TypeElement>> {
  if (ts.isInterfaceDeclaration(declaration)) {
    return [declaration.members];
  }
  return memberGroupsForTypeNode(declaration.type, objectDeclarations, seenTypes);
}

function memberGroupsForDeclarations(
  declarations: readonly Declaration[],
  objectDeclarations?: ObjectDeclarations,
  seenTypes: Set<string> = new Set(),
): ReadonlyArray<ReadonlyArray<ts.TypeElement>> {
  const interfaceMembers = declarations
    .filter(ts.isInterfaceDeclaration)
    .flatMap((declaration) => [...declaration.members]);
  if (interfaceMembers.length > 0 && declarations.every(ts.isInterfaceDeclaration)) {
    return [interfaceMembers];
  }
  return declarations.flatMap((declaration) => memberGroupsForDeclaration(declaration, objectDeclarations, seenTypes));
}

function declarationHasMembers(declaration: Declaration): boolean {
  if (ts.isInterfaceDeclaration(declaration)) {
    return true;
  }
  return typeNodeHasObjectMembers(declaration.type);
}

function declarationIsArrayAlias(declaration: Declaration): boolean {
  return ts.isTypeAliasDeclaration(declaration) && Boolean(arrayElementTypeNode(declaration.type));
}

function declarationIsRecordAlias(declaration: Declaration): boolean {
  return ts.isTypeAliasDeclaration(declaration) && isRecordLikeType(declaration.type);
}

function modelKind(declaration: Declaration, objectDeclarations: ObjectDeclarations): ModelKind {
  if (ts.isInterfaceDeclaration(declaration)) {
    return "object";
  }
  if (ts.isTypeLiteralNode(declaration.type)) {
    return "object";
  }
  if (declarationHasMembers(declaration)) {
    return "object";
  }
  if (memberGroupsForDeclaration(declaration, objectDeclarations, new Set([declaration.name.text])).length > 0) {
    return "object";
  }
  if (ts.isArrayTypeNode(declaration.type)) {
    return "array";
  }
  if (arrayElementTypeNode(declaration.type)) {
    return "array";
  }
  if (declarationIsRecordAlias(declaration)) {
    return "object";
  }
  if (ts.isUnionTypeNode(declaration.type)) {
    return "enum";
  }
  return "scalar";
}

function addArrayAliasFields(
  declaration: ts.TypeAliasDeclaration,
  sourceFile: ts.SourceFile,
  sourcePath: string,
  startLine: number,
  modelNames: Set<string>,
  fields: FieldNode[],
): void {
  const elementTypes = arrayElementTypeNodes(declaration.type);
  if (elementTypes.length === 0) {
    return;
  }
  const elementCandidates = elementTypes.flatMap(nonNullableTypeNodes);
  const ref = referencedModelFromTypeCandidates(elementCandidates, sourceFile, modelNames);
  const objectLike = Boolean(ref) || hasObjectLikeBoundary(elementCandidates);
  const fieldNullable = typeAllowsNullish(declaration.type);
  fields.push({
    path: "items",
    name: "items",
    type: declaration.type.getText(sourceFile),
    required: true,
    nullable: fieldNullable,
    parent: declaration.name.text,
    objectLike,
    source: spanForNode(declaration, sourceFile, sourcePath, startLine),
    ...(ref ? { ref } : {}),
  });
  const descendantRequired = !fieldNullable;
  addNestedTypeFields(
    elementCandidates,
    "items[]",
    declaration.name.text,
    sourceFile,
    sourcePath,
    startLine,
    modelNames,
    fields,
    {
      objectRequired: descendantRequired && hasOnlyInlineObjectBranches(elementTypes),
      arrayRequired: descendantRequired && hasOnlyInlineArrayObjectBranches(elementTypes),
      recordRequired: descendantRequired && hasOnlyRecordObjectBranches(elementTypes),
      arrayRecordRequired: descendantRequired && hasOnlyArrayRecordObjectBranches(elementTypes),
    },
  );
}

function addRecordAliasFields(
  declaration: ts.TypeAliasDeclaration,
  sourceFile: ts.SourceFile,
  sourcePath: string,
  startLine: number,
  modelNames: Set<string>,
  fields: FieldNode[],
): void {
  const valueTypes = recordValueTypeNodesForTypeNode(declaration.type);
  if (valueTypes.length === 0) {
    return;
  }
  addRecordValueFields(
    valueTypes,
    "",
    declaration.name.text,
    sourceFile,
    sourcePath,
    startLine,
    modelNames,
    fields,
    !typeAllowsNullish(declaration.type),
  );
}

type AddPropertyFieldOptions = {
  addNested?: boolean;
  ancestorRequired?: boolean;
  required?: boolean;
};

function addPropertyField(
  member: ts.PropertySignature,
  parentPath: string,
  modelId: string,
  sourceFile: ts.SourceFile,
  sourcePath: string,
  startLine: number,
  modelNames: Set<string>,
  fields: FieldNode[],
  options: AddPropertyFieldOptions = {},
): void {
  const name = propertyNameText(member.name);
  if (!name) {
    return;
  }
  const path = joinFieldPath(parentPath, name);
  const typeNode = member.type;
  const type = typeNode?.getText(sourceFile) ?? "unknown";
  const typeCandidates = typeNode ? nonNullableTypeNodes(typeNode) : [];
  const ref = referencedModelFromTypeCandidates(typeCandidates, sourceFile, modelNames) ?? referencedModel(type, modelNames);
  const objectLike = Boolean(ref) || hasObjectLikeBoundary(typeCandidates);
  const fieldRequired = (options.required ?? !member.questionToken) && (options.ancestorRequired ?? true);
  const fieldNullable = typeNode ? typeAllowsNullish(typeNode) : false;
  const descendantRequired = fieldRequired && !fieldNullable;
  const inlineObjectDescendantRequired = descendantRequired && hasOnlyInlineObjectBranches(typeCandidates);
  const inlineArrayDescendantRequired = descendantRequired && hasOnlyInlineArrayObjectBranches(typeCandidates);
  fields.push({
    path,
    name,
    type,
    required: fieldRequired,
    nullable: fieldNullable,
    parent: modelId,
    objectLike,
    source: spanForNode(member, sourceFile, sourcePath, startLine),
    ...(ref ? { ref } : {}),
  });

  if (options.addNested !== false) {
    addNestedTypeFields(
      typeCandidates,
      path,
      modelId,
      sourceFile,
      sourcePath,
      startLine,
      modelNames,
      fields,
      {
        objectRequired: inlineObjectDescendantRequired,
        arrayRequired: inlineArrayDescendantRequired,
        recordRequired: descendantRequired && hasOnlyRecordObjectBranches(typeCandidates),
        arrayRecordRequired: descendantRequired && hasOnlyArrayRecordObjectBranches(typeCandidates),
      },
    );
  }
}

function addPropertyFieldIfAbsent(
  member: ts.PropertySignature,
  parentPath: string,
  modelId: string,
  sourceFile: ts.SourceFile,
  sourcePath: string,
  startLine: number,
  modelNames: Set<string>,
  fields: FieldNode[],
  ancestorRequired: boolean,
  overrideExisting: boolean,
): void {
  const name = propertyNameText(member.name);
  if (!name) {
    return;
  }
  const path = joinFieldPath(parentPath, name);
  if (overrideExisting) {
    removeExistingPath(fields, path);
  }
  if (fields.some((field) => field.path === path)) {
    return;
  }
  addPropertyField(member, parentPath, modelId, sourceFile, sourcePath, startLine, modelNames, fields, {
    ancestorRequired,
  });
}

function addMemberGroupsFields(
  memberGroups: ReadonlyArray<ReadonlyArray<ts.TypeElement>>,
  parentPath: string,
  modelId: string,
  sourceFile: ts.SourceFile,
  sourcePath: string,
  startLine: number,
  modelNames: Set<string>,
  fields: FieldNode[],
  ancestorRequired: boolean,
  overrideExisting: boolean,
): void {
  if (memberGroups.length === 1) {
    const group = memberGroups[0] ?? [];
    const handledProperties = new Set<string>();
    for (const nested of group) {
      if (ts.isPropertySignature(nested)) {
        const name = propertyNameText(nested.name);
        if (!name || handledProperties.has(name)) {
          continue;
        }
        handledProperties.add(name);
        const occurrences = group.filter((candidate): candidate is ts.PropertySignature =>
          ts.isPropertySignature(candidate) && propertyNameText(candidate.name) === name
        );
        if (occurrences.length > 1) {
          addIntersectionPropertyField(
            occurrences,
            nested,
            parentPath,
            modelId,
            sourceFile,
            sourcePath,
            startLine,
            modelNames,
            fields,
            {
              ancestorRequired,
              overrideExisting,
            },
          );
        } else {
          addPropertyFieldIfAbsent(
            nested,
            parentPath,
            modelId,
            sourceFile,
            sourcePath,
            startLine,
            modelNames,
            fields,
            ancestorRequired,
            overrideExisting,
          );
        }
      } else if (ts.isIndexSignatureDeclaration(nested)) {
        addIndexSignatureFieldIfAbsent(
          nested,
          parentPath,
          modelId,
          sourceFile,
          sourcePath,
          startLine,
          modelNames,
          fields,
          ancestorRequired,
          overrideExisting,
        );
      }
    }
    return;
  }

  const seen = new Set<string>();
  for (const group of memberGroups) {
    for (const member of group) {
      if (!ts.isPropertySignature(member)) {
        continue;
      }
      const name = propertyNameText(member.name);
      if (!name || seen.has(name)) {
        continue;
      }
      seen.add(name);
      const occurrences = memberGroups
        .map((candidateGroup) => candidateGroup.find((candidate): candidate is ts.PropertySignature =>
          ts.isPropertySignature(candidate) && propertyNameText(candidate.name) === name
        ))
        .filter((candidate): candidate is ts.PropertySignature => Boolean(candidate));
      const required = occurrences.length === memberGroups.length && occurrences.every((candidate) => !candidate.questionToken);
      const path = joinFieldPath(parentPath, name);
      if (overrideExisting) {
        removeExistingPath(fields, path);
      }
      addUnionPropertyField(occurrences, member, parentPath, modelId, sourceFile, sourcePath, startLine, modelNames, fields, {
        ancestorRequired,
        required,
      });
      const allOccurrencesNonNullable = occurrences.every((candidate) =>
        candidate.type ? !typeAllowsNullish(candidate.type) : true
      );
      const descendantRequired = required && ancestorRequired && allOccurrencesNonNullable;
      const occurrenceTypeNodes = occurrences.flatMap((candidate) => candidate.type ? nonNullableTypeNodes(candidate.type) : []);
      addNestedTypeFields(
        occurrenceTypeNodes,
        path,
        modelId,
        sourceFile,
        sourcePath,
        startLine,
        modelNames,
        fields,
        {
          objectRequired: descendantRequired && hasOnlyInlineObjectBranches(occurrenceTypeNodes),
          arrayRequired: descendantRequired && hasOnlyInlineArrayObjectBranches(occurrenceTypeNodes),
          recordRequired: descendantRequired && hasOnlyRecordObjectBranches(occurrenceTypeNodes),
          arrayRecordRequired: descendantRequired && hasOnlyArrayRecordObjectBranches(occurrenceTypeNodes),
        },
      );
    }
  }
  const indexOccurrences = memberGroups
    .map((group) => group.find((candidate): candidate is ts.IndexSignatureDeclaration =>
      ts.isIndexSignatureDeclaration(candidate)
    ))
    .filter((candidate): candidate is ts.IndexSignatureDeclaration => Boolean(candidate));
  if (indexOccurrences.length > 0) {
    addUnionIndexSignatureField(
      indexOccurrences,
      indexOccurrences[0] as ts.IndexSignatureDeclaration,
      parentPath,
      modelId,
      sourceFile,
      sourcePath,
      startLine,
      modelNames,
      fields,
      {
        ancestorRequired,
        required: indexOccurrences.length === memberGroups.length,
        overrideExisting,
      },
    );
  }
}

function addIntersectionPropertyField(
  occurrences: ts.PropertySignature[],
  fallbackMember: ts.PropertySignature,
  parentPath: string,
  modelId: string,
  sourceFile: ts.SourceFile,
  sourcePath: string,
  startLine: number,
  modelNames: Set<string>,
  fields: FieldNode[],
  options: { ancestorRequired: boolean; overrideExisting: boolean },
): void {
  const name = propertyNameText(fallbackMember.name);
  if (!name) {
    return;
  }
  const path = joinFieldPath(parentPath, name);
  if (options.overrideExisting) {
    removeExistingPath(fields, path);
  }
  if (fields.some((field) => field.path === path)) {
    return;
  }
  const typeNodes = occurrences.flatMap((candidate) => candidate.type ? nonNullableTypeNodes(candidate.type) : []);
  const type = uniqueStrings(
    occurrences.map((candidate) => candidate.type?.getText(sourceFile) ?? "unknown"),
  ).join(" & ");
  const ref = referencedModelFromTypeCandidates(typeNodes, sourceFile, modelNames) ?? referencedModel(type, modelNames);
  const fieldRequired = options.ancestorRequired && occurrences.some((candidate) => !candidate.questionToken);
  const fieldNullable = occurrences.length > 0 &&
    occurrences.every((candidate) => candidate.type ? typeAllowsNullish(candidate.type) : false);
  const objectLike = Boolean(ref) || hasObjectLikeBoundary(typeNodes);
  fields.push({
    path,
    name,
    type,
    required: fieldRequired,
    nullable: fieldNullable,
    parent: modelId,
    objectLike,
    source: spanForNode(fallbackMember, sourceFile, sourcePath, startLine),
    ...(ref ? { ref } : {}),
  });
  for (const occurrence of occurrences) {
    const occurrenceDescendantRequired = options.ancestorRequired &&
      !occurrence.questionToken &&
      (occurrence.type ? !typeAllowsNullish(occurrence.type) : true);
    addNestedPropertyFields(
      occurrence,
      path,
      modelId,
      sourceFile,
      sourcePath,
      startLine,
      modelNames,
      fields,
      occurrenceDescendantRequired,
    );
  }
}

function addUnionPropertyField(
  occurrences: ts.PropertySignature[],
  fallbackMember: ts.PropertySignature,
  parentPath: string,
  modelId: string,
  sourceFile: ts.SourceFile,
  sourcePath: string,
  startLine: number,
  modelNames: Set<string>,
  fields: FieldNode[],
  options: Required<Pick<AddPropertyFieldOptions, "ancestorRequired" | "required">>,
): void {
  const name = propertyNameText(fallbackMember.name);
  if (!name) {
    return;
  }
  const path = joinFieldPath(parentPath, name);
  const typeNodes = occurrences.flatMap((candidate) => candidate.type ? nonNullableTypeNodes(candidate.type) : []);
  const type = uniqueStrings(
    occurrences.map((candidate) => candidate.type?.getText(sourceFile) ?? "unknown"),
  ).join(" | ");
  const ref = referencedModelFromTypeCandidates(typeNodes, sourceFile, modelNames) ?? referencedModel(type, modelNames);
  const fieldRequired = options.required && options.ancestorRequired;
  const fieldNullable = occurrences.some((candidate) => candidate.type ? typeAllowsNullish(candidate.type) : false);
  const objectLike = Boolean(ref) || hasObjectLikeBoundary(typeNodes);
  fields.push({
    path,
    name,
    type,
    required: fieldRequired,
    nullable: fieldNullable,
    parent: modelId,
    objectLike,
    source: spanForNode(fallbackMember, sourceFile, sourcePath, startLine),
    ...(ref ? { ref } : {}),
  });
}

function addIndexSignatureFieldIfAbsent(
  member: ts.IndexSignatureDeclaration,
  parentPath: string,
  modelId: string,
  sourceFile: ts.SourceFile,
  sourcePath: string,
  startLine: number,
  modelNames: Set<string>,
  fields: FieldNode[],
  ancestorRequired: boolean,
  overrideExisting: boolean,
): void {
  const path = joinFieldPath(parentPath, "additionalProperties");
  if (overrideExisting) {
    removeExistingPath(fields, path);
  }
  if (fields.some((field) => field.path === path)) {
    return;
  }
  addIndexSignatureField(member, parentPath, modelId, sourceFile, sourcePath, startLine, modelNames, fields, {
    ancestorRequired,
    required: true,
  });
}

function addUnionIndexSignatureField(
  occurrences: ts.IndexSignatureDeclaration[],
  fallbackMember: ts.IndexSignatureDeclaration,
  parentPath: string,
  modelId: string,
  sourceFile: ts.SourceFile,
  sourcePath: string,
  startLine: number,
  modelNames: Set<string>,
  fields: FieldNode[],
  options: { ancestorRequired: boolean; required: boolean; overrideExisting: boolean },
): void {
  const path = joinFieldPath(parentPath, "additionalProperties");
  if (options.overrideExisting) {
    removeExistingPath(fields, path);
  }
  if (fields.some((field) => field.path === path)) {
    return;
  }
  addIndexSignatureField(
    fallbackMember,
    parentPath,
    modelId,
    sourceFile,
    sourcePath,
    startLine,
    modelNames,
    fields,
    {
      ancestorRequired: options.ancestorRequired,
      required: options.required,
      nullable: occurrences.some((candidate) => typeAllowsNullish(candidate.type)),
      typeOverride: uniqueStrings(occurrences.map((candidate) => candidate.type.getText(sourceFile))).join(" | "),
      typeNodesOverride: occurrences.flatMap((candidate) => nonNullableTypeNodes(candidate.type)),
    },
  );
}

function addIndexSignatureField(
  member: ts.IndexSignatureDeclaration,
  parentPath: string,
  modelId: string,
  sourceFile: ts.SourceFile,
  sourcePath: string,
  startLine: number,
  modelNames: Set<string>,
  fields: FieldNode[],
  options: {
    ancestorRequired: boolean;
    required: boolean;
    typeOverride?: string;
    typeNodesOverride?: ts.TypeNode[];
    nullable?: boolean;
  },
): void {
  const path = joinFieldPath(parentPath, "additionalProperties");
  const typeNode = member.type;
  const typeNodes = options.typeNodesOverride ?? nonNullableTypeNodes(typeNode);
  const type = options.typeOverride ?? typeNode.getText(sourceFile);
  const ref = referencedModelFromTypeCandidates(typeNodes, sourceFile, modelNames) ?? referencedModel(type, modelNames);
  const fieldRequired = options.required && options.ancestorRequired;
  const fieldNullable = options.nullable ?? typeAllowsNullish(typeNode);
  const objectLike = Boolean(ref) || hasObjectLikeBoundary(typeNodes);
  fields.push({
    path,
    name: "additionalProperties",
    type,
    required: fieldRequired,
    nullable: fieldNullable,
    parent: modelId,
    objectLike,
    source: spanForNode(member, sourceFile, sourcePath, startLine),
    ...(ref ? { ref } : {}),
  });
  const descendantRequired = fieldRequired && !fieldNullable;
  addNestedTypeFields(
    typeNodes,
    path,
    modelId,
    sourceFile,
    sourcePath,
    startLine,
    modelNames,
    fields,
    {
      objectRequired: descendantRequired && hasOnlyInlineObjectBranches(typeNodes),
      arrayRequired: descendantRequired && hasOnlyInlineArrayObjectBranches(typeNodes),
      recordRequired: descendantRequired && hasOnlyRecordObjectBranches(typeNodes),
      arrayRecordRequired: descendantRequired && hasOnlyArrayRecordObjectBranches(typeNodes),
    },
  );
}

function addNestedPropertyFields(
  member: ts.PropertySignature,
  path: string,
  modelId: string,
  sourceFile: ts.SourceFile,
  sourcePath: string,
  startLine: number,
  modelNames: Set<string>,
  fields: FieldNode[],
  ancestorRequired: boolean,
): void {
  const typeNodes = member.type ? nonNullableTypeNodes(member.type) : [];
  addNestedTypeFields(typeNodes, path, modelId, sourceFile, sourcePath, startLine, modelNames, fields, ancestorRequired);
}

function addNestedTypeFields(
  typeNodes: ts.TypeNode[],
  path: string,
  modelId: string,
  sourceFile: ts.SourceFile,
  sourcePath: string,
  startLine: number,
  modelNames: Set<string>,
  fields: FieldNode[],
  required:
    | boolean
    | {
      objectRequired: boolean;
      arrayRequired: boolean;
      recordRequired: boolean;
      arrayRecordRequired: boolean;
    },
): void {
  const objectRequired = typeof required === "boolean" ? required && hasOnlyInlineObjectBranches(typeNodes) : required.objectRequired;
  const arrayRequired = typeof required === "boolean" ? required && hasOnlyInlineArrayObjectBranches(typeNodes) : required.arrayRequired;
  const recordRequired = typeof required === "boolean" ? required && hasOnlyRecordObjectBranches(typeNodes) : required.recordRequired;
  const arrayRecordRequired = typeof required === "boolean"
    ? required && hasOnlyArrayRecordObjectBranches(typeNodes)
    : required.arrayRecordRequired;
  const inlineObjectMemberGroups = inlineObjectMemberGroupsForTypeNodes(typeNodes);
  if (inlineObjectMemberGroups.length > 0) {
    addMemberGroupsFields(
      inlineObjectMemberGroups,
      path,
      modelId,
      sourceFile,
      sourcePath,
      startLine,
      modelNames,
      fields,
      objectRequired,
      false,
    );
  }
  const inlineArrayObjectMemberGroups = inlineArrayObjectMemberGroupsForTypeNodes(typeNodes);
  if (inlineArrayObjectMemberGroups.length > 0) {
    addMemberGroupsFields(
      inlineArrayObjectMemberGroups,
      `${path}[]`,
      modelId,
      sourceFile,
      sourcePath,
      startLine,
      modelNames,
      fields,
      arrayRequired,
      false,
    );
  }
  const recordValueTypes = recordValueTypeNodesForTypeNodes(typeNodes);
  if (recordValueTypes.length > 0) {
    addRecordValueFields(
      recordValueTypes,
      path,
      modelId,
      sourceFile,
      sourcePath,
      startLine,
      modelNames,
      fields,
      recordRequired,
    );
  }
  const arrayRecordValueTypes = arrayRecordValueTypeNodesForTypeNodes(typeNodes);
  if (arrayRecordValueTypes.length > 0) {
    addRecordValueFields(
      arrayRecordValueTypes,
      `${path}[]`,
      modelId,
      sourceFile,
      sourcePath,
      startLine,
      modelNames,
      fields,
      arrayRecordRequired,
    );
  }
}

function addRecordValueFields(
  valueTypes: ts.TypeNode[],
  parentPath: string,
  modelId: string,
  sourceFile: ts.SourceFile,
  sourcePath: string,
  startLine: number,
  modelNames: Set<string>,
  fields: FieldNode[],
  ancestorRequired: boolean,
): void {
  const path = joinFieldPath(parentPath, "additionalProperties");
  const typeCandidates = valueTypes.flatMap(nonNullableTypeNodes);
  const type = uniqueStrings(valueTypes.map((candidate) => candidate.getText(sourceFile))).join(" | ");
  const ref = referencedModelFromTypeCandidates(typeCandidates, sourceFile, modelNames) ?? referencedModel(type, modelNames);
  const fieldNullable = valueTypes.some(typeAllowsNullish);
  const objectLike = Boolean(ref) || hasObjectLikeBoundary(typeCandidates);
  if (!fields.some((field) => field.path === path)) {
    fields.push({
      path,
      name: "additionalProperties",
      type,
      required: ancestorRequired,
      nullable: fieldNullable,
      parent: modelId,
      objectLike,
      source: spanForNode(valueTypes[0] as ts.Node, sourceFile, sourcePath, startLine),
      ...(ref ? { ref } : {}),
    });
  }
  const descendantRequired = ancestorRequired && !fieldNullable;
  addNestedTypeFields(
    typeCandidates,
    path,
    modelId,
    sourceFile,
    sourcePath,
    startLine,
    modelNames,
    fields,
    {
      objectRequired: descendantRequired && hasOnlyInlineObjectBranches(typeCandidates),
      arrayRequired: descendantRequired && hasOnlyInlineArrayObjectBranches(typeCandidates),
      recordRequired: descendantRequired && hasOnlyRecordObjectBranches(typeCandidates),
      arrayRecordRequired: descendantRequired && hasOnlyArrayRecordObjectBranches(typeCandidates),
    },
  );
}

function removeExistingPath(fields: FieldNode[], path: string): void {
  for (let index = fields.length - 1; index >= 0; index -= 1) {
    const existing = fields[index];
    if (existing && (existing.path === path || existing.path.startsWith(`${path}.`) || existing.path.startsWith(`${path}[].`))) {
      fields.splice(index, 1);
    }
  }
}

function inlineArrayObjectMemberGroupsForTypeNodes(
  typeNodes: ts.TypeNode[],
): ReadonlyArray<ReadonlyArray<ts.TypeElement>> {
  return typeNodes
    .flatMap(arrayElementTypeNodes)
    .flatMap((candidate) => candidate ? inlineObjectMemberGroupsForTypeNodes(nonNullableTypeNodes(candidate)) : []);
}

function inlineObjectMemberGroupsForTypeNodes(typeNodes: ts.TypeNode[]): ReadonlyArray<ReadonlyArray<ts.TypeElement>> {
  return typeNodes.flatMap(inlineObjectMemberGroupsForTypeNode);
}

function inlineObjectMemberGroupsForTypeNode(typeNode: ts.TypeNode): ReadonlyArray<ReadonlyArray<ts.TypeElement>> {
  const unwrapped = unwrapParenthesizedType(typeNode);
  if (ts.isTypeLiteralNode(unwrapped)) {
    return [unwrapped.members];
  }
  if (ts.isIntersectionTypeNode(unwrapped)) {
    const members = unwrapped.types.flatMap((candidate) =>
      inlineObjectMemberGroupsForTypeNode(candidate).flatMap((group) => [...group])
    );
    return members.length > 0 ? [members] : [];
  }
  return [];
}

function hasOnlyInlineObjectBranches(typeNodes: ts.TypeNode[]): boolean {
  return typeNodes.length > 0 && typeNodes.every(isInlineObjectBranch);
}

function hasOnlyInlineArrayObjectBranches(typeNodes: ts.TypeNode[]): boolean {
  return typeNodes.length > 0 &&
    typeNodes.every((candidate) => {
      const elements = arrayElementTypeNodes(candidate);
      return elements.length > 0 && elements.every((element) => typeBranches(element).every(isInlineObjectBranch));
    });
}

function hasOnlyRecordObjectBranches(typeNodes: ts.TypeNode[]): boolean {
  return typeNodes.length > 0 &&
    typeNodes.every((candidate) => {
      const valueTypes = recordValueTypeNodesForTypeNode(candidate);
      return valueTypes.length > 0 &&
        valueTypes.every((valueType) => typeBranches(valueType).every(isInlineObjectBranch));
    });
}

function hasOnlyArrayRecordObjectBranches(typeNodes: ts.TypeNode[]): boolean {
  return typeNodes.length > 0 &&
    typeNodes.every((candidate) => {
      const elementTypes = arrayElementTypeNodes(candidate);
      return elementTypes.length > 0 &&
        elementTypes.every((elementType) => hasOnlyRecordObjectBranches(nonNullableTypeNodes(elementType)));
    });
}

function hasObjectLikeBoundary(typeNodes: ts.TypeNode[]): boolean {
  return typeNodes.some(typeNodeHasObjectLikeBoundary);
}

function typeNodeHasObjectLikeBoundary(typeNode: ts.TypeNode): boolean {
  const unwrapped = unwrapParenthesizedType(typeNode);
  if (ts.isUnionTypeNode(unwrapped)) {
    return nonNullableTypeNodes(unwrapped).some(typeNodeHasObjectLikeBoundary);
  }
  if (ts.isIntersectionTypeNode(unwrapped)) {
    return unwrapped.types.some(typeNodeHasObjectLikeBoundary);
  }
  if (isInlineObjectBranch(unwrapped) || isRecordLikeType(unwrapped) || isOpaqueObjectType(unwrapped)) {
    return true;
  }
  return arrayElementTypeNodes(unwrapped).some((elementType) =>
    nonNullableTypeNodes(elementType).some(typeNodeHasObjectLikeBoundary)
  );
}

function isInlineObjectBranch(typeNode: ts.TypeNode): boolean {
  const unwrapped = unwrapParenthesizedType(typeNode);
  if (ts.isTypeLiteralNode(unwrapped)) {
    return true;
  }
  return ts.isIntersectionTypeNode(unwrapped) && unwrapped.types.every(isInlineObjectBranch);
}

function topLevelObjectAlwaysPresent(
  declaration: ts.TypeAliasDeclaration,
  objectDeclarations: ObjectDeclarations,
): boolean {
  if (typeAllowsNullish(declaration.type)) {
    return false;
  }
  const branches = nonNullableTypeNodes(declaration.type);
  return branches.length > 0 &&
    branches.every((branch) =>
      memberGroupsForTypeNode(branch, objectDeclarations, new Set([declaration.name.text])).length > 0
    );
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function typeBranches(typeNode: ts.TypeNode): ts.TypeNode[] {
  const unwrapped = unwrapParenthesizedType(typeNode);
  return ts.isUnionTypeNode(unwrapped) ? unwrapped.types.map(unwrapParenthesizedType) : [unwrapped];
}

function memberGroupsForTypeNode(
  typeNode: ts.TypeNode,
  objectDeclarations: ObjectDeclarations | undefined,
  seenTypes: Set<string>,
): ReadonlyArray<ReadonlyArray<ts.TypeElement>> {
  const unwrapped = unwrapParenthesizedType(typeNode);
  if (ts.isTypeLiteralNode(unwrapped)) {
    return [unwrapped.members];
  }
  if (ts.isUnionTypeNode(unwrapped)) {
    return nonNullableTypeNodes(unwrapped).flatMap((candidate) =>
      memberGroupsForTypeNode(candidate, objectDeclarations, seenTypes)
    );
  }
  if (ts.isIntersectionTypeNode(unwrapped)) {
    const members = unwrapped.types.flatMap((candidate) =>
      memberGroupsForTypeNode(candidate, objectDeclarations, seenTypes).flatMap((group) => [...group])
    );
    return members.length > 0 ? [members] : [];
  }
  if (ts.isTypeReferenceNode(unwrapped)) {
    const refName = typeReferenceName(unwrapped);
    const referenced = refName ? objectDeclarations?.get(refName) : undefined;
    if (!refName || !referenced || seenTypes.has(refName)) {
      return [];
    }
    return memberGroupsForDeclarations(referenced, objectDeclarations, new Set([...seenTypes, refName]));
  }
  return [];
}

function typeNodeHasObjectMembers(typeNode: ts.TypeNode): boolean {
  const unwrapped = unwrapParenthesizedType(typeNode);
  if (ts.isTypeLiteralNode(unwrapped)) {
    return true;
  }
  if (ts.isUnionTypeNode(unwrapped)) {
    return nonNullableTypeNodes(unwrapped).some(typeNodeHasObjectMembers);
  }
  if (ts.isIntersectionTypeNode(unwrapped)) {
    return unwrapped.types.some((candidate) => {
      const unwrappedCandidate = unwrapParenthesizedType(candidate);
      return ts.isTypeReferenceNode(unwrappedCandidate) || typeNodeHasObjectMembers(unwrappedCandidate);
    });
  }
  return false;
}

function typeReferenceName(typeNode: ts.TypeReferenceNode): string | null {
  const typeName = typeNode.typeName;
  if (ts.isIdentifier(typeName)) {
    return typeName.text;
  }
  if (ts.isQualifiedName(typeName)) {
    return typeName.right.text;
  }
  return null;
}

function isRecordLikeType(typeNode: ts.TypeNode): boolean {
  const unwrapped = unwrapParenthesizedType(typeNode);
  if (ts.isTypeReferenceNode(unwrapped)) {
    const refName = typeReferenceName(unwrapped);
    if (refName === "Record") {
      return true;
    }
    if (refName === "Readonly" && unwrapped.typeArguments?.length === 1) {
      return isRecordLikeType(unwrapped.typeArguments[0] as ts.TypeNode);
    }
    return false;
  }
  if (ts.isTypeOperatorNode(unwrapped) && unwrapped.operator === ts.SyntaxKind.ReadonlyKeyword) {
    return isRecordLikeType(unwrapped.type);
  }
  return false;
}

function isOpaqueObjectType(typeNode: ts.TypeNode): boolean {
  const unwrapped = unwrapParenthesizedType(typeNode);
  if (unwrapped.kind === ts.SyntaxKind.ObjectKeyword) {
    return true;
  }
  return ts.isTypeReferenceNode(unwrapped) && typeReferenceName(unwrapped) === "Object";
}

function recordValueTypeNodesForTypeNodes(typeNodes: ts.TypeNode[]): ts.TypeNode[] {
  return typeNodes.flatMap(recordValueTypeNodesForTypeNode);
}

function arrayRecordValueTypeNodesForTypeNodes(typeNodes: ts.TypeNode[]): ts.TypeNode[] {
  return typeNodes.flatMap((typeNode) =>
    arrayElementTypeNodes(typeNode).flatMap((elementType) => recordValueTypeNodesForTypeNode(elementType))
  );
}

function recordValueTypeNodesForTypeNode(typeNode: ts.TypeNode): ts.TypeNode[] {
  const unwrapped = unwrapParenthesizedType(typeNode);
  if (ts.isUnionTypeNode(unwrapped)) {
    return nonNullableTypeNodes(unwrapped).flatMap(recordValueTypeNodesForTypeNode);
  }
  if (ts.isTypeReferenceNode(unwrapped)) {
    const refName = typeReferenceName(unwrapped);
    if (refName === "Record" && unwrapped.typeArguments && unwrapped.typeArguments.length >= 2) {
      return [unwrapParenthesizedType(unwrapped.typeArguments[1] as ts.TypeNode)];
    }
    if (refName === "Readonly" && unwrapped.typeArguments?.length === 1) {
      return recordValueTypeNodesForTypeNode(unwrapped.typeArguments[0] as ts.TypeNode);
    }
    return [];
  }
  if (ts.isTypeOperatorNode(unwrapped) && unwrapped.operator === ts.SyntaxKind.ReadonlyKeyword) {
    return recordValueTypeNodesForTypeNode(unwrapped.type);
  }
  return [];
}

function propertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

function nonNullableTypeNodes(typeNode: ts.TypeNode): ts.TypeNode[] {
  const unwrapped = unwrapParenthesizedType(typeNode);
  if (!ts.isUnionTypeNode(unwrapped)) {
    return [unwrapped];
  }
  return unwrapped.types
    .map(unwrapParenthesizedType)
    .filter((candidate) => !isNullishTypeNode(candidate));
}

function typeAllowsNullish(typeNode: ts.TypeNode): boolean {
  const unwrapped = unwrapParenthesizedType(typeNode);
  if (ts.isUnionTypeNode(unwrapped)) {
    return unwrapped.types.map(unwrapParenthesizedType).some(isNullishTypeNode);
  }
  return isNullishTypeNode(unwrapped);
}

function unwrapParenthesizedType(typeNode: ts.TypeNode): ts.TypeNode {
  let current = typeNode;
  while (ts.isParenthesizedTypeNode(current)) {
    current = current.type;
  }
  return current;
}

function isNullishTypeNode(typeNode: ts.TypeNode): boolean {
  return (
    typeNode.kind === ts.SyntaxKind.UndefinedKeyword ||
    (ts.isLiteralTypeNode(typeNode) && typeNode.literal.kind === ts.SyntaxKind.NullKeyword)
  );
}

function arrayElementTypeNode(typeNode: ts.TypeNode): ts.TypeNode | null {
  return arrayElementTypeNodes(typeNode)[0] ?? null;
}

function arrayElementTypeNodes(typeNode: ts.TypeNode): ts.TypeNode[] {
  const unwrapped = unwrapParenthesizedType(typeNode);
  if (ts.isUnionTypeNode(unwrapped)) {
    return nonNullableTypeNodes(unwrapped).flatMap(arrayElementTypeNodes);
  }
  if (ts.isTypeOperatorNode(unwrapped) && unwrapped.operator === ts.SyntaxKind.ReadonlyKeyword) {
    return arrayElementTypeNodes(unwrapped.type);
  }
  if (ts.isArrayTypeNode(unwrapped)) {
    return [unwrapParenthesizedType(unwrapped.elementType)];
  }
  if (ts.isTupleTypeNode(unwrapped)) {
    return unwrapped.elements.map(tupleElementTypeNode);
  }
  if (!ts.isTypeReferenceNode(unwrapped) || !unwrapped.typeArguments || unwrapped.typeArguments.length !== 1) {
    return [];
  }
  const typeName = unwrapped.typeName.getText();
  if (typeName !== "Array" && typeName !== "ReadonlyArray") {
    return [];
  }
  return [unwrapParenthesizedType(unwrapped.typeArguments[0] as ts.TypeNode)];
}

function tupleElementTypeNode(element: ts.TypeNode): ts.TypeNode {
  if (ts.isNamedTupleMember(element)) {
    return unwrapParenthesizedType(element.type);
  }
  if (ts.isOptionalTypeNode(element)) {
    return unwrapParenthesizedType(element.type);
  }
  if (ts.isRestTypeNode(element)) {
    return unwrapParenthesizedType(element.type);
  }
  return unwrapParenthesizedType(element);
}

function referencedModel(typeText: string, modelNames: Set<string>): string | null {
  const bare = /^readonly\s+/.test(typeText) ? typeText.replace(/^readonly\s+/, "") : typeText;
  const candidates = bare
    .split("|")
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate !== "null" && candidate !== "undefined");
  for (const candidate of candidates) {
    const arrayMatch = /^([A-Z][A-Za-z0-9_]*)\[\]$/.exec(candidate);
    if (arrayMatch?.[1] && modelNames.has(arrayMatch[1])) {
      return arrayMatch[1];
    }
    const genericArrayMatch = /^(?:Array|ReadonlyArray)\s*<\s*(.+)\s*>$/.exec(candidate);
    const genericArrayRef = genericArrayMatch?.[1] ? referencedModel(genericArrayMatch[1], modelNames) : null;
    if (genericArrayRef) {
      return genericArrayRef;
    }
    const readonlyMatch = /^Readonly\s*<\s*(.+)\s*>$/.exec(candidate);
    const readonlyRef = readonlyMatch?.[1] ? referencedModel(readonlyMatch[1], modelNames) : null;
    if (readonlyRef) {
      return readonlyRef;
    }
    if (modelNames.has(candidate)) {
      return candidate;
    }
    const genericReferenceMatch = /^([A-Z][A-Za-z0-9_]*)\s*<.+>$/.exec(candidate);
    if (genericReferenceMatch?.[1] && modelNames.has(genericReferenceMatch[1])) {
      return genericReferenceMatch[1];
    }
  }
  return null;
}

function referencedModelFromTypeCandidates(
  candidates: ts.TypeNode[],
  sourceFile: ts.SourceFile,
  modelNames: Set<string>,
): string | null {
  for (const candidate of candidates) {
    if (ts.isTypeReferenceNode(candidate)) {
      const refName = typeReferenceName(candidate);
      if (refName && modelNames.has(refName)) {
        return refName;
      }
    }
    const ref = referencedModel(candidate.getText(sourceFile), modelNames);
    if (ref) {
      return ref;
    }
    for (const arrayElement of arrayElementTypeNodes(candidate)) {
      const arrayRef = referencedModelFromTypeCandidates(nonNullableTypeNodes(arrayElement), sourceFile, modelNames);
      if (arrayRef) {
        return arrayRef;
      }
    }
  }
  return null;
}

function spanForNode(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  sourcePath: string,
  startLine: number,
): SourceSpan {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return {
    path: sourcePath,
    span: {
      startLine: startLine + start.line,
      endLine: startLine + end.line,
    },
  };
}
