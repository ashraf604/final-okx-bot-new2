const { MongoClient } = require("mongodb");

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
