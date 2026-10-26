require("dotenv").config();
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const db = require("./db");

const TARGET_DATABASE = "smart_recipe_finder_v2";
const EXPECTED_RECIPE_COUNT = 150;
const CATEGORY_ORDER = [
    "Breakfast", "Lunch", "Dinner", "Snacks", "Desserts",
    "Healthy", "Vegetarian", "Non-vegetarian", "South Indian", "Drinks"
];

function extractRecipes(html) {
    const marker = "const recipes =";
    const markerIndex = html.indexOf(marker);
    if (markerIndex === -1) {
        throw new Error('Could not find "const recipes =" in recipe.html.');
    }

    const start = html.indexOf("{", markerIndex);
    if (start === -1) throw new Error("Recipes object not found.");

    let depth = 0;
    let quote = null;
    let escaped = false;

    for (let i = start; i < html.length; i++) {
        const ch = html[i];

        if (quote) {
            if (escaped) { escaped = false; continue; }
            if (ch === "\\") { escaped = true; continue; }
            if (ch === quote) quote = null;
            continue;
        }

        if (ch === "'" || ch === '"') { quote = ch; continue; }
        if (ch === "{") depth++;
        if (ch === "}") {
            depth--;
            if (depth === 0) {
                return vm.runInNewContext("(" + html.slice(start, i + 1) + ")");
            }
        }
    }
    throw new Error("End of recipes object not found.");
}

function query(sql, values = []) {
    return new Promise((resolve, reject) => {
        db.query(sql, values, (err, results) => err ? reject(err) : resolve(results));
    });
}

function normalize(value) {
    return String(value ?? "")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

function toMinutes(value) {
    const match = String(value ?? "").match(/\d+/);
    return match ? Number(match[0]) : 0;
}

function toServings(value) {
    const match = String(value ?? "").match(/\d+/);
    return match ? Math.max(1, Number(match[0])) : 1;
}

function classifyIngredient(name) {
    const n = normalize(name);
    const groups = {
        Vegetables: [
            "tomato", "potato", "onion", "shallot", "garlic", "ginger", "carrot",
            "beans", "peas", "capsicum", "bell pepper", "spinach", "cabbage",
            "cauliflower", "brinjal", "eggplant", "okra", "ladies finger",
            "drumstick", "pumpkin", "bottle gourd", "ridge gourd", "cucumber",
            "mushroom", "coriander leaves", "curry leaves", "green chilli",
            "chilli", "lemon", "mint", "coconut", "jackfruit", "raw banana"
        ],
        Fruits: [
            "apple", "banana", "mango", "orange", "pineapple", "watermelon",
            "papaya", "grapes", "strawberry", "fruit", "tender coconut"
        ],
        Dairy: [
            "milk", "curd", "yogurt", "yoghurt", "butter", "ghee", "cheese",
            "paneer", "cream", "buttermilk", "khoya"
        ],
        Spices: [
            "salt", "pepper", "turmeric", "cumin", "mustard", "coriander powder",
            "chilli powder", "chili powder", "garam masala", "cardamom", "clove",
            "cinnamon", "fenugreek", "asafoetida", "hing", "curry powder",
            "sambar powder", "rasam powder", "cumin seeds", "mustard seeds"
        ]
    };

    for (const [category, words] of Object.entries(groups)) {
        if (words.some(word => n === normalize(word) || n.includes(normalize(word)))) {
            return category;
        }
    }
    return "Other";
}

function safeIdentifier(name) {
    if (!/^[A-Za-z0-9_]+$/.test(name)) {
        throw new Error(`Unexpected database column name: ${name}`);
    }
    return `\`${name}\``;
}

async function main() {
    const htmlPath = path.join(__dirname, "recipe.html");
    if (!fs.existsSync(htmlPath)) {
        throw new Error("Copy your own recipe.html into this backend folder first.");
    }

    const selected = await query("SELECT DATABASE() AS dbName");
    if (!selected[0] || selected[0].dbName !== TARGET_DATABASE) {
        throw new Error(
            `Safety stop: connected to "${selected[0]?.dbName || "no database"}", not "${TARGET_DATABASE}". Nothing was imported.`
        );
    }

    const [categoryColumns, recipeColumns, ingredientColumns, linkColumns] = await Promise.all([
        query("SHOW COLUMNS FROM categories"),
        query("SHOW COLUMNS FROM recipes"),
        query("SHOW COLUMNS FROM ingredients"),
        query("SHOW COLUMNS FROM recipe_ingredients")
    ]);

    const colNames = rows => rows.map(row => row.Field);
    const categoryColNames = colNames(categoryColumns);
    const recipeColNames = colNames(recipeColumns);
    const ingredientColNames = colNames(ingredientColumns);
    const linkColNames = colNames(linkColumns);

    const categoryIdCol = ["id", "category_id"].find(c => categoryColNames.includes(c));
    const categoryNameCol = ["name", "category_name", "title", "slug"].find(c => categoryColNames.includes(c));
    if (!categoryIdCol || !categoryNameCol) {
        throw new Error("Could not identify the ID and name columns in categories. No data was imported.");
    }

    const required = {
        recipes: ["id", "category_id", "name", "slug", "description", "prep_time", "cook_time",
            "servings", "image_url", "video_url", "preparation", "steps"],
        ingredients: ["id", "name", "category"],
        recipe_ingredients: ["recipe_id", "ingredient_id", "quantity"]
    };
    for (const [table, columns] of Object.entries(required)) {
        const actual = table === "recipes" ? recipeColNames :
            table === "ingredients" ? ingredientColNames : linkColNames;
        const missing = columns.filter(c => !actual.includes(c));
        if (missing.length) {
            throw new Error(`Schema check failed: ${table} is missing columns: ${missing.join(", ")}. No data was imported.`);
        }
    }

    const categoryRows = await query(
        `SELECT ${safeIdentifier(categoryIdCol)} AS id, ${safeIdentifier(categoryNameCol)} AS name FROM categories`
    );
    if (categoryRows.length !== 10) {
        throw new Error(`Expected the existing 10 categories, found ${categoryRows.length}. No data was imported.`);
    }

    const categoryByName = new Map(categoryRows.map(c => [normalize(c.name), c.id]));
    const missingCategories = CATEGORY_ORDER.filter(name => !categoryByName.has(normalize(name)));
    if (missingCategories.length) {
        throw new Error(
            `These expected categories were not found in the existing categories table: ${missingCategories.join(", ")}. ` +
            `No category rows were added and no recipes were imported.`
        );
    }

    const html = fs.readFileSync(htmlPath, "utf8");
    const recipeObject = extractRecipes(html);
    const entries = Object.entries(recipeObject);

    if (entries.length !== EXPECTED_RECIPE_COUNT) {
        throw new Error(`Expected ${EXPECTED_RECIPE_COUNT} recipe records in recipe.html, found ${entries.length}. No data was imported.`);
    }

    // The inspected source is arranged in ten consecutive groups of 15 recipes.
    // Validate each group's source labels before using that group to assign category_id.
    const groupChecks = [
        /breakfast/i, /lunch/i, /dinner/i, /snack|street food/i, /dessert|sweet/i,
        /healthy|millet|salad|fruit|drink/i, /vegetarian/i, /non.?vegetarian/i,
        /south indian/i, /drink|beverage/i
    ];
    entries.forEach(([slug, item], index) => {
        const group = Math.floor(index / 15);
        if (!item.name || !Array.isArray(item.ingredients) || !Array.isArray(item.steps)) {
            throw new Error(`Recipe "${slug}" is missing a name, ingredients array, or steps array. No data was imported.`);
        }
        if (!groupChecks[group].test(String(item.category || ""))) {
            throw new Error(
                `Recipe order/category check failed at "${slug}" (${item.category}). ` +
                `The source order differs from the inspected 15-recipes-per-category layout. No data was imported.`
            );
        }
    });

    await query("START TRANSACTION");
    try {
        let insertedRecipes = 0;
        let updatedRecipes = 0;
        let insertedIngredients = 0;
        let insertedLinks = 0;

        for (let i = 0; i < entries.length; i++) {
            const [sourceSlug, item] = entries[i];
            const slug = String(sourceSlug).trim().toLowerCase()
                .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
            const categoryName = CATEGORY_ORDER[Math.floor(i / 15)];
            const categoryId = categoryByName.get(normalize(categoryName));
            const steps = item.steps.map((step, idx) => ({
                step_number: idx + 1,
                title: String(step?.[0] || `Step ${idx + 1}`).trim(),
                description: String(step?.[1] || "").trim()
            }));

            const recipeValues = [
                categoryId,
                String(item.name).trim(),
                slug,
                String(item.description || "").trim(),
                toMinutes(item.prep),
                toMinutes(item.cook),
                toServings(item.servings),
                String(item.image || "").trim(),
                String(item.video || "").trim(),
                String(item.preparation || "").trim(),
                JSON.stringify(steps)
            ];

            let existing = await query("SELECT id FROM recipes WHERE slug = ? LIMIT 1", [slug]);
            if (!existing.length) {
                existing = await query("SELECT id FROM recipes WHERE LOWER(name) = LOWER(?) LIMIT 1", [item.name]);
            }

            let recipeId;
            if (existing.length) {
                recipeId = existing[0].id;
                await query(
                    `UPDATE recipes SET category_id=?, name=?, slug=?, description=?, prep_time=?, cook_time=?, servings=?, image_url=?, video_url=?, preparation=?, steps=? WHERE id=?`,
                    [...recipeValues, recipeId]
                );
                updatedRecipes++;
            } else {
                const result = await query(
                    `INSERT INTO recipes (category_id, name, slug, description, prep_time, cook_time, servings, image_url, video_url, preparation, steps)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    recipeValues
                );
                recipeId = result.insertId;
                insertedRecipes++;
            }

            for (const pair of item.ingredients) {
                const ingredientName = String(pair?.[0] || "").trim().replace(/\s+/g, " ");
                const quantity = String(pair?.[1] || "").trim();
                if (!ingredientName) continue;

                let found = await query(
                    "SELECT id, category FROM ingredients WHERE LOWER(name)=LOWER(?) LIMIT 1",
                    [ingredientName]
                );
                let ingredientId;
                const classifiedCategory = classifyIngredient(ingredientName);

                if (found.length) {
                    ingredientId = found[0].id;
                    if (found[0].category === "Other" && classifiedCategory !== "Other") {
                        await query("UPDATE ingredients SET category=? WHERE id=?", [classifiedCategory, ingredientId]);
                    }
                } else {
                    const result = await query(
                        "INSERT INTO ingredients (name, category) VALUES (?, ?)",
                        [ingredientName, classifiedCategory]
                    );
                    ingredientId = result.insertId;
                    insertedIngredients++;
                }

                const existingLink = await query(
                    "SELECT recipe_id FROM recipe_ingredients WHERE recipe_id=? AND ingredient_id=? LIMIT 1",
                    [recipeId, ingredientId]
                );
                if (existingLink.length) {
                    await query(
                        "UPDATE recipe_ingredients SET quantity=? WHERE recipe_id=? AND ingredient_id=?",
                        [quantity, recipeId, ingredientId]
                    );
                } else {
                    await query(
                        "INSERT INTO recipe_ingredients (recipe_id, ingredient_id, quantity) VALUES (?, ?, ?)",
                        [recipeId, ingredientId, quantity]
                    );
                    insertedLinks++;
                }
            }
        }

        const counts = await query(
            `SELECT
                (SELECT COUNT(*) FROM categories) AS categories,
                (SELECT COUNT(*) FROM recipes) AS recipes,
                (SELECT COUNT(*) FROM ingredients) AS ingredients,
                (SELECT COUNT(*) FROM recipe_ingredients) AS recipe_ingredients`
        );

        await query("COMMIT");
        console.log("Import completed successfully.");
        console.log(`Database: ${TARGET_DATABASE}`);
        console.log(`Source recipes: ${entries.length}`);
        console.log(`Recipes inserted: ${insertedRecipes}; recipes updated: ${updatedRecipes}`);
        console.log(`New ingredients inserted: ${insertedIngredients}`);
        console.log(`New recipe_ingredients links inserted: ${insertedLinks}`);
        console.log("Final table counts:", counts[0]);
    } catch (error) {
        await query("ROLLBACK");
        throw error;
    }
}

main()
    .catch(error => {
        console.error("\nImport stopped:", error.message);
        process.exitCode = 1;
    })
    .finally(() => {
        db.end(err => {
            if (err) console.error("Error closing MySQL connection:", err.message);
        });
    });
