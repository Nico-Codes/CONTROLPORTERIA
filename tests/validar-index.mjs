#!/usr/bin/env node
/**
 * Validación estática del HTML y JS del proyecto.
 * No necesita dependencias: se ejecuta con `node tests/validar-index.mjs`.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const archivoHtml = resolve(raiz, 'index.html');
const archivoJs = resolve(raiz, 'src/main.js');
const html = readFileSync(archivoHtml, 'utf8');
const js = readFileSync(archivoJs, 'utf8');
const codigo = html + '\n' + js;

const errores = [];
const advertencias = [];

const ids = [...html.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)].map(m => m[1]);
const idsUnicos = new Set(ids);
const duplicados = ids.filter((id, i) => ids.indexOf(id) !== i);

if (duplicados.length > 0) {
  errores.push(`IDs duplicados: ${[...new Set(duplicados)].join(', ')}`);
}

const referencias = [...codigo.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)]
  .map(m => m[1]);
const faltantes = [...new Set(referencias.filter(id => !idsUnicos.has(id)))];

if (faltantes.length > 0) {
  errores.push(`getElementById() apunta a IDs inexistentes: ${faltantes.join(', ')}`);
}

const handlers = [...html.matchAll(/\bon[a-z]+\s*=\s*["']([A-Za-z_$][\w$]*)\(/g)]
  .map(m => m[1]);
const funcionesDefinidas = new Set([
  ...[...js.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]),
  ...[...js.matchAll(/\bwindow\.([A-Za-z_$][\w$]*)\s*=/g)].map(m => m[1])
]);
const handlersFaltantes = [...new Set(handlers.filter(fn => !funcionesDefinidas.has(fn)))];

if (handlersFaltantes.length > 0) {
  errores.push(`Handlers inline sin función definida: ${handlersFaltantes.join(', ')}`);
}

const dinamicos = [...codigo.matchAll(/getElementById\(\s*`([^`]+)`\s*\)/g)].map(m => m[1]);
if (dinamicos.length > 0) {
  advertencias.push(`IDs construidos dinámicamente (revisar a mano): ${dinamicos.join(', ')}`);
}

console.log(`Archivos: ${archivoHtml} + ${archivoJs}`);
console.log(`IDs definidos: ${idsUnicos.size}`);
console.log(`Referencias getElementById(): ${new Set(referencias).size}`);
console.log(`Handlers inline: ${new Set(handlers).size}`);

for (const aviso of advertencias) console.warn(`ADVERTENCIA: ${aviso}`);

if (errores.length > 0) {
  for (const error of errores) console.error(`ERROR: ${error}`);
  process.exit(1);
}

console.log('Validación estática OK.');
