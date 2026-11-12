/**
 * @file mediaSupport.ts
 * @description Camera / microphone availability checks with user-facing explanations.
 *
 * Browsers only expose navigator.mediaDevices (camera, microphone) on secure pages: HTTPS or
 * http://localhost. Opening the app from a phone at http://192.168.x.x:3000 hides it completely.
 */

export type MediaProblem = 'insecure' | 'unsupported' | null;

/** Why live camera/microphone access is unavailable on this page, or null if it is available. */
export function mediaProblem(): MediaProblem {
  if (typeof window === 'undefined') return 'unsupported';
  if (!window.isSecureContext) return 'insecure';
  if (!navigator.mediaDevices?.getUserMedia) return 'unsupported';
  return null;
}

/** Phones and tablets: the native camera app (file input with `capture`) gives sharper receipt photos. */
export function isTouchDevice(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(pointer: coarse)').matches || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

export function insecureContextHelp(feature: 'microphone' | 'camera'): string {
  const httpsUrl = typeof window !== 'undefined' ? `https://${window.location.hostname}:3000` : 'the https:// address';
  return `This browser only allows the ${feature} on secure pages. Open ${httpsUrl} (start the server with "npm run dev:https") or use localhost on this computer.`;
}

/** Turns a getUserMedia / MediaRecorder error into a short, actionable message. */
export function describeMediaError(err: unknown, feature: 'microphone' | 'camera'): string {
  const name = (err as { name?: string })?.name || '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return `${feature === 'camera' ? 'Camera' : 'Microphone'} permission was blocked. Allow it in the browser's site settings (lock icon in the address bar), then try again.`;
    case 'NotFoundError':
    case 'OverconstrainedError':
      return `No ${feature} was found on this device.`;
    case 'NotReadableError':
    case 'AbortError':
      return `The ${feature} is being used by another app. Close it and try again.`;
    default:
      return `Could not start the ${feature}: ${(err as Error)?.message || 'unknown error'}`;
  }
}

/** Recording format supported by this browser (Chrome/Android: webm, iOS Safari: mp4). */
export function pickRecorderMime(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']) {
    if (MediaRecorder.isTypeSupported?.(m)) return m;
  }
  return '';
}

/** Copies text; falls back to a hidden textarea on pages where the Clipboard API is unavailable. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** Opens the phone's share sheet when available, otherwise copies. Returns what happened. */
export async function shareOrCopy(url: string, title: string): Promise<'shared' | 'copied' | 'failed'> {
  if (typeof navigator !== 'undefined' && navigator.share && isTouchDevice()) {
    try {
      await navigator.share({ title, url });
      return 'shared';
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') return 'failed';
    }
  }
  return (await copyText(url)) ? 'copied' : 'failed';
}
