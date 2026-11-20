const admin = require('firebase-admin');
const { randomBytes } = require('crypto');

const AJUSTES_PUSH_POR_DEFECTO = {
    activo: true,
    minutosAvisoPrevio: 8,
    minutosAvisoVencimiento: 5
};

function cargarCredencial() {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('Falta FIREBASE_SERVICE_ACCOUNT.');
    const decoded = Buffer.from(raw, 'base64').toString('utf8');
    return JSON.parse(decoded.trim().startsWith('{') ? decoded : raw);
}

function leerUbicacion(req, nombre) {
    const valor = req.headers[nombre];
    if (typeof valor !== 'string' || !valor) return '';
    try { return decodeURIComponent(valor).slice(0, 100); } catch (e) { return valor.slice(0, 100); }
}

function describirDispositivo(userAgent = '') {
    const sistema = /android/i.test(userAgent) ? 'Android'
        : /iphone|ipad|ipod/i.test(userAgent) ? 'iOS'
        : /windows/i.test(userAgent) ? 'Windows'
        : /macintosh|mac os/i.test(userAgent) ? 'macOS'
        : /linux/i.test(userAgent) ? 'Linux' : 'Desconocido';
    const navegador = /edg\//i.test(userAgent) ? 'Edge'
        : /firefox\//i.test(userAgent) ? 'Firefox'
        : /chrome\//i.test(userAgent) && !/edg\//i.test(userAgent) ? 'Chrome'
        : /safari\//i.test(userAgent) && !/chrome\//i.test(userAgent) ? 'Safari' : 'Otro';
    return `${sistema} · ${navegador}`;
}

function crearIdPlanta(nombre) {
    const base = nombre.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 36) || 'planta';
    return `${base}-${randomBytes(3).toString('hex')}`;
}

if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(cargarCredencial()) });
}

module.exports = async function (req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido.' });
    try {
        const encabezado = req.headers.authorization || '';
        const token = encabezado.startsWith('Bearer ') ? encabezado.slice(7) : '';
        if (!token) return res.status(401).json({ error: 'Falta autenticación.' });
        const sesion = await admin.auth().verifyIdToken(token);
        const db = admin.firestore();
        const perfilSnap = await db.collection('usuarios').doc(sesion.uid).get();
        const perfil = perfilSnap.exists ? perfilSnap.data() : null;
        if (!perfil || perfil.activo === false) return res.status(403).json({ error: 'La cuenta no está activa.' });

        const { accion, usuario, nombre, rol, plantas, clave, uid, activo } = req.body || {};
        if (accion === 'registrar_acceso') {
            const userAgent = String(req.headers['user-agent'] || '').slice(0, 500);
            const acceso = {
                uid: sesion.uid,
                usuario: perfil.usuario || sesion.email || '',
                nombre: perfil.nombre || '',
                rol: perfil.rol || 'operador',
                plantas: Array.isArray(perfil.plantas) ? perfil.plantas : [],
                ciudad: leerUbicacion(req, 'x-vercel-ip-city'),
                region: leerUbicacion(req, 'x-vercel-ip-country-region'),
                pais: leerUbicacion(req, 'x-vercel-ip-country'),
                dispositivo: describirDispositivo(userAgent),
                timestampMs: Date.now(),
                creadoEn: admin.firestore.FieldValue.serverTimestamp()
            };
            await db.collection('auditoria_accesos').add(acceso);
            await db.collection('usuarios').doc(sesion.uid).set({
                ultimoAccesoMs: acceso.timestampMs,
                ultimoAccesoUbicacion: [acceso.ciudad, acceso.region, acceso.pais].filter(Boolean).join(', ')
            }, { merge: true });

            const corte = Date.now() - 90 * 24 * 60 * 60 * 1000;
            const vencidos = await db.collection('auditoria_accesos').where('timestampMs', '<', corte).orderBy('timestampMs', 'asc').limit(100).get();
            if (!vencidos.empty) {
                const batch = db.batch();
                vencidos.forEach(d => batch.delete(d.ref));
                await batch.commit();
            }
            return res.status(201).json({ ok: true });
        }

        if (perfil.rol !== 'superadmin') return res.status(403).json({ error: 'Solo el superadmin puede gestionar la configuración.' });

        if (accion === 'resumen_superadmin') {
            const [plantasSnap, ajustesSnap, accesosSnap] = await Promise.all([
                db.collection('plantas').get(),
                db.collection('config').doc('push_settings').get(),
                db.collection('auditoria_accesos').orderBy('timestampMs', 'desc').limit(100).get()
            ]);
            const ajustes = { ...AJUSTES_PUSH_POR_DEFECTO, ...(ajustesSnap.exists ? ajustesSnap.data() : {}) };
            const accesos = accesosSnap.docs.map(d => ({ id: d.id, ...d.data() }));
            return res.status(200).json({
                plantas: plantasSnap.docs.map(d => ({ id: d.id, ...d.data() })),
                ajustes,
                accesos
            });
        }

        if (accion === 'crear_planta') {
            const nombrePlanta = String(nombre || '').trim();
            if (nombrePlanta.length < 2 || nombrePlanta.length > 80) return res.status(400).json({ error: 'El nombre debe tener entre 2 y 80 caracteres.' });
            const existentes = await db.collection('plantas').get();
            if (existentes.docs.some(d => String(d.data().nombre || '').trim().toLocaleLowerCase('es') === nombrePlanta.toLocaleLowerCase('es'))) {
                return res.status(409).json({ error: 'Ya existe una planta con ese nombre.' });
            }
            const id = crearIdPlanta(nombrePlanta);
            await db.collection('plantas').doc(id).create({
                nombre: nombrePlanta,
                activo: true,
                creadoEn: admin.firestore.FieldValue.serverTimestamp(),
                creadoPor: sesion.uid
            });
            return res.status(201).json({ id, nombre: nombrePlanta });
        }

        if (accion === 'estado_planta') {
            if (!uid || typeof activo !== 'boolean') return res.status(400).json({ error: 'Planta o estado inválido.' });
            const plantaRef = db.collection('plantas').doc(uid);
            const plantaSnap = await plantaRef.get();
            if (!plantaSnap.exists) return res.status(404).json({ error: 'No se encontró la planta.' });
            if (!activo) {
                const todas = await db.collection('plantas').get();
                const activas = todas.docs.filter(d => d.data().activo !== false);
                if (activas.length <= 1 && activas.some(d => d.id === uid)) return res.status(409).json({ error: 'Debe quedar al menos una planta activa.' });
            }
            await plantaRef.update({ activo });
            return res.status(200).json({ ok: true });
        }

        if (accion === 'guardar_ajustes_push') {
            const { ajustes } = req.body || {};
            const camposValidos = ajustes && typeof ajustes.activo === 'boolean'
                && Number.isInteger(ajustes.minutosAvisoPrevio) && ajustes.minutosAvisoPrevio >= 2 && ajustes.minutosAvisoPrevio <= 60
                && Number.isInteger(ajustes.minutosAvisoVencimiento) && ajustes.minutosAvisoVencimiento >= 1 && ajustes.minutosAvisoVencimiento <= 30;
            if (!camposValidos) return res.status(400).json({ error: 'Revisá los valores de notificaciones y sus límites.' });
            await db.collection('config').doc('push_settings').set({
                activo: ajustes.activo,
                minutosAvisoPrevio: ajustes.minutosAvisoPrevio,
                minutosAvisoVencimiento: ajustes.minutosAvisoVencimiento,
                actualizadoEn: admin.firestore.FieldValue.serverTimestamp(),
                actualizadoPor: sesion.uid
            }, { merge: true });
            return res.status(200).json({ ok: true });
        }

        if (accion === 'listar') {
            const snap = await db.collection('usuarios').limit(500).get();
            return res.status(200).json({ usuarios: snap.docs.map(d => ({ uid: d.id, ...d.data() })) });
        }
        if (accion === 'crear') {
            const nombreUsuario = String(usuario || '').trim().toLowerCase();
            const nombreVisible = String(nombre || '').trim();
            const listaPlantas = Array.isArray(plantas) ? [...new Set(plantas.filter(p => typeof p === 'string' && p && p !== '*'))] : [];
            if (!/^[a-z0-9._-]{3,40}$/.test(nombreUsuario) || !nombreVisible || !['gerente', 'operador'].includes(rol) || !clave || clave.length < 8 || !listaPlantas.length) {
                return res.status(400).json({ error: 'Revisá usuario, nombre, rol, plantas y contraseña (mínimo 8 caracteres).' });
            }
            const existentes = await db.collection('plantas').get();
            const validas = new Set(existentes.docs.map(d => d.id));
            if (listaPlantas.some(p => !validas.has(p))) return res.status(400).json({ error: 'Una planta seleccionada no existe.' });
            const nuevo = await admin.auth().createUser({ email: `${nombreUsuario}@rondas.meatex`, password: clave, displayName: nombreVisible });
            try {
                await admin.auth().setCustomUserClaims(nuevo.uid, { rol, plantas: listaPlantas });
                await db.collection('usuarios').doc(nuevo.uid).set({ nombre: nombreVisible, usuario: nombreUsuario, rol, plantas: listaPlantas, activo: true, creadoEn: admin.firestore.FieldValue.serverTimestamp() });
            } catch (error) {
                await admin.auth().deleteUser(nuevo.uid);
                throw error;
            }
            return res.status(201).json({ uid: nuevo.uid });
        }
        if (accion === 'clave' || accion === 'estado') {
            if (!uid || uid === sesion.uid) return res.status(400).json({ error: 'El usuario indicado no es válido.' });
            const objetivoRef = db.collection('usuarios').doc(uid);
            const objetivoSnap = await objetivoRef.get();
            if (!objetivoSnap.exists || objetivoSnap.data().rol === 'superadmin') return res.status(404).json({ error: 'No se encontró un usuario administrable.' });
            if (accion === 'clave') {
                if (!clave || clave.length < 8) return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres.' });
                await admin.auth().updateUser(uid, { password: clave });
                await admin.auth().revokeRefreshTokens(uid);
            } else {
                if (typeof activo !== 'boolean') return res.status(400).json({ error: 'Estado inválido.' });
                await admin.auth().updateUser(uid, { disabled: !activo });
                await admin.auth().revokeRefreshTokens(uid);
                await objetivoRef.update({ activo });
            }
            return res.status(200).json({ ok: true });
        }
        return res.status(400).json({ error: 'Acción no válida.' });
    } catch (error) {
        console.error('[Usuarios] Error:', error);
        return res.status(500).json({ error: error.code === 'auth/email-already-exists' ? 'Ese nombre de usuario ya existe.' : 'No se pudo completar la operación.' });
    }
};
