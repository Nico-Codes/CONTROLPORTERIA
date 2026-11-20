const admin = require('firebase-admin');

const DIAS_SEMANA = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

function cargarCredenciales() {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('Falta la variable de entorno FIREBASE_SERVICE_ACCOUNT.');
    try { return JSON.parse(raw); } catch (e) { return JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); }
}

admin.initializeApp({ credential: admin.credential.cert(cargarCredenciales()) });
const db = admin.firestore();
const messaging = admin.messaging();

function ahoraArgentina() {
    return new Date(Date.now() - 3 * 60 * 60 * 1000);
}
function fechaISOArgentina(d) {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function rutaCompletada(regsHoy, ruta) {
    return regsHoy.some(reg => reg.severidad === 'OK' && (reg.rutaId === ruta.id || (reg.codigoQR === ruta.codigoQR && String(reg.horarioProgramado || '') === String(ruta.hora || ''))));
}
function huboEscaneo(regsHoy, ruta) {
    return regsHoy.some(reg => reg.codigoQR === ruta.codigoQR && String(reg.horarioProgramado || '') === String(ruta.hora || ''));
}

async function enviarProactivosPlanta(tokens, plantaId, ajustes) {
    const ahora = ahoraArgentina();
    const hoyISO = fechaISOArgentina(ahora);
    const hoyNombre = DIAS_SEMANA[ahora.getUTCDay()];

    const rutasSnap = await db.collection('plantas').doc(plantaId).collection('rutas_horarias').get();
    const rutasHoy = rutasSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(r => r.dia === hoyNombre || r.dia === 'Todos');
    if (rutasHoy.length === 0) return;

    const regsSnap = await db.collection('plantas').doc(plantaId).collection('registros_ronda').where('fechaISO', '==', hoyISO).limit(500).get();
    const regsHoy = regsSnap.docs.map(d => d.data());

    const grupoPrevio = [], grupoVence = [], grupoIncumplido = [];
    for (const ruta of rutasHoy) {
        if (rutaCompletada(regsHoy, ruta)) continue;
        const [hh, mm] = (ruta.hora || '00:00').split(':').map(Number);
        const obj = new Date(ahora);
        obj.setUTCHours(isNaN(hh) ? 0 : hh, isNaN(mm) ? 0 : mm, 0, 0);
        const diffMin = Math.round((ahora.getTime() - obj.getTime()) / 60000);
        const margen = Number(ruta.margen) || 15;

        const previo = Number(ajustes.minutosAvisoPrevio) || 8;
        if (diffMin <= -(previo - 1) && diffMin >= -(previo + 1)) grupoPrevio.push(ruta);
        const minParaFin = margen - diffMin;
        if (diffMin > 0 && minParaFin <= (Number(ajustes.minutosAvisoVencimiento) || 5) && minParaFin > 0) grupoVence.push(ruta);
        else if (ahora.getTime() >= obj.getTime() + margen * 60000 && !huboEscaneo(regsHoy, ruta)) grupoIncumplido.push(ruta);
    }

    const alertasRef = db.collection('config').doc(`push_alertas_${plantaId}`);
    const alertasSnap = await alertasRef.get();
    const alertas = alertasSnap.exists ? (alertasSnap.data() || {}) : {};
    const nowMs = Date.now();
    const cooldowns = { lote_8m: 15 * 60 * 1000, lote_3m: 10 * 60 * 1000 };

    async function enviarGrupo(grupo, cooldownKey, titulo, bodyFn, severidad, tag) {
        const tokensPlanta = tokens.filter(d => Array.isArray(d.plantas) && (d.plantas.includes('*') || d.plantas.includes(plantaId))).map(d => d.token).filter(Boolean);
        if (grupo.length === 0 || tokensPlanta.length === 0) return;
        if (cooldownKey === 'lote_inc') {
            const pendientes = await db.runTransaction(async tx => {
                const snap = await tx.get(alertasRef);
                const data = snap.exists ? snap.data() : {};
                const prefijoHoy = `${hoyISO}_`;
                const enviadosHoy = Object.fromEntries(Object.entries(data.incumplimientosEnviados || {}).filter(([clave]) => clave.startsWith(prefijoHoy)));
                const nuevas = grupo.filter(ruta => !enviadosHoy[`${hoyISO}_${ruta.id}`]);
                nuevas.forEach(ruta => { enviadosHoy[`${hoyISO}_${ruta.id}`] = nowMs; });
                if (nuevas.length) tx.set(alertasRef, { ...data, incumplimientosEnviados: enviadosHoy });
                return nuevas;
            });
            if (!pendientes.length) return;
            grupo = pendientes;
        }
        const hash = grupo.map(r => r.codigoQR + '@' + r.hora).sort().join(',');
        const key = `${cooldownKey}_${hash}`;
        const last = alertas[key] || 0;
        if (cooldownKey !== 'lote_inc' && nowMs - last < cooldowns[cooldownKey]) return;
        const cant = grupo.length;
        try {
            await messaging.sendEachForMulticast({
                tokens: tokensPlanta,
                data: { title: titulo, body: bodyFn(cant), severidad, tag, punto: grupo.map(r => r.puntoNombre).join(', ') },
                android: { priority: 'high' },
                webpush: { headers: { Urgency: 'high' } }
            });
            if (cooldownKey !== 'lote_inc') {
                alertas[key] = nowMs;
                await alertasRef.set(alertas, { merge: true });
            }
        } catch (err) {
            console.error('Error enviando push proactivo:', err.message);
        }
    }

    await enviarGrupo(grupoPrevio, 'lote_8m', 'Punto de Ronda Próximo',
        c => c === 1 ? 'Se acerca la hora de 1 punto de ronda. Preparate para escanear.' : `Se acercan las horas de ${c} puntos de ronda. Preparate para escanear.`,
        'info', 'ronda-lote-8min');
    await enviarGrupo(grupoVence, 'lote_3m', 'Vencimiento de Ventana',
        c => c === 1 ? 'Está por vencer un punto de ronda en los próximos minutos.' : `Están por vencer ${c} puntos de ronda en los próximos minutos.`,
        'ADVERTENCIA', 'ronda-lote-vence-3min');
    await enviarGrupo(grupoIncumplido, 'lote_inc', 'Incumplimiento de Ronda',
        c => c === 1 ? 'El tiempo límite de 1 punto de ronda ha vencido sin escanearse.' : `El tiempo límite de ${c} puntos de ronda ha vencido sin escanearse.`,
        'CRITICO', 'ronda-lote-incumplido');
}

async function enviarProactivos(tokens, plantas, ajustes) {
    for (const plantaId of plantas) await enviarProactivosPlanta(tokens, plantaId, ajustes);
}

async function main() {
    const tokensSnap = await db.collection('dispositivos_notificaciones').get();
    const tokens = tokensSnap.docs.map(d => d.data()).filter(d => d.token && d.activo !== false);
    const plantasSnap = await db.collection('plantas').get();
    const plantas = plantasSnap.docs.map(d => d.id);
    const ajustesSnap = await db.collection('config').doc('push_settings').get();
    const ajustes = ajustesSnap.exists ? ajustesSnap.data() : {};
    const notificacionesActivas = ajustes.activo !== false;

    if (notificacionesActivas) await enviarProactivos(tokens, plantas, ajustes);

    const cursorRef = db.collection('config').doc('push_cursor');
    const cursorSnap = await cursorRef.get();
    const lastMs = cursorSnap.exists ? (cursorSnap.data().lastMs || 0) : Date.now() - 5 * 60 * 1000;

    const snap = await db.collectionGroup('registros_ronda').where('timestampMs', '>', lastMs).orderBy('timestampMs', 'asc').limit(200).get();

    let maxMs = lastMs;
    let enviados = 0;

    if (!snap.empty) {
        for (const doc of snap.docs) {
            const reg = doc.data();
            if (typeof reg.timestampMs === 'number') maxMs = Math.max(maxMs, reg.timestampMs);
            if (!notificacionesActivas) continue;
            if (reg.severidad !== 'CRITICO' && reg.severidad !== 'ADVERTENCIA') continue;
            const plantaId = doc.ref.parent.parent?.id;
            if (!plantaId) continue;
            const tokensPlanta = tokens.filter(d => Array.isArray(d.plantas) && (d.plantas.includes('*') || d.plantas.includes(plantaId))).map(d => d.token).filter(Boolean);
            if (tokensPlanta.length === 0) continue;

            const critico = reg.severidad === 'CRITICO';
            const title = critico ? '⚠️ Incidencia crítica' : '⚠️ Desvío de ronda';
            const body = `${reg.operador || 'Guardia'}: ${reg.puntoNombre || 'Punto'} - ${reg.estado || ''}`.trim();

            try {
                const resp = await messaging.sendEachForMulticast({
                    tokens: tokensPlanta,
                    data: { title, body, severidad: reg.severidad, tag: critico ? 'ronda-critico' : 'ronda-desvio', punto: reg.puntoNombre || '', operador: reg.operador || '' },
                    android: { priority: 'high' },
                    webpush: { headers: { Urgency: 'high' } }
                });
                enviados += resp.successCount;
                if (resp.failureCount > 0) console.warn(`Envío parcial: ${resp.successCount} ok, ${resp.failureCount} fallos.`);
            } catch (err) {
                console.error('Error enviando push:', err.message);
            }
        }
        await cursorRef.set({ lastMs: maxMs, actualizadoEn: new Date().toISOString() }, { merge: true });
    } else {
        await cursorRef.set({ lastMs: Date.now(), actualizadoEn: new Date().toISOString() }, { merge: true });
        console.log('Sin registros nuevos.');
    }

    // Limpieza de retencion (una vez por dia).
    try {
        const cursorData = (await cursorRef.get()).data() || {};
        const lastCleanup = cursorData.lastCleanup || 0;
        if (Date.now() - lastCleanup > 24 * 60 * 60 * 1000) {
            const corte = Date.now() - 60 * 24 * 60 * 60 * 1000;
            let eliminados = 0;
            for (let i = 0; i < 3; i++) {
                for (const plantaId of plantas) {
                    const oldSnap = await db.collection('plantas').doc(plantaId).collection('registros_ronda')
                        .where('timestampMs', '<', corte).orderBy('timestampMs', 'asc').limit(400).get();
                    if (oldSnap.empty) continue;
                    const batch = db.batch();
                    oldSnap.forEach(d => batch.delete(d.ref));
                    await batch.commit();
                    eliminados += oldSnap.size;
                }
            }
            await cursorRef.set({ lastCleanup: Date.now() }, { merge: true });
            if (eliminados > 0) console.log(`Limpieza: ${eliminados} registros antiguos eliminados.`);
        }
    } catch (e) {
        console.warn('Error en limpieza:', e.message);
    }

    if (!snap.empty) console.log(`Procesados ${snap.size} registros. Push enviados: ${enviados}. Cursor: ${maxMs}`);
}

main().catch(err => { console.error(err); process.exit(1); });
