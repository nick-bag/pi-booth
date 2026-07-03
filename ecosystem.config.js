module.exports = {
  apps: [
    {
      name: 'pi-booth',
      script: 'server/index.js',
      interpreter: 'node',
      watch: false,
      autorestart: true,
    },
  ],
};
