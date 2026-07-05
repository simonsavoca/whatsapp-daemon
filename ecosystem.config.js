const path = require("path");

module.exports = {
  apps: [
    {
      name: "whatsapp-daemon",
      script: "daemon.js",
      cwd: __dirname,
      autorestart: true,
    },
  ],
};
