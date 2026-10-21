import { describe, expect, it } from 'vitest';
import { UPDATE_CHECK_INTERVAL, offlineReadyState, shouldCheckOnReturn } from './sw-register.js';
import { holdPage, pageBusy } from './busy.js';

describe('shouldCheckOnReturn', () => {
  it('asks for a new worker on a return, at most once a minute', () => {
    expect(shouldCheckOnReturn(UPDATE_CHECK_INTERVAL)).toBe(true);
    expect(shouldCheckOnReturn(UPDATE_CHECK_INTERVAL - 1)).toBe(false);
  });
});

describe('holdPage', () => {
  it('keeps the page busy until every hold is released', () => {
    expect(pageBusy()).toBe(false);
    const a = holdPage();
    const b = holdPage();
    expect(pageBusy()).toBe(true);
    a();
    expect(pageBusy()).toBe(true);
    b();
    expect(pageBusy()).toBe(false);
  });
});

describe('offlineReadyState', () => {
  const controlled = { controller: {} as ServiceWorker };
  const uncontrolled = { controller: null };

  it('is ready once the page is under a worker', () => {
    expect(offlineReadyState({ prod: true, serviceWorker: controlled })).toBe('ready');
  });

  it('is installing in a production build whose page has no worker yet', () => {
    expect(offlineReadyState({ prod: true, serviceWorker: uncontrolled })).toBe('installing');
  });

  it('is unavailable in a development build, where no worker is registered', () => {
    expect(offlineReadyState({ prod: false, serviceWorker: uncontrolled })).toBe('unavailable');
  });

  it('is unavailable without service workers', () => {
    expect(offlineReadyState({ prod: true, serviceWorker: undefined })).toBe('unavailable');
  });
});
