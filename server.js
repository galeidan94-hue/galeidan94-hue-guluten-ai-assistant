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
let cache = { faq: [], products: [], recipes: [], externalRecipes: [], loadedAt: 0 };
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
  let externalRecipes = [];
  try {
    externalRecipes = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'external_recipes.json'), 'utf8'));
  } catch (e) {
    externalRecipes = [];
  }
  cache = { faq, products, recipes, externalRecipes, loadedAt: now };
  return cache;
}

// הקטלוג כולל כ-1400 מוצרים - יותר מדי כדי לשלוח את כולו בכל בקשה (יקר, איטי, ומבלבל את המודל).
// במקום זה מחפשים רק את המוצרים הרלוונטיים להודעה של הלקוח, לפי חפיפת מילים בשם/קטגוריה/מותג/תיאור.
const STOPWORDS = new Set(['את','של','עם','אני','אתה','את','יש','אין','זה','זו','על','אם','לא','כן','גם','או','מה','איך','למה','כמה','אפשר','רוצה','רוצים','תמליץ','המלצה','טוב','בשביל','עבור','מוצר','מוצרים','מוצרי','אצלכם','לכם','חנות','באתר','אתר','ללא','גלוטן','מתכון','מתכונים','מתכוני','לבדוק','בדוק','תוכל','תוכלי']);

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

// מטפל גם בסיומות ריבוי/יחיד ("עוגייה"/"עוגיות") - מוריד סיומות נפוצות כדי
// לקבל צורת "שורש" גסה שמתאימה לשתי הצורות.
const HEBREW_SUFFIXES = ['יות', 'ות', 'ים', 'יה', 'ה', 'י'];

// כשמורידים סיומת, אות סופית (ם/ן/ך/ף/ץ) שהופיעה כ"רגילה" באמצע המילה המקורית
// ("לחמי") צריכה לחזור לצורתה הסופית ("לחם") כי היא עכשיו סוף המילה.
const FINAL_LETTER_MAP = { 'כ': 'ך', 'מ': 'ם', 'נ': 'ן', 'פ': 'ף', 'צ': 'ץ' };

function stripHebrewSuffix(word) {
  for (const suf of HEBREW_SUFFIXES) {
    if (word.length > suf.length + 2 && word.endsWith(suf)) {
      const stripped = word.slice(0, -suf.length);
      const lastChar = stripped[stripped.length - 1];
      if (FINAL_LETTER_MAP[lastChar]) {
        return stripped.slice(0, -1) + FINAL_LETTER_MAP[lastChar];
      }
      return stripped;
    }
  }
  return word;
}

// פתרון כללי (לא רק לפי מילון ידני) לתעתיק מותגים: הופכים מילה עברית ל"שלד עיצורים"
// (משמיטים תנועות ואותיות א/ה/ו/י שלא ברור אם הן עיצור או תנועה), ואותו דבר למילה
// לטינית (משמיטים תנועות aeiou) - כך ש"נוטרזן" ו-"NutraZen" מגיעים לאותו שלד "ntrzn".
const HEBREW_TO_LATIN_CONSONANT = {
  'ב': 'b', 'ג': 'g', 'ד': 'd', 'ז': 'z', 'ח': 'h', 'ט': 't',
  'כ': 'k', 'ך': 'k', 'ל': 'l', 'מ': 'm', 'ם': 'm', 'נ': 'n', 'ן': 'n',
  'ס': 's', 'פ': 'p', 'ף': 'p', 'צ': 'tz', 'ץ': 'tz', 'ק': 'k', 'ר': 'r',
  'ש': 's', 'ת': 't',
};

function hebrewConsonantSkeleton(word) {
  let out = '';
  for (const ch of word) {
    if (HEBREW_TO_LATIN_CONSONANT[ch]) out += HEBREW_TO_LATIN_CONSONANT[ch];
  }
  return out;
}

function latinConsonantSkeleton(word) {
  return word.toLowerCase().replace(/[aeiou]/g, '');
}

// בודק אם למילה עברית יש מילה לטינית "מתחזה" (brand transliterated) בתוך הטקסט,
// לפי השוואת שלד העיצורים (זהה, או קרוב מאוד - הפרש של תו אחד).
function matchesTransliteratedBrand(haystack, hebrewToken) {
  if (!/^[\u0590-\u05FF]+$/.test(hebrewToken) || hebrewToken.length < 3) return false;
  if (!/[A-Za-z]/.test(haystack)) return false; // אין בכלל אותיות לטיניות - לא שווה לבדוק
  const targetSkeleton = hebrewConsonantSkeleton(hebrewToken);
  if (targetSkeleton.length < 3) return false;
  const latinWords = haystack.match(/[A-Za-z]+/g) || [];
  return latinWords.some(w => {
    const sk = latinConsonantSkeleton(w);
    return sk.length >= 3 && (sk === targetSkeleton || levenshteinLite(sk, targetSkeleton) <= 1);
  });
}

// תעתיק בין עברית לאנגלית לשמות מותגים ספציפיים עם הגייה יוצאת דופן (למשל "שר"
// הוא תעתיק ל-"Schar" הגרמני/איטלקי - "sch" מייצג צליל אחד, מה ששלד-עיצורים כללי
// היה מפספס). למותגים "רגילים" יותר, matchesTransliteratedBrand למעלה מספיק לבד.
const TRANSLITERATION_MAP = {
  'שר': 'schar', 'שאר': 'schar',
  'מולינו': 'molino',
  'תמי': 'tami', 'תמי4': 'tami4',
};
const REVERSE_TRANSLITERATION = Object.fromEntries(
  Object.entries(TRANSLITERATION_MAP).map(([he, en]) => [en, he])
);

function transliterate(word) {
  const lower = word.toLowerCase();
  const variants = [word];
  if (TRANSLITERATION_MAP[word]) variants.push(TRANSLITERATION_MAP[word]);
  if (REVERSE_TRANSLITERATION[lower]) variants.push(REVERSE_TRANSLITERATION[lower]);
  return variants;
}

// חיפוש "מטושטש" (fuzzy) בין שתי מילים קצרות - סופר כמה תווים שונים בין המילים
// (מרחק עריכה גס), כדי לתפוס שגיאות הקלדה קטנות ("שוקולט" במקום "שוקולד").
function levenshteinLite(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 99;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

function fuzzyIncludes(haystack, token, tryTransliteration = true) {
  if (haystack.includes(token)) return true;
  if (tryTransliteration && matchesTransliteratedBrand(haystack, token)) return true;
  if (token.length < 4) return false; // מילים קצרות מדי - הטשטוש עלול להיות מטעה
  const words = haystack.split(/\s+/);
  return words.some(w => w.length >= 3 && levenshteinLite(w, token) <= 1);
}

function tokenize(text, excludeWords = []) {
  const excludeSet = new Set(excludeWords);
  const rawWords = text
    .replace(/[^\u0590-\u05FFa-zA-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .map(w => w.trim())
    .filter(w => w.length >= 2 && !STOPWORDS.has(w) && !excludeSet.has(w));

  const withVariants = rawWords.flatMap(w => {
    const prefixVariants = stripHebrewPrefixes(w);
    const allVariants = prefixVariants.flatMap(v => [v, stripHebrewSuffix(v)]);
    return allVariants.flatMap(v => transliterate(v));
  }).filter(w => w.length >= 3 && !STOPWORDS.has(w) && !excludeSet.has(w));
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
    const firstWord = p.name.split(' ')[0] || '';
    let score = 0;
    for (const t of tokens) {
      if (fuzzyIncludes(firstWord, t)) score += 4; // התאמה למילה הראשונה בשם (בד"כ המותג) - החזקה ביותר
      else if (fuzzyIncludes(p.name, t)) score += 3;
      else if (fuzzyIncludes(p.category, t)) score += 2;
      else if (p.description.includes(t)) score += 1;
    }
    return { p, score };
  }).filter(x => tokens.length ? x.score > 0 : true);

  scored.sort((a, b) => b.score - a.score || (b.p.in_stock ? 1 : 0) - (a.p.in_stock ? 1 : 0));
  return scored.slice(0, limit).map(x => x.p);
}

function searchRecipes(query, recipes, limit = 4) {
  const tokens = tokenize(query);
  if (!tokens.length || !recipes.length) return [];

  const scored = recipes.map(r => {
    const haystack = `${r.title} ${r.tags} ${r.summary || ''} ${(r.ingredients || []).join(' ')} ${(r.steps || []).join(' ')}`;
    let score = 0;
    for (const t of tokens) {
      if (fuzzyIncludes(haystack, t, false)) score += 1;
    }
    return { r, score };
  }).filter(x => x.score > 0);

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(x => x.r);
}

function searchExternalRecipes(query, externalRecipes, limit = 3) {
  const tokens = tokenize(query);
  if (!tokens.length || !externalRecipes.length) return [];

  const scored = externalRecipes.map(r => {
    const haystack = `${r.title} ${r.tags}`;
    let score = 0;
    for (const t of tokens) {
      if (fuzzyIncludes(haystack, t, false)) score += 1;
    }
    return { r, score };
  }).filter(x => x.score > 0);

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(x => x.r);
}

function buildSystemPrompt(userMessage, searchContext) {
  const { faq, products, recipes, externalRecipes } = loadKnowledge();

  const faqText = faq.map(f => `שאלה: ${f.question}\nתשובה: ${f.answer}`).join('\n\n');

  // חשוב: קודם מחפשים רק לפי ההודעה הנוכחית - כדי שנושא ישן משיחה קודמת (למשל
  // "עוגיות") לא "ידביק" ויעוות תוצאות לשאלה חדשה ולא קשורה (למשל "קמח").
  // רק אם ההודעה הנוכחית לבד לא מוצאת שום דבר, מרחיבים להקשר של ההודעות האחרונות
  // (עוזר בעיקר להמשכי שיחה בלי מילת מפתח, כמו "תני משהו יותר פשוט").
  let relevant = searchProducts(userMessage, products);
  if (!relevant.length && searchContext) relevant = searchProducts(searchContext, products);

  const productsText = relevant.length
    ? relevant.map(p =>
        `- ${p.name} | קטגוריה: ${p.category} | מחיר: ${p.price} ש"ח | במלאי: ${p.in_stock ? 'כן' : 'לא'} | קישור: ${p.url}\n  תיאור ורכיבים: ${p.description}`
      ).join('\n')
    : '(לא נמצאו מוצרים תואמים לשאלה זו מתוך החיפוש האוטומטי)';

  let relevantRecipes = searchRecipes(userMessage, recipes);
  if (!relevantRecipes.length && searchContext) relevantRecipes = searchRecipes(searchContext, recipes);

  const recipesText = relevantRecipes.length
    ? relevantRecipes.map(r => {
        const ingredientsList = (r.ingredients || []).map(i => `    - ${i}`).join('\n');
        const stepsList = (r.steps || []).map((s, i) => `    ${i + 1}. ${s}`).join('\n');
        return `- ${r.title} | תגיות: ${r.tags} | זמן הכנה: ${r.cooking_time || 'לא צוין'} | קישור: ${r.url}\n  מרכיבים:\n${ingredientsList}\n  שלבי הכנה:\n${stepsList}`;
      }).join('\n\n')
    : '(אין כרגע מתכון תואם ידוע מהבלוג שלנו לשאלה הזו)';

  let relevantExternal = searchExternalRecipes(userMessage, externalRecipes);
  if (!relevantExternal.length && searchContext) relevantExternal = searchExternalRecipes(searchContext, externalRecipes);

  const externalRecipesText = relevantExternal.length
    ? relevantExternal.map(r => `- ${r.title} | מקור: ${r.source} | קישור: ${r.url}`).join('\n')
    : '(אין מתכון חיצוני תואם ידוע)';

  const productCategories = [...new Set(products.map(p => p.category).filter(Boolean))];
  const recipeCategories = [...new Set(
    recipes.flatMap(r => (r.tags || '').split(',').map(t => t.trim()).filter(Boolean))
  )];

  return `את/ה עוזר/ת AI ידידותי/ת ומכירתי/ת של חנות "גולוטן" - חנות אונליין למוצרים ללא גלוטן. תפקידך:

1. לענות על שאלות נפוצות בהתאם למידע שמופיע כאן בלבד - אסור להמציא מדיניות שלא מופיעה במידע.

2. חשוב מאוד לגבי מתכונים ובישול:
   - יש לך למטה רשימת "מתכונים תואמים מהבלוג שלנו" - כל מתכון שם כולל מרכיבים מדויקים ושלבי הכנה מלאים. אם הרשימה לא ריקה, את/ה **חייב/ת** לתת ללקוח את תוכן המתכון בפועל (מרכיבים ושלבים עיקריים, אפשר בקצרה) יחד עם הקישור המדויק שלו - לא רק להזכיר שהוא קיים.
   - אם יש כמה מתכונים תואמים, אפשר להזכיר את כולם בקצרה ולתת קישור לכל אחד, ולהתמקד במתכון המתאים ביותר.
   - אם אין שום מתכון תואם ברשימה הפנימית, בדוק/י את רשימת "מתכונים ממקורות חיצוניים" למטה. אם יש שם התאמה, הצע/י אותה תוך ציון ברור של המקור (למשל "מצאתי מתכון כזה באתר קמח הארץ") וקישור - ותמיד ציין/י שזה לא מהבלוג שלנו.
   - אם גם ברשימה החיצונית אין התאמה: אל תמציא/י מתכון מיד. קודם שאל/י את הלקוח בנימוס: "אין לנו כרגע מתכון כזה בבלוג שלנו - תרצה/י שאציע לך רעיון כללי מהידע שלי, או שנפנה אותך לחפש בעמוד המתכונים שלנו: https://guluten.co.il/מתכונים?". רק אם הלקוח מאשר, תני/תן רעיון מהידע הכללי שלך על בישול ואפייה ללא גלוטן (כולל סוגי קמחים) - ותמיד ציין/י בבירור שזו הצעה כללית, לא ממקור ספציפי.
   - אסור להמציא קישור למתכון ספציפי שלא מופיע באחת משתי הרשימות.

3. קריטי לגבי מוצרים - איסור המצאה מוחלט:
   - מותר להמליץ אך ורק על מוצרים שמופיעים **מילה במילה** ברשימת "מוצרים רלוונטיים" למטה. לפני שאת/ה כותב/ת שם מוצר, ודא/י שהוא מופיע שם בדיוק.
   - **אסור בהחלט** לצרף קישור (url) של מוצר אחד לתיאור/שם של מוצר אחר. הקישור תמיד שייך אך ורק למוצר שהוא מתאר, בדיוק כפי שהם מופיעים יחד ברשימה.
   - אם אין ברשימה מוצר שמתאים לשאלה - אין להציג שום "כרטיס מוצר" מומצא. יש להגיד בפשטות שאין כרגע מוצר כזה בחנות (או שלא נמצא בחיפוש), ולעבור לסעיף 4 (שאלה מכוונת) או להציע קטגוריה קרובה מהרשימה.
   - כל מוצר ברשימה כולל תיאור עם רכיבים ואלרגנים אמיתיים - אפשר להשתמש בזה לענות על "יש בזה סויה?" וכדומה, אבל **תמיד** להוסיף משפט קצר שהמידע מבוסס על נתוני האתר, וכדאי ללקוח לבדוק גם על גבי האריזה לפני רכישה (בדומה למדיניות המוצהרת של החנות).

4. אם לקוח מזכיר מוצר בשם לא מדויק (טעות כתיבה, אנגלית-עברית מעורבב, יחיד/רבים) - נסה/י להבין לאיזה מוצר הכוונה מתוך הרשימה שסופקה (יש כלי התאמה חכם שכבר מתמודד עם זה ברוב המקרים). אם עדיין לא ברור, או שלא נמצאה התאמה טובה ברשימה, אל תגיד/י סתם "אין לי מידע" - שאל/י שאלה מכוונת אחת שתעזור לצמצם (לדוגמה: "איזה סוג מוצר בדיוק - חטיף, קמח, או משהו אחר?"), ואז הצע/י את המוצר המתאים ביותר מהרשימה שכן קיימת.

5. חשוב מאוד - טון מכירתי וחם: המטרה היא לעזור ללקוח למצוא בדיוק מה שהוא צריך ולעודד רכישה. בכל תשובה, כשרלוונטי, הצע/י בעדינות צעד הבא: מוצר משלים לקנייה, או מתכון מתאים - אבל תמיד רק מתוך הרשימות שסופקו, לא מומצא. תמיד בטון נעים ולא נודניקי.

6. קטגוריות: יש לך למטה רשימה של כל קטגוריות המוצרים והמתכונים שקיימות בחנות. אם לקוח שואל "אילו סוגים יש לכם של X", אפשר להיעזר ברשימה הזו כדי לענות בביטחון אילו קטגוריות קיימות, גם אם החיפוש האוטומטי לא החזיר תוצאות ספציפיות.

7. פורמט התשובה - חשוב טכנית: הצ'אט מציג טקסט רגיל בלבד ולא תומך בעיצוב Markdown. **אסור** להשתמש בכוכביות להדגשה (**כמו זה**), בסולמיות (#), או בקווים מפרידים (---). לרשימות, פשוט תשתמש/י במספור פשוט עם ירידת שורה (1. ... שורה חדשה 2. ...) או במקף רגיל בתחילת שורה - לא כוכביות.

8. לענות בעברית, בטון חם וידידותי, בקצרה וברורה.

9. אם נשאלת שאלה שאין עליה מידע מדויק על החנות עצמה (למשל כשרות של מוצר ספציפי שלא ברשימה, מדיניות שלא מופיעה כאן), אמור בכנות שאין לך את המידע המדויק והפנה ליצירת קשר בוואטסאפ במספר 052-3030351. הכלל הזה חל על עובדות ספציפיות על החנות/המוצרים - לא על ידע כללי בבישול, מתכונים, או תזונה.

9. כל המוצרים בחנות ללא גלוטן - זה לא צריך לצוין כל פעם כי זה מובן מאליו לחנות הזו.

מידע נפוץ (FAQ):
${faqText}

מוצרים רלוונטיים לשאלה הנוכחית:
${productsText}

מתכונים תואמים מהבלוג שלנו:
${recipesText}

מתכונים ממקורות חיצוניים (רק כגיבוי, תמיד לציין את המקור):
${externalRecipesText}

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
        temperature: 0.3,
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
