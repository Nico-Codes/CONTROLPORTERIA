# Documentación técnica y funcional

## Control de Rondas – Meatex

Estado documentado: 19 de noviembre de 2026. Código base: commit `060002e68efb7d602dd829c14ca697e02296eb17`.

## 1. Resumen

Aplicación web progresiva para registrar rondas de vigilancia. El operador selecciona su nombre, escanea el QR de un punto y la aplicación compara su posición GPS y la hora con las rutas programadas. El encargado consulta auditorías, administra puntos, rutas y operadores, y exporta registros.

La interfaz es estática. El navegador se comunica directamente con Firestore y Firebase Cloud Messaging. Vite construye la aplicación para Vercel; Firebase Hosting redirige al sitio de Vercel.

## 2. Arquitectura y archivos

```text
index.html                    Markup y entrada de Vite
src/main.js                   Aplicación: operador, encargado, Firebase y UI
src/domain/rondas.js          Reglas puras de cumplimiento de rutas
src/utils/geo.js              Distancia Haversine y tolerancia GPS
src/utils/format.js           Formato y escape de texto HTML
src/styles.css                Estilos propios
public/manifest.json          Metadata PWA e iconos
public/firebase-messaging-sw.js Service Worker, cache del mismo origen y FCM
firestore.rules               Reglas de Firestore versionadas
api/push.js                   Emisor serverless de Vercel
push-sender/index.js           Emisor alternativo para GitHub Actions
tests/                        Validadores y pruebas unitarias
```

`index.html` carga `/src/main.js` como módulo. La implementación inline duplicada que existía en el HTML fue retirada para que la app tenga un solo punto de entrada.

### Tecnologías

- JavaScript nativo con módulos ES; no hay framework frontend.
- Vite 8 para desarrollo y build; salida en `dist/`.
- Tailwind CSS, Font Awesome, html5-qrcode, qrcode-generator y SheetJS por CDN.
- Firebase Web SDK 10.12.2 por CDN de `gstatic.com`; Firebase Admin se usa solo en los emisores de push.
- Vitest para pruebas de módulos puros; scripts Node para contratos estáticos.

## 3. Roles y operación

### Operador

1. Selecciona un operador activo; la selección se guarda en `localStorage`.
2. Consulta la agenda del día y el progreso de las rutas.
3. Escanea un QR. La aplicación busca el punto por coincidencia exacta de código, obtiene posición GPS y evalúa ruta, horario y radio.
4. Un QR desconocido se muestra como `CRITICO` y no se guarda.
5. Un QR conocido genera un registro aun si queda como advertencia o crítico, para conservar la incidencia.

### Encargado

La sesión de la interfaz se guarda en `sessionStorage`. El panel tiene las secciones Auditoría, Puntos de control, Programación de horarios y Personal. Permite filtrar registros, administrar rutas y operadores, activar/desactivar operadores, generar QR, consultar métricas y exportar XLSX.

La contraseña `admin123` está en código cliente. Es una barrera visual de la interfaz, no un mecanismo de autenticación seguro.

## 4. Reglas de rondas

- Cada punto se identifica por el texto exacto de su QR.
- Las rutas aplicables son las del día actual o las marcadas `Todos`.
- Para completar una ruta se requiere un registro `OK` que corresponda a su `rutaId`; los registros históricos sin ese ID pueden asociarse por QR y hora programada.
- Cada horario de un punto requiere su propio escaneo válido. Advertencias y críticos no completan rutas.
- `OK`: QR registrado, dentro del radio GPS y dentro del margen horario.
- `ADVERTENCIA`: ubicación correcta pero fuera del margen horario.
- `CRITICO`: QR registrado fuera del radio GPS o punto no programado para el día.
- Límites de interfaz: 20 puntos y 30 operadores.

La distancia GPS se calcula con Haversine. El radio predeterminado es 25 m cuando el punto no contiene una tolerancia válida.

## 5. Datos de Firestore

| Colección | Uso y campos relevantes |
|---|---|
| `puntos_control` | Punto de control: nombre editable, código QR estable, latitud, longitud y tolerancia. |
| `rutas_horarias` | Día, código QR, nombre del punto, hora objetivo y margen en minutos. |
| `operadores` | Nombre, legajo, turno y estado activo. |
| `registros_ronda` | Operador, QR/punto, fecha/hora, coordenadas, distancia, tolerancia, ruta aplicada, margen, estado, severidad y fechas de creación/expiración. |
| `dispositivos_notificaciones` | Token FCM, rol y datos asociados al dispositivo. |
| `config` | Cursor y marcas de cooldown/limpieza de los emisores. |

Los nuevos registros incluyen `timestampMs`, `fechaISO`, `rutaId`, `diaRuta`, `margen`, `tolerancia`, `creadoEn` y `expiraEn`. El historial conserva el margen y la tolerancia aplicados cuando se produjo el escaneo.

## 6. Panel y exportación

El encargado puede cambiar el nombre de un punto sin alterar su código QR. Los horarios asociados reciben el nombre actualizado; los registros históricos conservan el nombre guardado al momento del escaneo. En la pestaña Programación de horarios se pueden seleccionar varios puntos desde el mapa Leaflet con cartografía de OpenStreetMap y asignarles en conjunto los mismos días, hora y margen. Se crea una programación independiente por cada combinación de punto y día. El mapa requiere Internet y muestra su atribución.

El panel consulta registros del día seleccionado con un máximo configurado de 2.000 por carga. Los filtros incluyen operador, severidad/estado y texto de búsqueda. Los KPI se calculan con los registros disponibles en el cache del día seleccionado.

La exportación `.xlsx` crea las hojas `Rondas`, `Resumen` y `Por operador`, con límite de 10.000 registros. Para el día actual toma la ventana de retención de 60 días; para una fecha histórica seleccionada exporta ese día. Aplica los filtros activos.

## 7. Retención

La aplicación calcula un corte de 60 días usando `timestampMs` y, al iniciar con conexión, elimina hasta cinco lotes de 400 registros (máximo 2.000 por carga). El emisor de GitHub Actions también tiene una limpieza diaria acotada. Los registros históricos sin `expiraEn` pueden limpiarse porque la consulta usa `timestampMs`.

No hay TTL de Firestore configurado. La limpieza en cliente y emisor requiere permisos de borrado en las reglas actuales.

## 8. Offline y Service Worker

El Service Worker precarga rutas/recursos del mismo origen y aplica network-first a navegación; otros recursos del mismo origen se cachean tras una respuesta exitosa. Ignora solicitudes a otros orígenes, incluidas las importaciones de Firebase desde `gstatic.com`.

Si Firestore rechaza o no puede completar el envío de un registro, el cliente guarda el objeto en `localStorage` bajo `cola_rondas_offline` y reintenta al recibir el evento `online`. Las fechas se reconstruyen antes de reenviar.

Esto no equivale a soporte offline completo: no se configura persistencia local de Firestore, los recursos CDN de Firebase no se cachean y una apertura en frío sin red no está garantizada. Para escanear sin red la app debe estar cargada y tener los catálogos necesarios disponibles en memoria.

## 9. Notificaciones

El navegador registra `/firebase-messaging-sw.js` y solicita un token FCM. La clave `VAPID_KEY` de `src/main.js` está vacía en el commit documentado; debe configurarse para habilitar correctamente el registro web push. El Service Worker muestra notificaciones recibidas en segundo plano.

Los emisores ejecutan dos grupos de trabajo: alertas proactivas de rutas próximas/vencidas y notificaciones por registros recientes `ADVERTENCIA` o `CRITICO`. Se guarda un cursor y cooldown en `config` para controlar la repetición.

### Emisores disponibles

- **cron-job.org → Vercel Function:** cron-job.org llama `GET https://controlporteria.vercel.app/api/push` según su programación. Debe enviar `Authorization: Bearer <CRON_SECRET>`. Vercel requiere las variables `FIREBASE_SERVICE_ACCOUNT` y `CRON_SECRET`.
- **GitHub Actions:** `.github/workflows/push-sender.yml` permite ejecución manual de `push-sender/` como alternativa; no tiene cron automático para evitar dos emisores simultáneos.

No se deben ejecutar ambos emisores simultáneamente sin evaluar duplicados y cooldowns compartidos.

## 10. Seguridad y privacidad

Las reglas actuales permiten acceso abierto de lectura/escritura a catálogos, dispositivos y configuración; permiten lectura, creación y borrado de registros, pero niegan su actualización. No hay Firebase Auth. Como resultado, una persona con acceso al proyecto Firebase puede leer o alterar datos independientemente de la contraseña de la UI.

El endpoint serverless usa `CRON_SECRET` para limitar invocaciones. Esto protege ese endpoint, pero no restringe el acceso directo a Firestore. La cuenta de servicio debe guardarse únicamente en secretos de GitHub/Vercel y nunca en el frontend.

La selección de operador no verifica identidad. Desactivar un operador lo oculta de la vista/selector; eliminarlo no elimina su historial de escaneos.

## 11. Instalación y despliegue

```bash
npm install
npm run dev
npm run build
npm run preview
npm test
```

Vite usa `index.html` en la raíz y publica `dist/`. Vercel sirve ese directorio y la función `api/push.js`. Firebase Hosting está configurado para redirigir `/` y `/index.html` a `https://controlporteria.vercel.app/`. Las reglas se despliegan con `firebase deploy --only firestore:rules`.

## 12. Pruebas

`npm test` ejecuta `tests/validar-index.mjs`, `tests/validar-reglas.mjs` y Vitest sobre `tests/unit/`. Hay pruebas unitarias para rondas, geografía y formato. Los validadores estáticos comprueban patrones del HTML/JavaScript y contratos de negocio; no prueban el navegador real, Firestore remoto, permisos móviles ni la entrega de push.

## 13. Limitaciones conocidas

- Doble control de acceso insuficiente para producción: clave de encargado en el cliente y reglas Firestore abiertas.
- No hay autenticación de operadores.
- La clave VAPID está vacía por defecto.
- La app no garantiza arranque offline ni persistencia local de Firestore.
- Los emisores y la app dependen de servicios externos/CDN y conectividad para sincronizar.
- No existen pruebas de extremo a extremo en navegador.
