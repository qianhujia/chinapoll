// R2 service for uploading and managing assets (logos, favicons, etc.)

export interface R2UploadResult {
  key: string;
  url: string;
  size: number;
  contentType: string;
}

export interface R2Env {
  R2: R2Bucket;
}

// Generate a unique key for an uploaded asset
export function generateAssetKey(filename: string, prefix = 'assets'): string {
  const ext = filename.split('.').pop()?.toLowerCase() || 'bin';
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 10);
  return `${prefix}/${timestamp}-${random}.${ext}`;
}

// Validate image file
export function validateImageFile(file: File, maxSizeMB = 5): { ok: true } | { ok: false; error: string } {
  const allowedTypes = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp', 'image/x-icon'];
  if (!allowedTypes.includes(file.type)) {
    return { ok: false, error: 'File type not allowed. Use PNG, JPEG, SVG, WebP, or ICO.' };
  }
  if (file.size > maxSizeMB * 1024 * 1024) {
    return { ok: false, error: `File too large. Maximum size is ${maxSizeMB}MB.` };
  }
  return { ok: true };
}

// Upload a file to R2
export async function uploadToR2(
  env: R2Env,
  file: File,
  key: string,
  origin: string
): Promise<R2UploadResult> {
  const arrayBuffer = await file.arrayBuffer();
  await env.R2.put(key, arrayBuffer, {
    httpMetadata: {
      contentType: file.type,
    },
  });

  return {
    key,
    url: `${origin}/assets/${key}`, // Served via Worker route
    size: file.size,
    contentType: file.type,
  };
}

// Delete a file from R2
export async function deleteFromR2(env: R2Env, key: string): Promise<void> {
  await env.R2.delete(key);
}

// Get public URL for an asset (assumes custom domain or public bucket setup)
// For local dev, we serve via a Worker route
export function getAssetUrl(key: string, origin: string): string {
  return `${origin}/assets/${key}`;
}