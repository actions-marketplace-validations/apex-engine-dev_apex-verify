export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function retry(fn, { retries = 0, delayMs = 0, factor = 2, shouldRetry } = {}) {
  let wait = delayMs;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      if (attempt > retries || (shouldRetry && !shouldRetry(e))) throw e;
      await sleep(wait);
      wait *= factor;
    }
  }
}
