const { RequestGovernor, RequestLimitError } = require('../src/request-limits');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function track(promise) {
  const result = { status: 'pending' };
  result.done = promise.then(
    value => Object.assign(result, { status: 'resolved', value }),
    error => Object.assign(result, { status: 'rejected', error })
  );
  return result;
}

function clock() {
  let time = 0;
  let nextId = 0;
  const timers = new Map();
  const flush = async () => {
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
  };
  return {
    now: () => time,
    setTimeout: (callback, ms) => {
      const id = ++nextId;
      timers.set(id, { callback, at: time + ms });
      return id;
    },
    clearTimeout: id => timers.delete(id),
    countTimers: () => timers.size,
    flush,
    async tick(ms) {
      const end = time + ms;
      await flush();
      while (true) {
        const next = Array.from(timers.entries()).filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        time = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
        await flush();
      }
      time = end;
      await flush();
    }
  };
}

describe('shared request governor', () => {
  test('serializes requests and spaces their start times with one overall deadline', async () => {
    const timer = clock();
    const governor = new RequestGovernor({}, timer);
    const first = deferred();
    const calls = [];
    const one = governor.run(options => {
      calls.push({ at: timer.now(), ...options });
      return first.promise;
    });
    const two = governor.run(options => {
      calls.push({ at: timer.now(), ...options });
      return 'two';
    });
    await timer.tick(500);
    expect(calls).toHaveLength(1);
    first.resolve('one');
    await timer.tick(499);
    expect(calls).toHaveLength(1);
    await timer.tick(1);
    expect(calls.map(call => call.at)).toEqual([0, 1000]);
    expect(calls[1].timeoutMs).toBe(14000);
    await expect(one).resolves.toBe('one');
    await expect(two).resolves.toBe('two');
    expect(timer.countTimers()).toBe(0);
  });

  test('does not overlap a slow active request after the spacing interval passes', async () => {
    const timer = clock();
    const governor = new RequestGovernor({}, timer);
    const active = deferred();
    const first = governor.run(() => active.promise);
    const next = jest.fn(() => 'next');
    const second = governor.run(next);
    await timer.tick(5000);
    expect(next).not.toHaveBeenCalled();
    active.resolve('first');
    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('next');
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('rejects a rolling minute limit without a network attempt and allows the exact expiry boundary', async () => {
    const timer = clock();
    const governor = new RequestGovernor({ maxRequestsPerMinute: 2, minIntervalMs: 0 }, timer);
    const task = jest.fn(() => 'result');
    await governor.run(task, { engine: 'brave' });
    await timer.tick(1000);
    await governor.run(task, { engine: 'tavily' });
    const rejected = governor.run(task, { engine: 'exa' });
    await expect(rejected).rejects.toBeInstanceOf(RequestLimitError);
    await expect(rejected).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfterMs: 59000, engine: 'exa' });
    expect(task).toHaveBeenCalledTimes(2);
    await timer.tick(59000);
    await expect(governor.run(task)).resolves.toBe('result');
    expect(task).toHaveBeenCalledTimes(3);
  });

  test('preserves consumed requests across settings changes, including a lowered limit', async () => {
    const timer = clock();
    const governor = new RequestGovernor({ maxRequestsPerMinute: 3, minIntervalMs: 0 }, timer);
    const task = jest.fn(() => 'result');
    await governor.run(task);
    await timer.tick(1000);
    await governor.run(task);
    await timer.tick(1000);
    await governor.run(task);
    governor.configure({ maxRequestsPerMinute: 1 });
    await expect(governor.run(task)).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfterMs: 60000 });
    await timer.tick(59000);
    await expect(governor.run(task)).rejects.toMatchObject({ retryAfterMs: 1000 });
    await timer.tick(1000);
    await expect(governor.run(task)).resolves.toBe('result');
  });

  test('uses revised spacing for queued work without clearing request history', async () => {
    const timer = clock();
    const governor = new RequestGovernor({}, timer);
    await governor.run(() => 'first');
    const second = track(governor.run(() => 'second'));
    await timer.tick(100);
    governor.configure({ minIntervalMs: 200 });
    await timer.tick(99);
    expect(second.status).toBe('pending');
    await timer.tick(1);
    expect(second.value).toBe('second');
    governor.configure({ maxRequestsPerMinute: 2 });
    await expect(governor.run(() => 'third')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  test('rejects a queued stale preflight without a request or additional pacing delay', async () => {
    const timer = clock();
    const governor = new RequestGovernor({ maxRequestsPerMinute: 2, minIntervalMs: 1000 }, timer);
    await governor.run(() => 'first');
    let revision = 1;
    const staleTask = jest.fn();
    const beforeStart = jest.fn(() => {
      if (revision !== 1) throw Object.assign(new Error('Settings changed'), { code: 'STALE_SETTINGS' });
    });
    const stale = track(governor.run(staleTask, { beforeStart }));
    const calls = [];
    const next = track(governor.run(() => {
      calls.push(timer.now());
      return 'next';
    }));
    revision = 2;
    await timer.tick(999);
    expect(beforeStart).not.toHaveBeenCalled();
    await timer.tick(1);
    expect(stale.error.code).toBe('STALE_SETTINGS');
    expect(staleTask).not.toHaveBeenCalled();
    expect(next.value).toBe('next');
    expect(calls).toEqual([1000]);
    expect(timer.countTimers()).toBe(0);
    await expect(governor.run(() => 'over budget')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  test('bounds pending work and frees a queue slot when a caller cancels', async () => {
    const timer = clock();
    const governor = new RequestGovernor({ maxPending: 2, minIntervalMs: 0, maxRequestsPerMinute: 3 }, timer);
    const active = deferred();
    const first = governor.run(() => active.promise);
    const controller = new AbortController();
    const canceledTask = jest.fn();
    const queued = track(governor.run(canceledTask, { signal: controller.signal }));
    const third = governor.run(() => 'third');
    await expect(governor.run(() => 'full')).rejects.toMatchObject({ code: 'QUEUE_FULL' });
    controller.abort();
    await queued.done;
    expect(queued.error).toMatchObject({ code: 'ERR_CANCELED', name: 'AbortError' });
    const fourth = governor.run(() => 'fourth');
    active.resolve('first');
    await expect(Promise.all([first, third, fourth])).resolves.toEqual(['first', 'third', 'fourth']);
    expect(canceledTask).not.toHaveBeenCalled();
    expect(timer.countTimers()).toBe(0);
  });

  test('queued deadlines and pacing waits expire without contacting the provider', async () => {
    const timer = clock();
    const governor = new RequestGovernor({}, timer);
    await governor.run(() => 'first');
    const task = jest.fn();
    const queued = track(governor.run(task, { timeoutMs: 500 }));
    await timer.tick(500);
    expect(queued.error).toMatchObject({ code: 'TIMEOUT' });
    expect(task).not.toHaveBeenCalled();
    expect(timer.countTimers()).toBe(0);
  });

  test('cancellation keeps an ignored active request serialized until it settles', async () => {
    const timer = clock();
    const governor = new RequestGovernor({ minIntervalMs: 0 }, timer);
    const active = deferred();
    const controller = new AbortController();
    let receivedSignal;
    const first = track(governor.run(({ signal }) => {
      receivedSignal = signal;
      return active.promise;
    }, { signal: controller.signal }));
    const next = jest.fn(() => 'next');
    const second = governor.run(next);
    controller.abort();
    await first.done;
    expect(first.error.code).toBe('ERR_CANCELED');
    expect(receivedSignal.aborted).toBe(true);
    expect(next).not.toHaveBeenCalled();
    active.resolve('too late');
    await expect(second).resolves.toBe('next');
  });

  test('the overall deadline aborts active work and reports TIMEOUT instead of its cancellation error', async () => {
    const timer = clock();
    const governor = new RequestGovernor({}, timer);
    let receivedSignal;
    const result = track(governor.run(({ signal }) => {
      receivedSignal = signal;
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(
        Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' })
      )));
    }, { timeoutMs: 100 }));
    await timer.tick(100);
    expect(result.error.code).toBe('TIMEOUT');
    expect(receivedSignal.aborted).toBe(true);
    expect(timer.countTimers()).toBe(0);
  });

  test('honors server Retry-After for queued and later calls without retries or resetting on configure', async () => {
    const timer = clock();
    const governor = new RequestGovernor({ minIntervalMs: 0 }, timer);
    const active = deferred();
    const task = jest.fn(() => active.promise);
    const first = track(governor.run(task, { engine: 'brave' }));
    const waitingTask = jest.fn(() => 'next');
    const waiting = track(governor.run(waitingTask, { engine: 'tavily' }));
    active.reject(Object.assign(new Error('rate limited'), { code: 'RATE_LIMITED', retryAfterMs: 3000 }));
    await timer.flush();
    expect(first.error).toMatchObject({ code: 'RATE_LIMITED', retryAfterMs: 3000 });
    expect(waiting.error).toMatchObject({ code: 'RATE_LIMITED', retryAfterMs: 3000, engine: 'tavily' });
    governor.configure({ maxRequestsPerMinute: 600 });
    await timer.tick(2999);
    await expect(governor.run(waitingTask)).rejects.toMatchObject({ retryAfterMs: 1 });
    expect(waitingTask).not.toHaveBeenCalled();
    expect(task).toHaveBeenCalledTimes(1);
    await timer.tick(1);
    await expect(governor.run(waitingTask)).resolves.toBe('next');
  });

  test('counts failed provider attempts and rejects already queued requests when the local budget expires', async () => {
    const timer = clock();
    const governor = new RequestGovernor({ maxRequestsPerMinute: 2 }, timer);
    const active = deferred();
    const first = track(governor.run(() => active.promise));
    const waitingTask = jest.fn();
    const waiting = track(governor.run(waitingTask));
    governor.configure({ maxRequestsPerMinute: 1 });
    active.reject(new Error('provider failed'));
    await timer.flush();
    expect(first.error.message).toBe('provider failed');
    expect(waiting.error).toMatchObject({ code: 'RATE_LIMITED', retryAfterMs: 60000 });
    expect(waitingTask).not.toHaveBeenCalled();
  });

  test('disposal cancels active and queued work, clears timers, and rejects subsequent work', async () => {
    const timer = clock();
    const governor = new RequestGovernor({}, timer);
    const active = deferred();
    let receivedSignal;
    const first = track(governor.run(({ signal }) => {
      receivedSignal = signal;
      return active.promise;
    }));
    const task = jest.fn();
    const second = track(governor.run(task));
    governor.dispose();
    governor.dispose();
    await timer.flush();
    expect(first.error.code).toBe('ERR_CANCELED');
    expect(second.error.code).toBe('ERR_CANCELED');
    expect(receivedSignal.aborted).toBe(true);
    expect(timer.countTimers()).toBe(0);
    await expect(governor.run(task)).rejects.toMatchObject({ code: 'ERR_CANCELED' });
    active.resolve('late');
    await timer.flush();
    expect(task).not.toHaveBeenCalled();
  });

  test('already aborted work does not consume a request', async () => {
    const timer = clock();
    const governor = new RequestGovernor({ maxRequestsPerMinute: 1 }, timer);
    const controller = new AbortController();
    controller.abort();
    const task = jest.fn(() => 'result');
    await expect(governor.run(task, { signal: controller.signal })).rejects.toMatchObject({ code: 'ERR_CANCELED' });
    await expect(governor.run(task)).resolves.toBe('result');
    expect(task).toHaveBeenCalledTimes(1);
  });

  test.each([
    { maxRequestsPerMinute: 0 }, { maxRequestsPerMinute: 601 }, { maxRequestsPerMinute: 1.5 },
    { minIntervalMs: -1 }, { minIntervalMs: 60001 }, { maxPending: 0 }
  ])('rejects invalid limits %p', config => {
    expect(() => new RequestGovernor(config)).toThrow(RequestLimitError);
  });
});
