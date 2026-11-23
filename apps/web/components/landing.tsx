import { ArrowRight, Check, EyeOff, Gauge, Lock, UserRound } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";

import type { Locale } from "../i18n/config";
import { BrandMark } from "./brand";
import { LocaleSwitcher } from "./preferences";

/**
 * Public landing page (signed-out `/`). Palette: ink navy, sand, teal — fixed
 * colours rather than theme tokens, so the page reads the same in light and dark.
 * Every claim on it must trace to something the product does today.
 */

const TUTOR_MODES = ["socratic", "concept", "worked_example", "practice", "exam_prep", "writing_feedback"] as const;
const SAFETY = [
  { key: "isolation", Icon: Lock },
  { key: "disclosure", Icon: UserRound },
  { key: "images", Icon: EyeOff },
  { key: "budget", Icon: Gauge },
] as const;

function Bullets({ items }: { items: string[] }) {
  return (
    <ul className="grid gap-2 text-sm text-[#22344d]">
      {items.map((item) => (
        <li key={item} className="flex gap-2">
          <Check className="mt-0.5 size-4 shrink-0 text-[#1f7a70]" aria-hidden />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

function Screen({ src, alt, width, height }: { src: string; alt: string; width: number; height: number }) {
  return (
    <div className="overflow-hidden rounded-xl border border-[#d8ccb4] bg-white shadow-[0_20px_50px_-20px_rgba(11,29,51,0.35)]">
      <Image src={src} alt={alt} width={width} height={height} unoptimized className="h-auto w-full" />
    </div>
  );
}

function Kicker({ children }: { children: ReactNode }) {
  return <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#1f7a70]">{children}</p>;
}

export async function LandingPage({ locale }: { locale: Locale }) {
  const t = await getTranslations("landing");
  const tc = await getTranslations("common");
  const tm = await getTranslations("tutor.modes");
  const list = (key: string) => t.raw(key) as string[];

  return (
    <div className="min-h-dvh bg-[#fbf7ef] text-[#0b1d33]" data-testid="landing">
      {/* Hero */}
      <section className="bg-[#0b1d33] text-white">
        <header className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-6 py-5">
          <div className="flex items-center gap-2.5">
            <BrandMark />
            <span className="text-sm font-semibold tracking-tight">{tc("appName")}</span>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/sign-in"
              className="rounded-md px-3 py-2 text-sm font-medium text-white/85 hover:bg-white/10 hover:text-white"
            >
              {t("signIn")}
            </Link>
            <div className="rounded-md bg-white text-[#0b1d33]">
              <LocaleSwitcher />
            </div>
          </div>
        </header>
        <div className="mx-auto grid max-w-6xl items-center gap-10 px-6 pb-16 pt-8 lg:grid-cols-[1fr_1.1fr] lg:pb-24 lg:pt-12">
          <div className="flex flex-col gap-6">
            <Kicker>
              <span className="text-[#7fd1c4]">{t("hero.eyebrow")}</span>
            </Kicker>
            <h1 className="text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">{t("hero.title")}</h1>
            <p className="max-w-xl text-lg text-white/80">{t("hero.subtitle")}</p>
            <div className="flex flex-wrap gap-3">
              <Link
                href="/sign-in"
                data-testid="landing-demo"
                className="inline-flex items-center gap-2 rounded-lg bg-[#e3c98f] px-5 py-3 text-sm font-semibold text-[#0b1d33] hover:bg-[#ecd6a6]"
              >
                {t("hero.ctaDemo")}
                <ArrowRight className="size-4 rtl:rotate-180" aria-hidden />
              </Link>
              <Link
                href="/join"
                data-testid="landing-join"
                className="inline-flex items-center rounded-lg border border-white/30 px-5 py-3 text-sm font-semibold text-white hover:bg-white/10"
              >
                {t("hero.ctaJoin")}
              </Link>
            </div>
            <p className="text-sm text-white/60">{t("hero.coverage")}</p>
          </div>
          <Image
            src="/landing/hero.jpg"
            alt={t("hero.imageAlt")}
            width={1536}
            height={1024}
            priority
            unoptimized
            className="h-auto w-full rounded-2xl"
          />
        </div>
      </section>

      {/* Proof band: a real screen, not an illustration */}
      <section className="border-b border-[#e6dcc8] bg-[#f3ead9]">
        <div className="mx-auto grid max-w-6xl items-center gap-10 px-6 py-16 lg:grid-cols-[1fr_1.6fr]">
          <div className="flex flex-col gap-4">
            <Kicker>{t("proof.kicker")}</Kicker>
            <h2 className="text-3xl font-semibold tracking-tight">{t("proof.title")}</h2>
            <p className="text-[#22344d]">{t("proof.body")}</p>
            <p className="border-s-4 border-[#1f7a70] ps-4 text-[#22344d]" data-testid="landing-nodata">
              {t("proof.noData")}
            </p>
          </div>
          <figure className="flex flex-col gap-2">
            <Screen src={`/landing/mastery-${locale}.jpg`} alt={t("proof.alt")} width={1400} height={1000} />
            <figcaption className="text-xs text-[#5a6b80]">{t("proof.caption")}</figcaption>
          </figure>
        </div>
      </section>

      {/* Three value props */}
      <section className="mx-auto max-w-6xl px-6 py-16">
        <h2 className="mb-10 text-3xl font-semibold tracking-tight">{t("values.title")}</h2>
        <div className="grid items-center gap-10 lg:grid-cols-[1fr_1.4fr]">
          <div className="flex flex-col gap-3">
            <Kicker>{t("values.advisor.role")}</Kicker>
            <h3 className="text-2xl font-semibold">{t("values.advisor.title")}</h3>
            <p className="text-[#22344d]">{t("values.advisor.body")}</p>
          </div>
          <Screen src={`/landing/inbox-${locale}.jpg`} alt={t("values.advisor.alt")} width={1400} height={900} />
        </div>
        <div className="mt-14 grid gap-6 md:grid-cols-2">
          <div className="flex flex-col gap-3 rounded-2xl border border-[#e6dcc8] bg-white p-6">
            <Kicker>{t("values.student.role")}</Kicker>
            <h3 className="text-xl font-semibold">{t("values.student.title")}</h3>
            <p className="text-[#22344d]">{t("values.student.body")}</p>
            <Bullets items={TUTOR_MODES.map((m) => `${tm(`${m}.label`)} — ${tm(`${m}.hint`)}`)} />
          </div>
          <div className="flex flex-col gap-3 rounded-2xl border border-[#e6dcc8] bg-white p-6">
            <Kicker>{t("values.head.role")}</Kicker>
            <h3 className="text-xl font-semibold">{t("values.head.title")}</h3>
            <p className="text-[#22344d]">{t("values.head.body")}</p>
            <Bullets items={list("values.head.items")} />
          </div>
        </div>
      </section>

      {/* Two countries */}
      <section className="bg-[#0b1d33] text-white">
        <div className="mx-auto max-w-6xl px-6 py-16">
          <h2 className="text-3xl font-semibold tracking-tight">{t("countries.title")}</h2>
          <p className="mt-3 max-w-3xl text-white/80">{t("countries.body")}</p>
          <div className="mt-8 grid gap-6 md:grid-cols-2">
            {(["al", "ae"] as const).map((c) => (
              <div key={c} className="rounded-2xl bg-white p-6 text-[#0b1d33]">
                <h3 className="mb-4 text-xl font-semibold">{t(`countries.${c}.name`)}</h3>
                <Bullets items={list(`countries.${c}.items`)} />
              </div>
            ))}
          </div>
          <p className="mt-6 max-w-3xl text-sm text-white/70">{t("countries.confirm")}</p>
          <p className="mt-2 text-sm font-medium text-[#e3c98f]" data-testid="landing-pricing">
            {t("countries.pricing")}
          </p>
        </div>
      </section>

      {/* Safeguarding and privacy */}
      <section className="mx-auto max-w-6xl px-6 py-16">
        <h2 className="mb-8 text-3xl font-semibold tracking-tight">{t("safety.title")}</h2>
        <div className="grid gap-6 sm:grid-cols-2">
          {SAFETY.map(({ key, Icon }) => (
            <div key={key} className="flex gap-4 rounded-2xl border border-[#e6dcc8] bg-white p-6">
              <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg bg-[#dff1ee] text-[#1f7a70]">
                <Icon className="size-5" aria-hidden />
              </span>
              <div className="flex flex-col gap-1.5">
                <h3 className="font-semibold">{t(`safety.${key}.title`)}</h3>
                <p className="text-sm text-[#22344d]">{t(`safety.${key}.body`)}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-[#e6dcc8] bg-[#f3ead9]">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-6 py-8 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-2xl text-sm text-[#22344d]" data-testid="landing-demo-note">
            {t("footer.demo")}
          </p>
          <div className="rounded-md bg-white">
            <LocaleSwitcher />
          </div>
        </div>
      </footer>
    </div>
  );
}
