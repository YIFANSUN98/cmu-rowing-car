import type { Publication } from './schema';
export type Access = { role: 'admin' | 'team'; csrf: string; publication?: Publication | null };
let access: Access | undefined;
let generation = 0;
const memory = new Map<string, { value: unknown; at: number }>();
const pending = new Map<string, Promise<unknown>>();
const revisions = new Map<string, number>();
export const accessGeneration = () => generation;
export const cached = <T>(key: string): T | undefined => memory.get(key)?.value as T | undefined;
export const cachedAt = (key: string) => memory.get(key)?.at ?? 0;
export const remember = (key: string, value: unknown) => memory.set(key, { value, at: Date.now() });
export const setAccess = (value?: Access) => {
  if (!value || access?.csrf !== value.csrf) {
    generation++;
    memory.clear();
    pending.clear();
    revisions.clear();
  }
  access = value;
  if (value && 'publication' in value) remember('plan', value.publication);
};
export const apiUrl = (path: string) =>
  new URL(`${import.meta.env.BASE_URL}api/${path}`, window.location.origin).href;
export function api<T>(path: string, method = 'GET', value?: unknown): Promise<T> {
  const key = method + ':' + path;
  if (method === 'GET' && pending.has(key)) return pending.get(key) as Promise<T>;
  const task = request<T>(path, method, value);
  if (method === 'GET') {
    pending.set(key, task);
    void task
      .finally(() => {
        if (pending.get(key) === task) pending.delete(key);
      })
      .catch(() => {});
  }
  return task;
}
async function request<T>(path: string, method: string, value?: unknown): Promise<T> {
  const epoch = generation;
  const resource = path.split('?')[0];
  if (method !== 'GET') revisions.set(resource, (revisions.get(resource) ?? 0) + 1);
  const revision = revisions.get(resource) ?? 0;
  const previous = path === 'plan' ? cached<Publication | null>('plan') : undefined;
  const url = new URL(apiUrl(path));
  if (method === 'GET' && previous?.id) url.searchParams.set('version', previous.id);
  const response = await fetch(url, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      ...(method === 'GET'
        ? {}
        : { 'Content-Type': 'application/json', 'X-CSRF-Token': access?.csrf ?? '' }),
    },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
  if (generation !== epoch) throw new Error('The access session changed.');
  if (response.status === 401 && path !== 'login' && access)
    window.dispatchEvent(new Event('access-expired'));
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error('The website connection is unavailable. Please reload and try again.');
  }
  if (!response.ok)
    throw Object.assign(new Error(data?.error ?? 'The request could not be completed.'), {
      status: response.status,
    });
  if (generation !== epoch) throw new Error('The access session changed.');
  if (path === 'plan' && data?.unchanged === true) {
    if (!previous) throw new Error('Reload the page to retrieve the published plan.');
    data = previous;
  }
  if (revision === (revisions.get(resource) ?? 0)) {
    if (method === 'GET' && path !== 'inputs') remember(path, data);
    if (path === 'plan' && method === 'PUT') remember('plan', data);
    if (path === 'plan' && method === 'DELETE') remember('plan', null);
  } else if (memory.has(path)) {
    return cached<T>(path)!;
  }
  return data as T;
}
