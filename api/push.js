const admin = require('firebase-admin');
const { timingSafeEqual } = require('node:crypto');

const DIAS_SEMANA = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

let initialized = false;
function initAdmin() {
    if (initialized || admin.apps.length) {
        initialized = true;
        return;
    }
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('Falta la variable de entorno FIREBASE_SERVICE_ACCOUNT.');
    let creds;
    try {
        creds = JSON.parse(raw);
    } catch (e) {
        creds = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    }
    admin.initializeApp({ credential: admin.credential.cert(creds) });
    initialized = true;
}

// Hora actual en Argentina (UTC-3, sin horario de verano).
function ahoraArgentina() {
    const now = new Date();
    return new Date(now.getTime() - 3 * 60 * 60 * 1000);
}

function fechaISOArgentina(d) {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function rutaCompletada(regsHoy, ruta) {
    return regsHoy.some(reg =>
        reg.severidad === 'OK' &&
        (reg.rutaId === ruta.id || (reg.codigoQR === ruta.codigoQR && String(reg.horarioProgramado || '') === String(ruta.hora || '')))
    );
}

function huboEscaneo(regsHoy, ruta) {
    return regsHoy.some(reg =>
        reg.codigoQR === ruta.codigoQR &&
        String(reg.horarioProgramado || '') === String(ruta.hora || '')
    );
}

async function enviarProactivos(db, messaging, tokens) {
    const ahora = ahoraArgentina();
    const hoyISO = fechaISOArgentina(ahora);
    const hoyNombre = DIAS_SEMANA[ahora.getUTCDay()];

    const rutasSnap = await db.collection('rutas_horarias').get();
    const rutasHoy = rutasSnap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(r => r.dia === hoyNombre || r.dia === 'Todos');

    if (rutasHoy.length === 0) {
        console.log('[Push] Sin rutas para hoy.');
        return;
    }

    const regsSnap = await db.collection('registros_ronda').where('fechaISO', '==', hoyISO).limit(500).get();
    const regsHoy = regsSnap.docs.map(d => d.data());

    const grupoPrevio = [];
    const grupoVence = [];
    const grupoIncumplido = [];

    for (const ruta of rutasHoy) {
        if (rutaCompletada(regsHoy, ruta)) continue;
        const [hh, mm] = (ruta.hora || '00:00').split(':').map(Number);
        const obj = new Date(ahora);
        obj.setUTCHours(isNaN(hh) ? 0 : hh, isNaN(mm) ? 0 : mm, 0, 0);
        const diffMin = Math.round((ahora.getTime() - obj.getTime()) / 60000);
        const margen = Number(ruta.margen) || 15;

        if (diffMin <= -3 && diffMin >= -12) grupoPrevio.push(ruta);

        const minParaFin = margen - diffMin;
        if (diffMin > 0 && minParaFin <= 5 && minParaFin >= 0) grupoVence.push(ruta);
        else if (diffMin > margen && !huboEscaneo(regsHoy, ruta)) grupoIncumplido.push(ruta);
    }

    const alertasRef = db.collection('config').doc('push_alertas');
    const alertasSnap = await alertasRef.get();
    const alertas = alertasSnap.exists ? (alertasSnap.data() || {}) : {};
    const nowMs = Date.now();

    const cooldowns = { lote_8m: 15 * 60 * 1000, lote_3m: 10 * 60 * 1000, lote_inc: 60 * 60 * 1000 };

    async function enviarGrupo(grupo, cooldownKey, titulo, bodyFn, severidad, tag) {
        if (grupo.length === 0 || tokens.length === 0) return;
        const hash = grupo.map(r => r.codigoQR + '@' + r.hora).sort().join(',');
        const key = `${cooldownKey}_${hash}`;
        const last = alertas[key] || 0;
        if (nowMs - last < cooldowns[cooldownKey]) return;

        const cant = grupo.length;
        const body = bodyFn(cant);
        try {
            await messaging.sendEachForMulticast({
                tokens,
                data: { title: titulo, body, severidad, tag, punto: grupo.map(r => r.puntoNombre).join(', ') },
                android: { priority: 'high' },
                webpush: { headers: { Urgency: 'high' } }
            });
            alertas[key] = nowMs;
            await alertasRef.set(alertas, { merge: true });
            console.log(`[Push] Enviado "${titulo}" para ${grupo.length} ruta(s).`);
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

module.exports = async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'POST') {
        res.setHeader('Allow', 'GET, POST');
        return res.status(405).json({ error: 'Método no permitido.' });
    }

    const secret = process.env.CRON_SECRET;
    if (!secret) {
        console.error('[Push] Falta la variable de entorno CRON_SECRET.');
        return res.status(503).json({ error: 'Emisor no configurado.' });
    }

    const authorization = req.headers.authorization || '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    const esperado = Buffer.from(secret);
    const recibido = Buffer.from(token);
    const autorizado = esperado.length === recibido.length && timingSafeEqual(esperado, recibido);
    if (!autorizado) {
        return res.status(401).json({ error: 'No autorizado.' });
    }

    try {
        initAdmin();
        const db = admin.firestore();
        const messaging = admin.messaging();

        const tokensSnap = await db.collection('dispositivos_notificaciones').get();
        const tokens = tokensSnap.docs.map(d => d.data().token).filter(Boolean);
        console.log(`[Push] Tokens registrados: ${tokens.length} (docs: ${tokensSnap.size})`);

        // 1) Alertas proactivas (próximo, vencimiento, incumplimiento).
        await enviarProactivos(db, messaging, tokens);

        // 2) Incidentes post-escaneo (registros CRITICO/ADVERTENCIA nuevos).
        const cursorRef = db.collection('config').doc('push_cursor');
        const cursorSnap = await cursorRef.get();
        const lastMs = cursorSnap.exists ? (cursorSnap.data().lastMs || 0) : Date.now() - 5 * 60 * 1000;

        const snap = await db.collection('registros_ronda')
            .where('timestampMs', '>', lastMs)
            .orderBy('timestampMs', 'asc')
            .limit(200)
            .get();

        let maxMs = lastMs;
        let enviados = 0;

        if (!snap.empty) {
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
                        data: {
                            title,
                            body,
                            severidad: reg.severidad,
                            tag: critico ? 'ronda-critico' : 'ronda-desvio',
                            punto: reg.puntoNombre || '',
                            operador: reg.operador || ''
                        },
                        android: { priority: 'high' },
                        webpush: { headers: { Urgency: 'high' } }
                    });
                    enviados += resp.successCount;
                    if (resp.failureCount > 0) {
                        console.warn(`Envío parcial: ${resp.successCount} ok, ${resp.failureCount} fallos.`);
                    }
                } catch (err) {
                    console.error('Error enviando push:', err.message);
                }
            }

            await cursorRef.set({ lastMs: maxMs, actualizadoEn: new Date().toISOString() }, { merge: true });
        } else {
            await cursorRef.set({ lastMs: Date.now(), actualizadoEn: new Date().toISOString() }, { merge: true });
        }

        // 3) Limpieza de retención (una vez por día).
        try {
            const cursorData = cursorSnap.exists ? cursorSnap.data() : {};
            const lastCleanup = cursorData.lastCleanup || 0;
            if (Date.now() - lastCleanup > 24 * 60 * 60 * 1000) {
                const corte = Date.now() - 60 * 24 * 60 * 60 * 1000;
                let eliminados = 0;
                for (let i = 0; i < 3; i++) {
                    const oldSnap = await db.collection('registros_ronda')
                        .where('timestampMs', '<', corte)
                        .orderBy('timestampMs', 'asc')
                        .limit(400)
                        .get();
                    if (oldSnap.empty) break;
                    const batch = db.batch();
                    oldSnap.forEach(d => batch.delete(d.ref));
                    await batch.commit();
                    eliminados += oldSnap.size;
                    if (oldSnap.size < 400) break;
                }
                await cursorRef.set({ lastCleanup: Date.now() }, { merge: true });
                if (eliminados > 0) console.log(`[Push] Limpieza: ${eliminados} registros antiguos eliminados.`);
            }
        } catch (e) {
            console.warn('[Push] Error en limpieza:', e.message);
        }

        return res.status(200).json({
            ok: true,
            processed: snap.empty ? 0 : snap.size,
            sent: enviados,
            cursor: maxMs,
            message: snap.empty ? 'Sin registros nuevos.' : `Procesados ${snap.size} registros. Push enviados: ${enviados}.`
        });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ ok: false, error: e.message });
    }
};
