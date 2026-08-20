const NOTIFICATION_PATH = '/notifications';

function safeRelativeRoute(value) {
  try {
    const destination = typeof value === 'string' ? new URL(value, self.location.origin) : new URL(NOTIFICATION_PATH, self.location.origin);
    return destination.origin === self.location.origin ? `${destination.pathname}${destination.search}` : NOTIFICATION_PATH;
  } catch {
    return NOTIFICATION_PATH;
  }
}

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  const notificationId = typeof payload.notificationId === 'string' ? payload.notificationId : '';
  const groupName = typeof payload.groupName === 'string' && payload.groupName ? payload.groupName : 'TeamTaler';
  const eventLabel = typeof payload.eventLabel === 'string' && payload.eventLabel ? payload.eventLabel : 'Neue Benachrichtigung';
  const route = safeRelativeRoute(payload.route);
  const separator = route.includes('?') ? '&' : '?';
  const url = notificationId ? `${route}${separator}notification=${encodeURIComponent(notificationId)}` : route;
  event.waitUntil(Promise.all([
    self.registration.showNotification(groupName, {
      body: eventLabel,
      badge: '/icons/icon-192.png',
      icon: '/icons/icon-192.png',
      data: { url, notificationId },
      tag: notificationId || undefined,
    }),
    typeof self.navigator.setAppBadge === 'function'
      ? self.navigator.setAppBadge().catch(() => undefined)
      : Promise.resolve(),
    self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then((clients) => {
      clients.forEach((client) => client.postMessage({ type: 'TEAMTALER_NOTIFICATION_RECEIVED' }));
    }),
  ]));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const requestedDestination = new URL(event.notification.data?.url || NOTIFICATION_PATH, self.location.origin);
  const destination = requestedDestination.origin === self.location.origin
    ? requestedDestination.href
    : new URL(NOTIFICATION_PATH, self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then(async (clients) => {
    for (const client of clients) {
      if ('focus' in client) {
        if ('navigate' in client) await client.navigate(destination);
        await client.focus();
        return;
      }
    }
    return self.clients.openWindow(destination);
  }));
});
