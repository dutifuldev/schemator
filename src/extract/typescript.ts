import ts from "typescript";
import { joinFieldPath } from "../field-path.js";
import type { FieldNode, ModelKind, ModelNode, SourceSpan } from "../types.js";

type Declaration =
  | ts.InterfaceDeclaration
  | ts.TypeAliasDeclaration;

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
    if (declarationIsArrayAlias(declaration)) {
      names.add(declaration.name.text);
    }
  }
  return names;
}

function collectObjectDeclarations(declarations: Declaration[]): Map<string, Declaration> {
  const objects = new Map<string, Declaration>();
  for (const declaration of declarations) {
    if (declarationHasMembers(declaration)) {
      objects.set(declaration.name.text, declaration);
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
        objects.set(declaration.name.text, declaration);
        changed = true;
      }
    }
  }
  return objects;
}

function declarationToModel(
  declaration: Declaration,
  sourceFile: ts.SourceFile,
  sourcePath: string,
  startLine: number,
  modelNames: Set<string>,
  objectDeclarations: Map<string, Declaration>,
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
    addMemberGroupsFields(memberGroups, "", id, sourceFile, sourcePath, startLine, modelNames, fields, true, true);
  } else if (ts.isTypeAliasDeclaration(declaration)) {
    addArrayAliasFields(declaration, sourceFile, sourcePath, startLine, modelNames, fields);
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
  objectDeclarations: Map<string, Declaration>,
): boolean {
  return ts.isTypeAliasDeclaration(declaration) &&
    memberGroupsForDeclaration(declaration, objectDeclarations, new Set([declaration.name.text])).length > 0;
}

function addInheritedInterfaceFields(
  declaration: ts.InterfaceDeclaration,
  modelId: string,
  sourceFile: ts.SourceFile,
  sourcePath: string,
  startLine: number,
  modelNames: Set<string>,
  objectDeclarations: Map<string, Declaration>,
  fields: FieldNode[],
  seenInterfaces: Set<string>,
): void {
  for (const baseName of extendedInterfaceNames(declaration, sourceFile)) {
    if (seenInterfaces.has(baseName)) {
      continue;
    }
    const base = objectDeclarations.get(baseName);
    if (!base) {
      continue;
    }
    seenInterfaces.add(baseName);
    if (ts.isInterfaceDeclaration(base)) {
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
      memberGroupsForDeclaration(base, objectDeclarations, seenInterfaces),
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
  objectDeclarations?: Map<string, Declaration>,
  seenTypes: Set<string> = new Set(),
): ReadonlyArray<ReadonlyArray<ts.TypeElement>> {
  if (ts.isInterfaceDeclaration(declaration)) {
    return [declaration.members];
  }
  return memberGroupsForTypeNode(declaration.type, objectDeclarations, seenTypes);
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

function modelKind(declaration: Declaration, objectDeclarations: Map<string, Declaration>): ModelKind {
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
  const inlineObjectTypes = typeLiterals(elementCandidates);
  const objectLike = Boolean(ref) || inlineObjectTypes.length > 0;
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
  if (inlineObjectTypes.length > 0) {
    const descendantRequired = !fieldNullable && hasOnlyInlineObjectBranches(elementTypes);
    addTypeLiteralVariantFields(
      inlineObjectTypes,
      "items[]",
      declaration.name.text,
      sourceFile,
      sourcePath,
      startLine,
      modelNames,
      fields,
      descendantRequired,
    );
  }
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
  const inlineObjectTypes = typeLiterals(typeCandidates);
  const inlineArrayObjectTypes = typeCandidates
    .map(arrayElementTypeNode)
    .flatMap((candidate) => candidate ? nonNullableTypeNodes(candidate) : [])
    .filter((candidate): candidate is ts.TypeLiteralNode => ts.isTypeLiteralNode(candidate));
  const objectLike = Boolean(ref) ||
    inlineObjectTypes.length > 0 ||
    inlineArrayObjectTypes.length > 0 ||
    typeCandidates.some(isRecordLikeType);
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
    if (inlineObjectTypes.length > 0) {
      addTypeLiteralVariantFields(
        inlineObjectTypes,
        path,
        modelId,
        sourceFile,
        sourcePath,
        startLine,
        modelNames,
        fields,
        inlineObjectDescendantRequired,
      );
    }
    if (inlineArrayObjectTypes.length > 0) {
      addTypeLiteralVariantFields(
        inlineArrayObjectTypes,
        `${path}[]`,
        modelId,
        sourceFile,
        sourcePath,
        startLine,
        modelNames,
        fields,
        inlineArrayDescendantRequired,
      );
    }
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
    for (const nested of memberGroups[0] ?? []) {
      if (ts.isPropertySignature(nested)) {
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
      const inlineObjectTypes = occurrences.flatMap((candidate) => propertyInlineObjectTypes(candidate));
      if (inlineObjectTypes.length > 0) {
        const inlineObjectDescendantRequired = descendantRequired &&
          occurrences.every((candidate) => candidate.type ? hasOnlyInlineObjectBranches(nonNullableTypeNodes(candidate.type)) : true);
        addTypeLiteralVariantFields(
          inlineObjectTypes,
          path,
          modelId,
          sourceFile,
          sourcePath,
          startLine,
          modelNames,
          fields,
          inlineObjectDescendantRequired,
        );
      }
      const inlineArrayObjectTypes = occurrences.flatMap((candidate) => propertyInlineArrayObjectTypes(candidate));
      if (inlineArrayObjectTypes.length > 0) {
        const inlineArrayDescendantRequired = descendantRequired &&
          occurrences.every((candidate) => candidate.type ? hasOnlyInlineArrayObjectBranches(nonNullableTypeNodes(candidate.type)) : true);
        addTypeLiteralVariantFields(
          inlineArrayObjectTypes,
          `${path}[]`,
          modelId,
          sourceFile,
          sourcePath,
          startLine,
          modelNames,
          fields,
          inlineArrayDescendantRequired,
        );
      }
    }
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
  const inlineObjectTypes = occurrences.flatMap((candidate) => propertyInlineObjectTypes(candidate));
  const inlineArrayObjectTypes = occurrences.flatMap((candidate) => propertyInlineArrayObjectTypes(candidate));
  const fieldRequired = options.required && options.ancestorRequired;
  const fieldNullable = occurrences.some((candidate) => candidate.type ? typeAllowsNullish(candidate.type) : false);
  const objectLike = Boolean(ref) ||
    inlineObjectTypes.length > 0 ||
    inlineArrayObjectTypes.length > 0 ||
    typeNodes.some(isRecordLikeType);
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

function addTypeLiteralVariantFields(
  typeNodes: ts.TypeLiteralNode[],
  parentPath: string,
  modelId: string,
  sourceFile: ts.SourceFile,
  sourcePath: string,
  startLine: number,
  modelNames: Set<string>,
  fields: FieldNode[],
  ancestorRequired: boolean,
): void {
  addMemberGroupsFields(
    typeNodes.map((typeNode) => typeNode.members),
    parentPath,
    modelId,
    sourceFile,
    sourcePath,
    startLine,
    modelNames,
    fields,
    ancestorRequired,
    false,
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

function propertyInlineObjectTypes(member: ts.PropertySignature): ts.TypeLiteralNode[] {
  return member.type ? typeLiterals(nonNullableTypeNodes(member.type)) : [];
}

function propertyInlineArrayObjectTypes(member: ts.PropertySignature): ts.TypeLiteralNode[] {
  if (!member.type) {
    return [];
  }
  return nonNullableTypeNodes(member.type)
    .map(arrayElementTypeNode)
    .flatMap((candidate) => candidate ? typeLiterals(nonNullableTypeNodes(candidate)) : []);
}

function typeLiterals(typeNodes: ts.TypeNode[]): ts.TypeLiteralNode[] {
  return typeNodes.filter((candidate): candidate is ts.TypeLiteralNode => ts.isTypeLiteralNode(candidate));
}

function hasOnlyInlineObjectBranches(typeNodes: ts.TypeNode[]): boolean {
  return typeNodes.length > 0 && typeNodes.every((candidate) => ts.isTypeLiteralNode(candidate));
}

function hasOnlyInlineArrayObjectBranches(typeNodes: ts.TypeNode[]): boolean {
  return typeNodes.length > 0 &&
    typeNodes.every((candidate) => {
      const element = arrayElementTypeNode(candidate);
      return Boolean(element && typeBranches(element).every((branch) => ts.isTypeLiteralNode(branch)));
    });
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
  objectDeclarations: Map<string, Declaration> | undefined,
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
    return memberGroupsForDeclaration(referenced, objectDeclarations, new Set([...seenTypes, refName]));
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
  if (!ts.isTypeReferenceNode(unwrapped) || !unwrapped.typeArguments || unwrapped.typeArguments.length !== 1) {
    return [];
  }
  const typeName = unwrapped.typeName.getText();
  if (typeName !== "Array" && typeName !== "ReadonlyArray") {
    return [];
  }
  return [unwrapParenthesizedType(unwrapped.typeArguments[0] as ts.TypeNode)];
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
    const arrayElement = arrayElementTypeNode(candidate);
    if (arrayElement) {
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
