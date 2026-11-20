# Guía operativa – Control de Rondas Meatex

Revisada el 20 de noviembre de 2026 contra el código de `main`.

Esta guía cubre el desarrollo local, la configuración de servicios, la publicación y el diagnóstico de problemas habituales. La arquitectura y las reglas detalladas están en [documentacion_control_rondas_meatex.md](documentacion_control_rondas_meatex.md).

## 1. Requisitos y desarrollo local

- Node.js compatible con Vite 8 y npm.
- Acceso al proyecto Firebase `control-rondas-porteria-7ecc7`.
- Conexión a Internet para Firebase, los CDN y la cartografía de OpenStreetMap.

Desde la raíz del repositorio:

```bash
npm install
npm run dev
```

Vite muestra la dirección local, normalmente `http://localhost:5173`. Para verificar una versión de producción local:

```bash
npm test
npm run build
npm run preview
```

`npm test` combina validaciones estáticas y de contratos con pruebas unitarias. No es una prueba de navegador ni verifica servicios remotos. `npm run build` genera `dist/`; no editar esa carpeta manualmente.

## 2. Publicación

### Aplicación web

El proyecto Vercel `controlporteria` obtiene el código desde GitHub y publica automáticamente los cambios de la rama `main`. Antes de integrar cambios:

1. Ejecutar `npm test` y `npm run build`.
2. Revisar que el commit contenga solo los archivos del cambio.
3. Subir el commit a `main`.
4. Comprobar en Vercel que el deployment esté `READY` y apunte al commit esperado.
5. Abrir `https://controlporteria.vercel.app/` y revisar el flujo modificado.

Firebase Hosting no aloja el build: redirige `/` y `/index.html` al dominio de Vercel. Las reglas de Firestore tienen un despliegue separado:

```bash
firebase deploy --only firestore:rules
```

Confirmar el proyecto Firebase activo antes de ejecutar el comando.

### Variables de Vercel para el endpoint push

La función `api/push.js` requiere estas variables en el entorno de producción:

| Variable | Contenido | Uso |
|---|---|---|
| `CRON_SECRET` | Secreto aleatorio largo; mantenerlo privado. | Autoriza a cron-job.org a invocar `/api/push`. |
| `FIREBASE_SERVICE_ACCOUNT` | JSON completo de una cuenta de servicio o su representación Base64. | Credencial de Firebase Admin usada por la Function. |

No guardar estos valores en Git, el frontend, capturas públicas ni archivos de documentación. Si se rota `CRON_SECRET`, actualizar también el encabezado de cron-job.org y redeplegar las variables.

## 3. Programar cron-job.org

La programación activa usa cron-job.org; GitHub Actions no tiene cron automático.

Configurar la tarea para:

- URL: `https://controlporteria.vercel.app/api/push`
- Método: `GET` (la Function también acepta `POST`)
- Encabezado: `Authorization: Bearer <valor de CRON_SECRET>`
- Frecuencia: el intervalo operativo elegido en cron-job.org.

No incluir el secreto en la URL ni en el nombre público de la tarea. La frecuencia determina la latencia de los avisos; la lógica del emisor calcula sus ventanas a partir de la hora de cada ruta.

El workflow `.github/workflows/push-sender.yml` puede ejecutarse manualmente desde GitHub Actions. Requiere el secreto de repositorio `FIREBASE_SERVICE_ACCOUNT`. No activar otro cron automático para ese workflow mientras cron-job.org esté enviando notificaciones.

Los emisores tienen ventanas de alertas proactivas diferentes. La Function de Vercel avisa antes de la ruta entre 3 y 12 minutos y cerca del vencimiento dentro de los últimos 5 minutos; el emisor manual de GitHub usa entre 7 y 9 minutos y los últimos 3 minutos. Ambos procesan incidencias recientes y mantienen cursores/cooldowns en Firestore.

## 4. Diagnóstico de notificaciones

### Gate de permisos

La app no muestra el contenido hasta cumplir el gate inicial: instalación (solo en móvil no instalado), notificaciones y ubicación precisa. Si **Continuar** está deshabilitado, revisar cuál de los tres ítems no muestra **OK**. En navegadores sin soporte de notificaciones o geolocalización, el requisito correspondiente se considera cumplido. Si el usuario bloqueó un permiso, debe rehabilitarlo desde la configuración del navegador y recargar. El botón de notificaciones también registra el token FCM.

### Respuestas de `/api/push`

| Estado | Causa probable | Comprobación |
|---|---|---|
| `200` | La petición fue autenticada y procesada. Puede informar que no había rutas o registros nuevos. | Revisar el JSON de respuesta y los logs de Vercel. |
| `401` | Falta `Authorization`, el formato no es `Bearer ...` o el secreto no coincide. | Comparar el valor de `CRON_SECRET` de Vercel con el encabezado de cron-job.org; revisar espacios y redeploy. |
| `503` | Falta `CRON_SECRET` en el entorno de la Function. | Configurar la variable para Production y redeplegar. |
| `405` | Método distinto de GET o POST. | Cambiar la tarea a GET o POST. |
| `500` | Error al usar Firebase Admin, Firestore o FCM. | Inspeccionar logs de la Function y validar JSON/permisos de `FIREBASE_SERVICE_ACCOUNT`. |

Un `200` no prueba que un dispositivo haya mostrado una notificación: revisar que haya tokens en `dispositivos_notificaciones`, permiso de notificaciones en el navegador, registro del Service Worker y configuración de la clave pública VAPID.

La constante `VAPID_KEY` de `src/main.js` está vacía en la revisión indicada. Si el registro FCM web no genera token, configurar la clave pública Web Push correspondiente al proyecto Firebase, publicar de nuevo y volver a habilitar las notificaciones en el navegador. No colocar una clave privada VAPID allí.

## 5. Diagnóstico de mapa, rutas y fechas

- El mapa usa Leaflet y mosaicos de OpenStreetMap; necesita acceso de red a esos servicios.
- Un punto solo aparece como marcador si tiene latitud y longitud numéricas válidas.
- La lista lateral permite marcar o desmarcar varios puntos; después se confirman en conjunto.
- Días, hora objetivo y tolerancia elegidos se aplican a cada punto seleccionado. Se guarda un documento separado por cada día y punto.
- Si una de esas combinaciones ya tiene exactamente la misma hora, el guardado completo se rechaza y se informa el conflicto. Resolverlo quitando o cambiando la selección, día u hora.
- Si el mapa no carga, revisar la consola del navegador y bloqueos de CDN/red. La lista solo puede elegir marcadores con coordenadas válidas.

### Selector de fecha

- El máximo es hoy; no se pueden consultar fechas futuras.
- El mínimo es la fecha del registro más antiguo disponible.
- Si la fecha elegida no tiene registros, el panel avisa y vuelve a la fecha anterior.
- Los KPI y la tabla se recalculan con el cache del día seleccionado.

## 6. Datos, límites y seguridad

- Máximo de 20 puntos, 30 operadores, 2.000 registros por carga del panel y 10.000 registros por exportación.
- La app elimina hasta 2.000 registros antiguos al iniciar con conexión. El emisor elimina hasta 1.200 registros por ejecución de limpieza diaria.
- El nombre del punto es editable; el texto QR se conserva.
- Desactivar un operador lo oculta del selector; eliminarlo conserva su historial.
- La clave visual del encargado está en código cliente (`admin123`). No autentica usuarios.
- Las reglas de Firestore permiten acceso abierto de lectura/escritura a varias colecciones y no hay Firebase Auth. Cualquier cliente que conozca la configuración pública del proyecto puede acceder a esas colecciones. El secreto del cron solo protege `/api/push`; no protege directamente Firestore.
- La cola local de escaneos fallidos usa `localStorage` (`cola_rondas_offline`). La sesión del encargado usa `sessionStorage` (`sesion_encargado`). No hay persistencia local de Firestore ni garantía de arranque en frío sin Internet.

## 7. Archivos de referencia

- `README.md`: resumen, comandos y reglas principales.
- `documentacion_control_rondas_meatex.md`: documentación técnica y funcional completa.
- `firestore.rules`: permisos desplegados en Firestore.
- `api/push.js`: Function de producción para cron-job.org.
- `push-sender/index.js` y `.github/workflows/push-sender.yml`: emisor alternativo manual.
- `src/main.js`: UI y lógica activa de operador/encargado.
- `src/domain/` y `src/utils/`: reglas puras que se pueden probar sin DOM.
- `tests/`: validadores de contratos y pruebas unitarias.
- `tools/generar_pdf.py`: regenera los PDF de `output/pdf/` desde los Markdown (Python 3 + `reportlab`).
