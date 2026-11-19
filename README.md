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
- `push-sender/`: emisor alternativo ejecutable manualmente desde GitHub Actions; usa el secreto `FIREBASE_SERVICE_ACCOUNT`.
- El encargado puede cambiar el nombre de un punto sin alterar su código QR. Las pestañas separan Puntos de control y Programación de horarios; en esta última se pueden seleccionar varios puntos en el mapa y asignarles los mismos días, hora y tolerancia.
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
- El workflow `.github/workflows/push-sender.yml` permite ejecución manual. La programación de producción se realiza en cron-job.org llamando a `/api/push`.

## Datos y reglas de negocio

Colecciones principales: `operadores`, `puntos_control`, `rutas_horarias`, `registros_ronda` y `dispositivos_notificaciones`; los emisores usan además `config` para cursor y cooldowns.

- El QR debe coincidir exactamente con el código registrado.
- Una ruta aplica si corresponde al día actual o tiene día `Todos`.
- Cada horario requiere su propio registro `OK`; advertencias y críticos no completan la ruta.
- Severidades: `OK`, `ADVERTENCIA` (fuera de horario) y `CRITICO` (GPS fuera de tolerancia o punto no programado). Los QR desconocidos se muestran como críticos y no se guardan.
- Máximo 20 puntos y 30 operadores.
- Los nombres de los puntos se pueden editar; el código QR es inmutable. La programación permite seleccionar varias ubicaciones en un mapa online y crear sus horarios para los días elegidos.
- La retención prevista es de 60 días. La app borra como máximo 2.000 registros antiguos por carga; el emisor alternativo también ejecuta una limpieza diaria acotada.
- La exportación XLSX admite hasta 10.000 registros.

## Offline

El Service Worker precarga la navegación y guarda recursos del mismo origen después de obtenerlos online. No cachea las importaciones de Firebase servidas desde `gstatic.com` ni habilita persistencia local de Firestore. Por eso no se garantiza abrir o recargar la app sin conexión. Con la app ya cargada y sus catálogos disponibles, los escaneos cuyo envío falla se guardan en `localStorage` y se reintentan al reconectar.

## Notificaciones push

Para registrar tokens FCM se debe configurar una clave pública VAPID en `VAPID_KEY` dentro de `src/main.js`; actualmente está vacía. El Service Worker procesa mensajes en segundo plano.

Hay dos emisores alternativos:

1. cron-job.org invoca `GET https://controlporteria.vercel.app/api/push` según el intervalo configurado. Debe enviar `Authorization: Bearer <CRON_SECRET>`.
2. La función `api/push.js` requiere las variables de entorno `FIREBASE_SERVICE_ACCOUNT` y `CRON_SECRET` en Vercel. También acepta `POST`, pero ambos métodos requieren el encabezado de autorización.
3. GitHub Actions conserva una ejecución manual alternativa; su workflow no tiene programación automática para evitar dos emisores simultáneos.

## Seguridad y limitaciones

- Firestore no usa Firebase Auth y las reglas actuales permiten lectura/escritura abierta en las colecciones incluidas; cualquier cliente puede acceder a esos datos.
- La clave del encargado (`admin123`) está en el JavaScript del cliente y no constituye autenticación segura.
- El secreto del endpoint serverless protege la invocación del emisor, pero no reemplaza la autenticación de Firestore.
- No hay pruebas de integración de navegador. `npm test` ejecuta validadores estáticos/contractuales y pruebas unitarias de módulos puros.
- La carpeta `dist/` es generada por Vite y no debe editarse a mano.
