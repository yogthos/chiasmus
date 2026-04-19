// Portions adapted from pi-code-graph (MIT) https://github.com/picassio/pi-code-graph
//
// Per-file type environment for TypeScript/JavaScript.
// Three tiers of inference (run in order per file):
//   Tier 0: Explicit annotations       const x: User = ...
//   Tier 1: Constructor inference      const x = new User()
//   Tier 2: Assignment chain           const y = x (x already typed)
//
// Plus class-field type tracking so `this.field` and multi-step chains
// like `this.a.b.c` resolve through a registry keyed by class name.

export type TypeEnv = Map<string, Map<string, string>>;

const FILE_SCOPE = "";

/** Per-class field info: fieldName → typeName */
export type ClassFieldTypes = Map<string, string>;

/** Project-wide: className (short) → fieldTypes */
export type ClassFieldRegistry = Map<string, ClassFieldTypes>;

export interface TypeEnvironment {
  /** Look up a variable's type. Handles self/this via enclosing class walk. */
  lookup(varName: string, callNode: any): string | undefined;

  /** Resolve a dotted chain `['this', 'a', 'b']` → final type name. */
  resolveChain(chain: string[], callNode: any): string | undefined;

  /** Read-only view of all bindings. Useful for tests and diagnostics. */
  allBindings(): ReadonlyMap<string, ReadonlyMap<string, string>>;
}

const CLASS_NODE_TYPES = new Set([
  "class_declaration",
  "class",
  "abstract_class_declaration",
  "interface_declaration",
]);

const FUNCTION_NODE_TYPES = new Set([
  "function_declaration",
  "generator_function_declaration",
  "function_expression",
  "arrow_function",
  "method_definition",
  "function_signature",
]);

function findEnclosingClassName(node: any): string | undefined {
  let current: any = node.parent;
  while (current) {
    if (CLASS_NODE_TYPES.has(current.type)) {
      const nameNode = current.childForFieldName?.("name");
      if (nameNode) return nameNode.text;
    }
    current = current.parent;
  }
  return undefined;
}

function findEnclosingScopeKey(node: any): string {
  let current: any = node.parent;
  while (current) {
    if (FUNCTION_NODE_TYPES.has(current.type)) {
      const nameNode = current.childForFieldName?.("name");
      if (nameNode) return nameNode.text;
      return `__anon_${current.startPosition.row}_${current.startPosition.column}`;
    }
    current = current.parent;
  }
  return FILE_SCOPE;
}

export function stripNullable(typeText: string): string {
  let t = typeText.trim();
  t = t.replace(/^\|+|\|+$/g, "").trim();
  if (t.includes("|")) {
    const parts = t
      .split("|")
      .map((p) => p.trim())
      .filter((p) => p !== "null" && p !== "undefined" && p !== "void");
    if (parts.length > 0) t = parts[0];
  }
  t = t.replace(/\?$/, "").trim();
  return t;
}

export function extractSimpleTypeName(typeNode: any | null): string | undefined {
  if (!typeNode) return undefined;
  const text: string | undefined = typeNode.text;
  if (!text) return undefined;

  let stripped = stripNullable(text);
  // Reject collection-shaped types outright: a variable of type `T[]`,
  // `Array<T>`, `Promise<T>`, etc. is a wrapper, not a T — attributing
  // `arr.push()` to `T.push` would mis-link to the element class.
  if (stripped.endsWith("[]")) return undefined;
  if (/^(?:Array|Promise|Map|Set|Record)<.+>$/.test(stripped)) return undefined;
  // Identity-like wrappers (Readonly<T>, Partial<T>) unwrap to T.
  const idMatch = stripped.match(/^(?:Readonly|Partial)<(.+)>$/);
  if (idMatch) {
    stripped = stripNullable(idMatch[1]);
  }
  // Drop any remaining generic args: Foo<X> → Foo.
  stripped = stripped.replace(/<.*$/, "").trim();

  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(stripped)) return stripped;
  return undefined;
}

function extractVarAnnotation(declaratorNode: any): string | undefined {
  const typeAnnNode = declaratorNode.childForFieldName?.("type");
  if (typeAnnNode) {
    const innerType =
      typeAnnNode.childForFieldName?.("type") ?? typeAnnNode.namedChild?.(0);
    if (innerType) return extractSimpleTypeName(innerType);
  }
  for (let i = 0; i < declaratorNode.childCount; i++) {
    const child = declaratorNode.child(i);
    if (child && child.type === "type_annotation") {
      const inner = child.namedChild(0);
      if (inner) return extractSimpleTypeName(inner);
    }
  }
  return undefined;
}

function extractNewExpressionType(valueNode: any): string | undefined {
  if (valueNode.type !== "new_expression") return undefined;
  const constructorNode = valueNode.childForFieldName?.("constructor");
  if (constructorNode) return extractSimpleTypeName(constructorNode);
  const firstChild = valueNode.namedChild?.(0);
  if (firstChild) return extractSimpleTypeName(firstChild);
  return undefined;
}

function extractVarName(declaratorNode: any): string | undefined {
  const nameNode = declaratorNode.childForFieldName?.("name");
  if (nameNode && nameNode.type === "identifier") return nameNode.text;
  return undefined;
}

/**
 * Extract field type declarations from a class (or interface) body.
 * Handles:
 *   class Foo { bar: Baz; svc = new Service(); }
 *   class Foo { constructor(private readonly x: X) {} }
 *   class Foo { get config(): Config { ... } }
 *   interface Foo { bar: Bar; }
 */
export function extractClassFields(classNode: any): ClassFieldTypes {
  const fields = new Map<string, string>();

  const bodyNode = classNode.childForFieldName?.("body");
  if (!bodyNode) return fields;

  for (let i = 0; i < bodyNode.childCount; i++) {
    const child = bodyNode.child(i);
    if (!child) continue;

    if (
      child.type === "public_field_definition" ||
      child.type === "field_definition"
    ) {
      const nameNode = child.childForFieldName?.("name");
      if (!nameNode) continue;
      const fieldName: string | undefined = nameNode.text;
      if (!fieldName) continue;

      let fieldType: string | undefined;

      const typeAnnNode = child.childForFieldName?.("type");
      if (typeAnnNode) {
        const inner = typeAnnNode.namedChild?.(0) ?? typeAnnNode;
        fieldType = extractSimpleTypeName(inner);
      }

      if (!fieldType) {
        for (let j = 0; j < child.childCount; j++) {
          const c = child.child(j);
          if (c && c.type === "type_annotation") {
            const inner = c.namedChild(0);
            if (inner) {
              fieldType = extractSimpleTypeName(inner);
              break;
            }
          }
        }
      }

      if (!fieldType) {
        const valueNode = child.childForFieldName?.("value");
        if (valueNode) fieldType = extractNewExpressionType(valueNode);
      }

      if (fieldType) fields.set(fieldName, fieldType);
    }

    if (child.type === "method_definition") {
      const methodName = child.childForFieldName?.("name");
      const methodNameText: string | undefined = methodName?.text;

      if (methodNameText === "constructor") {
        const params = child.childForFieldName?.("parameters");
        if (params) {
          for (let k = 0; k < params.childCount; k++) {
            const param = params.child(k);
            if (param && param.type === "required_parameter") {
              let hasModifier = false;
              for (let m = 0; m < param.childCount; m++) {
                const mc = param.child(m);
                if (
                  mc &&
                  (mc.type === "accessibility_modifier" ||
                    mc.text === "readonly")
                ) {
                  hasModifier = true;
                  break;
                }
              }
              if (hasModifier) {
                const pName =
                  param.childForFieldName?.("pattern") ?? param.namedChild?.(0);
                if (pName) {
                  const paramName = pName.text;
                  const paramType = extractVarAnnotation(param);
                  if (paramName && paramType) fields.set(paramName, paramType);
                }
              }
            }
          }
        }
      }

      if (methodNameText) {
        let isGetter = false;
        for (let g = 0; g < child.childCount; g++) {
          const gc = child.child(g);
          if (gc && gc.type === "get") {
            isGetter = true;
            break;
          }
        }
        if (isGetter) {
          const returnTypeNode = child.childForFieldName?.("return_type");
          if (returnTypeNode) {
            const inner = returnTypeNode.namedChild?.(0) ?? returnTypeNode;
            const returnType = extractSimpleTypeName(inner);
            if (returnType) fields.set(methodNameText, returnType);
          }
        }
      }
    }

    if (child.type === "property_signature") {
      const nameNode = child.childForFieldName?.("name");
      if (nameNode) {
        const fieldName: string = nameNode.text;
        for (let j = 0; j < child.childCount; j++) {
          const c = child.child(j);
          if (c && c.type === "type_annotation") {
            const inner = c.namedChild(0);
            if (inner) {
              const fieldType = extractSimpleTypeName(inner);
              if (fieldType) fields.set(fieldName, fieldType);
              break;
            }
          }
        }
      }
    }
  }

  return fields;
}

/**
 * Build a per-file type environment by walking the AST.
 * Fills bindings from annotations, constructor calls, and assignment chains.
 */
export function buildTypeEnv(
  rootNode: any,
  classFieldRegistry: ClassFieldRegistry,
): TypeEnvironment {
  const env: TypeEnv = new Map();

  function getScope(key: string): Map<string, string> {
    let scope = env.get(key);
    if (!scope) {
      scope = new Map();
      env.set(key, scope);
    }
    return scope;
  }

  function processDeclarator(declNode: any): void {
    const varName = extractVarName(declNode);
    if (!varName) return;

    const scopeKey = findEnclosingScopeKey(declNode);
    const scope = getScope(scopeKey);

    const annotatedType = extractVarAnnotation(declNode);
    if (annotatedType) {
      scope.set(varName, annotatedType);
      return;
    }

    const valueNode = declNode.childForFieldName?.("value");
    if (valueNode) {
      if (valueNode.type === "new_expression") {
        const typeName = extractNewExpressionType(valueNode);
        if (typeName) {
          scope.set(varName, typeName);
          return;
        }
      }
      if (valueNode.type === "identifier") {
        const sourceVar = valueNode.text;
        if (sourceVar) {
          const sourceType =
            scope.get(sourceVar) ?? env.get(FILE_SCOPE)?.get(sourceVar);
          if (sourceType) {
            scope.set(varName, sourceType);
            return;
          }
        }
      }
    }
  }

  function walk(node: any): void {
    if (
      node.type === "lexical_declaration" ||
      node.type === "variable_declaration"
    ) {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child && child.type === "variable_declarator") {
          processDeclarator(child);
        }
      }
    }
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) walk(child);
    }
  }

  walk(rootNode);

  const environment: TypeEnvironment = {
    lookup(varName, callNode) {
      if (varName === "this" || varName === "self") {
        return findEnclosingClassName(callNode);
      }
      const scopeKey = findEnclosingScopeKey(callNode);
      if (scopeKey !== FILE_SCOPE) {
        const scope = env.get(scopeKey);
        if (scope) {
          const t = scope.get(varName);
          if (t) return t;
        }
      }
      const fileScope = env.get(FILE_SCOPE);
      return fileScope?.get(varName);
    },

    resolveChain(chain, callNode) {
      if (chain.length === 0) return undefined;
      let currentType = this.lookup(chain[0], callNode);
      if (!currentType) return undefined;
      for (let i = 1; i < chain.length; i++) {
        const fieldName = chain[i];
        const fields = classFieldRegistry.get(currentType);
        if (!fields) return undefined;
        const nextType = fields.get(fieldName);
        if (!nextType) return undefined;
        currentType = nextType;
      }
      return currentType;
    },

    allBindings() {
      return env;
    },
  };

  return environment;
}
