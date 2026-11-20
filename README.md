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
- `tools/crear_superadmin.js`: crea el primer superadmin (requiere `FIREBASE_SERVICE_ACCOUNT`).
- `tools/generar_pdf.py`: regenera los PDF desde los Markdown (requiere Python 3 y `reportlab`).

## Documentación

- [Manual técnico y funcional](documentacion_control_rondas_meatex.md): arquitectura, uso, datos, seguridad, retención, notificaciones y pruebas.
- [Guía operativa](GUIA_OPERATIVA.md): desarrollo, publicación, configuración de cron-job.org y solución de problemas.
- [Guía de desarrollo para agentes](AGENTS.md): convenciones de código, reglas de negocio congeladas y flujo de trabajo del repositorio.
- [Manual técnico en PDF](output/pdf/Manual_Tecnico_Control_Rondas_Meatex.pdf): edición lista para lectura o distribución; se regenera desde el manual técnico en Markdown.
- [Guía operativa en PDF](output/pdf/Guia_Operativa_Control_Rondas_Meatex.pdf): copia de la guía de despliegue y resolución de problemas.

Los PDF se regeneran con `python tools/generar_pdf.py` (requiere Python 3 y `reportlab`); no se editan a mano.

## Desarrollo

Requiere Node.js y npm.

```bash
npm install
npm run dev       # Vite en http://localhost:5173
npm run build     # genera dist/
npm run preview   # sirve el build local
npm test          # validadores y pruebas unitarias
```

## Acceso y permisos

Antes de mostrar el contenido, la app exige un gate de permisos: instalación (solo en móvil si la app no está instalada), notificaciones y ubicación precisa. El botón **Continuar** se habilita cuando los tres requisitos están en **OK**; si el navegador no soporta notificaciones o geolocalización, ese requisito se considera cumplido. Un permiso bloqueado se debe rehabilitar desde la configuración del navegador.

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
- El selector de fecha del panel no permite fechas futuras y toma como mínimo la fecha del registro más antiguo. Si el día elegido no tiene registros, avisa y vuelve a la fecha anterior.
- La retención prevista es de 60 días. La app borra como máximo 2.000 registros antiguos por carga; el emisor alternativo también ejecuta una limpieza diaria acotada.
- La exportación XLSX admite hasta 10.000 registros.

## Offline

El Service Worker precarga la navegación y guarda recursos del mismo origen después de obtenerlos online. No cachea las importaciones de Firebase servidas desde `gstatic.com` ni habilita persistencia local de Firestore. Por eso no se garantiza abrir o recargar la app sin conexión. Con la app ya cargada y sus catálogos disponibles, los escaneos cuyo envío falla se guardan en `localStorage` y se reintentan al reconectar.

## Autenticación

La app usa **Firebase Authentication** (email/contraseña) con emails sintéticos (`usuario@rondas.meatex`); el usuario solo ingresa su nombre de usuario y contraseña. No hay auto-registro: el superadmin crea los usuarios desde el panel.

Roles:
- **Superadmin:** gestión total (plantas, usuarios, contraseñas, datos).
- **Gerente:** gestión de su planta (puntos, rutas, operadores).
- **Operador:** escaneo de QR y consulta de agenda.

El primer superadmin se crea con `node tools/crear_superadmin.js <usuario> <contraseña> [nombre]` (requiere `FIREBASE_SERVICE_ACCOUNT`). Las reglas de Firestore exigen autenticación (`request.auth != null`).

## Notificaciones push

Para registrar tokens FCM se debe configurar una clave pública VAPID en `VAPID_KEY` dentro de `src/main.js`; en la revisión del 20 de noviembre de 2026 está vacía. El Service Worker procesa mensajes en segundo plano.

El emisor automático activo es cron-job.org → Vercel; GitHub Actions se conserva como alternativa manual:

1. cron-job.org invoca `GET https://controlporteria.vercel.app/api/push` según el intervalo configurado. Debe enviar `Authorization: Bearer <CRON_SECRET>`.
2. La función `api/push.js` requiere las variables de entorno `FIREBASE_SERVICE_ACCOUNT` y `CRON_SECRET` en Vercel. Acepta `GET` y `POST`; ambos métodos requieren el encabezado de autorización.
3. GitHub Actions conserva una ejecución manual alternativa; su workflow solo se activa con `workflow_dispatch` y no tiene programación automática.

## Seguridad y limitaciones

- La app usa Firebase Auth para autenticar usuarios. Las reglas de Firestore exigen `request.auth != null` y limitan la lectura de perfiles al propio usuario.
- El primer superadmin se crea con el script `tools/crear_superadmin.js` (requiere cuenta de servicio). No hay auto-registro.
- El secreto del endpoint serverless (`CRON_SECRET`) protege la invocación del emisor, pero no reemplaza la autenticación de Firestore.
- La clave VAPID está vacía por defecto; configurarla para habilitar Web Push.
- No hay pruebas de integración de navegador. `npm test` ejecuta validadores estáticos/contractuales y pruebas unitarias de módulos puros.
- La carpeta `dist/` es generada por Vite y no debe editarse a mano.
