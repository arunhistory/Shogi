import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths allow the same build to run from GitHub Pages subpaths
  // and from another static origin without baking a deployment hostname into code.
  base:'./',
  build:{
    target:'es2022',
    sourcemap:false,
  },
});
