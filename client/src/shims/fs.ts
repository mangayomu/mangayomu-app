/**
 * protobufjs probes `fs` before falling back to XMLHttpRequest in browsers.
 * An empty implementation makes that probe fail without loading Vite's Node
 * compatibility proxy.
 */
export default {};
