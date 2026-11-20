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
const emisorAlternativo = readFileSync(resolve(raiz, 'push-sender/index.js'), 'utf8');
const emisorVercel = readFileSync(resolve(raiz, 'api/push.js'), 'utf8');
const apiUsuarios = readFileSync(resolve(raiz, 'api/usuarios.js'), 'utf8');

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
comprobar('La pestaña de usuarios solo se muestra al superadmin', contiene("tabUsuarios.style.display = habilitado ? 'flex' : 'none';") && contiene("const habilitado = rol === 'superadmin';"));
comprobar('La administración solo aparece y responde al superadmin', contiene('id="tab-administracion"') && contiene("tabAdministracion.style.display = esSuperadmin ? 'flex' : 'none';") && contiene("sessionStorage.getItem('usuario_rol') !== 'superadmin') return;"));
comprobar('El superadmin puede crear y deshabilitar plantas', apiUsuarios.includes("accion === 'crear_planta'") && apiUsuarios.includes("accion === 'estado_planta'") && contiene('window.crearPlantaSistema'));
comprobar('Los ajustes globales controlan ambos emisores', apiUsuarios.includes("accion === 'guardar_ajustes_push'") && emisorVercel.includes("doc('push_settings')") && emisorAlternativo.includes("doc('push_settings')") && emisorVercel.includes('if (!notificacionesActivas) continue;') && emisorAlternativo.includes('if (!notificacionesActivas) continue;'));
comprobar('Los accesos registran ubicación aproximada y protegen su colección', apiUsuarios.includes("accion === 'registrar_acceso'") && apiUsuarios.includes("'x-vercel-ip-city'") && reglas.includes('match /auditoria_accesos/{doc}') && reglas.includes('allow read, write: if false;'));
comprobar('El login es una vista opaca e independiente', html.includes('z-[100] min-h-screen overflow-y-auto bg-[#F7F7F5]') && contiene("modal.style.display = 'flex';") && contiene('const esOperadorAutenticado = tieneSesion && !esEncargado && catalogosListos;'));
comprobar('No quedan IDs inexistentes del bug original', !contiene('badge-criticos-tab') && !contiene('bar-validos') && !contiene('bar-adv') && !contiene('bar-crit'));

// Operadores
comprobar('Existe activar/desactivar operador', contiene('window.toggleOperadorActivo = async (id, activo)'));
comprobar('La tabla de personal usa métricas reales', contiene('const escaneosOp = regsDia.filter(r => r.operador === op.nombre);'));
comprobar('Eliminar operador pide confirmación', contiene('if (!confirm(`¿Eliminar a "${nombre}"? El historial de escaneos se conserva.`)) return;'));

// Puntos y rutas
comprobar('Eliminar punto pide confirmación', contiene('if (!confirm(aviso)) return;'));
comprobar('Eliminar punto borra sus rutas en lote', contiene('rutasAsociadas.forEach(r => batch.delete(doc(db, "plantas", plantaActiva, "rutas_horarias", r.id)));'));
comprobar('No se permiten nombres de punto duplicados', contiene('if (existePuntoConNombre(nombre))'));
comprobar('Editar un punto solo modifica su nombre', contiene('updateDoc(doc(db, "plantas", plantaActiva, "puntos_control", id), { nombre });'));
comprobar('Recalibrar un punto actualiza la ubicación dentro de la planta activa', contiene("updateDoc(doc(db, 'plantas', plantaActiva, 'puntos_control', id), { lat, lng });"));
comprobar('El escáner espera la sincronización de puntos y horarios', contiene('function iniciarSuscripcionesCatalogos(plantaId)') && contiene('if (!snapshot.metadata.fromCache) pendientes.delete(nombre);') && contiene('if (!catalogosListos) {'));
comprobar('Puntos, rutas y operadores se actualizan con listeners de Firestore', contiene("onSnapshot(collection(db, 'plantas', plantaId, 'puntos_control')") && contiene("onSnapshot(collection(db, 'plantas', plantaId, 'rutas_horarias')") && contiene("onSnapshot(collection(db, 'plantas', plantaId, 'operadores')"));
comprobar('Se puede editar el radio GPS de un punto desde el panel y el mapa', contiene('window.editarRadioPunto = async (id) =>') && contiene("updateDoc(doc(db, 'plantas', plantaActiva, 'puntos_control', id), { tolerancia });") && contiene('botonAccion(\'Editar radio\'') && contiene('editarRadioPunto(\'${p.id}\')'));
comprobar('Editar el punto conserva su código QR y evita nombres duplicados', contiene('existePuntoConNombre(nombre, punto.codigo)'));
comprobar('Los horarios asociados reciben el nuevo nombre', contiene('lote.update(ruta.ref, { puntoNombre: nombre })'));
comprobar('La programación permite elegir puntos desde el mapa', contiene('window.abrirModalMapaRuta'));
comprobar('El panel separa puntos y programación en pestañas propias', contiene("cambiarTabAdmin('puntos')") && contiene('id="seccion-puntos"') && contiene("cambiarTabAdmin('rutas')") && contiene('id="seccion-rutas"'));
comprobar('El mapa permite seleccionar varios puntos simultáneamente', contiene('let codigosMapaRutaPendientes = new Set()') && contiene('codigosMapaRutaPendientes.add(codigo)'));
comprobar('La programación crea cada combinación de punto y día', contiene('codigosQR.forEach(codigoQR => {') && contiene('diasSeleccionadosForm.forEach(dia => {') && contiene('batch.set(ref, { dia, codigoQR, puntoNombre, hora, margen })'));
comprobar('El modal llama al renderizador existente del mapa', contiene('actualizarPuntosMapaRuta();') && !contiene('renderizarListaPuntosMapaRuta()'));
comprobar('El mapa posiciona los puntos con sus coordenadas', contiene('window.L.marker([lat, lng]'));
comprobar('El mapa muestra atribución de los proveedores de tiles', contiene('arcgisonline.com') && contiene('Esri'));
comprobar('No se permiten operadores duplicados', contiene('operadoresCache.some(op => String(op.nombre || \'\').trim().toLowerCase() === nombre.toLowerCase())'));

// Exportación
comprobar('La exportación usa SheetJS', contiene("XLSX.utils.book_append_sheet(wb, ws, 'Rondas');"));
comprobar('La exportación incluye resumen por operador', contiene("XLSX.utils.book_append_sheet(wb, wsOperadores, 'Por operador');"));
comprobar('La exportación respeta 60 días desde hoy', contiene('const corte = Date.now() - RETENCION_MS;'));

// Reglas de Firestore
comprobar('firestore.rules versiona las reglas', reglas.includes("rules_version = '2';"));
comprobar('Las reglas limitan el acceso a plantas asignadas', reglas.includes('function perteneceAPlanta(plantaId)') && reglas.includes('plantaId in perfil().plantas'));
comprobar('Los registros solo se crean en una planta asignada', /match \/registros_ronda\/\{doc\} \{[\s\S]*allow create: if perteneceAPlanta\(plantaId\);/.test(reglas));
comprobar('Las reglas niegan la modificación de registros', /allow update: if false;/.test(reglas));
comprobar('La app limpia registros de más de 60 días', contiene('async function limpiarRegistrosAntiguos()'));
comprobar('La limpieza usa lotes de 400 registros', contiene('limit(400)'));
comprobar('Las reglas incluyen dispositivos_notificaciones', reglas.includes('match /dispositivos_notificaciones/{doc}'));
comprobar('El emisor alternativo procesa datos por planta', emisorAlternativo.includes("collection('plantas').doc(plantaId).collection('rutas_horarias')") && emisorAlternativo.includes("collectionGroup('registros_ronda')"));
comprobar('El emisor alternativo filtra tokens por planta', emisorAlternativo.includes('d.plantas.includes(plantaId)') && emisorAlternativo.includes('d.plantas.includes(\'*\')'));

for (const nombre of ok) console.log(`OK  ${nombre}`);
if (fallas.length > 0) {
  console.error(`\n${fallas.length} verificación(es) fallaron:`);
  for (const falla of fallas) console.error(`ERROR  ${falla}`);
  process.exit(1);
}

console.log(`\n${ok.length} verificaciones de contrato OK.`);
