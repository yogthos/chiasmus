// Portions adapted from pi-code-graph (MIT) https://github.com/picassio/pi-code-graph
//
// Project-wide qualified-name resolution for TS/JS call graphs.
// Combines per-file class field maps into a project registry, then walks
// each pending call's receiver chain to compute a `Class.method` QN.

import type {
  CallsFact,
  CodeGraph,
  FileTypeInfo,
  PendingCall,
} from "./types.js";
import type { ClassFieldRegistry } from "./type-env.js";

/**
 * JS/DOM built-in types whose prototype methods we do NOT model. Resolving
 * a chain to one of these would mis-attribute things like `m.has()` (on a
 * Map) to `Map.has` in the graph — not a user-defined method. Keep small
 * and focused: collision-heavy prototypes from the ECMAScript standard +
 * the most common Node/DOM globals.
 */
const JS_BUILTIN_TYPES = new Set<string>([
  // Lowercase primitives + TS-only widening types — annotations like
  // `: any` would otherwise attribute every call on `any` to `any.method`.
  "any", "unknown", "never", "void", "object",
  "string", "number", "boolean", "bigint", "symbol", "undefined", "null",
  // ECMAScript built-ins (prototype methods not modeled).
  "Array", "Map", "Set", "WeakMap", "WeakSet",
  "Promise", "Error", "TypeError", "RangeError", "SyntaxError",
  "Date", "RegExp", "Function", "Object", "String", "Number", "Boolean",
  "Symbol", "BigInt",
  "Int8Array", "Uint8Array", "Uint8ClampedArray",
  "Int16Array", "Uint16Array", "Int32Array", "Uint32Array",
  "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array",
  "ArrayBuffer", "SharedArrayBuffer", "DataView",
  "Buffer", "URL", "URLSearchParams",
  "JSON", "Math", "Reflect", "Proxy", "Intl",
  "console", "process",
  // TS library-only shapes.
  "ReadonlySet", "ReadonlyMap", "ReadonlyArray", "Iterable", "IterableIterator",
  "AsyncIterable", "AsyncIterableIterator",
]);

/**
 * Method registry with enough detail for both verification and declaring-
 * class lookup. `flat` maps each class to its full (own + inherited)
 * method set; `own` keeps only direct declarations; `parents` captures
 * extends edges so callers can walk the chain to find where a method was
 * actually defined.
 */
export interface ClassMethodRegistry {
  flat: Map<string, Set<string>>;
  own: Map<string, Set<string>>;
  parents: Map<string, string>;
}

/**
 * Build a project-wide class field registry from per-file type info.
 * Propagates fields from a base class down through `extends` chains so
 * `class Child extends Base` inherits Base's fields. Child-declared
 * fields shadow parent fields. Cycles are detected and broken.
 */
export function buildClassFieldRegistry(
  perFile: FileTypeInfo[],
): ClassFieldRegistry {
  const ownFields = new Map<string, Map<string, string>>();
  const parents = new Map<string, string>();

  for (const info of perFile) {
    for (const { className, fields } of info.classFields) {
      let existing = ownFields.get(className);
      if (!existing) {
        existing = new Map();
        ownFields.set(className, existing);
      }
      // Last write wins on same-name classes — ambiguous anyway.
      for (const [name, type] of Object.entries(fields)) {
        existing.set(name, type);
      }
    }
    for (const ext of info.classExtends ?? []) {
      // If two files declare the same class with different parents,
      // last write wins. Unlikely in practice.
      parents.set(ext.className, ext.parent);
    }
  }

  // Resolve extends chains with memoization + in-progress guard for cycle
  // safety. Parent fields merge into children; own fields shadow.
  const resolved = new Map<string, Map<string, string>>();
  const inProgress = new Set<string>();

  function resolve(className: string): Map<string, string> {
    const cached = resolved.get(className);
    if (cached) return cached;
    if (inProgress.has(className)) {
      // Cycle — return own fields only to break the loop.
      return ownFields.get(className) ?? new Map();
    }
    inProgress.add(className);

    const merged = new Map<string, string>();
    const parent = parents.get(className);
    if (parent) {
      const parentFields = resolve(parent);
      for (const [k, v] of parentFields) merged.set(k, v);
    }
    const own = ownFields.get(className);
    if (own) {
      for (const [k, v] of own) merged.set(k, v);
    }

    inProgress.delete(className);
    resolved.set(className, merged);
    return merged;
  }

  // Resolve every class that has at least one field or appears as a parent.
  const classNames = new Set<string>([
    ...ownFields.keys(),
    ...parents.keys(),
    ...parents.values(),
  ]);
  for (const cn of classNames) resolve(cn);

  return resolved;
}

/**
 * Build a project-wide class method registry. Parent methods flow down
 * into the child's flat set so `Child.method` verifies when `method` is
 * only defined on `Parent`. Cycle-safe. Returns own, flat, and parent
 * maps so callers can find the declaring class for a given method.
 */
export function buildClassMethodRegistry(
  perFile: FileTypeInfo[],
  extraContainsMethods?: Iterable<{ parent: string; child: string }>,
): ClassMethodRegistry {
  const own = new Map<string, Set<string>>();
  const parents = new Map<string, string>();

  for (const info of perFile) {
    for (const { className, methods } of info.classMethods ?? []) {
      let existing = own.get(className);
      if (!existing) {
        existing = new Set();
        own.set(className, existing);
      }
      for (const m of methods) existing.add(m);
    }
    for (const ext of info.classExtends ?? []) {
      parents.set(ext.className, ext.parent);
    }
  }
  if (extraContainsMethods) {
    for (const c of extraContainsMethods) {
      let existing = own.get(c.parent);
      if (!existing) {
        existing = new Set();
        own.set(c.parent, existing);
      }
      existing.add(c.child);
    }
  }

  const flat = new Map<string, Set<string>>();
  const inProgress = new Set<string>();
  function resolve(className: string): Set<string> {
    const cached = flat.get(className);
    if (cached) return cached;
    if (inProgress.has(className)) {
      return own.get(className) ?? new Set();
    }
    inProgress.add(className);

    const merged = new Set<string>();
    const parent = parents.get(className);
    if (parent) {
      for (const m of resolve(parent)) merged.add(m);
    }
    const ownSet = own.get(className);
    if (ownSet) for (const m of ownSet) merged.add(m);

    inProgress.delete(className);
    flat.set(className, merged);
    return merged;
  }

  const classNames = new Set<string>([
    ...own.keys(),
    ...parents.keys(),
    ...parents.values(),
  ]);
  for (const cn of classNames) resolve(cn);
  return { flat, own, parents };
}

/**
 * Resolve `pending.receiverChain` → final type name via the registry,
 * starting from either `this` (→ enclosingClass) or a known local/file
 * var type. Returns undefined when any step is unknown.
 */
function resolveChain(
  pending: PendingCall,
  registry: ClassFieldRegistry,
): string | undefined {
  const { receiverChain, enclosingClass, varTypes } = pending;
  if (receiverChain.length === 0) return undefined;

  let currentType: string | undefined;
  const head = receiverChain[0];
  if (head === "this" || head === "self") {
    currentType = enclosingClass ?? undefined;
  } else {
    currentType = varTypes[head];
  }
  if (!currentType) return undefined;

  for (let i = 1; i < receiverChain.length; i++) {
    const fieldName = receiverChain[i];
    const fields = registry.get(currentType);
    if (!fields) return undefined;
    const next = fields.get(fieldName);
    if (!next) return undefined;
    currentType = next;
  }
  return currentType;
}

/**
 * Build an index of method name → [class names defining a method by that name].
 * Used for the unique-method fallback: a method that only exists on one
 * class can be attributed to that class even when the receiver chain
 * failed to resolve.
 */
function buildMethodOwnerIndex(graph: CodeGraph): Map<string, Set<string>> {
  const byMethod = new Map<string, Set<string>>();
  // Gather method → parent class pairs from `contains` where the child is
  // a method-kind define. `contains(parent, child)` is parent=class, child=method.
  const methodNames = new Set<string>();
  for (const d of graph.defines) {
    if (d.kind === "method") methodNames.add(d.name);
  }
  for (const c of graph.contains) {
    if (!methodNames.has(c.child)) continue;
    let set = byMethod.get(c.child);
    if (!set) {
      set = new Set();
      byMethod.set(c.child, set);
    }
    set.add(c.parent);
  }
  return byMethod;
}

/**
 * For each pending call, compute `calleeQN = "{finalType}.{method}"` when
 * the receiver chain resolves. Mutates matching CallsFact rows on `graph`.
 * Matching pairs (caller, callee) on the first unset row.
 *
 * Falls back to a unique-method heuristic: when the receiver chain can't
 * resolve, if exactly one class in the graph defines a method with that
 * name, attribute the call to that class. Ambiguous names (2+ owners) stay
 * unresolved — guessing there would be worse than no QN.
 */
export function resolveCallsWithRegistry(
  graph: CodeGraph,
  registry: ClassFieldRegistry,
  methodRegistry?: ClassMethodRegistry,
): void {
  if (!graph._typeInfo || graph._typeInfo.length === 0) return;

  const callIndex = new Map<string, CallsFact[]>();
  for (const c of graph.calls) {
    const key = `${c.caller}\0${c.callee}`;
    const arr = callIndex.get(key) ?? [];
    arr.push(c);
    callIndex.set(key, arr);
  }

  const methodOwners = buildMethodOwnerIndex(graph);
  const methods = methodRegistry
    ?? buildClassMethodRegistry(
      graph._typeInfo,
      methodContainsFacts(graph),
    );

  /**
   * Walk the extends chain from `startType` upward to find the first
   * class/interface whose own (non-inherited) methods include `method`.
   * Returns the declaring class name, or undefined when no ancestor
   * declares it. Cycle-safe.
   */
  function findDeclaringClass(startType: string, method: string): string | undefined {
    const seen = new Set<string>();
    let cur: string | undefined = startType;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      if (methods.own.get(cur)?.has(method)) return cur;
      cur = methods.parents.get(cur);
    }
    return undefined;
  }

  for (const info of graph._typeInfo) {
    for (const pending of info.pendingCalls) {
      let finalType = resolveChain(pending, registry);
      if (finalType && JS_BUILTIN_TYPES.has(finalType)) {
        finalType = undefined;
      }
      let qn: string | undefined;
      if (finalType) {
        // Trust chain only when the method actually exists on finalType
        // (own or inherited) — emit the declaring class's QN.
        const known = methods.flat.get(finalType);
        if (known && known.has(pending.callee)) {
          const declarer = findDeclaringClass(finalType, pending.callee)
            ?? finalType;
          qn = `${declarer}.${pending.callee}`;
        }
      }
      if (!qn) {
        // Unique-method fallback: exactly one class owns this method name
        // across the whole project (via contains facts).
        const owners = methodOwners.get(pending.callee);
        if (owners && owners.size === 1) {
          qn = `${owners.values().next().value as string}.${pending.callee}`;
        }
      }
      if (!qn) {
        // Registry fallback: unique owner in the method registry (for
        // interface-typed receivers whose methods come from classes that
        // don't appear in graph.contains).
        const typedOwner = findOwnerViaMethods(pending.callee, methods.flat);
        if (typedOwner) qn = `${typedOwner}.${pending.callee}`;
      }
      if (!qn) continue;
      const key = `${pending.caller}\0${pending.callee}`;
      const candidates = callIndex.get(key);
      if (!candidates) continue;
      const target = candidates.find((c) => !c.calleeQN);
      if (target) target.calleeQN = qn;
    }
  }
}

/**
 * Extract `{parent, child}` pairs where child is a method-kind define,
 * so we can seed the method registry with class bodies that were tracked
 * in the native extractor via `contains` facts (and not in
 * FileTypeInfo.classMethods, which came in later).
 */
function methodContainsFacts(graph: CodeGraph): Array<{ parent: string; child: string }> {
  const out: Array<{ parent: string; child: string }> = [];
  const methodNames = new Set<string>();
  for (const d of graph.defines) {
    if (d.kind === "method") methodNames.add(d.name);
  }
  for (const c of graph.contains) {
    if (methodNames.has(c.child)) out.push({ parent: c.parent, child: c.child });
  }
  return out;
}

/**
 * Of every class that has `method` (directly or via extends), return a
 * unique owner if exactly one exists. Returns undefined for ambiguous
 * or absent methods.
 */
function findOwnerViaMethods(
  method: string,
  flat: Map<string, Set<string>>,
): string | undefined {
  let sole: string | undefined;
  for (const [className, set] of flat) {
    if (!set.has(method)) continue;
    if (sole !== undefined) return undefined;
    sole = className;
  }
  return sole;
}
