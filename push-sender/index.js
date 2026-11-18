/**
 * Emisor gratuito de notificaciones push para Control de Rondas.
 *
 * Lee los registros nuevos de Firestore y envía una notificación push a todos los
 * dispositivos registrados en `dispositivos_notificaciones`. Mantiene un cursor
 * en `config/push_cursor` para no repetir envíos.
 *
 * Variables de entorno:
 *   FIREBASE_SERVICE_ACCOUNT  JSON completo de la cuenta de servicio (o base64).
 *
 * Ejecutar: node index.js
 */
const admin = require('firebase-admin');

function cargarCredenciales() {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('Falta la variable de entorno FIREBASE_SERVICE_ACCOUNT.');
    try {
        return JSON.parse(raw);
    } catch (e) {
        // Permitir base64 para secretos de CI.
        return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    }
}

admin.initializeApp({ credential: admin.credential.cert(cargarCredenciales()) });

const db = admin.firestore();
const messaging = admin.messaging();

async function main() {
    const cursorRef = db.collection('config').doc('push_cursor');
    const cursorSnap = await cursorRef.get();
    const lastMs = cursorSnap.exists ? (cursorSnap.data().lastMs || 0) : Date.now() - 5 * 60 * 1000;

    const snap = await db.collection('registros_ronda')
        .where('timestampMs', '>', lastMs)
        .orderBy('timestampMs', 'asc')
        .limit(200)
        .get();

    if (snap.empty) {
        console.log('Sin registros nuevos.');
        return;
    }

    const tokensSnap = await db.collection('dispositivos_notificaciones').get();
    const tokens = tokensSnap.docs.map(d => d.data().token).filter(Boolean);

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
                data: {
                    title,
                    body,
                    severidad: reg.severidad,
                    tag: critico ? 'ronda-critico' : 'ronda-desvio',
                    punto: reg.puntoNombre || '',
                    operador: reg.operador || ''
                },
                android: { priority: critico ? 'high' : 'normal' }
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
    console.log(`Procesados ${snap.size} registros. Push enviados: ${enviados}. Cursor: ${maxMs}`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
