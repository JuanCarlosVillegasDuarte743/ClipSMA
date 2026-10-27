const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const app = express();
const TIKTOK_HOSTS = new Set([
  'tiktok.com',
  'www.tiktok.com',
  'm.tiktok.com',
  'vm.tiktok.com',
  'vt.tiktok.com'
]);
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 20;
const RATE_LIMIT_MAX_CLIENTS = 5000;
const downloadRequests = new Map();
let rateLimitChecks = 0;

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const API_KEY = process.env.TIKWM_API_KEY;
if (!API_KEY) {
  throw new Error('Falta TIKWM_API_KEY. Configúrala en .env o en el entorno del servidor.');
}

const PORT = Number(process.env.PORT) || 3000;
app.disable('x-powered-by');
app.set('trust proxy', process.env.RENDER ? 1 : false);
app.use(express.json({ limit: '8kb' }));
app.use('/images', express.static(path.join(__dirname, '..', 'images')));
app.use(express.static(path.join(__dirname, '..', 'public')));

function isTikTokUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) {
    return false;
  }

  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && (!url.port || url.port === '443')
      && TIKTOK_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function isHttpsUrl(value) {
  if (typeof value !== 'string') {
    return false;
  }

  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

function limitDownloadRequests(req, res, next) {
  const now = Date.now();
  const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
  let client = downloadRequests.get(clientIp);

  if (!client || now - client.startedAt >= RATE_LIMIT_WINDOW_MS) {
    if (!client && downloadRequests.size >= RATE_LIMIT_MAX_CLIENTS) {
      for (const [ip, entry] of downloadRequests) {
        if (now - entry.startedAt >= RATE_LIMIT_WINDOW_MS) {
          downloadRequests.delete(ip);
        }
      }

      if (downloadRequests.size >= RATE_LIMIT_MAX_CLIENTS) {
        return res.status(503).json({ error: 'El servicio está temporalmente ocupado. Inténtalo más tarde.' });
      }
    }

    client = { startedAt: now, count: 0 };
    downloadRequests.set(clientIp, client);
  }

  if (client.count >= RATE_LIMIT_MAX_REQUESTS) {
    const retryAfter = Math.ceil((client.startedAt + RATE_LIMIT_WINDOW_MS - now) / 1000);
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({ error: 'Has realizado demasiadas solicitudes. Inténtalo más tarde.' });
  }

  client.count += 1;
  rateLimitChecks += 1;
  if (rateLimitChecks % 256 === 0) {
    for (const [ip, entry] of downloadRequests) {
      if (now - entry.startedAt >= RATE_LIMIT_WINDOW_MS) {
        downloadRequests.delete(ip);
      }
    }
  }

  return next();
}

app.post('/api/descargar', limitDownloadRequests, async (req, res) => {
  const url = req.body?.url;

  if (!isTikTokUrl(url)) {
    return res.status(400).json({ error: 'Introduce un enlace HTTPS válido de TikTok.' });
  }

  try {
    const response = await axios.get('https://tikwm.com/api', {
      params: {
        url,
        hd: 1,
        count: 1,
        key: API_KEY
      },
      timeout: 15000,
      maxRedirects: 0,
      maxContentLength: 1024 * 1024
    });

    const data = response.data;

    if (data?.code !== 0 || !data.data || typeof data.data !== 'object') {
      return res.status(400).json({ error: 'El proveedor no pudo procesar este video.' });
    }

    const videoUrl = data.data.play || data.data.play_hd;
    const audioUrl = data.data.music || null;
    if (!isHttpsUrl(videoUrl) || (audioUrl !== null && !isHttpsUrl(audioUrl))) {
      return res.status(502).json({ error: 'El proveedor devolvió un enlace de descarga no válido.' });
    }

    return res.json({
      videoUrl,
      audioUrl
    });

  } catch {
    console.error('Error al contactar con el proveedor de procesamiento de videos.');
    return res.status(502).json({ error: 'No se pudo completar la solicitud. Inténtalo más tarde.' });
  }
});

app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'La solicitud es demasiado grande.' });
  }

  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'El cuerpo de la solicitud no es válido.' });
  }

  console.error('Error inesperado al procesar una solicitud HTTP.');
  return res.status(500).json({ error: 'Ocurrió un error interno. Inténtalo más tarde.' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Servidor activo en el puerto ${PORT}`);
  });
}

module.exports = { app, isHttpsUrl, isTikTokUrl };
