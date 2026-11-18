const admin = require('firebase-admin');

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

module.exports = async (req, res) => {
    try {
        initAdmin();
        const db = admin.firestore();
        const messaging = admin.messaging();

        const cursorRef = db.collection('config').doc('push_cursor');
        const cursorSnap = await cursorRef.get();
        const lastMs = cursorSnap.exists ? (cursorSnap.data().lastMs || 0) : Date.now() - 5 * 60 * 1000;

        const snap = await db.collection('registros_ronda')
            .where('timestampMs', '>', lastMs)
            .orderBy('timestampMs', 'asc')
            .limit(200)
            .get();

        if (snap.empty) {
            await cursorRef.set({ lastMs: Date.now(), actualizadoEn: new Date().toISOString() }, { merge: true });
            return res.status(200).json({ ok: true, processed: 0, sent: 0, cursor: Date.now(), message: 'Sin registros nuevos.' });
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

        return res.status(200).json({
            ok: true,
            processed: snap.size,
            sent: enviados,
            cursor: maxMs,
            message: `Procesados ${snap.size} registros. Push enviados: ${enviados}.`
        });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ ok: false, error: e.message });
    }
};
