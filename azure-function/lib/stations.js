// Emisoras disponibles. Origen del stream de Caracol: streamtheworld (AAC).
// Se fuerza https:// porque AudioPlayer de Alexa exige TLS; verifica en el
// simulador que el endpoint acepta HTTPS antes de publicar el skill.
const STATIONS = {
  'caracol-bogota': {
    title: 'Caracol Radio Bogotá',
    url: 'https://16643.live.streamtheworld.com/CARACOL_RADIOAAC.aac'
  },
  rac1: {
    // TODO: sustituye por la URL real de RAC1 (ver README.md).
    title: 'RAC1 Barcelona',
    url: 'https://REEMPLAZA-CON-LA-URL-REAL/rac1.mp3'
  }
};

module.exports = STATIONS;
