import packageJson from '../../package.json';

export const environment = {
  version: packageJson.version,
  production: false,
  /** En desarrollo `ng serve` hace proxy de /socket.io hacia http://localhost:3000. */
  socketUrl: '',
};
