const assert = require('node:assert/strict');
const test = require('node:test');

process.env.TIKWM_API_KEY = process.env.TIKWM_API_KEY || 'test-key';
process.env.RENDER = process.env.RENDER || 'test';
const { app, isHttpsUrl, isTikTokUrl } = require('./server');

async function withServer(callback) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));

  try {
    const address = server.address();
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test('only accepts HTTPS links from supported TikTok hosts', () => {
  assert.equal(isTikTokUrl('https://www.tiktok.com/@creator/video/123'), true);
  assert.equal(isTikTokUrl('https://vm.tiktok.com/short-link'), true);
  assert.equal(isTikTokUrl('http://www.tiktok.com/@creator/video/123'), false);
  assert.equal(isTikTokUrl('https://tiktok.com.example.org/video/123'), false);
  assert.equal(isTikTokUrl('https://user@www.tiktok.com/video/123'), false);
  assert.equal(isTikTokUrl(`https://www.tiktok.com/${'a'.repeat(2050)}`), false);
});

test('only accepts HTTPS media URLs without embedded credentials', () => {
  assert.equal(isHttpsUrl('https://cdn.example/video.mp4'), true);
  assert.equal(isHttpsUrl('http://cdn.example/video.mp4'), false);
  assert.equal(isHttpsUrl('https://user:pass@cdn.example/video.mp4'), false);
  assert.equal(isHttpsUrl('not a URL'), false);
});

test('serves the informational pages, robots.txt, and sitemap', async () => {
  await withServer(async (baseUrl) => {
    for (const route of ['/about/', '/contact/', '/privacy/', '/terms/', '/robots.txt', '/sitemap.xml']) {
      const response = await fetch(`${baseUrl}${route}`);
      assert.equal(response.status, 200, `${route} should be available`);
    }

    const adsFile = await fetch(`${baseUrl}/ads.txt`);
    assert.equal(adsFile.status, 200);
    assert.match(await adsFile.text(), /^google\.com, pub-9788309907035738, DIRECT, f08c47fec0942fa0\s*$/);

    const home = await fetch(baseUrl);
    const homeHtml = await home.text();
    assert.equal((homeHtml.match(/adsbygoogle\.js/g) || []).length, 1);
    assert.match(homeHtml, /name="google-adsense-account" content="ca-pub-9788309907035738"/);
  });
});

test('rejects non-TikTok links without contacting the external API', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/descargar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/video' })
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Introduce un enlace HTTPS válido de TikTok.' });
  });
});

test('limits repeated requests from the same forwarded client IP', async () => {
  await withServer(async (baseUrl) => {
    const request = () => fetch(`${baseUrl}/api/descargar`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '203.0.113.42'
      },
      body: JSON.stringify({ url: 'https://example.com/video' })
    });

    for (let attempt = 0; attempt < 20; attempt += 1) {
      assert.equal((await request()).status, 400);
    }

    const limited = await request();
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
  });
});

test('returns sanitized errors for malformed and oversized JSON bodies', async () => {
  await withServer(async (baseUrl) => {
    const malformed = await fetch(`${baseUrl}/api/descargar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{invalid'
    });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { error: 'El cuerpo de la solicitud no es válido.' });

    const oversized = await fetch(`${baseUrl}/api/descargar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'a'.repeat(9000) })
    });
    assert.equal(oversized.status, 413);
    assert.deepEqual(await oversized.json(), { error: 'La solicitud es demasiado grande.' });
  });
});
