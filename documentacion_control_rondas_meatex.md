# Documentación técnica y funcional

## Control de Rondas – Meatex

Revisado el 20 de noviembre de 2026 contra el commit `0fa3c5088ec674abf4a14837b98ca5bef8c9ac6b`.

## 1. Resumen

Aplicación web progresiva para registrar rondas de vigilancia. El operador selecciona su nombre, escanea el QR de un punto y la aplicación compara su posición GPS y la hora con las rutas programadas. El encargado consulta auditorías, administra puntos, rutas y operadores, y exporta registros.

Al abrir la app, un gate de permisos exige instalar la PWA (en móvil), habilitar notificaciones y permitir la ubicación precisa antes de mostrar el contenido.

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

El único punto de entrada activo es `index.html` → `src/main.js`. `src/supervisor.js` puede aparecer como archivo local sin seguimiento, pero no forma parte de la entrada versionada. No se deben seguir sus imports incompletos ni editar `dist/`, que se genera al construir.

## 3. Roles y operación

### Acceso inicial y permisos

Antes de mostrar la vista de operador o el panel, la app presenta un gate de permisos obligatorios:

- **Instalación:** solo en móvil y solo si la app no se abrió como PWA instalada. Usa el prompt del navegador o muestra instrucciones para "Agregar a pantalla de inicio" cuando el prompt no está disponible.
- **Notificaciones:** solicita el permiso y registra el token FCM. Si el usuario lo deniega, el gate lo informa y no permite continuar.
- **Ubicación precisa:** solicita una lectura GPS con alta precisión. Sin ella no se puede validar la distancia al punto.

El botón **Continuar** permanece deshabilitado hasta que los tres requisitos estén en **OK**. Si el navegador no soporta notificaciones o geolocalización, el requisito correspondiente se considera cumplido para no bloquear la app. Si un permiso fue bloqueado, debe rehabilitarse desde la configuración del navegador.

### Operador

1. Selecciona un operador activo; la selección se guarda en `localStorage`.
2. Consulta la agenda del día y el progreso de las rutas.
3. Escanea un QR. La aplicación busca el punto por coincidencia exacta de código, obtiene posición GPS y evalúa ruta, horario y radio.
4. Un QR desconocido se muestra como `CRITICO` y no se guarda.
5. Un QR conocido genera un registro aun si queda como advertencia o crítico, para conservar la incidencia.

### Encargado

La sesión se gestiona con **Firebase Authentication** (email/contraseña con email sintético `usuario@rondas.meatex`). El panel tiene las secciones Auditoría, Puntos de control, Programación de horarios y Personal. Permite filtrar registros, administrar rutas y operadores, activar/desactivar operadores, generar QR, consultar métricas y exportar XLSX.

Roles:
- **Superadmin:** gestión total (plantas, usuarios, contraseñas, datos).
- **Gerente:** gestión de su planta (puntos, rutas, operadores).
- **Operador:** escaneo de QR y consulta de agenda.

No hay auto-registro: el superadmin crea los usuarios con `tools/crear_superadmin.js` (o el panel, en fases posteriores).

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
| `puntos_control` | Documento con nombre editable, código QR estable, latitud, longitud y tolerancia GPS en metros. El código QR identifica al punto. |
| `rutas_horarias` | Un documento por punto y día: `dia`, `codigoQR`, `puntoNombre`, `hora` y `margen` en minutos. Programar varios puntos crea documentos separados por cada combinación de punto y día. |
| `operadores` | Nombre, legajo, turno y estado activo. Desactivar conserva el documento y el historial; eliminar al operador no borra sus registros. |
| `registros_ronda` | Operador, QR/punto, fecha/hora, coordenadas, distancia, tolerancia, ruta aplicada, margen, estado, severidad y fechas de creación/expiración. El cliente crea y lee registros; las reglas niegan su actualización y permiten su borrado para retención. |
| `dispositivos_notificaciones` | Token FCM, rol, fecha de alta y datos asociados al dispositivo. |
| `config` | Cursor de registros procesados, marcas de limpieza y cooldowns de notificaciones proactivas. |

Los nuevos registros incluyen `timestampMs`, `fechaISO`, `rutaId`, `diaRuta`, `margen`, `tolerancia`, `creadoEn` y `expiraEn`. El historial conserva el margen y la tolerancia aplicados cuando se produjo el escaneo.

## 6. Panel y exportación

El encargado puede cambiar el nombre de un punto sin alterar su código QR. Los horarios asociados reciben el nombre actualizado; los registros históricos conservan el nombre guardado al momento del escaneo. En la pestaña Programación de horarios se pueden seleccionar varios puntos desde el mapa Leaflet con imágenes satelitales de Esri (sin API key) y asignarles en conjunto los mismos días, hora y margen. Se crea una programación independiente por cada combinación de punto y día. El mapa requiere Internet y muestra su atribución.

La barra superior del panel permite retroceder o avanzar de a un día y abrir un calendario. El selector no admite fechas futuras; el mínimo es la fecha del registro más antiguo disponible. Si se elige un día sin registros, el panel avisa y vuelve a la fecha anterior.

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

El navegador registra `/firebase-messaging-sw.js` y solicita un token FCM. En la revisión de este documento `VAPID_KEY` en `src/main.js` está vacía. Para Web Push se debe configurar allí la clave pública VAPID del proyecto Firebase; es una clave pública de cliente, no debe confundirse con una clave privada. Sin ella, el registro web push puede fallar o depender de la configuración predeterminada del SDK. El Service Worker muestra notificaciones recibidas en segundo plano. El navegador requiere permiso del usuario y un contexto seguro (HTTPS o localhost). El gate inicial solicita el permiso de notificaciones y registra el token FCM; si el usuario lo deniega, no puede continuar hasta habilitarlo.

Los emisores ejecutan dos grupos de trabajo: alertas proactivas de rutas próximas/vencidas y notificaciones por registros recientes `ADVERTENCIA` o `CRITICO`. Se guarda un cursor y cooldown en `config` para controlar la repetición.

### Emisores disponibles

- **cron-job.org → Vercel Function (emisor principal):** cron-job.org llama `GET https://controlporteria.vercel.app/api/push` según el intervalo configurado. Debe enviar `Authorization: Bearer <CRON_SECRET>`. Vercel requiere las variables `FIREBASE_SERVICE_ACCOUNT` y `CRON_SECRET`. La función acepta GET y POST; otros métodos devuelven 405, secreto faltante 503 y autorización inválida 401. La cuenta de servicio acepta JSON o JSON codificado en Base64.
- **GitHub Actions (alternativa manual):** `.github/workflows/push-sender.yml` solo se ejecuta con `workflow_dispatch`; no tiene cron automático. Lee el secreto `FIREBASE_SERVICE_ACCOUNT` y ejecuta `push-sender/`.

El emisor de Vercel agrupa avisos previos cuando faltan de 3 a 12 minutos, avisos próximos al vencimiento dentro de los últimos 5 minutos y alertas de incumplimiento después del margen. El emisor alternativo de GitHub usa ventanas distintas: aviso previo entre 7 y 9 minutos y aviso de vencimiento dentro de los últimos 3 minutos. Ambos limpian como máximo tres lotes de 400 registros por ejecución diaria. Mantener un solo emisor automático evita duplicados; la ejecución manual de GitHub también puede coincidir con cron-job.org.

Los emisores calculan la fecha/hora operativa con un desplazamiento fijo UTC-3. Si cambia la zona horaria de operación o sus reglas, debe revisarse esta conversión en ambos emisores.

No se deben ejecutar ambos emisores simultáneamente sin evaluar duplicados y cooldowns compartidos.

## 10. Seguridad y privacidad

La app usa **Firebase Authentication** (email/contraseña). Las reglas de Firestore exigen `request.auth != null` para todas las colecciones. Los perfiles de usuario (`usuarios/{uid}`) solo son legibles por su propio dueño; su escritura está denegada desde el cliente (solo Admin SDK).

El endpoint serverless usa `CRON_SECRET` para limitar invocaciones. Esto protege ese endpoint, pero no reemplaza la autenticación de Firestore. La cuenta de servicio debe guardarse únicamente en secretos de GitHub/Vercel y nunca en el frontend.

El primer superadmin se crea con `tools/crear_superadmin.js` (requiere `FIREBASE_SERVICE_ACCOUNT`). No hay auto-registro.

La selección de operador no verifica identidad. Desactivar un operador lo oculta de la vista/selector; eliminarlo no elimina su historial de escaneos.

## 11. Instalación y despliegue

```bash
npm install
npm run dev
npm run build
npm run preview
npm test
```

Vite usa `index.html` en la raíz y genera `dist/`. Vercel sirve ese directorio y la función `api/push.js`; el proyecto está conectado a GitHub para desplegar la rama `main`. Firebase Hosting está configurado para redirigir `/` y `/index.html` a `https://controlporteria.vercel.app/`. Las reglas se despliegan por separado con `firebase deploy --only firestore:rules`. Consultar `GUIA_OPERATIVA.md` para configuración y diagnóstico de despliegue y cron.

## 12. Pruebas

`npm test` ejecuta `tests/validar-index.mjs`, `tests/validar-reglas.mjs` y Vitest sobre `tests/unit/`. Hay pruebas unitarias para rondas, geografía y formato. Los validadores estáticos comprueban patrones del HTML/JavaScript y contratos de negocio; no prueban el navegador real, Firestore remoto, permisos móviles ni la entrega de push.

## 13. Limitaciones conocidas

- La autenticación usa Firebase Auth con emails sintéticos (`usuario@rondas.meatex`). La gestión de usuarios (Fase 3) aún no está implementada en el panel; se crea el superadmin por script.
- El multi-planta (Fase 2) aún no está implementado; los datos siguen en colecciones top-level.
- La clave VAPID está vacía por defecto.
- La app no garantiza arranque offline ni persistencia local de Firestore.
- Los emisores y la app dependen de servicios externos/CDN y conectividad para sincronizar.
- No existen pruebas de extremo a extremo en navegador.

## 14. Documentos de mantenimiento

- `README.md`: presentación breve, reglas principales y comandos de desarrollo.
- `documentacion_control_rondas_meatex.md`: arquitectura, flujos, modelo de datos, seguridad, retención, push y pruebas.
- `GUIA_OPERATIVA.md`: configuración de servicios, despliegue, cron-job.org y resolución de problemas frecuentes.
- `output/pdf/Manual_Tecnico_Control_Rondas_Meatex.pdf` y `output/pdf/Guia_Operativa_Control_Rondas_Meatex.pdf`: ediciones PDF de los manuales; regenerar cuando cambie el Markdown correspondiente.
- `tools/generar_pdf.py`: regenera ambos PDF desde los Markdown; requiere Python 3 y `reportlab`.
- `tools/crear_superadmin.js`: crea el primer superadmin (requiere `FIREBASE_SERVICE_ACCOUNT`).
