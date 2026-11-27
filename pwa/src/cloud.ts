import { cloudSessionKey, createCloudClient, type CloudSession } from '../../shared/cloud-client';

const url = import.meta.env.VITE_SUPABASE_URL || '';
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || '';
export const configured = Boolean(url && publishableKey);
export const cloud = configured ? createCloudClient({ url, publishableKey, storage: window.localStorage }) : null;
export async function api<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
  if (!cloud) throw new Error('NOT_CONFIGURED');
  return cloud.call<T>(action, params);
}
export const vapidPublicKey = import.meta.env.VITE_VAPID_PUBLIC_KEY || '';

export const deviceReadingOwner = (userId: string) => `${url.replace(/\/$/, '')}:${userId}`;
export function canReadOnDevice(owner: string) {
  try {
    const value: CloudSession | null = JSON.parse(localStorage.getItem(cloudSessionKey(url)) || 'null');
    return Boolean(value?.user.id && deviceReadingOwner(value.user.id) === owner && value.access_token && value.expires_at * 1000 > Date.now());
  } catch { return false; }
}
