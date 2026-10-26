const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const API_KEY = process.env.TIKWM_API_KEY;
if (!API_KEY) {
  throw new Error('Falta TIKWM_API_KEY. Configúrala en .env o en el entorno del servidor.');
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.post('/api/descargar', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL no proporcionada' });
  }

  try {
    const response = await axios.get('https://tikwm.com/api', {
      params: {
        url,
        hd: 1,
        count: 1,
        key: API_KEY
      }
    });

    const data = response.data;

    if (data.code !== 0) {
      return res.status(400).json({ error: data.msg || 'Error al procesar el video' });
    }

    console.log('Datos recibidos de la API:', data.data);  // Aquí el log

    const videoSinMarca = data.data.play || data.data.play_hd;
    if (!videoSinMarca) {
      return res.status(404).json({ error: 'No se encontró video sin marca de agua' });
    }

    return res.json({
      videoUrl: videoSinMarca,
      audioUrl: data.data.music || null,
      cover: data.data.cover  // Quizá aquí cambiarás después
    });

  } catch (err) {
    console.error(err.message || err);
    return res.status(500).json({ error: 'Error del servidor al contactar con TikWM' });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor activo en http://localhost:${PORT}`);
});
