// Migra los datos existentes (colecciones top-level) a una planta con subcolecciones.
//
// Requiere:
//   - Node.js
//   - npm install firebase-admin (ya está en package.json)
//   - Variable de entorno FIREBASE_SERVICE_ACCOUNT
//
// Uso:
//   node tools/migrar_planta.js <plantaId> <nombrePlanta> [--dry-run]
//
// Ejemplo:
//   node tools/migrar_planta.js carcaraña2 "Meatex Carcaraña 2"
//   node tools/migrar_planta.js carcaraña2 "Meatex Carcaraña 2" --dry-run
//
// Colecciones migradas: puntos_control, operadores, rutas_horarias, registros_ronda.
// Los datos originales NO se borran; se copian a las subcolecciones de la planta.
// Después de verificar, se pueden borrar las colecciones top-level manualmente.

const admin = require('firebase-admin');

function cargarCredencial() {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) {
        console.error('Falta la variable de entorno FIREBASE_SERVICE_ACCOUNT.');
        process.exit(1);
    }
    let json = raw;
    try {
        const decoded = Buffer.from(raw, 'base64').toString('utf8');
        if (decoded.trim().startsWith('{')) json = decoded;
    } catch (e) {}
    return JSON.parse(json);
}

const credencial = cargarCredencial();
if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(credencial) });
}

const db = admin.firestore();
const dryRun = process.argv.includes('--dry-run');

async function migrarColeccion(plantaId, nombreColeccion) {
    const snap = await db.collection(nombreColeccion).get();
    if (snap.empty) {
        console.log(`  ${nombreColeccion}: sin documentos.`);
        return 0;
    }

    let batch = db.batch();
    let enLote = 0;
    let count = 0;
    let existentes = 0;
    const promesasLotes = [];
    const destino = db.collection('plantas').doc(plantaId).collection(nombreColeccion);
    const destinoSnap = await destino.get();
    const idsDestino = new Set(destinoSnap ? destinoSnap.docs.map(d => d.id) : []);
    snap.forEach(doc => {
        const ref = destino.doc(doc.id);
        if (idsDestino.has(doc.id)) {
            existentes++;
            count++;
            return;
        }
        if (!dryRun) {
            batch.set(ref, doc.data());
            enLote++;
            if (enLote === 450) {
                // Guardar el lote completo antes de iniciar otro para respetar el límite de Firestore.
                promesasLotes.push(batch.commit());
                batch = db.batch();
                enLote = 0;
            }
        }
        count++;
    });
    if (!dryRun && enLote > 0) promesasLotes.push(batch.commit());
    if (!dryRun) await Promise.all(promesasLotes);
    console.log(`  ${nombreColeccion}: ${count - existentes} ${dryRun ? 'por copiar' : 'copiados'}, ${existentes} ya existentes sin cambios.`);
    return count - existentes;
}

async function main() {
    const plantaId = process.argv[2];
    const nombrePlanta = process.argv[3];

    if (!plantaId || !nombrePlanta) {
        console.error('Uso: node tools/migrar_planta.js <plantaId> <nombrePlanta> [--dry-run]');
        process.exit(1);
    }

    console.log(`${dryRun ? '[DRY-RUN] ' : ''}Migrando a planta "${nombrePlanta}" (id: ${plantaId})...`);

    // Crear el documento de la planta.
    if (!dryRun) {
        const plantaRef = db.collection('plantas').doc(plantaId);
        const plantaSnap = await plantaRef.get();
        if (!plantaSnap.exists) await plantaRef.create({
            nombre: nombrePlanta,
            activo: true,
            creadoEn: admin.firestore.FieldValue.serverTimestamp()
        });
    }
    console.log(`  Planta "${nombrePlanta}" ${dryRun ? '(simulada)' : 'creada'}.`);

    // Migrar colecciones.
    const colecciones = ['puntos_control', 'operadores', 'rutas_horarias', 'registros_ronda'];
    let total = 0;
    for (const col of colecciones) {
        total += await migrarColeccion(plantaId, col);
    }

    console.log(`\nTotal: ${total} documentos ${dryRun ? 'pendientes de copiar' : 'copiados'}.`);
    if (dryRun) {
        console.log('Modo dry-run: no se escribió nada. Ejecutá sin --dry-run para aplicar.');
    } else {
        console.log('Migración completada. Verificá los datos en Firestore antes de borrar las colecciones top-level.');
    }
}

main().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
});
