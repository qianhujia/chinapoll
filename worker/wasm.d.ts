// A WebAssembly module imported into the Worker bundle.
//
// wrangler compiles a `.wasm` import at deploy time and hands the script a ready
// `WebAssembly.Module`. That is the only way to run WebAssembly here: workerd refuses to
// compile bytes at runtime ("Wasm code generation disallowed by embedder"), so a module
// cannot be fetched as an asset and instantiated later (see worker/services/ogImage.ts).
declare module '*.wasm' {
  const module: WebAssembly.Module;
  export default module;
}
