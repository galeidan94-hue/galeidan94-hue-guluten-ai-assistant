// שרת פשוט שמקבל הודעות מהצ'אט באתר, מוסיף להן את בסיס הידע (FAQ + מוצרים),
// שולח את זה ל-OpenAI API, ומחזיר את התשובה לווידג'ט.

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const PORT = process.env.PORT || 3000;

if (!OPENAI_API_KEY) {
  console.warn('אזהרה: לא הוגדר OPENAI_API_KEY בקובץ .env - הקריאות ל-API ייכשלו.');
}

let cache = { faq: [], products: [], loadedAt: 0 };
const RELOAD_INTERVAL_MS = 5 * 60 * 1000; // 5 דקות

function loadKnowledge() {
  const now = Date.now();
  if (now - cache.loadedAt < RELOAD_INTERVAL_MS && cache.products.length) {
    return cache;
  }
  const faq = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'faq.json'), 'utf8'));
  const products = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'products.json'), 'utf8'));
  cache = { faq, products, loadedAt: now };
  return cache;
}

const STOPWORDS = new Set(['את','של','עם','אני','אתה','את','יש','אין','זה','זו','על','אם','לא','כן','גם','או','מה','איך','למה','כמה','אפשר','רוצה','רוצים','תמליץ','המלצה','טוב','בשביל','עבור']);

function tokenize(text) {
  return text
    .replace(/[^\u0590-\u05FFa-zA-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .map(w => w.trim())
    .filter(w => w.length >= 2 && !STOPWORDS.has(w));
}

function searchProducts(query, products, limit = 15) {
  const tokens = tokenize(query);
  if (!tokens.length) return [];

  const scored = products.map(p => {
    const haystack = `${p.name} ${p.category} ${p.description}`;
    let score = 0;
    for (const t of tokens) {
      if (haystack.includes(t)) score += 1;
    }
    return { p, score };
  }).filter(x => x.score > 0);

  scored.sort((a, b) => b.score - a.score || (b.p.in_stock ? 1 : 0) - (a.p.in_stock ? 1 : 0));
  return scored.slice(0, limit).map(x => x.p);
}

function buildSystemPrompt(userMessage) {
  const { faq, products } = loadKnowledge();

  const faqText = faq.map(f => `שאלה: ${f.question}\nתשובה: ${f.answer}`).join('\n\n');

  const relevant = searchProducts(userMessage, products);
  const productsText = relevant.length
    ? relevant.map(p =>
        `- ${p.name} | קטגוריה: ${p.category} | מחיר: ${p.price} ש"ח | במלאי: ${p.in_stock ? 'כן' : 'לא'} | קישור: ${p.url}`
      ).join('\n')
    : '(לא נמצאו מוצרים תואמים לשאלה זו מתוך החיפוש האוטומטי - אם השאלה עוסקת במוצר ספציפי, אפשר להציע ללקוח לחפש באתר או לשאול בניסוח אחר.)';

  return `את/ה עוזר/ת AI ידידותי/ת של חנות "גולוטן" - חנות אונליין למוצרים ללא גלוטן. תפקידך:
1. לענות על שאלות נפוצות בהתאם למידע שמופיע כאן בלבד - אסור להמציא מדיניות שלא מופיעה במידע.
2. להמליץ על מוצרים אך ורק מתוך הרשימה הרלוונטית שמופיעה כאן (זו תת-קבוצה מתוך קטלוג של כ-1100 מוצרים פעילים, שנבחרה אוטומטית לפי השאלה) - אסור בהחלט להמציא שם מוצר, מחיר, או פרט שלא מופיע במפורש ברשימה הזו. אם השאלה עוסקת במוצר ספציפי שלא נמצא ברשימה, אמור בכנות שאין לך מידע מדויק עליו ברגע זה, והצע ללקוח לחפש אותו באתר או לנסח את השאלה אחרת - אל תנחש.
3. תמיד לצטט את הקישור (url) בדיוק כפי שהוא מופיע ברשימה, מילה במילה - אסור לקצר, לשנות, או להמציא קישור.
4. להציע מתכונים ורעיונות בישול על סמך הידע הכללי שלך - זה לא חייב להיות מוגבל למידע שכאן, ואפשר לשלב בהם המלצה למוצר מהרשימה (עם קישור מדויק) אם רלוונטי.
5. לענות בעברית, בטון חם וידידותי, בקצרה וברורה.
6. אם נשאלת שאלה שאין עליה מידע (למשל ייעוץ רפואי, כשרות של מוצר ספציפי שלא ברשימה), אמור בכנות שאין לך את המידע המדויק והפנה ליצירת קשר בוואטסאפ במספר
