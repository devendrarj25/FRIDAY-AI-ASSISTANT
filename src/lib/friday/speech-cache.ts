const cache = new Map<string, Float32Array>();

export function resetPhraseCache(): void {
  cache.clear();
}

export function cachePhrase(id: string, samples: Float32Array): void {
  if (cache.size > 32) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(id, samples.slice(0, 16000));
}

export function phraseCacheKey(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

export function storeCachedPhrase(text: string, samples: Float32Array): void {
  cachePhrase(phraseCacheKey(text), samples);
}

export function takeCachedPhrase(text: string): Float32Array | null {
  return cachedPhrase(phraseCacheKey(text));
}

export function cachedPhrase(id: string): Float32Array | null {
  const hit = cache.get(id);
  return hit ? hit.slice() : null;
}
