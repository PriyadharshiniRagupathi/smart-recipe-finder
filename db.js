require("dotenv").config();
const mysql = require("mysql2");
const fs = require("fs");
const dbName = process.env.DB_NAME || "smart_recipe_finder_v2";

if (!process.env.DB_USER || !process.env.DB_PASSWORD) {
    throw new Error(
        "Missing DB_USER or DB_PASSWORD. Add them to your .env file before starting the backend."
    );
}

const db = mysql.createConnection({
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: dbName,
    charset: "utf8mb4",
    ssl: {
        ca: fs.readFileSync("./ca.pem"),
        rejectUnauthorized: true
    }
});

db.connect((err) => {
    if (err) {
        console.error("MySQL connection failed:", err.message);
        return;
    }
    console.log(`MySQL connected successfully to database: ${dbName}`);
});

module.exports = db;
