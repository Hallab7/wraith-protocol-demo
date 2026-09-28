import { describe, expect, it, vi } from 'vitest';
import {
  CACHE_PREFIX,
  CACHE_VERSION,
  CACHE_VERSION_SUFFIX,
  cacheName,
  expectedCacheNames,
  isObsoleteCache,
  planCacheMigration,
  purgeObsoleteCaches,
  type CacheStorageLike,
} from './swCache';

const NEXT_VERSION = CACHE_VERSION + 1;

function fakeCacheStorage(initial: string[]): CacheStorageLike & { names: string[] } {
  const names = [...initial];
  return {
    names,
    keys: async () => [...names],
    delete: async (name: string) => {
      const index = names.indexOf(name);
      if (index === -1) return false;
      names.splice(index, 1);
      return true;
    },
  };
}

describe('cache versioning', () => {
  it('names every app cache with the prefix and explicit version', () => {
    for (const name of expectedCacheNames()) {
      expect(name.startsWith(`${CACHE_PREFIX}-`)).toBe(true);
      expect(name.endsWith(`-${CACHE_VERSION_SUFFIX}`)).toBe(true);
    }

    expect(cacheName('rpc')).toBe(`wraith-rpc-${CACHE_VERSION_SUFFIX}`);
    expect(new Set(expectedCacheNames()).size).toBe(expectedCacheNames().length);
  });

  it('treats only this app\u2019s stale caches as obsolete', () => {
    expect(isObsoleteCache(cacheName('rpc'))).toBe(false);
    expect(isObsoleteCache('rpc-cache')).toBe(true);
    expect(isObsoleteCache('workbox-precache-v2-http://localhost/')).toBe(true);
    expect(isObsoleteCache('some-other-app-cache')).toBe(false);
    expect(isObsoleteCache(cacheName('rpc', NEXT_VERSION))).toBe(true);
  });
});

describe('activation cache migration', () => {
  it('updates: keeps the current version and purges the superseded one', () => {
    const previous = expectedCacheNames(CACHE_VERSION - 1);
    const current = expectedCacheNames();

    const plan = planCacheMigration([...current, ...previous]);

    expect(plan.keep).toEqual(current);
    expect(plan.delete).toEqual(previous);
  });

  it('rolls back: an older worker purges the newer version\u2019s caches', () => {
    const rolledBackTo = expectedCacheNames();
    const newer = expectedCacheNames(NEXT_VERSION);

    const plan = planCacheMigration([...newer, ...rolledBackTo]);

    expect(plan.keep).toEqual(rolledBackTo);
    expect(plan.delete).toEqual(newer);
  });

  it('recovers stale installs that predate cache versioning', () => {
    const storage = fakeCacheStorage([
      'rpc-cache',
      'google-fonts-cache',
      'google-fonts-webfonts',
      'workbox-precache-v2-http://localhost:5173/',
    ]);

    return expect(purgeObsoleteCaches(storage)).resolves.toEqual([
      'rpc-cache',
      'google-fonts-cache',
      'google-fonts-webfonts',
      'workbox-precache-v2-http://localhost:5173/',
    ]);
  });

  it('leaves caches owned by other apps untouched', async () => {
    const mine = expectedCacheNames();
    const foreign = ['another-app-precache', 'some-other-app-cache'];
    const storage = fakeCacheStorage([...mine, ...foreign]);

    await expect(purgeObsoleteCaches(storage)).resolves.toEqual([]);
    expect(storage.names).toEqual([...mine, ...foreign]);
  });

  it('purges every obsolete app cache in a single activation', async () => {
    const before = ['wraith-precache-v0', 'wraith-rpc-v0', 'google-fonts-cache'];
    const storage = fakeCacheStorage([...before, ...expectedCacheNames()]);

    const deleted = await purgeObsoleteCaches(storage);

    expect(deleted).toEqual(before);
    expect(storage.names).toEqual(expectedCacheNames());
  });

  it('never rejects when cache storage is unavailable or a delete fails', async () => {
    const failingKeys: CacheStorageLike = {
      keys: vi.fn().mockRejectedValue(new Error('storage disabled')),
      delete: vi.fn(),
    };
    await expect(purgeObsoleteCaches(failingKeys)).resolves.toEqual([]);

    const failingDelete: CacheStorageLike = {
      keys: async () => ['wraith-rpc-v0', 'wraith-fonts-files-v0'],
      delete: vi.fn().mockRejectedValue(new Error('delete blocked')),
    };
    await expect(purgeObsoleteCaches(failingDelete)).resolves.toEqual([]);
  });
});
