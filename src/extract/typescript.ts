import ts from "typescript";
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
  return new Set(
    declarations
      .filter((declaration) => declarationHasMembers(declaration) || declarationIsArrayAlias(declaration))
      .map((declaration) => declaration.name.text),
  );
}

function collectObjectDeclarations(declarations: Declaration[]): Map<string, Declaration> {
  const objects = new Map<string, Declaration>();
  for (const declaration of declarations) {
    if (declarationHasMembers(declaration)) {
      objects.set(declaration.name.text, declaration);
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
  const memberGroups = memberGroupsForDeclaration(declaration);
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
    addMemberGroupsFields(memberGroups, "", id, sourceFile, sourcePath, startLine, modelNames, fields, true);
  } else if (ts.isTypeAliasDeclaration(declaration)) {
    addArrayAliasFields(declaration, sourceFile, sourcePath, startLine, modelNames, fields);
  }
  return {
    id,
    kind: modelKind(declaration),
    source: spanForNode(declaration, sourceFile, sourcePath, startLine),
    fields,
  };
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
      memberGroupsForDeclaration(base),
      "",
      modelId,
      sourceFile,
      sourcePath,
      startLine,
      modelNames,
      fields,
      true,
    );
  }
}

function extendedInterfaceNames(declaration: ts.InterfaceDeclaration, sourceFile: ts.SourceFile): string[] {
  return (declaration.heritageClauses ?? [])
    .filter((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)
    .flatMap((clause) => clause.types.map((heritageType) => heritageType.expression.getText(sourceFile)));
}

function memberGroupsForDeclaration(declaration: Declaration): ts.NodeArray<ts.TypeElement>[] {
  if (ts.isInterfaceDeclaration(declaration)) {
    return [declaration.members];
  }
  if (ts.isTypeLiteralNode(declaration.type)) {
    return [declaration.type.members];
  }
  if (ts.isUnionTypeNode(unwrapParenthesizedType(declaration.type))) {
    return typeLiterals(nonNullableTypeNodes(declaration.type)).map((typeLiteral) => typeLiteral.members);
  }
  return [];
}

function declarationHasMembers(declaration: Declaration): boolean {
  return memberGroupsForDeclaration(declaration).length > 0;
}

function declarationIsArrayAlias(declaration: Declaration): boolean {
  return ts.isTypeAliasDeclaration(declaration) && Boolean(arrayElementTypeNode(declaration.type));
}

function modelKind(declaration: Declaration): ModelKind {
  if (ts.isInterfaceDeclaration(declaration)) {
    return "object";
  }
  if (ts.isTypeLiteralNode(declaration.type)) {
    return "object";
  }
  if (declarationHasMembers(declaration)) {
    return "object";
  }
  if (ts.isUnionTypeNode(declaration.type)) {
    return "enum";
  }
  if (ts.isArrayTypeNode(declaration.type)) {
    return "array";
  }
  if (arrayElementTypeNode(declaration.type)) {
    return "array";
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
  const elementType = arrayElementTypeNode(declaration.type);
  if (!elementType) {
    return;
  }
  const elementCandidates = nonNullableTypeNodes(elementType);
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
    addTypeLiteralVariantFields(
      inlineObjectTypes,
      "items[]",
      declaration.name.text,
      sourceFile,
      sourcePath,
      startLine,
      modelNames,
      fields,
      !fieldNullable,
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
  const path = parentPath ? `${parentPath}.${name}` : name;
  const typeNode = member.type;
  const type = typeNode?.getText(sourceFile) ?? "unknown";
  const typeCandidates = typeNode ? nonNullableTypeNodes(typeNode) : [];
  const ref = referencedModelFromTypeCandidates(typeCandidates, sourceFile, modelNames) ?? referencedModel(type, modelNames);
  const inlineObjectTypes = typeLiterals(typeCandidates);
  const inlineArrayObjectTypes = typeCandidates
    .map(arrayElementTypeNode)
    .flatMap((candidate) => candidate ? nonNullableTypeNodes(candidate) : [])
    .filter((candidate): candidate is ts.TypeLiteralNode => ts.isTypeLiteralNode(candidate));
  const objectLike = Boolean(ref) || inlineObjectTypes.length > 0 || inlineArrayObjectTypes.length > 0;
  const fieldRequired = (options.required ?? !member.questionToken) && (options.ancestorRequired ?? true);
  const fieldNullable = typeNode ? typeAllowsNullish(typeNode) : false;
  const descendantRequired = fieldRequired && !fieldNullable;
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
        descendantRequired,
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
        descendantRequired,
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
): void {
  const name = propertyNameText(member.name);
  if (!name) {
    return;
  }
  const path = parentPath ? `${parentPath}.${name}` : name;
  if (fields.some((field) => field.path === path)) {
    return;
  }
  addPropertyField(member, parentPath, modelId, sourceFile, sourcePath, startLine, modelNames, fields, {
    ancestorRequired,
  });
}

function addMemberGroupsFields(
  memberGroups: ts.NodeArray<ts.TypeElement>[],
  parentPath: string,
  modelId: string,
  sourceFile: ts.SourceFile,
  sourcePath: string,
  startLine: number,
  modelNames: Set<string>,
  fields: FieldNode[],
  ancestorRequired: boolean,
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
      addPropertyField(member, parentPath, modelId, sourceFile, sourcePath, startLine, modelNames, fields, {
        addNested: false,
        ancestorRequired,
        required,
      });
      const path = parentPath ? `${parentPath}.${name}` : name;
      const allOccurrencesNonNullable = occurrences.every((candidate) =>
        candidate.type ? !typeAllowsNullish(candidate.type) : true
      );
      const descendantRequired = required && ancestorRequired && allOccurrencesNonNullable;
      const inlineObjectTypes = occurrences.flatMap((candidate) => propertyInlineObjectTypes(candidate));
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
          descendantRequired,
        );
      }
      const inlineArrayObjectTypes = occurrences.flatMap((candidate) => propertyInlineArrayObjectTypes(candidate));
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
          descendantRequired,
        );
      }
    }
  }
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
  );
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
  const unwrapped = unwrapParenthesizedType(typeNode);
  if (ts.isTypeOperatorNode(unwrapped) && unwrapped.operator === ts.SyntaxKind.ReadonlyKeyword) {
    return arrayElementTypeNode(unwrapped.type);
  }
  if (ts.isArrayTypeNode(unwrapped)) {
    return unwrapParenthesizedType(unwrapped.elementType);
  }
  if (!ts.isTypeReferenceNode(unwrapped) || !unwrapped.typeArguments || unwrapped.typeArguments.length !== 1) {
    return null;
  }
  const typeName = unwrapped.typeName.getText();
  if (typeName !== "Array" && typeName !== "ReadonlyArray") {
    return null;
  }
  return unwrapParenthesizedType(unwrapped.typeArguments[0] as ts.TypeNode);
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
    const genericArrayMatch = /^(?:Array|ReadonlyArray)\s*<\s*([A-Z][A-Za-z0-9_]*)\s*>$/.exec(candidate);
    if (genericArrayMatch?.[1] && modelNames.has(genericArrayMatch[1])) {
      return genericArrayMatch[1];
    }
    if (modelNames.has(candidate)) {
      return candidate;
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
