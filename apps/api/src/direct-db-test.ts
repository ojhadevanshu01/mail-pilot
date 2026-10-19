import "dotenv/config";
import pg from "pg";

const pool = new pg.Pool({
  connectionString: process.env.DIRECT_URL,
});

pool
  .query("SELECT 1 AS result")
  .then((result) => console.log("Direct connection successful:", result.rows))
  .catch((error) => {
    console.error("Connection failed:", error.code, error.message);
  })
  .finally(() => pool.end());
