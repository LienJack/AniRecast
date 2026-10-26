/** Thin client for the daemon's JSON envelope API (`{ok:true,data}` / `{ok:false,error}`). */

export interface ApiErrorBody {
  code: string;
  message: string;
  hint?: string;
  details?: unknown;
}

export class ApiError extends Error {
  readonly code: string;
  readonly hint: string | undefined;
  readonly status: number;
  readonly details: unknown;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.code;
    this.hint = body.hint;
    this.details = body.details;
  }
}

type Envelope<T> = { ok: true; data: T } | { ok: false; error: ApiErrorBody };

/** Waits until the daemon answers again (it restarts in a few seconds after an update). */
async function daemonBack(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch('/api/health')).ok) return true;
    } catch {
      // still down
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function request<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
  const init: RequestInit = { method, headers: {} };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'Content-Type': 'application/json' };
  }
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (error) {
    // Reads are safe to repeat: wait for the service to come back (a restart takes seconds) and try once more.
    if (method === 'GET' && !retried && (await daemonBack(15_000)))
      return request<T>(method, path, body, true);
    throw new ApiError(0, {
      code: 'daemon_not_running',
      message: `連不到 AniRecast 服務，可能正在重新啟動（${error instanceof Error ? error.message : String(error)}）`,
      hint:
        method === 'GET'
          ? '等十幾秒後重新整理頁面；一直如此請確認 daemon 是否在執行。'
          : '這個操作可能沒有送出：等幾秒，確認畫面上的狀態後再按一次。',
    });
  }
  let json: Envelope<T>;
  try {
    json = (await res.json()) as Envelope<T>;
  } catch {
    throw new ApiError(res.status, { code: 'internal', message: `服務回應無法解析（HTTP ${res.status}）` });
  }
  if (!json.ok) throw new ApiError(res.status, json.error);
  return json.data;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
  upload: <T>(path: string, form: FormData) => request<T>('POST', path, form),
};

/** URL for a workspace-relative path served by the daemon (Range supported). */
export function fileUrl(rel: string | null | undefined, bust?: string | number): string | undefined {
  if (!rel) return undefined;
  const encoded = rel
    .split('/')
    .map((p) => encodeURIComponent(p))
    .join('/');
  return `/api/files/${encoded}${bust !== undefined ? `?v=${bust}` : ''}`;
}

export const isConflict = (e: unknown): e is ApiError => e instanceof ApiError && e.code === 'conflict';

export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.hint ? `${e.message}（${e.hint}）` : e.message;
  return e instanceof Error ? e.message : String(e);
}
