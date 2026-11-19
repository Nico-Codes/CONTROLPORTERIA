#!/usr/bin/env node
/**
 * Pruebas de contrato sobre el código fuente del monolito.
 * No reemplazan pruebas de integración, pero congelan las reglas de negocio
 * críticas para que un cambio accidental no las rompa en silencio.
 *
 * Ejecutar con: node tests/validar-reglas.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(resolve(raiz, 'index.html'), 'utf8');
function listarArchivosJs(directorio) {
  return readdirSync(directorio, { withFileTypes: true }).flatMap(entrada => {
    const ruta = resolve(directorio, entrada.name);
    if (entrada.isDirectory()) return listarArchivosJs(ruta);
    return entrada.isFile() && entrada.name.endsWith('.js') ? [ruta] : [];
  });
}
const archivosJs = listarArchivosJs(resolve(raiz, 'src'));
const codigo = html + '\n' + archivosJs.map(archivo => readFileSync(archivo, 'utf8')).join('\n');
const reglas = readFileSync(resolve(raiz, 'firestore.rules'), 'utf8');

const fallas = [];
const ok = [];

function comprobar(nombre, condicion, detalle = '') {
  if (condicion) ok.push(nombre);
  else fallas.push(detalle ? `${nombre}: ${detalle}` : nombre);
}

function contiene(fragmento) {
  return codigo.includes(fragmento);
}

// Límites operativos
comprobar('Máximo 30 operadores', /const MAX_OPERADORES = 30;/.test(codigo));
comprobar('Máximo 20 puntos de control', /const MAX_PUNTOS = 20;/.test(codigo));
comprobar('Retención de 60 días', /const DIAS_RETENCION = 60;/.test(codigo));

// Retención y modelo de datos
comprobar('Los registros guardan expiraEn', contiene('expiraEn: new Date(ahora.getTime() + RETENCION_MS)'));
comprobar('Los registros guardan rutaId', contiene('rutaId: mejor && mejor.id ? mejor.id : null'));
comprobar('Los registros guardan margen', contiene('margen: mejor ? margen : null'));
comprobar('Los registros guardan tolerancia', contiene('tolerancia: tolerancia'));
comprobar('La cola offline reconstruye las fechas', contiene('itemFs.expiraEn = new Date(Number(itemFs.timestampMs) + RETENCION_MS)'));

// Regla de escaneo por horario
comprobar('Solo un registro OK completa una ruta', /function registroCorrespondeARuta\(reg, ruta\) \{\s*if \(!reg \|\| !ruta \|\| reg\.severidad !== ['"]OK['"]\) return false;/.test(codigo));
comprobar('La agenda usa registroCorrespondeARuta', contiene('const regOk = regsHoy.find(reg => registroCorrespondeARuta(reg, r));'));
comprobar('El escaneo prioriza la ruta pendiente más temprana', contiene('const pendientes = rutasPunto.filter(r => !rutaCompletada(regsHoy, r));'));

// Panel
comprobar('Los KPIs usan el cache del día seleccionado', contiene('const regsDia = registrosAdminCache.filter(r => r.fechaISO === fechaFiltro);'));
comprobar('Cada bloque del panel se renderiza aislado', contiene("console.error(`[Panel] Error al renderizar ${nombre}:`, e);"));
comprobar('No quedan IDs inexistentes del bug original', !contiene('badge-criticos-tab') && !contiene('bar-validos') && !contiene('bar-adv') && !contiene('bar-crit'));

// Operadores
comprobar('Existe activar/desactivar operador', contiene('window.toggleOperadorActivo = async (id, activo)'));
comprobar('La tabla de personal usa métricas reales', contiene('const escaneosOp = regsDia.filter(r => r.operador === op.nombre);'));
comprobar('Eliminar operador pide confirmación', contiene('if (!confirm(`¿Eliminar a "${nombre}"? El historial de escaneos se conserva.`)) return;'));

// Puntos y rutas
comprobar('Eliminar punto pide confirmación', contiene('if (!confirm(aviso)) return;'));
comprobar('Eliminar punto borra sus rutas en lote', contiene('rutasAsociadas.forEach(r => batch.delete(doc(db, "rutas_horarias", r.id)));'));
comprobar('No se permiten nombres de punto duplicados', contiene('if (existePuntoConNombre(nombre))'));
comprobar('No se permiten operadores duplicados', contiene('operadoresCache.some(op => String(op.nombre || \'\').trim().toLowerCase() === nombre.toLowerCase())'));

// Exportación
comprobar('La exportación usa SheetJS', contiene("XLSX.utils.book_append_sheet(wb, ws, 'Rondas');"));
comprobar('La exportación incluye resumen por operador', contiene("XLSX.utils.book_append_sheet(wb, wsOperadores, 'Por operador');"));
comprobar('La exportación respeta 60 días desde hoy', contiene('const corte = Date.now() - RETENCION_MS;'));

// Reglas de Firestore
comprobar('firestore.rules versiona las reglas', reglas.includes("rules_version = '2';"));
comprobar('Las reglas permiten crear registros', /match \/registros_ronda\/\{doc\} \{[\s\S]*allow read, create, delete: if true;/.test(reglas));
comprobar('Las reglas niegan la modificación de registros', /allow update: if false;/.test(reglas));
comprobar('La app limpia registros de más de 60 días', contiene('async function limpiarRegistrosAntiguos()'));
comprobar('La limpieza usa lotes de 400 registros', contiene('limit(400)'));
comprobar('Las reglas incluyen dispositivos_notificaciones', reglas.includes('match /dispositivos_notificaciones/{doc}'));

for (const nombre of ok) console.log(`OK  ${nombre}`);
if (fallas.length > 0) {
  console.error(`\n${fallas.length} verificación(es) fallaron:`);
  for (const falla of fallas) console.error(`ERROR  ${falla}`);
  process.exit(1);
}

console.log(`\n${ok.length} verificaciones de contrato OK.`);
