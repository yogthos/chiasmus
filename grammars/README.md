# Vendored tree-sitter grammars

Prebuilt WASM grammars for languages whose upstream npm packages either ship
no WASM build or can't be loaded through tree-sitter's native Node bindings.

| File | Upstream | Version | License |
| --- | --- | --- | --- |
| `tree-sitter-scheme.wasm` | [6cdh/tree-sitter-scheme](https://github.com/6cdh/tree-sitter-scheme) (`@6cdh/tree-sitter-scheme`) | 0.24.7-1 | MIT — `LICENSE-tree-sitter-scheme` |
| `tree-sitter-commonlisp.wasm` | [theHamsta/tree-sitter-commonlisp](https://github.com/theHamsta/tree-sitter-commonlisp) (`tree-sitter-commonlisp`) | 0.4.1 | MIT — `LICENSE-tree-sitter-commonlisp` |

Scheme has to be WASM: its grammar declares a node type named `syntax`, and
tree-sitter's Node bindings generate `class SyntaxNode extends SyntaxNode` for
it, which throws `ReferenceError: Cannot access 'SyntaxNode' before
initialization` on `setLanguage`. Reproduced on tree-sitter 0.22.4 and 0.25.1.
Common Lisp loads natively, but is vendored as WASM too so neither language
drags a node-gyp build into `npm install`.

Racket reuses the Scheme grammar (`.rkt` → language `racket`); `#lang` lines
parse as an ERROR node that tree-sitter recovers from, and everything after it
extracts normally.

## Rebuilding

Needs `tree-sitter-cli` and either Docker or Emscripten on PATH.

```sh
npm pack @6cdh/tree-sitter-scheme@0.24.7-1
tar xzf 6cdh-tree-sitter-scheme-0.24.7-1.tgz
tree-sitter build --wasm -o grammars/tree-sitter-scheme.wasm package

npm pack tree-sitter-commonlisp@0.4.1
tar xzf tree-sitter-commonlisp-0.4.1.tgz
tree-sitter build --wasm -o grammars/tree-sitter-commonlisp.wasm package
```
