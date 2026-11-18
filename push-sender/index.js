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

async function enviarProactivos(tokens) {
    const ahora = ahoraArgentina();
    const hoyISO = fechaISOArgentina(ahora);
    const hoyNombre = DIAS_SEMANA[ahora.getUTCDay()];

    const rutasSnap = await db.collection('rutas_horarias').get();
    const rutasHoy = rutasSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(r => r.dia === hoyNombre || r.dia === 'Todos');
    if (rutasHoy.length === 0) return;

    const regsSnap = await db.collection('registros_ronda').where('fechaISO', '==', hoyISO).get();
    const regsHoy = regsSnap.docs.map(d => d.data());

    const grupoPrevio = [], grupoVence = [], grupoIncumplido = [];
    for (const ruta of rutasHoy) {
        if (rutaCompletada(regsHoy, ruta)) continue;
        const [hh, mm] = (ruta.hora || '00:00').split(':').map(Number);
        const obj = new Date(ahora);
        obj.setUTCHours(isNaN(hh) ? 0 : hh, isNaN(mm) ? 0 : mm, 0, 0);
        const diffMin = Math.round((ahora.getTime() - obj.getTime()) / 60000);
        const margen = Number(ruta.margen) || 15;

        if (diffMin <= -4 && diffMin >= -6) grupoPrevio.push(ruta);
        const minParaFin = margen - diffMin;
        if (diffMin > 0 && minParaFin <= 3 && minParaFin >= 0) grupoVence.push(ruta);
        else if (diffMin > margen && !huboEscaneo(regsHoy, ruta)) grupoIncumplido.push(ruta);
    }

    const alertasRef = db.collection('config').doc('push_alertas');
    const alertasSnap = await alertasRef.get();
    const alertas = alertasSnap.exists ? (alertasSnap.data() || {}) : {};
    const nowMs = Date.now();
    const cooldowns = { lote_5m: 15 * 60 * 1000, lote_3m: 10 * 60 * 1000, lote_inc: 60 * 60 * 1000 };

    async function enviarGrupo(grupo, cooldownKey, titulo, bodyFn, severidad, tag) {
        if (grupo.length === 0 || tokens.length === 0) return;
        const hash = grupo.map(r => r.codigoQR + '@' + r.hora).sort().join(',');
        const key = `${cooldownKey}_${hash}`;
        const last = alertas[key] || 0;
        if (nowMs - last < cooldowns[cooldownKey]) return;
        const cant = grupo.length;
        try {
            await messaging.sendEachForMulticast({
                tokens,
                data: { title: titulo, body: bodyFn(cant), severidad, tag, punto: grupo.map(r => r.puntoNombre).join(', ') },
                android: { priority: 'high' },
                webpush: { headers: { Urgency: 'high' } }
            });
            alertas[key] = nowMs;
            await alertasRef.set(alertas, { merge: true });
        } catch (err) {
            console.error('Error enviando push proactivo:', err.message);
        }
    }

    await enviarGrupo(grupoPrevio, 'lote_5m', 'Punto de Ronda Próximo',
        c => c === 1 ? 'Tenés 1 punto de ronda pendiente por cubrir en 5 minutos.' : `Tenés ${c} puntos de ronda pendientes por cubrir en 5 minutos.`,
        'info', 'ronda-lote-5min');
    await enviarGrupo(grupoVence, 'lote_3m', 'Vencimiento de Ventana',
        c => c === 1 ? 'Tenés 1 punto de ronda por vencer en 3 minutos. Ingresá a escanearlo.' : `Tenés ${c} puntos de ronda por vencer en 3 minutos. Ingresá a escanearlos.`,
        'ADVERTENCIA', 'ronda-lote-vence-3min');
    await enviarGrupo(grupoIncumplido, 'lote_inc', 'Incumplimiento de Ronda',
        c => c === 1 ? 'El tiempo límite para 1 punto de ronda ha vencido sin escanearse.' : `El tiempo límite para ${c} puntos de ronda ha vencido sin escanearse.`,
        'CRITICO', 'ronda-lote-incumplido');
}

async function main() {
    const tokensSnap = await db.collection('dispositivos_notificaciones').get();
    const tokens = tokensSnap.docs.map(d => d.data().token).filter(Boolean);

    await enviarProactivos(tokens);

    const cursorRef = db.collection('config').doc('push_cursor');
    const cursorSnap = await cursorRef.get();
    const lastMs = cursorSnap.exists ? (cursorSnap.data().lastMs || 0) : Date.now() - 5 * 60 * 1000;

    const snap = await db.collection('registros_ronda').where('timestampMs', '>', lastMs).orderBy('timestampMs', 'asc').limit(200).get();

    if (snap.empty) {
        await cursorRef.set({ lastMs: Date.now(), actualizadoEn: new Date().toISOString() }, { merge: true });
        console.log('Sin registros nuevos.');
        return;
    }

    let maxMs = lastMs;
    let enviados = 0;

    for (const doc of snap.docs) {
        const reg = doc.data();
        if (typeof reg.timestampMs === 'number') maxMs = Math.max(maxMs, reg.timestampMs);
        if (reg.severidad !== 'CRITICO' && reg.severidad !== 'ADVERTENCIA') continue;
        if (tokens.length === 0) continue;

        const critico = reg.severidad === 'CRITICO';
        const title = critico ? '⚠️ Incidencia crítica' : '⚠️ Desvío de ronda';
        const body = `${reg.operador || 'Guardia'}: ${reg.puntoNombre || 'Punto'} - ${reg.estado || ''}`.trim();

        try {
            const resp = await messaging.sendEachForMulticast({
                tokens,
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
    console.log(`Procesados ${snap.size} registros. Push enviados: ${enviados}. Cursor: ${maxMs}`);
}

main().catch(err => { console.error(err); process.exit(1); });
