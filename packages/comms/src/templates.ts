/**
 * Message templates in sq / en / ar. One catalogue feeds every channel: free-text
 * channels (Telegram, e-mail, SMS, Web Push) render it here; WhatsApp sends the
 * pre-approved Business template of the same key with the same ordered parameters.
 * Direction comes from the locale (Arabic is RTL), never from a country.
 */

export const TEMPLATE_LOCALES = ["sq", "en", "ar"] as const;
export type TemplateLocale = (typeof TEMPLATE_LOCALES)[number];
export const FALLBACK_LOCALE: TemplateLocale = "en";

interface LocalizedText {
  subject: string;
  body: string;
}

export interface TemplateDefinition {
  /** Variables in WhatsApp parameter order ({{1}}, {{2}} ...). */
  params: readonly string[];
  text: Readonly<Record<TemplateLocale, LocalizedText>>;
}

export const TEMPLATES = {
  "alert.critical": {
    params: ["student", "reason"],
    text: {
      en: {
        subject: "Attention needed: {{student}}",
        body: "{{student}} needs attention: {{reason}}. Open Student Success OS for the full explanation.",
      },
      sq: {
        subject: "Kërkohet vëmendje: {{student}}",
        body: "{{student}} ka nevojë për vëmendje: {{reason}}. Hapni Student Success OS për shpjegimin e plotë.",
      },
      ar: {
        subject: "مطلوب انتباه: {{student}}",
        body: "يحتاج {{student}} إلى المتابعة: {{reason}}. افتح Student Success OS للاطلاع على التفسير الكامل.",
      },
    },
  },
  "digest.weekly": {
    params: ["student", "summary"],
    text: {
      en: { subject: "Weekly update for {{student}}", body: "This week for {{student}}: {{summary}}" },
      sq: { subject: "Përmbledhja javore për {{student}}", body: "Këtë javë për {{student}}: {{summary}}" },
      ar: { subject: "الملخص الأسبوعي لـ {{student}}", body: "هذا الأسبوع لـ {{student}}: {{summary}}" },
    },
  },
  "message.new": {
    params: ["sender", "preview"],
    text: {
      en: { subject: "New message from {{sender}}", body: "{{sender}}: {{preview}}" },
      sq: { subject: "Mesazh i ri nga {{sender}}", body: "{{sender}}: {{preview}}" },
      ar: { subject: "رسالة جديدة من {{sender}}", body: "{{sender}}: {{preview}}" },
    },
  },
  "goal.nudge": {
    params: ["student", "goal", "progress"],
    text: {
      en: { subject: "Goal check-in: {{goal}}", body: "{{student}} is at {{progress}}% on “{{goal}}”. Keep going!" },
      sq: { subject: "Kontroll i objektivit: {{goal}}", body: "{{student}} është në {{progress}}% për “{{goal}}”. Vazhdo kështu!" },
      ar: { subject: "متابعة الهدف: {{goal}}", body: "وصل {{student}} إلى {{progress}}٪ في «{{goal}}». واصل التقدم!" },
    },
  },
  "announcement.new": {
    params: ["title"],
    text: {
      en: { subject: "School announcement: {{title}}", body: "New announcement: {{title}}. Open Student Success OS to read it." },
      sq: { subject: "Njoftim nga shkolla: {{title}}", body: "Njoftim i ri: {{title}}. Hapni Student Success OS për ta lexuar." },
      ar: { subject: "إعلان من المدرسة: {{title}}", body: "إعلان جديد: {{title}}. افتح Student Success OS لقراءته." },
    },
  },
  "optout.confirmed": {
    params: [],
    text: {
      en: { subject: "Unsubscribed", body: "You will no longer receive messages on this channel. Reply START to subscribe again." },
      sq: { subject: "Çregjistruar", body: "Nuk do të merrni më mesazhe në këtë kanal. Përgjigjuni START për t'u regjistruar përsëri." },
      ar: { subject: "تم إلغاء الاشتراك", body: "لن تتلقى رسائل على هذه القناة بعد الآن. أرسل START للاشتراك مجددًا." },
    },
  },
} as const satisfies Record<string, TemplateDefinition>;

export type TemplateKey = keyof typeof TEMPLATES;

/** Appended to SMS so every recipient can opt out in their own language. */
export const OPT_OUT_HINT: Readonly<Record<TemplateLocale, string>> = {
  en: "Reply STOP to unsubscribe.",
  sq: "Përgjigjuni NDALO për t'u çregjistruar.",
  ar: "أرسل توقف لإلغاء الاشتراك.",
};

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}

export interface RenderedTemplate {
  key: TemplateKey;
  locale: TemplateLocale;
  dir: "ltr" | "rtl";
  subject: string;
  body: string;
}

export function isTemplateKey(key: string): key is TemplateKey {
  return Object.prototype.hasOwnProperty.call(TEMPLATES, key);
}

/** "ar-AE" -> "ar"; unknown -> en. */
export function resolveLocale(locale: string): TemplateLocale {
  const base = locale.toLowerCase().split(/[-_]/)[0];
  return (TEMPLATE_LOCALES as readonly string[]).includes(base ?? "") ? (base as TemplateLocale) : FALLBACK_LOCALE;
}

export function textDirection(locale: TemplateLocale): "ltr" | "rtl" {
  return locale === "ar" ? "rtl" : "ltr";
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  throw new TemplateError(`template variable must be a string or number, got ${typeof value}`);
}

function fill(text: string, vars: Readonly<Record<string, unknown>>, key: string): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    const value = vars[name];
    if (value === undefined || value === null) throw new TemplateError(`template ${key} is missing variable "${name}"`);
    return stringify(value);
  });
}

export function renderTemplate(key: string, locale: string, vars: Readonly<Record<string, unknown>>): RenderedTemplate {
  if (!isTemplateKey(key)) throw new TemplateError(`unknown template "${key}"`);
  const loc = resolveLocale(locale);
  const text = TEMPLATES[key].text[loc];
  return { key, locale: loc, dir: textDirection(loc), subject: fill(text.subject, vars, key), body: fill(text.body, vars, key) };
}

/** Ordered parameter values for a WhatsApp Business template. */
export function templateParams(key: string, vars: Readonly<Record<string, unknown>>): string[] {
  if (!isTemplateKey(key)) throw new TemplateError(`unknown template "${key}"`);
  return TEMPLATES[key].params.map((name) => {
    const value = vars[name];
    if (value === undefined || value === null) throw new TemplateError(`template ${key} is missing variable "${name}"`);
    return stringify(value);
  });
}
