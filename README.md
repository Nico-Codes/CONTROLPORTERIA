# Control de Rondas – Meatex

PWA estática para registrar y auditar rondas de vigilancia mediante códigos QR, GPS y ventanas horarias. Toda la aplicación vive en `public/index.html` y usa Firebase Hosting + Firestore directamente desde el navegador.

## Estado actual

- `index.html`: punto de entrada de Vite (HTML + referencias a `src/`).
- `src/main.js`: toda la lógica de la aplicación (módulo ES).
- `src/styles.css`: estilos propios (el resto usa Tailwind CDN).
- `public/`: archivos estáticos servidos en la raíz (`manifest.json`, iconos, `firebase-messaging-sw.js`, `404.html`).
- `api/push.js`: función serverless de Vercel (emisor de push).
- `push-sender/`: script equivalente para ejecución local o cron externo.
- `firestore.rules`: reglas de Firestore versionadas.
- `tests/`: validación estática y pruebas de contrato.
- `vite.config.mjs`: configuración de Vite.
- `tests/validar-reglas.mjs`: pruebas de contrato de las reglas de negocio y de Firestore.
- `package.json`: scripts de prueba y servidor local (sin dependencias).

No hay build ni tests de navegador. El repositorio Git está inicializado en la rama `main`.

## Desarrollo local

```bash
npm install
npm run dev        # servidor de desarrollo Vite (http://localhost:5173)
npm run build      # genera dist/ para producción
npm run preview    # previsualiza el build
npm test           # validación estática + pruebas de contrato
```

## Despliegue

- **Vercel:** importá el repo en Vercel. Detecta Vite automáticamente, ejecuta `npm run build` y sirve `dist/`. La función `api/push.js` se despliega como serverless.
- **Firebase:** las reglas de Firestore se despliegan con `firebase deploy --only firestore:rules`. El hosting de Firebase redirige a Vercel.

## Firestore

### Reglas

El archivo `firestore.rules` reproduce las reglas actuales del proyecto y agrega la colección que faltaba:

- `operadores`, `puntos_control` y `rutas_horarias`: lectura y escritura.
- `registros_ronda`: lectura, creación y borrado (la app borra en lotes los registros de más de 60 días); no se permite modificar.
- `dispositivos_notificaciones`: lectura y escritura (necesario para guardar los tokens FCM).

> Las reglas siguen siendo abiertas porque la aplicación no usa Firebase Auth. Cualquier persona con la URL puede escribir en las colecciones. Endurecerlas requiere implementar autenticación.

### Retención de 60 días

Los registros nuevos guardan `expiraEn` (timestamp) y la aplicación elimina en lotes los registros con más de 60 días al cargar. La limpieza corre en segundo plano, sin bloquear el panel, y borra hasta 2.000 registros por carga.

> La política TTL de Firestore sería la opción ideal, pero el proyecto tiene la facturación deshabilitada y la API administrativa devuelve `403 billing disabled`. Si en el futuro se habilita el plan Blaze, se puede activar TTL sobre `expiraEn` y quitar el borrado desde la app.

Los registros históricos anteriores a este cambio no tienen `expiraEn`, pero sí `timestampMs`, por lo que la limpieza por fecha también los alcanza.

### Límites operativos

- Máximo **20 puntos de control**.
- Máximo **30 operadores** (activos o inactivos).
- Límite de lectura diaria del panel: **2.000 registros**.
- Límite de exportación XLSX: **10.000 registros**.

## Reglas de negocio

- Cada punto se identifica por el texto exacto de su QR.
- El GPS se valida con distancia Haversine contra la tolerancia del punto (por defecto 25 m).
- La ruta aplica si su día coincide con el día actual o si es `"Todos"`.
- **Cada horario programado exige su propio escaneo válido**. Si un punto tiene 3 horarios el mismo día, deben hacerse 3 escaneos dentro de sus respectivos márgenes. Un escaneo no completa los otros horarios.
- Estados: `OK` (válido), `ADVERTENCIA` (fuera de horario) y `CRITICO` (fuera de rango GPS o punto no programado).
- Un QR desconocido se muestra como crítico, pero no se persiste.
- Los operadores pueden **desactivarse** (dejan de aparecer en la vista operador) o **eliminarse** (el historial de escaneos se conserva).

## Exportación

El botón **Exportar rondas** genera un archivo `.xlsx` con tres hojas:

- `Rondas`: detalle de registros.
- `Resumen`: totales por severidad.
- `Por operador`: escaneos, válidos, advertencias, críticos y porcentaje de válidos.

Si el panel está en el día actual, exporta los últimos 60 días. Si se navegó a una fecha anterior, exporta ese día. Se aplican los filtros de operador, estado y búsqueda activos.

## Notificaciones

La app solo muestra **notificaciones del sistema** (bandeja del teléfono). Se eliminó el banner interno de la aplicación.

Para push real con la app cerrada se necesita:

1. Una clave pública VAPID de Firebase Console → Cloud Messaging → **Certificados push web**.
2. Pegarla en la constante `VAPID_KEY` de `public/index.html`.
3. Un emisor de push (Cloud Function, servidor o cron job) que lea los tokens de `dispositivos_notificaciones` y envíe los mensajes. Este repositorio incluye un emisor gratuito basado en Vercel + cron-job.org (cada 1 minuto).

Sin VAPID, `getToken()` falla y no se registran tokens nuevos. El código actual registra el error en consola y continúa.

## Validación

```bash
node tests/validar-index.mjs
node tests/validar-reglas.mjs
# o simplemente
npm test
```

`validar-index.mjs` detecta:

- `getElementById()` que apunta a IDs inexistentes.
- IDs duplicados.
- Handlers inline (`onclick`, `onchange`, etc.) sin función definida.

`validar-reglas.mjs` congela las reglas de negocio críticas: límites, retención, escaneo por horario, métricas reales del panel, exportación y reglas de Firestore.

También se puede validar la sintaxis del JavaScript extrayendo el `<script type="module">` y ejecutando `node --check`.

## Limitaciones conocidas

- La contraseña del encargado (`admin123`) está en el código y no hay Firebase Auth.
- Las reglas de Firestore son abiertas.
- No hay cache de app shell: sin internet la app no carga de forma fiable, aunque los escaneos ya abiertos se encolan en `localStorage`.
- No hay pipeline de despliegue; se despliega con Firebase CLI.
- No hay tests automatizados de reglas de negocio; solo validación estática.
