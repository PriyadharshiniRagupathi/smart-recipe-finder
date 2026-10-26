require("dotenv").config();
const express = require("express");
const db = require("./db");
const cors = require("cors");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const origins = (process.env.FRONTEND_ORIGINS ||
    "http://127.0.0.1:5500,http://localhost:5500")
    .split(",").map(value => value.trim()).filter(Boolean);

app.use(cors({ origin: origins }));
app.use(express.json());

function query(sql, values = []) {
    return new Promise((resolve, reject) => {
        db.query(sql, values, (err, results) => err ? reject(err) : resolve(results));
    });
}

function normalize(value) {
    return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function safeIdentifier(name) {
    if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error("Unexpected column name.");
    return `\`${name}\``;
}

async function categoryInfo() {
    const columns = await query("SHOW COLUMNS FROM categories");
    const names = columns.map(row => row.Field);
    const id = ["id", "category_id"].find(name => names.includes(name));
    const label = ["name", "category_name", "title", "slug"].find(name => names.includes(name));
    if (!id || !label) throw new Error("Could not identify categories ID/name columns.");
    return { id: safeIdentifier(id), label: safeIdentifier(label) };
}

async function recipeListSql(where = "", suffix = "") {
    const c = await categoryInfo();
    return `SELECT r.*, c.${c.label.replace(/`/g, "")} AS category, c.${c.label.replace(/`/g, "")} AS category_name,
        r.image_url AS image, r.video_url AS video
        FROM recipes r JOIN categories c ON c.${c.id.replace(/`/g, "")}=r.category_id
        ${where} ${suffix}`;
}

app.get("/", (req, res) => res.send("Smart Recipe Finder Backend is Running!"));

app.get("/categories", async (req, res) => {
    try {
        const c = await categoryInfo();
        const rows = await query(`SELECT ${c.id} AS id, ${c.label} AS name FROM categories ORDER BY ${c.id}`);
        res.json(rows);
    } catch (err) {
        console.error("Error fetching categories:", err.message);
        res.status(500).json({ error: "Could not fetch categories." });
    }
});

app.get("/ingredients", async (req, res) => {
    try {
        res.json(await query("SELECT id, name, category FROM ingredients ORDER BY category, name"));
    } catch (err) {
        console.error("Error fetching ingredients:", err.message);
        res.status(500).json({ error: "Could not fetch ingredients." });
    }
});

app.get("/recipes/search", async (req, res) => {
    try {
        const rawNames = typeof req.query.ingredients === "string" ? req.query.ingredients : "";
        const names = [...new Set(rawNames.split(",").map(x => x.trim()).filter(Boolean))];
        if (!names.length) return res.status(400).json({ error: "Select at least one ingredient." });

        const marks = names.map(() => "?").join(",");
        const matched = await query(
            `SELECT id, name FROM ingredients WHERE LOWER(name) IN (${marks})`,
            names.map(name => name.toLowerCase())
        );
        const ids = [...new Set(matched.map(row => row.id))];

        // If any selected ingredient is absent from the database, no recipe can contain all selections.
        if (ids.length !== names.length) return res.json([]);

        const sql = await recipeListSql(
            `WHERE r.id IN (
                SELECT ri.recipe_id
                FROM recipe_ingredients ri
                WHERE ri.ingredient_id IN (${ids.map(() => "?").join(",")})
                GROUP BY ri.recipe_id
                HAVING COUNT(DISTINCT ri.ingredient_id)=?
            )`,
            "ORDER BY r.name"
        );
        const results = await query(sql, [...ids, ids.length]);
        res.json(results);
    } catch (err) {
        console.error("Ingredient search failed:", err.message);
        res.status(500).json({ error: "Could not search recipes." });
    }
});

app.get("/recipes", async (req, res) => {
    try {
        const sql = await recipeListSql("", "ORDER BY r.name");
        res.json(await query(sql));
    } catch (err) {
        console.error("Error fetching recipes:", err.message);
        res.status(500).json({ error: "Could not fetch recipes." });
    }
});

async function sendRecipeDetails(req, res, mode) {
    try {
        const value = mode === "name" ? req.params.name : req.params.id;
        const recipeSql = await recipeListSql(
           mode === "name"
    ? "WHERE LOWER(r.name)=LOWER(?) OR LOWER(r.slug)=LOWER(?)"
    :
                (/^\d+$/.test(value) ? "WHERE r.id=?" : "WHERE r.slug=?"),
            "LIMIT 1"
        );
        const rows = await query(
    recipeSql,
    mode === "name" ? [value, value] : [value]
);
        if (!rows.length) return res.status(404).json({ error: "Recipe not found." });

        const recipe = rows[0];
        let ingredients = await query(
            `SELECT i.id AS ingredient_id, i.name AS ingredient_name, i.category, ri.quantity
             FROM recipe_ingredients ri
             JOIN ingredients i ON i.id=ri.ingredient_id
             WHERE ri.recipe_id=? ORDER BY i.name`,
            [recipe.id]
        );

        let steps = recipe.steps || [];
        if (typeof steps === "string") {
            try { steps = JSON.parse(steps); } catch { steps = []; }
        }
        if (!Array.isArray(steps)) steps = [];

        res.json({ recipe, ingredients, steps });
    } catch (err) {
        console.error("Error fetching recipe details:", err.message);
        res.status(500).json({ error: "Could not fetch recipe details." });
    }
}

// Keep the name route before /recipe/:id so Express does not treat "name" as an ID.
app.get("/recipe/name/:name", (req, res) => sendRecipeDetails(req, res, "name"));
app.get("/recipe/:id", (req, res) => sendRecipeDetails(req, res, "id"));

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
