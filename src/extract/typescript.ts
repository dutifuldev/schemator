import ts from "typescript";
import type { FieldNode, ModelKind, ModelNode, SourceSpan } from "../types.js";

type Declaration =
  | ts.InterfaceDeclaration
  | ts.TypeAliasDeclaration;

export function extractTypeScriptModels(
  code: string,
  sourcePath: string,
  startLine: number,
): ModelNode[] {
  const sourceFile = ts.createSourceFile(sourcePath, code, ts.ScriptTarget.Latest, true);
  const declarations = collectDeclarations(sourceFile);
  const objectModelNames = new Set(
    declarations
      .filter((declaration) => declarationHasMembers(declaration))
      .map((declaration) => declaration.name.text),
  );
  return declarations.map((declaration) =>
    declarationToModel(declaration, sourceFile, sourcePath, startLine, objectModelNames)
  );
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

function declarationToModel(
  declaration: Declaration,
  sourceFile: ts.SourceFile,
  sourcePath: string,
  startLine: number,
  modelNames: Set<string>,
): ModelNode {
  const id = declaration.name.text;
  const fields: FieldNode[] = [];
  const members = membersForDeclaration(declaration);
  if (members) {
    for (const member of members) {
      if (ts.isPropertySignature(member)) {
        addPropertyField(member, "", id, sourceFile, sourcePath, startLine, modelNames, fields);
      }
    }
  }
  return {
    id,
    kind: modelKind(declaration),
    source: spanForNode(declaration, sourceFile, sourcePath, startLine),
    fields,
  };
}

function membersForDeclaration(declaration: Declaration): ts.NodeArray<ts.TypeElement> | null {
  if (ts.isInterfaceDeclaration(declaration)) {
    return declaration.members;
  }
  if (ts.isTypeLiteralNode(declaration.type)) {
    return declaration.type.members;
  }
  return null;
}

function declarationHasMembers(declaration: Declaration): boolean {
  return membersForDeclaration(declaration) !== null;
}

function modelKind(declaration: Declaration): ModelKind {
  if (ts.isInterfaceDeclaration(declaration)) {
    return "object";
  }
  if (ts.isTypeLiteralNode(declaration.type)) {
    return "object";
  }
  if (ts.isUnionTypeNode(declaration.type)) {
    return "enum";
  }
  if (ts.isArrayTypeNode(declaration.type)) {
    return "array";
  }
  return "scalar";
}

function addPropertyField(
  member: ts.PropertySignature,
  parentPath: string,
  modelId: string,
  sourceFile: ts.SourceFile,
  sourcePath: string,
  startLine: number,
  modelNames: Set<string>,
  fields: FieldNode[],
): void {
  const name = propertyNameText(member.name);
  if (!name) {
    return;
  }
  const path = parentPath ? `${parentPath}.${name}` : name;
  const typeNode = member.type;
  const type = typeNode?.getText(sourceFile) ?? "unknown";
  const ref = referencedModel(type, modelNames);
  const typeCandidates = typeNode ? nonNullableTypeNodes(typeNode) : [];
  const inlineObjectType = typeCandidates.find((candidate) => ts.isTypeLiteralNode(candidate)) as
    | ts.TypeLiteralNode
    | undefined;
  const inlineArrayObjectType = typeCandidates
    .map(arrayElementTypeNode)
    .find((candidate): candidate is ts.TypeLiteralNode => Boolean(candidate && ts.isTypeLiteralNode(candidate)));
  const objectLike = Boolean(ref) || Boolean(inlineObjectType) || Boolean(inlineArrayObjectType);
  fields.push({
    path,
    name,
    type,
    required: !member.questionToken,
    nullable: type.includes("null"),
    parent: modelId,
    objectLike,
    source: spanForNode(member, sourceFile, sourcePath, startLine),
    ...(ref ? { ref } : {}),
  });

  const nestedType = inlineArrayObjectType ?? inlineObjectType;
  if (nestedType) {
    const nestedParentPath = inlineArrayObjectType ? `${path}[]` : path;
    for (const nested of nestedType.members) {
      if (ts.isPropertySignature(nested)) {
        addPropertyField(nested, nestedParentPath, modelId, sourceFile, sourcePath, startLine, modelNames, fields);
      }
    }
  }
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
  if (ts.isArrayTypeNode(typeNode)) {
    return unwrapParenthesizedType(typeNode.elementType);
  }
  if (!ts.isTypeReferenceNode(typeNode) || !typeNode.typeArguments || typeNode.typeArguments.length !== 1) {
    return null;
  }
  const typeName = typeNode.typeName.getText();
  if (typeName !== "Array" && typeName !== "ReadonlyArray") {
    return null;
  }
  return unwrapParenthesizedType(typeNode.typeArguments[0] as ts.TypeNode);
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
    if (modelNames.has(candidate)) {
      return candidate;
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
