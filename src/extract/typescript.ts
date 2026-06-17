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
  const objectLike = Boolean(ref) || Boolean(typeNode && ts.isTypeLiteralNode(typeNode));
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

  if (typeNode && ts.isTypeLiteralNode(typeNode)) {
    for (const nested of typeNode.members) {
      if (ts.isPropertySignature(nested)) {
        addPropertyField(nested, path, modelId, sourceFile, sourcePath, startLine, modelNames, fields);
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

function referencedModel(typeText: string, modelNames: Set<string>): string | null {
  const bare = /^readonly\s+/.test(typeText) ? typeText.replace(/^readonly\s+/, "") : typeText;
  const arrayMatch = /^([A-Z][A-Za-z0-9_]*)\[\]$/.exec(bare);
  if (arrayMatch?.[1] && modelNames.has(arrayMatch[1])) {
    return arrayMatch[1];
  }
  if (modelNames.has(bare)) {
    return bare;
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
