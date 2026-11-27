import {defineConfig} from 'vite';
import {fileURLToPath} from 'node:url';
export default defineConfig({
  root:'renderer',clearScreen:false,server:{host:'127.0.0.1',port:1420,strictPort:true},
  build:{target:'esnext',outDir:'../dist',emptyOutDir:true,rollupOptions:{input:{main:fileURLToPath(new URL('./renderer/index.html',import.meta.url)),overlay:fileURLToPath(new URL('./renderer/overlay.html',import.meta.url))}}}
});
