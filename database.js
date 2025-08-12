const { MongoClient } = require("mongodb");

// --- DEBUGGING CODE START ---
// هذا الكود سيطبع قيمة المتغير في الـ Logs لنرى ما هي المشكلة
console.log("--- DEBUGGING MONGO_URI ---");
const uri_for_debugging = process.env.MONGO_URI;
console.log("Is MONGO_URI variable present?", !!uri_for_debugging);
console.log("Type of MONGO_URI:", typeof uri_for_debugging);
if (uri_for_debugging) {
    console.log("Value of MONGO_URI:", uri_for_debugging.substring(0, 15) + "..."); // نطبع أول 15 حرفًا فقط للأمان
}
console.log("--- END DEBUGGING ---");
// --- DEBUGGING CODE END ---


const uri = process.env.MONGO_URI;

if (!uri) {
    throw new Error("MONGO_URI environment variable is not defined.");
}

const client = new MongoClient(uri);

let db;

async function connectDB() {
    if (db) return db;
    try {
        await client.connect();
        db = client.db("okxBotData"); 
        console.log("Successfully connected to MongoDB.");
        return db;
    } catch (e) {
        console.error("Failed to connect to MongoDB", e);
        process.exit(1);
    }
}

const getDB = () => db;

module.exports = { connectDB, getDB };
