# Control de Rondas – Meatex

PWA estática para registrar y auditar rondas de vigilancia mediante códigos QR, GPS y ventanas horarias. Toda la aplicación vive en `public/index.html` y usa Firebase Hosting + Firestore directamente desde el navegador.

## Estado actual

- `public/index.html`: aplicación completa (HTML, CSS y JavaScript).
- `public/firebase-messaging-sw.js`: service worker de FCM y notificaciones.
- `public/manifest.json`: metadatos PWA.
- `firestore.rules`: reglas de Firestore versionadas.
- `documentacion_control_rondas_meatex.md`: documentación funcional y técnica.
- `tests/validar-index.mjs`: validación estática del HTML/JS (IDs y handlers).

No hay build, `package.json`, tests de navegador ni repositorio Git inicializado.

## Puesta en marcha

1. Instalar Firebase CLI si no está disponible:
   ```bash
   npm install -g firebase-tools
   ```
2. Iniciar sesión y seleccionar el proyecto:
   ```bash
   firebase login
   firebase use control-rondas-porteria-7ecc7
   ```
3. Desplegar reglas de Firestore:
   ```bash
   firebase deploy --only firestore:rules
   ```
4. Desplegar la aplicación:
   ```bash
   firebase deploy --only hosting
   ```

## Firestore

### Reglas

El archivo `firestore.rules` reproduce las reglas actuales del proyecto y agrega la colección que faltaba:

- `operadores`, `puntos_control` y `rutas_horarias`: lectura y escritura.
- `registros_ronda`: solo lectura y creación; no se modifican ni se borran desde la app.
- `dispositivos_notificaciones`: lectura y escritura (necesario para guardar los tokens FCM).

> Las reglas siguen siendo abiertas porque la aplicación no usa Firebase Auth. Cualquier persona con la URL puede escribir en las colecciones. Endurecerlas requiere implementar autenticación.

### Retención de 60 días

Los registros nuevos guardan `expiraEn` (timestamp). Para que Firestore elimine automáticamente los registros con más de 60 días:

1. Ir a Google Cloud Console → Firestore → **Time-to-live**.
2. Crear una política TTL sobre la colección `registros_ronda` y el campo `expiraEn`.
3. Verificar que la política quede en estado **Activa**.

La eliminación por TTL la ejecuta Firestore, no la aplicación, por lo que no requiere permiso de `delete` en las reglas. Los registros históricos anteriores a este cambio no tienen `expiraEn`; si se quiere aplicarles retención, hay que borrarlos o migrarlos una vez desde la consola o con un script administrativo.

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
3. Un emisor de push (Cloud Function o servidor) que lea los tokens de `dispositivos_notificaciones` y envíe los mensajes. El repositorio no incluye ese emisor.

Sin VAPID, `getToken()` falla y no se registran tokens nuevos. El código actual registra el error en consola y continúa.

## Validación

```bash
node tests/validar-index.mjs
```

El script detecta:

- `getElementById()` que apunta a IDs inexistentes.
- IDs duplicados.
- Handlers inline (`onclick`, `onchange`, etc.) sin función definida.

También se puede validar la sintaxis del JavaScript extrayendo el `<script type="module">` y ejecutando `node --check`.

## Limitaciones conocidas

- La contraseña del encargado (`admin123`) está en el código y no hay Firebase Auth.
- Las reglas de Firestore son abiertas.
- No hay cache de app shell: sin internet la app no carga de forma fiable, aunque los escaneos ya abiertos se encolan en `localStorage`.
- No hay repositorio Git ni pipeline de despliegue.
- No hay tests automatizados de reglas de negocio; solo validación estática.
