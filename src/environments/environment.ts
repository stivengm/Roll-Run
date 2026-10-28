import packageJson from '../../package.json';

export const environment = {
  version: packageJson.version,
  production: true,
  /**
   * URL del servidor Socket.IO. Vacío = mismo origen (el servidor Node sirve el build).
   * Si publicas el front aparte (p. ej. GitHub Pages), pon aquí la URL del servidor.
   */
  socketUrl: '',
};
