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

// מזהה ביטויי שלילה כמו "ללא סויה" / "בלי בוטנים" / "נטול לקטוז" ומוציא מהם את
// הרכיב שיש להוציא לגמרי מהתוצאות - כדי שחיפוש "ללא X" לא יעלה בטעות מוצרים שמכילים X.
const NEGATION_CUES = ['ללא', 'בלי', 'נטול', 'נטולת', 'ללא תוספת'];
const NEGATION_FILLERS = new Set(['תוספת', 'עם', 'של', 'כל']);

function extractExclusions(query) {
  const words = query.replace(/[^\u0590-\u05FFa-zA-Z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const exclusions = [];
  for (let i = 0; i < words.length; i++) {
    if (NEGATION_CUES.includes(words[i])) {
      let j = i + 1;
      while (j < words.length && NEGATION_FILLERS.has(words[j])) j++;
      if (j < words.length && words[j].length >= 2) {
        exclusions.push(words[j]);
      }
    }
  }
  return exclusions;
}

// עברית מדביקה מילות יחס (ו/ב/כ/ל/מ/ש/ה) בתחילת מילים ("לעוגיות", "בלחם") -
// בלי טיפול בזה, חיפוש מילולי פשוט מפספס התאמות. מייצרים גם גרסה בלי הקידומת.
const HEBREW_PREFIXES = new Set(['ו', 'ב', 'כ', 'ל', 'מ', 'ש', 'ה']);

function stripHebrewPrefixes(word) {
  const variants = new Set([word]);
  let w = word;
  for (let i = 0; i < 2; i++) {
    if (w.length > 3 && HEBREW_PREFIXES.has(w[0])) {
      w = w.slice(1);
      if (w.length >= 2) variants.add(w);
    } else {
      break;
    }
  }
  return [...variants];
}

function tokenize(text, excludeWords = []) {
  const excludeSet = new Set(excludeWords);
  const rawWords = text
    .replace(/[^\u0590-\u05FFa-zA-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .map(w => w.trim())
    .filter(w => w.length >= 2 && !STOPWORDS.has(w) && !excludeSet.has(w));

  const withVariants = rawWords.flatMap(w => stripHebrewPrefixes(w));
  return [...new Set(withVariants)];
}

function searchProducts(query, products, limit = 15) {
  const exclusions = extractExclusions(query);
  const tokens = tokenize(query, exclusions);
  if (!tokens.length && !exclusions.length) return [];

  let candidates = products;
  if (exclusions.length) {
    candidates = candidates.filter(p => {
      const haystack = `${p.name} ${p.description}`;
      return !exclusions.some(ex => haystack.includes(ex));
    });
  }

  const scored = candidates.map(p => {
    const haystack = `${p.name} ${p.category} ${p.description}`;
    let score = 0;
    for (const t of tokens) {
      if (haystack.includes(t)) score += 1;
    }
    return { p, score };
  }).filter(x => tokens.length ? x.score > 0 : true);

  scored.sort((a, b) => b.score - a.score || (b.p.in_stock ? 1 : 0) - (a.p.in_stock ? 1 : 0));
  return scored.slice(0, limit).map(x => x.p);
}

function searchRecipes(query, recipes, limit = 3) {
  const tokens = tokenize(query);
  if (!tokens.length || !recipes.length) return [];

  const scored = recipes.map(r => {
    const haystack = `${r.title} ${r.tags} ${r.summary || ''} ${(r.ingredients || []).join(' ')} ${(r.steps || []).join(' ')}`;
    let score = 0;
    for (const t of tokens) {
      if (haystack.includes(t)) score += 1;
    }
    return { r, score };
  }).filter(x => x.score > 0);

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(x => x.r);
}

function buildSystemPrompt(userMessage, searchContext) {
  const { faq, products, recipes } = loadKnowledge();
  const queryForSearch = searchContext || userMessage;

  const faqText = faq.map(f => `שאלה: ${f.question}\nתשובה: ${f.answer}`).join('\n\n');

  const relevant = searchProducts(queryForSearch, products);
  const productsText = relevant.length
    ? relevant.map(p =>
        `- ${p.name} | קטגוריה: ${p.category} | מחיר: ${p.price} ש"ח | במלאי: ${p.in_stock ? 'כן' : 'לא'} | קישור: ${p.url}\n  תיאור ורכיבים: ${p.description}`
      ).join('\n')
    : '(לא נמצאו מוצרים תואמים לשאלה זו מתוך החיפוש האוטומטי - אם השאלה עוסקת במוצר ספציפי, אפשר להציע ללקוח לחפש באתר או לשאול בניסוח אחר.)';

  const relevantRecipes = searchRecipes(queryForSearch, recipes);
  const recipesText = relevantRecipes.length
    ? relevantRecipes.map(r => {
        const ingredientsList = (r.ingredients || []).map(i => `    - ${i}`).join('\n');
        const stepsList = (r.steps || []).map((s, i) => `    ${i + 1}. ${s}`).join('\n');
        return `- ${r.title} | תגיות: ${r.tags} | זמן הכנה: ${r.cooking_time || 'לא צוין'} | קישור: ${r.url}\n  מרכיבים:\n${ingredientsList}\n  שלבי הכנה:\n${stepsList}`;
      }).join('\n\n')
    : '(אין כרגע מתכון תואם ידוע מהבלוג שלנו לשאלה הזו)';

  const productCategories = [...new Set(products.map(p => p.category).filter(Boolean))];
  const recipeCategories = [...new Set(
    recipes.flatMap(r => (r.tags || '').split(',').map(t => t.trim()).filter(Boolean))
  )];

  return `את/ה עוזר/ת AI ידידותי/ת של חנות "גולוטן" - חנות אונליין למוצרים ללא גלוטן. תפקידך:
1. לענות על שאלות נפוצות בהתאם למידע שמופיע כאן בלבד - אסור להמציא מדיניות שלא מופיעה במידע.
2. חשוב מאוד לגבי מתכונים ובישול:
   - יש לך למטה רשימת "מתכונים תואמים מהבלוג שלנו" - כל מתכון שם כולל מרכיבים מדויקים ושלבי הכנה מלאים. אם הרשימה לא ריקה, את/ה **חייב/ת** לתת ללקוח את תוכן המתכון בפועל (מרכיבים ושלבים עיקריים, אפשר בקצרה) יחד עם הקישור המדויק שלו - לא רק להזכיר שהוא קיים, אלא לעזור בפועל עם התוכן שלו.
   - אם יש כמה מתכונים תואמים, אפשר להזכיר את כולם בקצרה ולתת קישור לכל אחד, ולהתמקד במתכון המתאים ביותר.
   - אם אין שום מתכון תואם ברשימה: אל תמציא/י מתכון מיד. קודם תשאל/י את הלקוח בנימוס: "אין לנו כרגע מתכון כזה בבלוג שלנו - תרצה/י שאציע לך רעיון כללי, או שנפנה אותך לחפש בעמוד המתכונים שלנו: https://guluten.co.il/מתכונים?". רק אם הלקוח מאשר שהוא רוצה הצעה כללית, אפשר לתת רעיון מתכון מהידע הכללי שלך על בישול ואפייה ללא גלוטן (כולל סוגי קמחים ללא גלוטן) - אבל תמיד לציין בבירור שזו הצעה כללית ולא מתכון מהבלוג שלנו.
   - אסור להמציא קישור למתכון ספציפי שלא מופיע ברשימה שסופקה.
3. חשוב לגבי מוצרים: להמליץ על מוצרים אך ורק מתוך הרשימה הרלוונטית שמופיעה כאן (זו תת-קבוצה מתוך קטלוג של כ-1100 מוצרים פעילים, שנבחרה אוטומטית לפי השאלה, ומסננת אוטומטית מוצרים עם רכיבים שהלקוח ביקש להימנע מהם) - אסור בהחלט להמציא שם מוצר, מחיר, או פרט שלא מופיע במפורש ברשימה הזו. כל מוצר כולל תיאור עם רכיבים ואלרגנים אמיתיים - השתמש/י בהם כדי לענות על שאלות כמו "יש בזה סויה?" או "מה מתאים למישהו שנמנע מסוכר?". אם השאלה עוסקת במוצר ספציפי שלא נמצא ברשימה, אמור בכנות שאין לך מידע מדויק עליו ברגע זה, והצע ללקוח לחפש אותו באתר או לנסח את השאלה אחרת - אל תנחש. תמיד לצטט את הקישור (url) של מוצר בדיוק כפי שהוא מופיע ברשימה, מילה במילה.
4. קטגוריות: יש לך למטה רשימה של כל קטגוריות המוצרים והמתכונים שקיימות בחנות. אם לקוח שואל "אילו סוגים יש לכם של X" או מחפש קטגוריה כללית, אפשר להיעזר ברשימה הזו כדי לענות בביטחון אילו קטגוריות קיימות, גם אם החיפוש האוטומטי לא החזיר מוצרים ספציפיים.
5. לענות בעברית, בטון חם וידידותי, בקצרה וברורה.
6. אם נשאלת שאלה שאין עליה מידע מדויק על החנות עצמה (למשל כשרות של מוצר ספציפי שלא ברשימה, מדיניות שלא מופיעה כאן), אמור בכנות שאין לך את המידע המדויק והפנה ליצירת קשר בוואטסאפ במספר 052-3030351. הכלל הזה חל על עובדות ספציפיות על החנות/המוצרים - לא על ידע כללי בבישול, מתכונים, או תזונה, ששם מותר לך לענות בביטחון מהידע הכללי שלך (בכפוף לכלל 2 לגבי בקשת אישור לפני הצעת מתכון חיצוני).
7. כל המוצרים בחנות ללא גלוטן - זה לא צריך לצוין כל פעם כי זה מובן מאליו לחנות הזו.

מידע נפוץ (FAQ):
${faqText}

מוצרים רלוונטיים לשאלה הנוכחית:
${productsText}

מתכונים תואמים מהבלוג שלנו:
${recipesText}

קטגוריות מוצרים קיימות בחנות:
${productCategories.join(', ')}

קטגוריות מתכונים קיימות בבלוג:
${recipeCategories.join(', ')}`;
}

app.post('/api/chat', async (req, res) => {
  try {
    const { message, history } = req.body;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'חסרה הודעה (message) בבקשה' });
    }

    // כדי שתשובות המשך כמו "תני משהו יותר פשוט" (בלי מילת מפתח) עדיין ימצאו
    // מוצרים/מתכונים רלוונטיים, מרחיבים את טקסט החיפוש עם ההודעות האחרונות של הלקוח.
    const recentUserMessages = (Array.isArray(history) ? history : [])
      .filter(h => h.role === 'user')
      .slice(-2)
      .map(h => h.content);
    const searchContext = [...recentUserMessages, message].join(' ');

    const systemPrompt = buildSystemPrompt(message, searchContext);

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
