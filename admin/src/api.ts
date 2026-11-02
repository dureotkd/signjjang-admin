export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

const base = (import.meta.env.VITE_ADMIN_API_URL || '/api/admin').replace(/\/$/, '');
const key = 'signjjang.admin.session';
export type AdminSession = { accessToken: string; admin: { username: string; name: string } };
export type Row = Record<string, unknown>;
export type PageResult = { items: Row[]; page: number; limit: number; total: number };

export function readSession(): AdminSession | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) || 'null');
    return value?.accessToken && value?.admin?.username ? value : null;
  } catch { return null; }
}

export function saveSession(session: AdminSession | null) {
  if (session) sessionStorage.setItem(key, JSON.stringify(session));
  else sessionStorage.removeItem(key);
}

export async function api<T>(path: string, token?: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      ...options,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
    });
  } catch { throw new ApiError('서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.', 0); }
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(result?.error?.message || '요청을 처리하지 못했습니다.', response.status);
  if (!result?.success) throw new ApiError('서버 응답을 확인할 수 없습니다.', response.status);
  return result.data as T;
}

export async function openDocument(id: string, token: string) {
  const response = await fetch(`${base}/documents/${encodeURIComponent(id)}/file`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    const result = await response.json().catch(() => null);
    throw new ApiError(result?.error?.message || '서류를 열 수 없습니다.', response.status);
  }
  const blob = await response.blob();
  if (!['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif'].includes(blob.type.split(';')[0])) {
    throw new ApiError('미리보기를 지원하지 않는 파일 형식입니다.', 415);
  }
  return URL.createObjectURL(blob);
}

export function exportCsv(name: string, columns: { key: string; label: string }[], rows: Row[]) {
  const cell = (value: unknown) => {
    const raw = Array.isArray(value) ? value.join(', ') : String(value ?? '');
    const safe = /^\s*[=+\-@]/.test(raw) || /^[\t\r]/.test(raw) ? `'${raw}` : raw;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  const csv = [columns.map(c => cell(c.label)).join(','), ...rows.map(row => columns.map(c => cell(row[c.key])).join(','))].join('\r\n');
  const url = URL.createObjectURL(new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8;' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${name}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
