import { IMAGE_TYPES, MAX_IMAGE_BYTES, type ImageUploadResponse } from '../../../shared/drawings';
import { getToken } from '../auth';

// Screenshots dropped or pasted onto the board become image shapes you can draw over

export class ImageUploadError extends Error {}

export function checkImageFile(file: { type: string; size: number }): string | null {
  if (!(file.type in IMAGE_TYPES)) return 'Only PNG, JPEG, GIF and WebP images can go on the board';
  if (file.size > MAX_IMAGE_BYTES) return `Image is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is 10 MB`;
  if (file.size === 0) return 'The image is empty';
  return null;
}

export async function uploadImage(file: Blob): Promise<ImageUploadResponse> {
  const problem = checkImageFile(file);
  if (problem) throw new ImageUploadError(problem);
  const headers: Record<string, string> = { 'content-type': file.type };
  const token = getToken();
  if (token) headers['x-agentarmy-token'] = token;
  const res = await fetch('/api/images', { method: 'POST', credentials: 'same-origin', headers, body: file });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new ImageUploadError(data.error ?? data.message ?? `Upload failed (${res.status})`);
  }
  return (await res.json()) as ImageUploadResponse;
}

export async function imageSize(file: Blob): Promise<{ width: number; height: number }> {
  try {
    const bitmap = await createImageBitmap(file);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return { width: 640, height: 400 };
  }
}

// Largest side capped so a 4K screenshot doesn't cover the whole board
export function fitImage(size: { width: number; height: number }, max = 900): { w: number; h: number } {
  const scale = Math.min(1, max / Math.max(size.width, size.height, 1));
  return { w: Math.max(8, Math.round(size.width * scale)), h: Math.max(8, Math.round(size.height * scale)) };
}

export function imageFromTransfer(data: DataTransfer | null): File | null {
  if (!data) return null;
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  for (const file of Array.from(data.files ?? [])) if (file.type.startsWith('image/')) return file;
  return null;
}
