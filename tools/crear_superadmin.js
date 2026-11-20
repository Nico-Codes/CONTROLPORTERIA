// Crea el primer superadmin en Firebase Auth + Firestore.
//
// Requiere:
//   - Node.js
//   - npm install firebase-admin (ya está en package.json)
//   - Variable de entorno FIREBASE_SERVICE_ACCOUNT con el JSON de la cuenta de servicio
//     (o su representación Base64), igual que para api/push.js.
//
// Uso:
//   node tools/crear_superadmin.js <usuario> <contraseña> [nombre]
//
// Ejemplo:
//   node tools/crear_superadmin.js superadmin MiClaveSegura123 "Super Administrador"
//
// El usuario se crea con el email sintético <usuario>@rondas.meatex.
// Después de crearlo, actualizá las reglas de Firestore si aún no lo hiciste.

const admin = require('firebase-admin');

function cargarCredencial() {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) {
        console.error('Falta la variable de entorno FIREBASE_SERVICE_ACCOUNT.');
        process.exit(1);
    }
    let json = raw;
    try {
        // Intentar Base64
        const decoded = Buffer.from(raw, 'base64').toString('utf8');
        if (decoded.trim().startsWith('{')) json = decoded;
    } catch (e) {}
    return JSON.parse(json);
}

const credencial = cargarCredencial();
if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(credencial) });
}

const auth = admin.auth();
const db = admin.firestore();

async function main() {
    const usuario = process.argv[2];
    const clave = process.argv[3];
    const nombre = process.argv[4] || usuario;

    if (!usuario || !clave) {
        console.error('Uso: node tools/crear_superadmin.js <usuario> <contraseña> [nombre]');
        process.exit(1);
    }

    const email = usuario + '@rondas.meatex';

    let userRecord;
    try {
        userRecord = await auth.getUserByEmail(email);
        console.log('El usuario ya existe:', userRecord.uid);
    } catch (e) {
        if (e.code === 'auth/user-not-found') {
            userRecord = await auth.createUser({
                email,
                password: clave,
                displayName: nombre
            });
            console.log('Usuario creado:', userRecord.uid);
        } else {
            throw e;
        }
    }

    // Establecer custom claims (rol superadmin).
    await auth.setCustomUserClaims(userRecord.uid, { rol: 'superadmin', plantas: ['*'] });

    // Crear/actualizar el perfil en Firestore.
    await db.collection('usuarios').doc(userRecord.uid).set({
        nombre,
        rol: 'superadmin',
        plantas: ['*'],
        activo: true,
        creadoEn: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    console.log('Superadmin listo:', usuario, '→', userRecord.uid);
    console.log('Rol: superadmin | Plantas: todas (*)');
}

main().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
});