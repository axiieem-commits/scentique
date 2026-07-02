const mysql = require("mysql2/promise");
require("dotenv").config();

function getDatabaseConfig() {
  const mysqlUrl = process.env.MYSQL_PUBLIC_URL || process.env.MYSQL_URL;

  if (mysqlUrl) {
    const url = new URL(mysqlUrl);

    return {
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: url.pathname.replace(/^\//, "")
    };
  }

  let host = process.env.DB_HOST || process.env.MYSQLHOST || "localhost";
  let port = Number(process.env.DB_PORT || process.env.MYSQLPORT || 3306);

  if (host.includes(":")) {
    const [hostname, hostPort] = host.split(":");
    host = hostname;
    port = Number(hostPort || port);
  }

  return {
    host,
    port,
    user: process.env.DB_USER || process.env.MYSQLUSER,
    password: process.env.DB_PASSWORD || process.env.MYSQLPASSWORD,
    database: process.env.DB_NAME || process.env.MYSQLDATABASE
  };
}

const db = mysql.createPool({
  ...getDatabaseConfig(),
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  connectTimeout: 20000
});

module.exports = db;
