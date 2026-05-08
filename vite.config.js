// Vite config — vanilla, no framework. Shaders loaded via `?raw`.
// HMR works for shader files on save.
export default {
  server: { port: 5173, host: true },
  build: { target: 'es2022', sourcemap: true }
};
