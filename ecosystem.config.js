module.exports = {
  apps: [
    {
      name: 'pi-booth',
      script: 'server/index.js',
      interpreter: 'node',
      env_file: 'server/.env',
      watch: false,
      autorestart: true,
    },
  ],
};
