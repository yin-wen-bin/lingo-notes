import { useEffect, useRef, useState } from 'react';
import { api, vapidPublicKey } from './cloud';
import { pushSubscriptionError, vapidBytes } from './model.mjs';
import type { Notice, Settings } from './types';

type Device = 'checking' | 'current' | 'missing' | 'other' | 'unknown';

async function fingerprint(subscription: PushSubscription) {
  const { endpoint, keys } = subscription.toJSON();
  if (!endpoint || !keys?.p256dh || !keys.auth) throw new Error('PUSH_SUBSCRIPTION_MISSING');
  const value = [new URL(endpoint).href, keys.p256dh.replace(/=+$/, ''), keys.auth.replace(/=+$/, '')];
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function currentSubscription() {
  const worker = await navigator.serviceWorker?.getRegistration('/');
  return await worker?.pushManager.getSubscription() ?? null;
}

async function registration() {
  const worker = await navigator.serviceWorker.getRegistration('/');
  if (worker?.active) return worker;
  await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  let timeout = 0;
  try {
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<never>((_, reject) => { timeout = window.setTimeout(() => reject(new Error('TIMEOUT')), 10_000); }),
    ]);
  } finally { clearTimeout(timeout); }
}

async function confirmDevice(subscription: PushSubscription | null): Promise<Device> {
  const result = await api<{device: Device}>('push.status', subscription ? {fingerprint:await fingerprint(subscription)} : {});
  return ['current', 'other', 'missing'].includes(result.device) ? result.device : 'unknown';
}

export function useDeviceNotification({
  enabled, refresh, busy, setBusy, patchSettings, notify, onError
}: {
  enabled: boolean;
  refresh: number;
  busy: string;
  setBusy: (value: string) => void;
  patchSettings: (value: Partial<Settings>) => void;
  notify: (notice: Notice) => void;
  onError: (error: unknown) => void;
}) {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & {standalone?:boolean}).standalone === true;
  const available = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(available ? Notification.permission : 'unsupported');
  const [device, setDevice] = useState<Device>('checking');
  const [delivery, setDelivery] = useState('');
  const operation = useRef(0);

  useEffect(() => {
    if (!enabled || !available || (ios && !standalone) || !navigator.onLine) return;
    let live = true;
    const check = operation.current;
    setPermission(Notification.permission);
    currentSubscription().then(confirmDevice).then(value => {
      if (live && check === operation.current) setDevice(value);
    }).catch(() => {
      if (live && check === operation.current) setDevice('unknown');
    });
    return () => { live = false; };
  }, [enabled, available, ios, standalone, refresh]);

  async function enablePush() {
    if (busy) return;
    if (ios && !standalone) { notify({text:'请先添加到主屏幕，再从主屏幕打开并开启通知。'}); return; }
    if (!available || !vapidPublicKey) { notify({text:'当前暂时无法开启通知，请稍后重试。',tone:'error'}); return; }
    if (Notification.permission === 'denied') { notify({text:'请在 iPhone 设置中允许 Lingo Notes 的通知。'}); return; }
    operation.current++;
    setBusy('push');
    setDelivery('');
    let created: PushSubscription | null = null;
    try {
      // iOS requires the permission request to begin within this click.
      const granted = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
      setPermission(granted);
      if (granted !== 'granted') { notify({text:'尚未允许通知。每日复习卡仍可在这里打开。'}); return; }
      const worker = await registration();
      let subscription = await worker.pushManager.getSubscription();
      if (subscription && device === 'missing') {
        // A provider-expired registration can still be present in the browser.
        await subscription.unsubscribe();
        subscription = await worker.pushManager.getSubscription();
      }
      if (!subscription) {
        subscription = await worker.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:vapidBytes(vapidPublicKey)});
        created = subscription;
      }
      await api('push.subscribe', {subscription:subscription.toJSON()});
      created = null;
      await api('settings.update', {push_enabled:true});
      const confirmed = await api<Settings>('settings.get');
      patchSettings(confirmed);
      const bound = await confirmDevice(subscription);
      setDevice(bound);
      if (!confirmed.push_enabled || bound !== 'current') throw new Error('PUSH_DEVICE_MISMATCH');
      notify({text:'本机已连接，可以发送一条测试通知。',tone:'success'});
    } catch (error) {
      await created?.unsubscribe().catch(() => {});
      const message = pushSubscriptionError(error);
      if (message) notify({text:message,tone:'error'});
      else onError(error);
    } finally { setBusy(''); }
  }

  async function disablePush() {
    if (busy || device !== 'current') return;
    operation.current++;
    setBusy('push');
    try {
      const subscription = await currentSubscription();
      if (!subscription) throw new Error('PUSH_SUBSCRIPTION_MISSING');
      const result = await api<{removed:boolean}>('push.unsubscribe', {endpoint:subscription.endpoint, fingerprint:await fingerprint(subscription)});
      if (!result.removed) throw new Error('PUSH_DEVICE_MISMATCH');
      patchSettings({push_enabled:false});
      await subscription.unsubscribe().catch(() => {});
      setDevice('missing');
      setDelivery('');
      notify({text:'已关闭这台设备的通知，复习卡片仍会保留。',tone:'success'});
    } catch (error) {
      onError(error);
      setDevice(await currentSubscription().then(confirmDevice).catch(() => 'unknown' as const));
    } finally { setBusy(''); }
  }

  const canTest = Boolean(enabled && available && permission === 'granted' && device === 'current' && (!ios || standalone));
  async function testPush() {
    if (busy || !canTest) return;
    operation.current++;
    setBusy('test');
    setDelivery('');
    let sentFingerprint: string | undefined;
    try {
      const subscription = await currentSubscription();
      if (!subscription) throw new Error('PUSH_SUBSCRIPTION_MISSING');
      sentFingerprint = await fingerprint(subscription);
      const result = await api<{accepted:boolean}>('push.test', {fingerprint:sentFingerprint});
      if (!result.accepted) throw new Error('PUSH_SEND_FAILED');
      setDelivery('推送服务已受理测试，请查看这台设备的锁屏或通知中心。');
    } catch (error) {
      setDelivery('未能确认测试通知已获受理。');
      if ((error as {code?:string})?.code === 'PUSH_SUBSCRIPTION_EXPIRED') {
        try {
          const stale = await currentSubscription();
          if (stale && await fingerprint(stale) === sentFingerprint) await stale.unsubscribe();
        } catch { /* Reconnect remains available if the browser removed the old subscription. */ }
      }
      onError(error);
      setDevice(await currentSubscription().then(confirmDevice).catch(() => 'unknown' as const));
    } finally { setBusy(''); }
  }

  return {ios, standalone, permission, device, delivery, canTest, enablePush, disablePush, testPush};
}
