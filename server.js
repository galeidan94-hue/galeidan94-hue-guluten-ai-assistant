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

// בסיס הידע נטען פעם אחת לזיכרון ומתעדכן כל כמה דקות - כך שאין קריאת דיסק
// יקרה בכל בקשה, אבל עדכון קבצים עדיין נכנס לתוקף בלי להפעיל מחדש את השרת.
let cache = { faq: [], products: [], recipes: [], loadedAt: 0 };
const RELOAD_INTERVAL_MS = 5 * 60 * 1000; // 5 דקות

function loadKnowledge() {
  const now = Date.now();
  if (now - cache.loadedAt < RELOAD_INTERVAL_MS && cache.products.length) {
    return cache;
  }
  const faq = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'faq.json'), 'utf8'));
  const products = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'products.json'), 'utf8'));
  let recipes = [];
  try {
    recipes = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'recipes.json'), 'utf8'));
  } catch (e) {
    recipes = [];
  }
  cache = { faq, products, recipes, loadedAt: now };
  return cache;
}

// הקטלוג כולל כ-1400 מוצרים - יותר מדי כדי לשלוח את כולו בכל בקשה (יקר, איטי, ומבלבל את המודל).
// במקום זה מחפשים רק את המוצרים הרלוונטיים להודעה של הלקוח, לפי חפיפת מילים בשם/קטגוריה/מותג/תיאור.
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

function searchRecipes(query, recipes, limit = 5) {
  const tokens = tokenize(query);
  if (!tokens.length || !recipes.length) return [];

  const scored = recipes.map(r => {
    const haystack = `${r.title} ${r.tags} ${r.summary || ''}`;
    let score = 0;
    for (const t of tokens) {
      if (haystack.includes(t)) score += 1;
    }
    return { r, score };
  }).filter(x => x.score > 0);

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(x => x.r);
}

function buildSystemPrompt(userMessage) {
  const { faq, products, recipes } = loadKnowledge();

  const faqText = faq.map(f => `שאלה: ${f.question}\nתשובה: ${f.answer}`).join('\n\n');

  const relevant = searchProducts(userMessage, products);
  const productsText = relevant.length
    ? relevant.map(p =>
        `- ${p.name} | קטגוריה: ${p.category} | מחיר: ${p.price} ש"ח | במלאי: ${p.in_stock ? 'כן' : 'לא'} | קישור: ${p.url}\n  תיאור ורכיבים: ${p.description}`
      ).join('\n')
    : '(לא נמצאו מוצרים תואמים לשאלה זו מתוך החיפוש האוטומטי - אם השאלה עוסקת במוצר ספציפי, אפשר להציע ללקוח לחפש באתר או לשאול בניסוח אחר.)';

  const relevantRecipes = searchRecipes(userMessage, recipes);
  const recipesText = relevantRecipes.length
    ? relevantRecipes.map(r => `- ${r.title} | תגיות: ${r.tags} | קישור: ${r.url}\n  תקציר: ${r.summary || ''}`).join('\n')
    : '(אין כרגע מתכון תואם ידוע מהבלוג שלנו לשאלה הזו)';

  return `את/ה עוזר/ת AI ידידותי/ת של חנות "גולוטן" - חנות אונליין למוצרים ללא גלוטן. תפקידך:
1. לענות על שאלות נפוצות בהתאם למידע שמופיע כאן בלבד - אסור להמציא מדיניות שלא מופיעה במידע.
2. להמליץ על מוצרים אך ורק מתוך הרשימה הרלוונטית שמופיעה כאן (זו תת-קבוצה מתוך קטלוג של כ-1100 מוצרים פעילים, שנבחרה אוטומטית לפי השאלה) - אסור בהחלט להמציא שם מוצר, מחיר, או פרט שלא מופיע במפורש ברשימה הזו. כל מוצר כולל תיאור עם רכיבים ואלרגנים אמיתיים - השתמש/י בהם כדי לענות על שאלות כמו "יש בזה סויה?" או "מה מתאים למישהו שנמנע מסוכר?". אם השאלה עוסקת במוצר ספציפי שלא נמצא ברשימה, אמור בכנות שאין לך מידע מדויק עליו ברגע זה, והצע ללקוח לחפש אותו באתר או לנסח את השאלה אחרת - אל תנחש.
3. תמיד לצטט את הקישור (url) בדיוק כפי שהוא מופיע ברשימה, מילה במילה - אסור לקצר, לשנות, או להמציא קישור.
4. לגבי מתכונים: אם יש מתכון תואם ברשימת "מתכונים מהבלוג שלנו" למטה - קודם כל תפני/ה אליו עם הקישור המדויק שלו. אם אין מתכון תואם ברשימה, אפשר להציע רעיון מתכון או טיפ בישול מהידע הכללי שלך (למשל על סוגי קמחים ללא גלוטן) - אבל בסוף התשובה תמיד להזכיר שאפשר למצוא עוד מתכונים בבלוג שלנו בכתובת https://guluten.co.il/מתכונים. אסור להמציא קישור למתכון ספציפי שלא מופיע ברשימה.
5. לענות בעברית, בטון חם וידידותי, בקצרה וברורה.
6. אם נשאלת שאלה שאין עליה מידע (למשל ייעוץ רפואי, כשרות של מוצר ספציפי שלא ברשימה), אמור בכנות שאין לך את המידע המדויק והפנה ליצירת קשר בוואטסאפ במספר 052-3030351.
7. כל המוצרים בחנות ללא גלוטן - זה לא צריך לצוין כל פעם כי זה מובן מאליו לחנות הזו.

מידע נפוץ (FAQ):
${faqText}

מוצרים רלוונטיים לשאלה הנוכחית:
${productsText}

מתכונים תואמים מהבלוג שלנו:
${recipesText}`;
}

app.post('/api/chat', async (req, res) => {
  try {
    const { message, history } = req.body;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'חסרה הודעה (message) בבקשה' });
    }

    const systemPrompt = buildSystemPrompt(message);

    // history הוא מערך אופציונלי של הודעות קודמות בפורמט [{role: 'user'|'assistant', content: '...'}]
    const messages = [
      { role: 'system', content: systemPrompt },
      ...(Array.isArray(history) ? history : []),
      { role: 'user', content: message },
    ];

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages,
        temperature: 0.6,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('OpenAI API error:', errText);
      return res.status(502).json({ error: 'שגיאה בפנייה ל-OpenAI API' });
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content?.trim() || 'מצטער, לא הצלחתי לייצר תשובה כרגע.';

    res.json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת פנימית' });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`השרת פועל על פורט ${PORT}`);
});
