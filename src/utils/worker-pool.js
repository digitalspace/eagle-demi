'use strict';

/**
 * Run `worker(item, index)` over an array or an async iterable, at most `concurrency` in flight.
 *
 * Runners share one iterator, so an iterable is consumed lazily rather than buffered. Results come
 * back in source order for an array, pull order for an iterable.
 */
async function mapLimit(source, concurrency, worker) {
  const isArray = Array.isArray(source);
  const iterator = isArray ? source[Symbol.iterator]() : source[Symbol.asyncIterator]();
  const runnerCount = isArray ? Math.min(concurrency, source.length) : concurrency;
  const results = [];
  let cursor = 0;

  // The pull and the index are taken in one synchronous step, so a shared iterator still pairs
  // each item with its own position.
  const pull = () => {
    const step = iterator.next();
    const index = cursor++;
    return Promise.resolve(step).then(({ value, done }) => ({ value, done, index }));
  };

  const runners = Array.from({ length: runnerCount }, async () => {
    for (;;) {
      const { value, done, index } = await pull();
      if (done) return;
      results[index] = await worker(value, index);
    }
  });

  await Promise.all(runners);
  return results;
}

module.exports = { mapLimit };
