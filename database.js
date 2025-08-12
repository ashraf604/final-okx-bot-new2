// database.js

// استيراد مكتبة MongoDB
const { MongoClient } = require("mongodb");

// لا حاجة لاستخدام مكتبة "dotenv" في بيئة Render
// لأن Render يقوم بتعيين متغيرات البيئة تلقائيًا من لوحة التحكم.
// require("dotenv").config(); // <== تم تحويل هذا السطر إلى تعليق لأنه غير ضروري وقد يسبب مشاكل

// قراءة سلسلة الاتصال من متغيرات البيئة التي قمت بتعيينها في Render
const uri = process.env.MONGO_URI;

// التحقق من وجود سلسلة الاتصال، وإذا لم تكن موجودة، يتم إيقاف التطبيق مع رسالة خطأ واضحة
if (!uri) {
    throw new Error("MONGO_URI is not defined in your environment variables on Render.");
}

// إنشاء عميل MongoDB جديد باستخدام سلسلة الاتصال
const client = new MongoClient(uri);

// متغير لتخزين الاتصال بقاعدة البيانات لتجنب إعادة الاتصال في كل مرة
let db;

/**
 * دالة للاتصال بقاعدة البيانات.
 * إذا كان الاتصال موجودًا بالفعل، تعيده مباشرة.
 * إذا لم يكن موجودًا، تقوم بإنشاء اتصال جديد.
 */
async function connectDB() {
    if (db) return db; // إذا كان الاتصال موجودًا، قم بإعادته

    try {
        // محاولة الاتصال بالكلاستر الخاص بك في MongoDB Atlas
        await client.connect();
        
        // تحديد قاعدة البيانات التي تريد العمل عليها بالاسم
        // تأكد من أن "okxBotData" هو الاسم الصحيح لقاعدة بياناتك
        db = client.db("okxBotData"); 
        
        console.log("Successfully connected to MongoDB.");
        
        // إعادة كائن قاعدة البيانات للتعامل معه في أجزاء أخرى من الكود
        return db;
    } catch (e) {
        // في حالة فشل الاتصال، يتم طباعة الخطأ وإيقاف التطبيق
        console.error("Failed to connect to MongoDB", e);
        process.exit(1); // إنهاء العملية لأن التطبيق لا يمكنه العمل بدون قاعدة بيانات
    }
}

/**
 * دالة للحصول على كائن قاعدة البيانات المتصلة حاليًا.
 */
const getDB = () => db;

// تصدير الدوال لاستخدامها في ملفات أخرى مثل index.js
module.exports = { connectDB, getDB };
