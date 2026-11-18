/* Service Worker para Notificaciones Nativas y Firebase Cloud Messaging (FCM) */
/* Control de Rondas – Meatex */

importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

const firebaseConfig = {
    apiKey: "AIzaSyAl9AqfZzwojhuB_7QPFS0kfMbw5dfdI-4",
    authDomain: "control-rondas-porteria-7ecc7.firebaseapp.com",
    projectId: "control-rondas-porteria-7ecc7",
    storageBucket: "control-rondas-porteria-7ecc7.firebasestorage.app",
    messagingSenderId: "873679139344",
    appId: "1:873679139344:web:cdf54b69a8eb7582959095"
};

firebase.initializeApp(firebaseConfig);

let messaging = null;
try {
    messaging = firebase.messaging();
} catch (e) {
    console.warn('[SW] Firebase Messaging no disponible en este entorno:', e);
}

// Instalación y activación inmediata
self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(clients.claim());
});

// Receptor de notificaciones en segundo plano (FCM)
if (messaging) {
    messaging.onBackgroundMessage((payload) => {
        console.log('[SW] Push recibido en segundo plano:', payload);

        const title = payload.notification?.title || payload.data?.title || "Control de Rondas · Meatex";
        const body = payload.notification?.body || payload.data?.body || "Aviso del sistema de rondas.";
        const severidad = payload.data?.severidad || "info";

        const options = {
            body: body,
            icon: "/icon-192.png",
            badge: "/badge-72.png",
            vibrate: severidad === "CRITICO" ? [300, 100, 300, 100, 400] : [200, 100, 200],
            // Tag estable para evitar notificaciones duplicadas del mismo mensaje.
            tag: payload.data?.tag || payload.notification?.title || "ronda-alerta",
            renotify: true,
            requireInteraction: severidad === "CRITICO",
            data: payload.data || {}
        };

        return self.registration.showNotification(title, options);
    });
}

// Receptor de eventos de mensaje directo desde la ventana principal (para notificaciones locales nativas en Android)
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SHOW_NATIVE_NOTIFICATION') {
        const title = event.data.title || "Control de Rondas";
        const options = event.data.options || {};
        self.registration.showNotification(title, options);
    }
});

// Acción al hacer clic en la notificación desde la barra de Android
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
            for (const client of windowClients) {
                if (client.url && 'focus' in client) {
                    return client.focus();
                }
            }
            if (clients.openWindow) {
                return clients.openWindow('/');
            }
        })
    );
});
