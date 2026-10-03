import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OfflineError } from './notes-api.js';
import { resetConnectivity, setReachableForTests } from './connectivity.js';
import { NOT_AVAILABLE_OFFLINE, standInForImage, unavailableOffline, whenBackOnline } from './offline-file.js';

beforeEach(() => resetConnectivity());
afterEach(() => {
  document.body.innerHTML = '';
  resetConnectivity();
});

describe('unavailableOffline', () => {
  it('is true for a fetch that had no connection, and whenever the app is offline', () => {
    expect(unavailableOffline(new OfflineError())).toBe(true);
    expect(unavailableOffline(new Error('404 Not Found'))).toBe(false);
    expect(unavailableOffline()).toBe(false);
    setReachableForTests(false);
    expect(unavailableOffline()).toBe(true);
    expect(unavailableOffline(new Error('anything'))).toBe(true);
  });
});

describe('standInForImage', () => {
  const picture = () => {
    const img = document.createElement('img');
    img.setAttribute('src', '/api/notes/n1/files/photo.jpg');
    document.body.appendChild(img);
    return img;
  };

  it('leaves a picture that failed online to its caller', () => {
    const img = picture();
    expect(standInForImage(img, 'photo.jpg')).toBe(false);
    expect(img.hidden).toBe(false);
    expect(document.body.textContent).toBe('');
  });

  it('puts a plain line where the picture would be, and the picture back when the connection returns', () => {
    setReachableForTests(false);
    const img = picture();
    expect(standInForImage(img, 'photo.jpg')).toBe(true);
    expect(img.hidden).toBe(true);
    expect(document.querySelector('.file-unavailable')?.textContent).toBe(`photo.jpg · ${NOT_AVAILABLE_OFFLINE}`);

    setReachableForTests(true);
    expect(img.hidden).toBe(false);
    expect(document.querySelector('.file-unavailable')).toBeNull();
    expect(img.getAttribute('src')).toBe('/api/notes/n1/files/photo.jpg');
  });

  it('says only the phrase when there is no name to say', () => {
    setReachableForTests(false);
    standInForImage(picture(), '');
    expect(document.querySelector('.file-unavailable')?.textContent).toBe(NOT_AVAILABLE_OFFLINE);
  });
});

describe('whenBackOnline', () => {
  it('runs once, on the next return of the connection, unless stopped', () => {
    setReachableForTests(false);
    let ran = 0;
    whenBackOnline(() => (ran += 1));
    const stop = whenBackOnline(() => (ran += 10));
    stop();
    setReachableForTests(true);
    setReachableForTests(false);
    setReachableForTests(true);
    expect(ran).toBe(1);
  });
});
