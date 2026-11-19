# Control de Rondas – Meatex

PWA estática para registrar y auditar rondas de vigilancia mediante códigos QR, GPS y horarios programados. La interfaz está en `index.html`, la lógica principal en `src/main.js` y Firebase se consume directamente desde el navegador mediante módulos CDN.

## Estructura

- `index.html`: markup y punto de entrada Vite. Carga `src/main.js`.
- `src/main.js`: flujos de operador y encargado, Firestore, cámara, GPS, notificaciones y exportación.
- `src/domain/` y `src/utils/`: lógica pura de rondas, geografía y formato.
- `src/styles.css`: estilos propios; Tailwind se carga por CDN.
- `public/`: manifest, iconos, Service Worker FCM y 404.
- `firestore.rules`: reglas versionadas de Firestore.
- `api/push.js`: endpoint de push para Vercel; requiere `CRON_SECRET` y `FIREBASE_SERVICE_ACCOUNT`.
- `push-sender/`: emisor alternativo ejecutado por GitHub Actions cada cinco minutos; usa el secreto `FIREBASE_SERVICE_ACCOUNT`.
- `tests/`: validadores estáticos/contractuales y pruebas unitarias Vitest.

## Desarrollo

Requiere Node.js y npm.

```bash
npm install
npm run dev       # Vite en http://localhost:5173
npm run build     # genera dist/
npm run preview   # sirve el build local
npm test          # validadores y pruebas unitarias
```

## Despliegue

- **Vercel** sirve el build de Vite desde `dist/` y publica `api/push.js` como función serverless.
- **Firebase Hosting** redirige `/` y `/index.html` al dominio de Vercel. Las reglas se despliegan con `firebase deploy --only firestore:rules`.
- El workflow `.github/workflows/push-sender.yml` se ejecuta con cron cada cinco minutos (GitHub puede retrasar la ejecución). También permite ejecución manual.

## Datos y reglas de negocio

Colecciones principales: `operadores`, `puntos_control`, `rutas_horarias`, `registros_ronda` y `dispositivos_notificaciones`; los emisores usan además `config` para cursor y cooldowns.

- El QR debe coincidir exactamente con el código registrado.
- Una ruta aplica si corresponde al día actual o tiene día `Todos`.
- Cada horario requiere su propio registro `OK`; advertencias y críticos no completan la ruta.
- Severidades: `OK`, `ADVERTENCIA` (fuera de horario) y `CRITICO` (GPS fuera de tolerancia o punto no programado). Los QR desconocidos se muestran como críticos y no se guardan.
- Máximo 20 puntos y 30 operadores.
- La retención prevista es de 60 días. La app borra como máximo 2.000 registros antiguos por carga; el emisor alternativo también ejecuta una limpieza diaria acotada.
- La exportación XLSX admite hasta 10.000 registros.

## Offline

El Service Worker precarga la navegación y guarda recursos del mismo origen después de obtenerlos online. No cachea las importaciones de Firebase servidas desde `gstatic.com` ni habilita persistencia local de Firestore. Por eso no se garantiza abrir o recargar la app sin conexión. Con la app ya cargada y sus catálogos disponibles, los escaneos cuyo envío falla se guardan en `localStorage` y se reintentan al reconectar.

## Notificaciones push

Para registrar tokens FCM se debe configurar una clave pública VAPID en `VAPID_KEY` dentro de `src/main.js`; actualmente está vacía. El Service Worker procesa mensajes en segundo plano.

Hay dos emisores alternativos:

1. GitHub Actions ejecuta `push-sender/` cada cinco minutos y requiere el secreto de repositorio `FIREBASE_SERVICE_ACCOUNT`.
2. La función `api/push.js` requiere las variables de entorno `FIREBASE_SERVICE_ACCOUNT` y `CRON_SECRET`. Acepta `GET` (método usado por Vercel Cron) y `POST`; ambos requieren `Authorization: Bearer <CRON_SECRET>`. No hay una programación `crons` declarada en el `vercel.json` versionado; la configuración externa del proyecto debe apuntar a `/api/push`.

## Seguridad y limitaciones

- Firestore no usa Firebase Auth y las reglas actuales permiten lectura/escritura abierta en las colecciones incluidas; cualquier cliente puede acceder a esos datos.
- La clave del encargado (`admin123`) está en el JavaScript del cliente y no constituye autenticación segura.
- El secreto del endpoint serverless protege la invocación del emisor, pero no reemplaza la autenticación de Firestore.
- No hay pruebas de integración de navegador. `npm test` ejecuta validadores estáticos/contractuales y pruebas unitarias de módulos puros.
- La carpeta `dist/` es generada por Vite y no debe editarse a mano.
